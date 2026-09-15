import { describe, expect, it } from "vitest";
import type { SessionDetail, SessionSummary, SessionTurn, SubagentRecord } from "@pace/core";
import { indexSubagentRecords } from "@pace/core";
import type { PiEventBus } from "./shim";
import {
  childSessionIdFromSessionFile,
  createTintinwebSubagentShim,
  parseTintinwebAgentResult,
  stateFromFailedPayload,
  usageFromTintinwebPayload,
} from "./tintinweb";

function createMemoryBus(): PiEventBus & { emit(type: string, data: unknown): void } {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(channel, handler) {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler);
      listeners.set(channel, set);
      return () => set.delete(handler);
    },
    emit(type, data) {
      for (const handler of listeners.get(type) ?? []) {
        handler(data);
      }
    },
  };
}

function collect(observe: (onRecord: (record: SubagentRecord, phase: string) => void) => () => void) {
  const emitted: Array<{ record: SubagentRecord; phase: string }> = [];
  const stop = observe((record, phase) => emitted.push({ record, phase }));
  return { emitted, stop };
}

const parentSessionId = "parent-session";

describe("tintinweb payload mapping", () => {
  it("prefers Pi usage over the display-only tokens field", () => {
    expect(
      usageFromTintinwebPayload({
        tokens: "1.2k",
        usage: {
          input: 10,
          output: 4,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 17,
          cost: { total: 0.012 },
        },
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      totalTokens: 17,
      costUsd: 0.012,
    });
  });

  it("maps failed abort/stop to stopped, other failures to failed", () => {
    expect(stateFromFailedPayload({ status: "aborted" })).toBe("stopped");
    expect(stateFromFailedPayload({ status: "stopped" })).toBe("stopped");
    expect(stateFromFailedPayload({ status: "error" })).toBe("failed");
    expect(stateFromFailedPayload({ error: "boom" })).toBe("failed");
  });

  it("parses agent id and sessionFile from Agent tool results", () => {
    expect(
      parseTintinwebAgentResult({
        content: [{ type: "text", text: "Agent started in background.\nAgent ID: ag_1\n" }],
        details: { agentId: "ag_1", status: "background", sessionFile: "/pi/sessions/child-1.jsonl" },
      }),
    ).toEqual({
      sourceAgentId: "ag_1",
      sessionFile: "/pi/sessions/child-1.jsonl",
      status: "background",
    });
  });

  it("resolves childSessionId from a sessionFile basename present in the index", () => {
    expect(
      childSessionIdFromSessionFile("/home/me/.pi/agent/sessions/proj/child-9.jsonl", [
        { id: "child-9" },
      ]),
    ).toBe("child-9");
    expect(childSessionIdFromSessionFile("/tmp/memory-only.jsonl", [{ id: "other" }])).toBe(
      "memory-only",
    );
    expect(childSessionIdFromSessionFile(undefined, [{ id: "child-9" }])).toBe("");
  });
});

describe("tintinweb observe() live mapping", () => {
  it("correlates a foreground Agent tool with started/completed events by toolCallId and plugin id", () => {
    const bus = createMemoryBus();
    const sessionListeners: Array<(event: unknown) => void> = [];
    const shim = createTintinwebSubagentShim({
      events: bus,
      subscribeSession: (listener) => {
        sessionListeners.push(listener);
        return () => {};
      },
      now: () => "2026-09-15T12:00:00.000Z",
      resolveChildSessionId: (file) => (file.endsWith("child-fg.jsonl") ? "child-fg" : undefined),
    });
    const { emitted, stop } = collect((onRecord) =>
      shim.observe({ parentSessionId, onRecord }),
    );

    for (const listener of sessionListeners) {
      listener({
        type: "tool_execution_start",
        toolCallId: "call-fg",
        toolName: "Agent",
        args: { subagent_type: "Explore", prompt: "look", description: "Look around" },
      });
    }
    bus.emit("subagents:started", { id: "ag-fg", type: "Explore", description: "Look around" });
    bus.emit("subagents:completed", {
      id: "ag-fg",
      usage: { input: 3, output: 5, cacheRead: 0, totalTokens: 8, cost: { total: 0.002 } },
      sessionFile: "/pi/sessions/child-fg.jsonl",
    });
    for (const listener of sessionListeners) {
      listener({
        type: "tool_execution_end",
        toolCallId: "call-fg",
        toolName: "Agent",
        result: {
          content: [{ type: "text", text: "done" }],
          details: { agentId: "ag-fg", status: "completed", sessionFile: "/pi/sessions/child-fg.jsonl" },
        },
      });
    }

    expect(emitted.map((entry) => [entry.phase, entry.record.state])).toEqual([
      ["start", "started"],
      ["end", "completed"],
      ["update", "completed"],
    ]);
    expect(emitted[1].record).toMatchObject({
      childSessionId: "child-fg",
      parentSessionId,
      ownerToolCallId: "call-fg",
      sourceAgentId: "ag-fg",
      sessionFile: "/pi/sessions/child-fg.jsonl",
      usage: { inputTokens: 3, outputTokens: 5, cacheReadTokens: 0, totalTokens: 8, costUsd: 0.002 },
      capabilities: { send: true, stop: true },
    });
    stop();
  });

  it("correlates a background spawn: created/started events plus the Agent result id", () => {
    const bus = createMemoryBus();
    const sessionListeners: Array<(event: unknown) => void> = [];
    const shim = createTintinwebSubagentShim({
      events: bus,
      subscribeSession: (listener) => {
        sessionListeners.push(listener);
        return () => {};
      },
      now: () => "2026-09-15T12:00:00.000Z",
    });
    const { emitted, stop } = collect((onRecord) =>
      shim.observe({ parentSessionId, onRecord }),
    );

    for (const listener of sessionListeners) {
      listener({
        type: "tool_execution_start",
        toolCallId: "call-bg",
        toolName: "Agent",
        args: {
          subagent_type: "general-purpose",
          prompt: "work",
          description: "Bg",
          run_in_background: true,
        },
      });
    }
    bus.emit("subagents:created", { id: "ag-bg", type: "general-purpose", description: "Bg", isBackground: true });
    bus.emit("subagents:started", { id: "ag-bg", type: "general-purpose", description: "Bg" });
    for (const listener of sessionListeners) {
      listener({
        type: "tool_execution_end",
        toolCallId: "call-bg",
        toolName: "Agent",
        result: {
          content: [{ type: "text", text: "Agent ID: ag-bg" }],
          details: { agentId: "ag-bg", status: "background" },
        },
      });
    }
    bus.emit("subagents:completed", {
      id: "ag-bg",
      usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.001 } },
      sessionFile: "/pi/sessions/ag-bg.jsonl",
    });

    expect(emitted[0]).toMatchObject({ phase: "start", record: { state: "created", ownerToolCallId: "call-bg" } });
    expect(emitted.some((entry) => entry.record.state === "started" && entry.record.ownerToolCallId === "call-bg")).toBe(
      true,
    );
    const completed = emitted.filter((entry) => entry.record.state === "completed");
    expect(completed[completed.length - 1]?.record).toMatchObject({
      sourceAgentId: "ag-bg",
      ownerToolCallId: "call-bg",
      childSessionId: "ag-bg",
      usage: { totalTokens: 2, costUsd: 0.001 },
    });
    stop();
  });

  it("resumes a settled child back to started as phase update on the new Agent tool call", () => {
    const bus = createMemoryBus();
    const sessionListeners: Array<(event: unknown) => void> = [];
    const shim = createTintinwebSubagentShim({
      events: bus,
      subscribeSession: (listener) => {
        sessionListeners.push(listener);
        return () => {};
      },
      now: () => "2026-09-15T12:00:00.000Z",
    });
    const { emitted, stop } = collect((onRecord) =>
      shim.observe({ parentSessionId, onRecord }),
    );

    for (const listener of sessionListeners) {
      listener({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "Agent",
        args: { subagent_type: "Explore", prompt: "one", description: "First" },
      });
    }
    bus.emit("subagents:started", { id: "ag-1", type: "Explore", description: "First" });
    bus.emit("subagents:completed", { id: "ag-1", sessionFile: "/pi/sessions/child.jsonl" });
    for (const listener of sessionListeners) {
      listener({
        type: "tool_execution_start",
        toolCallId: "call-resume",
        toolName: "Agent",
        args: { resume: "ag-1", prompt: "again" },
      });
    }
    bus.emit("subagents:started", { id: "ag-1", type: "Explore", description: "First" });

    const resume = emitted.filter((entry) => entry.record.ownerToolCallId === "call-resume");
    expect(resume[0]).toMatchObject({
      phase: "update",
      record: { state: "started", sourceAgentId: "ag-1", childSessionId: "child" },
    });
    stop();
  });

  it("maps subagents:failed aborted/stopped to stopped and ignores steered/compacted", () => {
    const bus = createMemoryBus();
    const sessionListeners: Array<(event: unknown) => void> = [];
    const shim = createTintinwebSubagentShim({
      events: bus,
      subscribeSession: (listener) => {
        sessionListeners.push(listener);
        return () => {};
      },
      now: () => "2026-09-15T12:00:00.000Z",
    });
    const { emitted, stop } = collect((onRecord) =>
      shim.observe({ parentSessionId, onRecord }),
    );

    for (const listener of sessionListeners) {
      listener({
        type: "tool_execution_start",
        toolCallId: "call-stop",
        toolName: "Agent",
        args: { subagent_type: "Explore", prompt: "x", description: "Stop me" },
      });
    }
    bus.emit("subagents:started", { id: "ag-stop", type: "Explore", description: "Stop me" });
    bus.emit("subagents:steered", { id: "ag-stop", message: "nudge" });
    bus.emit("subagents:compacted", { id: "ag-stop" });
    bus.emit("subagents:failed", { id: "ag-stop", status: "aborted", error: "aborted" });

    expect(emitted.map((entry) => entry.record.state)).toEqual(["started", "stopped"]);
    expect(emitted[emitted.length - 1]?.phase).toBe("end");
    stop();
  });

  it("does not emit RPC-spawned agents that never gain an ownerToolCallId", () => {
    const bus = createMemoryBus();
    const shim = createTintinwebSubagentShim({
      events: bus,
      now: () => "2026-09-15T12:00:00.000Z",
    });
    const { emitted, stop } = collect((onRecord) =>
      shim.observe({ parentSessionId, onRecord }),
    );
    bus.emit("subagents:created", { id: "rpc-1", type: "Explore", description: "no tool" });
    bus.emit("subagents:started", { id: "rpc-1", type: "Explore", description: "no tool" });
    expect(emitted).toEqual([]);
    stop();
  });
});

