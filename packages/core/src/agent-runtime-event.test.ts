import { describe, expect, it } from "vitest";
import { shouldJournalRuntimeEvent, surfaceForMessagePart } from "./agent-runtime-event";

describe("surfaceForMessagePart", () => {
  it("routes text and image parts to chat, thinking and tool calls to trace", () => {
    expect(surfaceForMessagePart("text")).toBe("chat");
    expect(surfaceForMessagePart("image")).toBe("chat");
    expect(surfaceForMessagePart("thinking")).toBe("trace");
    expect(surfaceForMessagePart("tool_call")).toBe("trace");
  });
});


// The Session Event Journal is the physical form of replay: boundary events
// only, never the streaming delta hot path. This predicate is the single
// source of truth for what "boundary" means.
describe("shouldJournalRuntimeEvent", () => {
  it("drops streaming message_part deltas — replay must never re-stream", () => {
    expect(
      shouldJournalRuntimeEvent({
        type: "message_part",
        phase: "update",
        bodyMode: "delta",
        body: "frag",
        origin: "sdk",
      }),
    ).toBe(false);
  });

  it("keeps message_part boundaries — start and end snapshots anchor the timeline", () => {
    expect(
      shouldJournalRuntimeEvent({
        type: "message_part",
        phase: "start",
        bodyMode: "snapshot",
        body: "",
        origin: "sdk",
      }),
    ).toBe(true);
    expect(
      shouldJournalRuntimeEvent({
        type: "message_part",
        phase: "end",
        bodyMode: "snapshot",
        body: "Hello.",
        origin: "sdk",
      }),
    ).toBe(true);
  });

  it("drops cumulative tool updates already covered by the final result", () => {
    // Pi partialResult is cumulative; tool:end already carries the final result.
    expect(shouldJournalRuntimeEvent({ type: "tool", phase: "update", origin: "sdk" })).toBe(false);
  });

  it("keeps agent lifecycle boundaries", () => {
    for (const payload of [
      { type: "message", phase: "end", origin: "sdk" },
      { type: "tool", phase: "start", origin: "sdk" },
      { type: "tool", phase: "end", origin: "sdk" },
      { type: "run", phase: "start", origin: "sdk" },
      { type: "turn", phase: "end", origin: "sdk" },
      { type: "status", code: "retrying", origin: "sdk" },
      { type: "error", code: "run_error", origin: "sdk" },
      { type: "usage", origin: "sdk" },
      { type: "queue", origin: "sdk" },
      { type: "subagent", phase: "start", surface: "hidden", origin: "sdk" },
      { type: "subagent", phase: "update", surface: "hidden", origin: "sdk" },
      { type: "subagent", phase: "end", surface: "hidden", origin: "sdk" },
    ]) {
      expect(shouldJournalRuntimeEvent(payload)).toBe(true);
    }
  });

  it("keeps Gateway-minted legacy chat payloads — user messages live only there", () => {
    expect(
      shouldJournalRuntimeEvent({
        kind: "message",
        role: "user",
        body: "Fix the bug",
      }),
    ).toBe(true);
    expect(
      shouldJournalRuntimeEvent({
        kind: "control",
        role: "user",
        title: "Steer",
        body: "Focus on tests",
      }),
    ).toBe(true);
  });
});
