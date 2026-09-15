import { describe, expect, it } from "vitest";
import type { AgentRuntimeEvent } from "@pace/core";
import {
  addLegacyChatEventToModel,
  applyAgentRuntimeEvent,
  createSessionRuntimeModel,
  isContextCompacting,
  sessionStatusFromRuntimeModel,
  type SessionRuntimeModel,
} from "./session-runtime-model";

// The structured query model per the design doc §7: upsert keys come from
// protocol identity, ordering comes from Gateway seq, and Session Status is
// decided by run/error events only.

const runId = "pi-session-1:run-1";
const turnId = `${runId}:turn-1`;
const messageId = `${turnId}:msg-1`;
const partId = `${messageId}:part-0`;

function applyAll(
  model: SessionRuntimeModel,
  entries: Array<{ seq: number; timestamp: string; event: AgentRuntimeEvent }>,
): SessionRuntimeModel {
  return entries.reduce(
    (current, entry) => applyAgentRuntimeEvent(current, entry),
    model,
  );
}

describe("session runtime model", () => {
  it("assembles a streamed text answer into one keyed message and derives status from the Active Run", () => {
    let model = createSessionRuntimeModel();

    model = applyAll(model, [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: { type: "run", runId, phase: "start", trigger: "prompt", surface: "hidden", origin: "sdk" },
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:02.000Z",
        event: { type: "turn", runId, turnId, phase: "start", surface: "hidden", origin: "sdk" },
      },
      {
        seq: 3,
        timestamp: "2026-07-02T10:00:03.000Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId,
          role: "assistant",
          phase: "start",
          surface: "chat",
          origin: "sdk",
        },
      },
      {
        seq: 4,
        timestamp: "2026-07-02T10:00:04.000Z",
        event: {
          type: "message_part",
          runId,
          turnId,
          messageId,
          partId,
          partType: "text",
          phase: "update",
          bodyMode: "delta",
          body: "Hel",
          surface: "chat",
          origin: "sdk",
        },
      },
      {
        seq: 5,
        timestamp: "2026-07-02T10:00:05.000Z",
        event: {
          type: "message_part",
          runId,
          turnId,
          messageId,
          partId,
          partType: "text",
          phase: "update",
          bodyMode: "delta",
          body: "lo",
          surface: "chat",
          origin: "sdk",
        },
      },
    ]);

    expect(sessionStatusFromRuntimeModel(model)).toBe("running");

    const streamingMessage = model.messages.get(messageId);

    expect(streamingMessage).toMatchObject({
      messageId,
      role: "assistant",
      runId,
      turnId,
      phase: "streaming",
      parts: [{ partId, partType: "text", body: "Hello", done: false }],
    });

    model = applyAll(model, [
      {
        seq: 6,
        timestamp: "2026-07-02T10:00:06.000Z",
        event: {
          type: "message_part",
          runId,
          turnId,
          messageId,
          partId,
          partType: "text",
          phase: "end",
          bodyMode: "snapshot",
          body: "Hello",
          surface: "chat",
          origin: "sdk",
        },
      },
      {
        seq: 7,
        timestamp: "2026-07-02T10:00:07.000Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId,
          role: "assistant",
          phase: "end",
          parts: [{ partId, partType: "text", body: "Hello" }],
          surface: "chat",
          origin: "sdk",
        },
      },
      {
        seq: 8,
        timestamp: "2026-07-02T10:00:08.000Z",
        event: { type: "turn", runId, turnId, phase: "end", surface: "hidden", origin: "sdk" },
      },
      {
        seq: 9,
        timestamp: "2026-07-02T10:00:09.000Z",
        event: {
          type: "run",
          runId,
          phase: "end",
          trigger: "prompt",
          outcome: "completed",
          surface: "hidden",
          origin: "sdk",
        },
      },
    ]);

    expect(sessionStatusFromRuntimeModel(model)).toBe("completed");
    expect(model.messages.get(messageId)).toMatchObject({
      phase: "final",
      parts: [{ partId, partType: "text", body: "Hello", done: true }],
    });
    expect(model.runs.get(runId)).toMatchObject({
      trigger: "prompt",
      outcome: "completed",
      startedAt: "2026-07-02T10:00:01.000Z",
      endedAt: "2026-07-02T10:00:09.000Z",
    });
    expect(model.order).toEqual([{ kind: "message", id: messageId, seq: 3 }]);
  });

  it("keeps a model call's start stamp through the message end so its span stays derivable", () => {
    let model = createSessionRuntimeModel();

    model = applyAll(model, [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: { type: "run", runId, phase: "start", trigger: "prompt", surface: "hidden", origin: "sdk" },
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:02.000Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId,
          role: "assistant",
          phase: "start",
          surface: "chat",
          origin: "sdk",
        },
      },
      {
        seq: 3,
        timestamp: "2026-07-02T10:00:05.000Z",
        event: {
          type: "message_part",
          runId,
          turnId,
          messageId,
          partId,
          partType: "thinking",
          phase: "end",
          bodyMode: "snapshot",
          body: "Reading the repo.",
          surface: "trace",
          origin: "sdk",
        },
      },
      {
        seq: 4,
        timestamp: "2026-07-02T10:00:08.000Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId,
          role: "assistant",
          phase: "end",
          parts: [{ partId, partType: "thinking", body: "Reading the repo." }],
          surface: "chat",
          origin: "sdk",
        },
      },
    ]);

    // Both boundaries survive, so the call is a measurable 6s rather than a
    // single "last touched" stamp.
    expect(model.messages.get(messageId)).toMatchObject({
      phase: "final",
      startedAt: "2026-07-02T10:00:02.000Z",
      updatedAt: "2026-07-02T10:00:08.000Z",
    });
  });

  it("leaves a message that never opened unstamped rather than inventing a start", () => {
    // A journal cut short, or a bridge that only mints the closing boundary.
    const model = applyAll(createSessionRuntimeModel(), [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:08.000Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId,
          role: "assistant",
          phase: "end",
          parts: [{ partId, partType: "text", body: "Done." }],
          surface: "chat",
          origin: "sdk",
        },
      },
    ]);

    expect(model.messages.get(messageId)?.startedAt).toBeUndefined();
  });

  it("brackets a part with its own start and end stamps, unmoved by streaming deltas", () => {
    let model = createSessionRuntimeModel();

    model = applyAll(model, [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: { type: "run", runId, phase: "start", trigger: "prompt", surface: "hidden", origin: "sdk" },
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:02.000Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId,
          role: "assistant",
          phase: "start",
          surface: "chat",
          origin: "sdk",
        },
      },
      {
        seq: 3,
        timestamp: "2026-07-02T10:00:03.000Z",
        event: {
          type: "message_part",
          runId,
          turnId,
          messageId,
          partId,
          partType: "thinking",
          phase: "start",
          bodyMode: "snapshot",
          body: "",
          surface: "trace",
          origin: "sdk",
        },
      },
      {
        seq: 4,
        timestamp: "2026-07-02T10:00:04.000Z",
        event: {
          type: "message_part",
          runId,
          turnId,
          messageId,
          partId,
          partType: "thinking",
          phase: "update",
          bodyMode: "delta",
          body: "Reading",
          surface: "trace",
          origin: "sdk",
        },
      },
    ]);

    // The CoT clock reads part(start); a delta must never restate it.
    expect(model.messages.get(messageId)?.parts[0]).toMatchObject({
      startedAt: "2026-07-02T10:00:03.000Z",
      done: false,
    });
    expect(model.messages.get(messageId)?.parts[0].endedAt).toBeUndefined();

    model = applyAll(model, [
      {
        seq: 5,
        timestamp: "2026-07-02T10:00:07.000Z",
        event: {
          type: "message_part",
          runId,
          turnId,
          messageId,
          partId,
          partType: "thinking",
          phase: "end",
          bodyMode: "snapshot",
          body: "Reading the repo.",
          surface: "trace",
          origin: "sdk",
        },
      },
      {
        seq: 6,
        timestamp: "2026-07-02T10:00:09.000Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId,
          role: "assistant",
          phase: "end",
          parts: [{ partId, partType: "thinking", body: "Reading the repo." }],
          surface: "chat",
          origin: "sdk",
        },
      },
    ]);

    // The authoritative end snapshot rebuilds the parts; both boundaries have
    // to survive it, or the part's span dies the moment the message closes.
    expect(model.messages.get(messageId)?.parts[0]).toMatchObject({
      startedAt: "2026-07-02T10:00:03.000Z",
      endedAt: "2026-07-02T10:00:07.000Z",
      done: true,
    });
  });

  it("closes a part left open at the message boundary with the message's own end stamp", () => {
    // An aborted run: the streaming part never gets its own part(end), but the
    // message end does close it, so the span is measurable rather than absent.
    const model = applyAll(createSessionRuntimeModel(), [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:02.000Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId,
          role: "assistant",
          phase: "start",
          surface: "chat",
          origin: "sdk",
        },
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:03.000Z",
        event: {
          type: "message_part",
          runId,
          turnId,
          messageId,
          partId,
          partType: "text",
          phase: "update",
          bodyMode: "delta",
          body: "Working on it",
          surface: "chat",
          origin: "sdk",
        },
      },
      {
        seq: 3,
        timestamp: "2026-07-02T10:00:06.000Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId,
          role: "assistant",
          phase: "end",
          parts: [{ partId, partType: "text", body: "Working on it" }],
          surface: "chat",
          origin: "sdk",
        },
      },
    ]);

    expect(model.messages.get(messageId)?.parts[0]).toMatchObject({
      endedAt: "2026-07-02T10:00:06.000Z",
    });
    // No part(start) arrived, so the opening stamp stays absent rather than
    // being guessed from the first delta.
    expect(model.messages.get(messageId)?.parts[0].startedAt).toBeUndefined();
  });

  it("keeps Session Status owned by run events: a retrying status never completes the session", () => {
    let model = createSessionRuntimeModel();

    model = applyAll(model, [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: { type: "run", runId, phase: "start", trigger: "prompt", surface: "hidden", origin: "sdk" },
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:02.000Z",
        event: {
          type: "status",
          runId,
          code: "retrying",
          body: "stream disconnected",
          surface: "trace",
          origin: "sdk",
        },
      },
    ]);

    expect(sessionStatusFromRuntimeModel(model)).toBe("running");
    expect(model.statuses).toEqual([
      {
        code: "retrying",
        body: "stream disconnected",
        runId,
        at: "2026-07-02T10:00:02.000Z",
      },
    ]);
    expect(model.order).toEqual([{ kind: "status", id: "status-2", seq: 2 }]);
  });

  it("merges the announced tool_call part with tool execution: validated args win, result comes from execution", () => {
    let model = createSessionRuntimeModel();

    model = applyAll(model, [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: { type: "run", runId, phase: "start", trigger: "prompt", surface: "hidden", origin: "sdk" },
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:02.000Z",
        event: {
          type: "message_part",
          runId,
          turnId,
          messageId,
          partId,
          partType: "tool_call",
          phase: "end",
          bodyMode: "snapshot",
          body: '{"path":"a.ts"}',
          toolCallId: "call-1",
          surface: "trace",
          origin: "sdk",
        },
      },
    ]);

    expect(model.tools.get("call-1")).toMatchObject({
      toolCallId: "call-1",
      phase: "announced",
      argsText: '{"path":"a.ts"}',
    });

    model = applyAll(model, [
      {
        seq: 3,
        timestamp: "2026-07-02T10:00:03.000Z",
        event: {
          type: "tool",
          runId,
          turnId,
          toolCallId: "call-1",
          phase: "start",
          name: "read_file",
          args: { path: "a.ts", validated: true },
          surface: "trace",
          origin: "sdk",
        },
      },
      {
        seq: 4,
        timestamp: "2026-07-02T10:00:04.000Z",
        event: {
          type: "tool",
          runId,
          turnId,
          toolCallId: "call-1",
          phase: "end",
          name: "read_file",
          result: { ok: true },
          isError: false,
          surface: "trace",
          origin: "sdk",
        },
      },
    ]);

    expect(model.tools.get("call-1")).toMatchObject({
      toolCallId: "call-1",
      phase: "done",
      name: "read_file",
      argsText: '{"path":"a.ts"}',
      args: { path: "a.ts", validated: true },
      result: { ok: true },
      isError: false,
      // Execution timing: startedAt pinned at phase start, kept through end.
      startedAt: "2026-07-02T10:00:03.000Z",
      updatedAt: "2026-07-02T10:00:04.000Z",
    });
    expect(model.order).toEqual([
      { kind: "message", id: messageId, seq: 2 },
      { kind: "tool", id: "call-1", seq: 2 },
    ]);
  });

  it("keeps the tool name from the opening tool_call part across the message end snapshot", () => {
    let model = createSessionRuntimeModel();

    model = applyAll(model, [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: { type: "run", runId, phase: "start", trigger: "prompt", surface: "hidden", origin: "sdk" },
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:02.000Z",
        event: {
          type: "message_part",
          runId,
          turnId,
          messageId,
          partId,
          partType: "tool_call",
          phase: "start",
          bodyMode: "snapshot",
          body: "",
          toolName: "read_file",
          surface: "trace",
          origin: "sdk",
        },
      },
    ]);

    expect(model.messages.get(messageId)?.parts).toMatchObject([
      { partId, partType: "tool_call", name: "read_file" },
    ]);

    // The end snapshot restates content, not identity: dropping the name here
    // would blank the live label the moment the arguments finish streaming.
    model = applyAll(model, [
      {
        seq: 3,
        timestamp: "2026-07-02T10:00:03.000Z",
        event: {
          type: "message",
          runId,
          turnId,
          messageId,
          role: "assistant",
          phase: "end",
          parts: [
            {
              partId,
              partType: "tool_call",
              body: '{"path":"a.ts"}',
              toolCallId: "call-1",
            },
          ],
          surface: "chat",
          origin: "sdk",
        },
      },
    ]);

    expect(model.messages.get(messageId)?.parts).toMatchObject([
      { partId, partType: "tool_call", toolCallId: "call-1", name: "read_file" },
    ]);
  });

  it("takes the tool name from the closing tool_call part when the opening one had none", () => {
    let model = createSessionRuntimeModel();

    // Some providers only name the call once its block is parsed, so the name
    // can first arrive at part(end); the label must fill in rather than stay
    // anonymous for the rest of the run.
    model = applyAll(model, [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: { type: "run", runId, phase: "start", trigger: "prompt", surface: "hidden", origin: "sdk" },
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:02.000Z",
        event: {
          type: "message_part",
          runId,
          turnId,
          messageId,
          partId,
          partType: "tool_call",
          phase: "start",
          bodyMode: "snapshot",
          body: "",
          surface: "trace",
          origin: "sdk",
        },
      },
      {
        seq: 3,
        timestamp: "2026-07-02T10:00:03.000Z",
        event: {
          type: "message_part",
          runId,
          turnId,
          messageId,
          partId,
          partType: "tool_call",
          phase: "end",
          bodyMode: "snapshot",
          body: '{"path":"a.ts"}',
          toolCallId: "call-1",
          toolName: "read_file",
          surface: "trace",
          origin: "sdk",
        },
      },
    ]);

    expect(model.messages.get(messageId)?.parts).toMatchObject([
      { partId, partType: "tool_call", toolCallId: "call-1", name: "read_file" },
    ]);
  });

  it("fails the session on a run error even when a later run end reports completed", () => {
    let model = createSessionRuntimeModel();

    model = applyAll(model, [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: { type: "run", runId, phase: "start", trigger: "prompt", surface: "hidden", origin: "sdk" },
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:02.000Z",
        event: {
          type: "error",
          runId,
          code: "run_error",
          body: "model overloaded",
          surface: "chat",
          origin: "sdk",
        },
      },
      {
        seq: 3,
        timestamp: "2026-07-02T10:00:03.000Z",
        event: {
          type: "run",
          runId,
          phase: "end",
          trigger: "prompt",
          outcome: "failed",
          surface: "hidden",
          origin: "sdk",
        },
      },
    ]);

    expect(sessionStatusFromRuntimeModel(model)).toBe("failed");
    expect(model.errors).toEqual([
      {
        code: "run_error",
        body: "model overloaded",
        runId,
        at: "2026-07-02T10:00:02.000Z",
      },
    ]);
  });

  it("keeps a successful run successful when an extension reports a nonfatal error", () => {
    const model = applyAll(createSessionRuntimeModel(), [
      { seq: 1, timestamp: "2026-09-05T00:00:00.000Z", event: { type: "run", runId, phase: "start", trigger: "prompt", surface: "hidden", origin: "sdk" } },
      { seq: 2, timestamp: "2026-09-05T00:00:01.000Z", event: { type: "error", code: "extension_error", body: "extension failed", fatal: false, surface: "chat", origin: "sdk" } },
      { seq: 3, timestamp: "2026-09-05T00:00:02.000Z", event: { type: "run", runId, phase: "end", trigger: "prompt", outcome: "completed", surface: "hidden", origin: "sdk" } },
    ]);
    expect(sessionStatusFromRuntimeModel(model)).toBe("completed");
    expect(model.errors).toEqual([expect.objectContaining({ body: "extension failed", fatal: false })]);
  });

  it("mirrors Gateway-minted legacy chat events without advancing the agent seq watermark", () => {
    let model = createSessionRuntimeModel();

    // The user echo is minted at command accept, before the run starts.
    model = addLegacyChatEventToModel(model, {
      id: "user-echo-1",
      kind: "message",
      role: "user",
      body: "Ship the slice",
      messageId: "pi-sdk:pi-session-1:user:0",
      timestamp: "2026-07-02T10:00:00.500Z",
    });

    expect(model.lastSeq).toBe(0);
    expect(model.messages.get("pi-sdk:pi-session-1:user:0")).toMatchObject({
      role: "user",
      phase: "final",
      parts: [{ partType: "text", body: "Ship the slice" }],
    });

    // The following agent event is not treated as a replay.
    model = applyAgentRuntimeEvent(model, {
      seq: 1,
      timestamp: "2026-07-02T10:00:01.000Z",
      event: { type: "run", runId, phase: "start", trigger: "prompt", surface: "hidden", origin: "sdk" },
    });

    expect(model.runs.get(runId)).toBeDefined();
    // The mirrored user message orders before the run's first agent event.
    expect(model.order.map((entry) => entry.id)).toEqual([
      "pi-sdk:pi-session-1:user:0",
    ]);
    expect(model.order[0]?.seq).toBeLessThan(1);

    // A steer control echo mid-run keeps its control label and lands after
    // the latest agent event.
    model = addLegacyChatEventToModel(model, {
      id: "steer-echo-1",
      kind: "control",
      role: "user",
      title: "Steer",
      body: "Focus on tests",
      timestamp: "2026-07-02T10:00:02.000Z",
    });

    expect(model.messages.get("steer-echo-1")).toMatchObject({
      role: "user",
      controlLabel: "Steer",
      parts: [{ partType: "text", body: "Focus on tests" }],
    });
    expect(model.order.map((entry) => entry.id)).toEqual([
      "pi-sdk:pi-session-1:user:0",
      "steer-echo-1",
    ]);
    expect(model.order[1]?.seq).toBeGreaterThan(1);

    // Mirroring the same echo twice upserts instead of duplicating.
    const remirrored = addLegacyChatEventToModel(model, {
      id: "steer-echo-1",
      kind: "control",
      role: "user",
      title: "Steer",
      body: "Focus on tests",
      timestamp: "2026-07-02T10:00:02.000Z",
    });

    expect(remirrored.order).toHaveLength(2);
  });

  it("mirrors image parts from a Gateway-minted user echo", () => {
    const model = addLegacyChatEventToModel(createSessionRuntimeModel(), {
      id: "user-echo-image",
      kind: "message",
      role: "user",
      body: "Look at this",
      messageId: "pi-sdk:pi-session-1:user:1",
      timestamp: "2026-07-02T10:00:00.600Z",
      images: [{ mimeType: "image/png", data: "abc", name: "shot.png" }],
    });

    expect(model.messages.get("pi-sdk:pi-session-1:user:1")).toMatchObject({
      role: "user",
      parts: [
        { partType: "text", body: "Look at this" },
        {
          partType: "image",
          body: "data:image/png;base64,abc",
          done: true,
          name: "shot.png",
        },
      ],
    });
  });

  it("keeps distinct user turns when synthetic user:0 is reused with a new piEntryId (DF-008)", () => {
    let model = createSessionRuntimeModel();

    model = addLegacyChatEventToModel(model, {
      id: "user-1",
      kind: "message",
      role: "user",
      body: "First turn",
      messageId: "pi-sdk:pi-session-1:user:0",
      piEntryId: "entry-a",
      timestamp: "2026-07-30T05:52:27.489Z",
    });
    model = addLegacyChatEventToModel(model, {
      id: "user-3",
      kind: "message",
      role: "user",
      body: "Third turn after resume",
      messageId: "pi-sdk:pi-session-1:user:0",
      piEntryId: "entry-c",
      timestamp: "2026-08-01T10:53:25.679Z",
    });

    expect(model.messages.get("pi-sdk:pi-session-1:user:0")).toMatchObject({
      parts: [{ body: "First turn" }],
      piEntryId: "entry-a",
    });
    expect(model.messages.get("pi-sdk:pi-session-1:user:0#entry-c")).toMatchObject({
      parts: [{ body: "Third turn after resume" }],
      piEntryId: "entry-c",
    });
    expect(model.order.map((entry) => entry.id)).toEqual([
      "pi-sdk:pi-session-1:user:0",
      "pi-sdk:pi-session-1:user:0#entry-c",
    ]);
  });

  it("does not erase a finalized assistant answer when the same messageId is reused empty (DF-008)", () => {
    let model = createSessionRuntimeModel();
    const messageId = `${runId}:turn-1:msg-1`;

    model = applyAgentRuntimeEvent(model, {
      seq: 1,
      timestamp: "2026-07-30T05:52:27.761Z",
      event: {
        type: "message",
        runId,
        turnId: `${runId}:turn-1`,
        messageId,
        role: "assistant",
        phase: "start",
        surface: "chat",
        origin: "sdk",
      },
    });
    model = applyAgentRuntimeEvent(model, {
      seq: 2,
      timestamp: "2026-07-30T05:52:46.094Z",
      event: {
        type: "message",
        runId,
        turnId: `${runId}:turn-1`,
        messageId,
        role: "assistant",
        phase: "end",
        parts: [{ partId: `${messageId}:part-0`, partType: "text", body: "Kakeya answer" }],
        surface: "chat",
        origin: "sdk",
      },
    });
    model = applyAgentRuntimeEvent(model, {
      seq: 3,
      timestamp: "2026-08-01T10:53:25.832Z",
      event: {
        type: "message",
        runId,
        turnId: `${runId}:turn-1`,
        messageId,
        role: "assistant",
        phase: "start",
        surface: "chat",
        origin: "sdk",
      },
    });
    model = applyAgentRuntimeEvent(model, {
      seq: 4,
      timestamp: "2026-08-01T10:53:25.832Z",
      event: {
        type: "message",
        runId,
        turnId: `${runId}:turn-1`,
        messageId,
        role: "assistant",
        phase: "end",
        parts: [],
        surface: "chat",
        origin: "sdk",
      },
    });

    expect(model.messages.get(messageId)).toMatchObject({
      phase: "final",
      parts: [{ body: "Kakeya answer" }],
    });
  });

  it("reports a compaction as running only until its completion status arrives", () => {
    let model = createSessionRuntimeModel();

    expect(isContextCompacting(model)).toBe(false);

    model = applyAll(model, [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:00.000Z",
        event: {
          type: "run",
          runId,
          phase: "start",
          trigger: "prompt",
          surface: "hidden",
          origin: "sdk",
        },
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: {
          type: "status",
          runId,
          code: "compacting",
          surface: "trace",
          origin: "sdk",
        },
      },
    ]);

    expect(isContextCompacting(model)).toBe(true);

    model = applyAll(model, [
      {
        seq: 3,
        timestamp: "2026-07-02T10:00:09.000Z",
        event: {
          type: "status",
          runId,
          code: "compaction_done",
          surface: "trace",
          origin: "sdk",
        },
      },
      {
        seq: 4,
        timestamp: "2026-07-02T10:00:10.000Z",
        event: {
          type: "status",
          runId,
          code: "retrying",
          surface: "trace",
          origin: "sdk",
        },
      },
    ]);

    expect(isContextCompacting(model)).toBe(false);
  });

  it("treats an interrupted compaction as finished, live and on replay", () => {
    const startCompaction = [
      {
        seq: 1,
        timestamp: "2026-07-02T10:00:00.000Z",
        event: {
          type: "run",
          runId,
          phase: "start",
          trigger: "prompt",
          surface: "hidden",
          origin: "sdk",
        } satisfies AgentRuntimeEvent,
      },
      {
        seq: 2,
        timestamp: "2026-07-02T10:00:01.000Z",
        event: {
          type: "status",
          runId,
          code: "compacting",
          surface: "trace",
          origin: "sdk",
        } satisfies AgentRuntimeEvent,
      },
    ];

    // The Gateway closes the compaction explicitly when the run is aborted.
    expect(
      isContextCompacting(
        applyAll(createSessionRuntimeModel(), [
          ...startCompaction,
          {
            seq: 3,
            timestamp: "2026-07-02T10:00:04.000Z",
            event: {
              type: "status",
              runId,
              code: "compaction_aborted",
              surface: "trace",
              origin: "sdk",
            },
          },
        ]),
      ),
    ).toBe(false);

    // Replaying a journal that was cut off mid-compaction (the process died
    // before any closing status) must not strand the session in Compacting.
    expect(
      isContextCompacting(
        applyAll(createSessionRuntimeModel(), [
          ...startCompaction,
          {
            seq: 3,
            timestamp: "2026-07-02T10:00:04.000Z",
            event: {
              type: "run",
              runId,
              phase: "end",
              trigger: "prompt",
              outcome: "aborted",
              surface: "hidden",
              origin: "sdk",
            },
          },
        ]),
      ),
    ).toBe(false);
  });

  it("ignores replayed events at or below the last applied seq", () => {
    let model = createSessionRuntimeModel();
    const runStart = {
      seq: 1,
      timestamp: "2026-07-02T10:00:01.000Z",
      event: {
        type: "run",
        runId,
        phase: "start",
        trigger: "prompt",
        surface: "hidden",
        origin: "sdk",
      } satisfies AgentRuntimeEvent,
    };

    model = applyAgentRuntimeEvent(model, runStart);

    const replayed = applyAgentRuntimeEvent(model, runStart);

    expect(replayed).toBe(model);
  });

  it("indexes hidden subagent records by ownerToolCallId without adding a timeline row", () => {
    let model = createSessionRuntimeModel();
    model = applyAgentRuntimeEvent(model, {
      seq: 1,
      timestamp: "2026-09-15T12:00:00.000Z",
      event: {
        type: "subagent",
        phase: "start",
        surface: "hidden",
        origin: "sdk",
        record: {
          childSessionId: "child-1",
          parentSessionId: "pi-session-1",
          ownerToolCallId: "call-agent",
          state: "started",
          source: "tintinweb",
          createdAt: "2026-09-15T12:00:00.000Z",
          updatedAt: "2026-09-15T12:00:00.000Z",
        },
      },
    });
    model = applyAgentRuntimeEvent(model, {
      seq: 2,
      timestamp: "2026-09-15T12:01:00.000Z",
      event: {
        type: "subagent",
        phase: "end",
        surface: "hidden",
        origin: "sdk",
        record: {
          childSessionId: "child-1",
          parentSessionId: "pi-session-1",
          ownerToolCallId: "call-agent",
          state: "completed",
          source: "tintinweb",
          createdAt: "2026-09-15T12:00:00.000Z",
          updatedAt: "2026-09-15T12:01:00.000Z",
        },
      },
    });

    expect(model.order).toEqual([]);
    expect(model.messages.size).toBe(0);
    expect(model.subagentsByOwnerToolCallId.get("call-agent")?.state).toBe("completed");
    expect(model.subagentsByOwnerToolCallId.get("call-agent")?.childSessionId).toBe("child-1");
  });
});