function sessionDetail(turns: SessionTurn[]): SessionDetail {
  return {
    id: parentSessionId,
    timestamp: "2026-09-15T12:00:00.000Z",
    project: "demo",
    totalCostUsd: 0,
    totalTokens: 0,
    turnCount: turns.length,
    turns,
  };
}

function summary(id: string): SessionSummary {
  return {
    id,
    timestamp: "2026-09-15T12:00:00.000Z",
    project: "demo",
    title: { kind: "raw", text: id },
    totalCostUsd: 0,
    totalTokens: 0,
    modelBreakdown: [],
    toolCounts: [],
    skillCounts: [],
    presence: "external",
  };
}

describe("tintinweb fromSession() cold mapping", () => {
  it("rebuilds records from parsed parent turns plus the session index", () => {
    const detail = sessionDetail([
      {
        kind: "message",
        role: "user",
        timestamp: "2026-09-15T12:00:01.000Z",
        parts: [{ partType: "text", text: "delegate", payload: {} }],
      },
      {
        kind: "message",
        role: "assistant",
        timestamp: "2026-09-15T12:00:02.000Z",
        parts: [
          {
            partType: "toolCall",
            name: "Agent",
            payload: {
              id: "call-cold",
              arguments: {
                subagent_type: "Explore",
                prompt: "map the repo",
                description: "Explore",
                run_in_background: true,
              },
            },
          },
          {
            partType: "toolResult",
            name: "Agent",
            text: "Agent started in background.\nAgent ID: ag-cold\n",
            payload: {
              toolCallId: "call-cold",
              toolName: "Agent",
              content: [{ type: "text", text: "Agent ID: ag-cold" }],
              details: {
                agentId: "ag-cold",
                status: "background",
                sessionFile: "/home/me/.pi/agent/sessions/demo/child-cold.jsonl",
              },
            },
          },
        ],
      },
    ]);

    const records = createTintinwebSubagentShim().fromSession!(detail, [summary("child-cold")]);
    expect(records).toEqual([
      expect.objectContaining({
        childSessionId: "child-cold",
        parentSessionId,
        ownerToolCallId: "call-cold",
        sourceAgentId: "ag-cold",
        state: "started",
        source: "tintinweb",
        sessionFile: "/home/me/.pi/agent/sessions/demo/child-cold.jsonl",
        capabilities: { send: true, stop: true },
      }),
    ]);
  });

  it("joins a foreground Agent result that settled inline", () => {
    const detail = sessionDetail([
      {
        kind: "message",
        role: "assistant",
        timestamp: "2026-09-15T12:00:02.000Z",
        parts: [
          {
            partType: "toolCall",
            name: "Agent",
            payload: {
              id: "call-fg",
              arguments: { subagent_type: "Plan", prompt: "plan", description: "Plan" },
            },
          },
          {
            partType: "toolResult",
            name: "Agent",
            text: "the plan",
            payload: {
              toolCallId: "call-fg",
              details: {
                agentId: "ag-fg",
                status: "completed",
                sessionFile: "/sessions/child-fg.jsonl",
                usage: { input: 8, output: 2, totalTokens: 10, cost: { total: 0.01 } },
              },
            },
          },
        ],
      },
    ]);

    const [record] = createTintinwebSubagentShim().fromSession!(detail, [summary("child-fg")]);
    expect(record).toMatchObject({
      ownerToolCallId: "call-fg",
      sourceAgentId: "ag-fg",
      state: "completed",
      childSessionId: "child-fg",
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10, costUsd: 0.01 },
    });
  });

  it("leaves childSessionId empty when the child JSONL is not in the index and has no sessionFile", () => {
    const detail = sessionDetail([
      {
        kind: "message",
        role: "assistant",
        timestamp: "2026-09-15T12:00:02.000Z",
        parts: [
          {
            partType: "toolCall",
            name: "Agent",
            payload: { id: "call-mem", arguments: { subagent_type: "Explore", prompt: "x", description: "mem" } },
          },
          {
            partType: "toolResult",
            name: "Agent",
            text: "Agent ID: ag-mem",
            payload: { toolCallId: "call-mem", details: { agentId: "ag-mem", status: "background" } },
          },
        ],
      },
    ]);

    const [record] = createTintinwebSubagentShim().fromSession!(detail, [summary("unrelated")]);
    expect(record).toMatchObject({
      ownerToolCallId: "call-mem",
      sourceAgentId: "ag-mem",
      childSessionId: "",
    });
  });

  it("points spawn and resume Agent tool calls at the latest record", () => {
    const detail = sessionDetail([
      {
        kind: "message",
        role: "assistant",
        timestamp: "2026-09-15T12:00:02.000Z",
        parts: [
          {
            partType: "toolCall",
            name: "Agent",
            payload: {
              id: "call-1",
              arguments: { subagent_type: "Explore", prompt: "first", description: "First" },
            },
          },
          {
            partType: "toolResult",
            name: "Agent",
            text: "done",
            payload: {
              toolCallId: "call-1",
              details: {
                agentId: "ag-1",
                status: "completed",
                sessionFile: "/sessions/child.jsonl",
              },
            },
          },
        ],
      },
      {
        kind: "message",
        role: "assistant",
        timestamp: "2026-09-15T12:05:00.000Z",
        parts: [
          {
            partType: "toolCall",
            name: "Agent",
            payload: {
              id: "call-resume",
              arguments: { resume: "ag-1", prompt: "again" },
            },
          },
          {
            partType: "toolResult",
            name: "Agent",
            text: "resumed",
            payload: {
              toolCallId: "call-resume",
              details: { agentId: "ag-1", status: "background", sessionFile: "/sessions/child.jsonl" },
            },
          },
        ],
      },
    ]);

    const records = createTintinwebSubagentShim().fromSession!(detail, [summary("child")]);
    const lookup = indexSubagentRecords(records);
    expect(lookup.get("call-1")?.state).toBe("started");
    expect(lookup.get("call-resume")?.state).toBe("started");
    expect(lookup.get("call-1")?.childSessionId).toBe("child");
    expect(lookup.get("call-resume")?.sourceAgentId).toBe("ag-1");
  });
});
