import { describe, expect, it, vi } from "vitest";
import {
  createPublicPiSdkRuntimeForker,
  createPublicPiSdkRuntimeFactory,
  createPublicPiSdkRuntimeResumer,
} from "./pi-sdk-runtime-adapter";

describe("Pi SDK public runtime adapter", () => {
  it("rejects new prompts while closing and permits retry after cancellation failed", async () => {
    let fail!: (error: Error) => void;
    const cancellation = new Promise<void>((_, reject) => { fail = reject; });
    const abort = vi.fn().mockImplementationOnce(() => cancellation).mockResolvedValue(undefined);
    const session = { sessionId: "root", isStreaming: false, messages: [], prompt: vi.fn(async () => {}),
      abort, dispose: vi.fn(), subscribe: () => () => {}, extensionRunner: { emit: vi.fn(async () => {}) } };
    const runtime = await createPublicPiSdkRuntimeFactory({ sdk: { createAgentSession: async () => ({ session }) } })({ sessionId: "app", projectId: "p", cwd: "/repo" });
    const closing = runtime.dispose!();
    const rejected = expect(closing).rejects.toThrow("still running");
    fail(new Error("still running"));
    await rejected;
    expect(session.dispose).not.toHaveBeenCalled();
    const retry = runtime.dispose!();
    await expect(runtime.sendPrompt("late work")).rejects.toThrow("closing");
    await retry;
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(2);
  });

  it("preserves Pi's session totals, including usage reported by tools", async () => {
    const session = { sessionId: "root", isStreaming: false, messages: [],
      prompt: async () => {}, abort: async () => {}, dispose() {}, subscribe: () => () => {},
      getSessionStats: () => ({ tokens: { total: 999 }, cost: 9 }),
      sessionManager: { getEntries: () => [
        { type: "message", message: { role: "assistant", usage: { totalTokens: 20, cost: { total: 0.2 } } } },
        { type: "message", message: { role: "toolResult", usage: { totalTokens: 900, cost: { total: 8 } } } },
        { type: "compaction" },
        { type: "message", message: { role: "assistant", usage: { totalTokens: 30, cost: { total: 0.3 } } } },
      ] } };
    const runtime = await createPublicPiSdkRuntimeFactory({ sdk: { createAgentSession: async () => ({ session }) } })({ sessionId: "app", projectId: "p", cwd: "/repo" });
    expect((await runtime.getSnapshot?.())?.summary).toMatchObject({ totalTokens: 999, totalCostUsd: 9 });
    await runtime.dispose?.();
  });

  it("delivers shutdown once and waits for extensions before disposing the SDK session", async () => {
    const order: string[] = [];
    let release!: () => void;
    const shutdown = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const session = { sessionId: "parent", isStreaming: false, messages: [],
      prompt: async () => {}, abort: async () => {}, subscribe: () => () => {},
      extensionRunner: { async emit() { order.push("shutdown"); entered(); await shutdown; } },
      dispose() { order.push("dispose"); } };
    const runtime = await createPublicPiSdkRuntimeFactory({ sdk: { createAgentSession: async () => ({ session }) } })({ sessionId: "app", projectId: "/repo", cwd: "/repo" });
    const closing = runtime.dispose!();
    await started;
    expect(order).toEqual(["shutdown"]);
    const again = runtime.dispose!();
    release();
    await Promise.all([closing, again]);
    expect(order).toEqual(["shutdown", "dispose"]);
  });

  it("forwards plugin naming events and exposes the persisted Pi name", async () => {
    let emit: (event: unknown) => void = () => {};
    const session = {
      sessionId: "pi-named", sessionName: "Existing name", isStreaming: false, messages: [],
      prompt: vi.fn(async () => {}), abort: vi.fn(async () => {}), dispose: vi.fn(),
      subscribe(listener: (event: unknown) => void) { emit = listener; return vi.fn(); },
    };
    const runtime = await createPublicPiSdkRuntimeFactory({ sdk: { createAgentSession: async () => ({ session }) } })({ sessionId: "app-named", projectId: "p", cwd: "/repo" });
    expect(runtime).toMatchObject({ sessionName: "Existing name" });
    const events: unknown[] = [];
    runtime.onEvent?.(event => events.push(event));
    session.sessionName = "Plugin title";
    emit({ type: "session_info_changed", name: "Plugin title" });
    expect(events).toContainEqual(expect.objectContaining({ type: "session_info_changed", payload: expect.objectContaining({ name: "Plugin title" }) }));
    await expect(runtime.getSnapshot?.()).resolves.toMatchObject({ sessionName: "Plugin title" });
    emit({ type: "session_info_changed", name: undefined });
    expect(events).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ name: "" }) }));
    runtime.dispose?.();
  });

  it("adapts a public SDK AgentSession to the PiRuntimeDriver runtime contract", async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const prompt = vi.fn(async () => {});
    const session = {
      sessionId: "sdk-session-1",
      isStreaming: false,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "PACE_SDK_SPIKE_OK" }],
        },
      ],
      prompt,
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe(listener: (event: unknown) => void) {
        listeners.push(listener);

        return vi.fn();
      },
    };
    const createAgentSession = vi.fn(async () => ({ session }));
    const runtimeFactory = createPublicPiSdkRuntimeFactory({
      sdk: { createAgentSession },
      now: () => "2026-07-01T00:00:00.000Z",
    });

    const runtime = await runtimeFactory({
      sessionId: "app-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });

    await runtime.sendPrompt("Reply with exactly: PACE_SDK_SPIKE_OK");

    await expect(runtime.getSnapshot?.()).resolves.toMatchObject({
      status: "completed",
    });
    runtime.dispose?.();
    expect(runtime.piSessionId).toBe("sdk-session-1");
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/Users/void/code/opensource/Pig",
      }),
    );
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.not.objectContaining({
        noTools: expect.anything(),
      }),
    );
    expect(prompt).toHaveBeenCalledWith("Reply with exactly: PACE_SDK_SPIKE_OK");
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("opens a persisted SessionManager path when resuming a cold SDK session", async () => {
    const sessionManager = {
      getCwd: vi.fn(() => "/Users/void/code/opensource/Pig"),
      getSessionFile: vi.fn(
        () => "/Users/void/.pi/agent/sessions/pig/pi-session-resumed.jsonl",
      ),
      getLeafId: vi.fn(() => "entry-resumed-leaf"),
    };
    const session = {
      sessionId: "pi-session-resumed",
      isStreaming: false,
      messages: [],
      sessionManager,
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const createAgentSession = vi.fn(async () => ({ session }));
    const open = vi.fn(() => sessionManager);
    const runtimeResumer = createPublicPiSdkRuntimeResumer({
      sdk: {
        createAgentSession,
        SessionManager: {
          open,
        },
      },
      now: () => "2026-07-03T12:00:00.000Z",
    });

    const runtime = await runtimeResumer({
      sessionId: "app-session-resumed",
      projectId: "pig",
      piSessionId: "pi-session-resumed",
      cwd: "/fallback/cwd",
      sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-resumed.jsonl",
    });

    expect(open).toHaveBeenCalledWith(
      "/Users/void/.pi/agent/sessions/pig/pi-session-resumed.jsonl",
    );
    expect(createAgentSession).toHaveBeenCalledWith({
      cwd: "/Users/void/code/opensource/Pig",
      sessionManager,
    });
    expect(runtime.piSessionId).toBe("pi-session-resumed");
    expect(runtime.sessionFile).toBe(
      "/Users/void/.pi/agent/sessions/pig/pi-session-resumed.jsonl",
    );
    expect(runtime.seedPromptCount).toBe(0);
  });

  it("seeds prompt/run high-water from prior user messages on resume (DF-008)", async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const sessionManager = {
      getCwd: vi.fn(() => "/Users/void/code/opensource/Pig"),
      getSessionFile: vi.fn(
        () => "/Users/void/.pi/agent/sessions/pig/pi-session-resumed.jsonl",
      ),
    };
    const session = {
      sessionId: "pi-session-resumed",
      isStreaming: false,
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer 1" },
        { role: "user", content: "second" },
        { role: "assistant", content: "answer 2" },
      ],
      sessionManager,
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        listeners.push(listener);
        return vi.fn();
      }),
    };
    const runtimeResumer = createPublicPiSdkRuntimeResumer({
      sdk: {
        createAgentSession: vi.fn(async () => ({ session })),
        SessionManager: {
          open: vi.fn(() => sessionManager),
        },
      },
    });

    const runtime = await runtimeResumer({
      sessionId: "app-session-resumed",
      projectId: "pig",
      piSessionId: "pi-session-resumed",
      cwd: "/fallback/cwd",
      sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-resumed.jsonl",
    });

    expect(runtime.seedPromptCount).toBe(2);

    const events: Array<{ payload?: { runId?: string } }> = [];
    runtime.onEvent?.((event) => {
      events.push(event as { payload?: { runId?: string } });
    });

    listeners[0]?.({ type: "agent_start" });

    expect(events).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          type: "run",
          runId: "pi-session-resumed:run-3",
          phase: "start",
        }),
      }),
    ]);
  });

  it("exposes the SDK SessionManager leaf id for user message identity", async () => {
    const sessionManager = {
      getSessionFile: vi.fn(() => "/Users/void/.pi/session.jsonl"),
      getLeafId: vi.fn(() => "pi-entry-user-1"),
    };
    const session = {
      sessionId: "sdk-session-1",
      isStreaming: false,
      messages: [],
      sessionManager,
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const runtimeFactory = createPublicPiSdkRuntimeFactory({
      sdk: { createAgentSession: vi.fn(async () => ({ session })) },
    });

    const runtime = await runtimeFactory({
      sessionId: "app-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });

    expect(runtime.getLeafId?.()).toBe("pi-entry-user-1");
    expect(sessionManager.getLeafId).toHaveBeenCalledTimes(1);
  });

  it("resolves user message boundaries after the SDK appends the user entry", async () => {
    const listeners: Array<(event: unknown) => void> = [];
    let leafId: string | null = "pi-entry-before-prompt";
    const sessionManager = {
      getSessionFile: vi.fn(() => "/Users/void/.pi/session.jsonl"),
      getLeafId: vi.fn(() => leafId),
      getEntry: vi.fn((entryId: string) =>
        entryId === "pi-entry-user-1"
          ? {
              type: "message",
              id: "pi-entry-user-1",
              parentId: "pi-entry-before-user-1",
              message: { role: "user", content: "Build through SDK" },
            }
          : undefined,
      ),
    };
    const session = {
      sessionId: "sdk-session-1",
      isStreaming: false,
      messages: [],
      sessionManager,
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe(listener: (event: unknown) => void) {
        listeners.push(listener);

        return vi.fn();
      },
    };
    const runtimeFactory = createPublicPiSdkRuntimeFactory({
      sdk: { createAgentSession: vi.fn(async () => ({ session })) },
    });
    const runtime = await runtimeFactory({
      sessionId: "app-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });
    runtime.onEvent?.(() => {});
    const boundary = runtime.waitForNextUserMessageBoundary?.();

    leafId = "pi-entry-user-1";
    listeners[0]?.({
      type: "message_end",
      message: { role: "user", content: "Build through SDK" },
    });

    await expect(boundary).resolves.toEqual({
      piEntryId: "pi-entry-user-1",
    });
    expect(sessionManager.getLeafId).toHaveBeenCalledTimes(1);
    expect(sessionManager.getEntry).toHaveBeenCalledWith("pi-entry-user-1");
  });

  it("creates a forked SDK runtime from a user message entry id", async () => {
    const sessionManager = {
      getCwd: vi.fn(() => "/Users/void/code/opensource/Pig"),
      getSessionFile: vi.fn(
        () => "/Users/void/.pi/agent/sessions/pig/pi-session-forked.jsonl",
      ),
      getEntry: vi.fn((entryId: string) =>
        entryId === "pi-entry-user-2"
          ? {
              id: "pi-entry-user-2",
              parentId: "pi-entry-before-user-2",
              type: "message",
              message: {
                role: "user",
                content: "Revise this branch",
              },
            }
          : undefined,
      ),
      createBranchedSession: vi.fn(
        () => "/Users/void/.pi/agent/sessions/pig/pi-session-forked.jsonl",
      ),
    };
    const session = {
      sessionId: "pi-session-forked",
      isStreaming: false,
      messages: [],
      sessionManager,
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const createAgentSession = vi.fn(async () => ({ session }));
    const open = vi.fn(() => sessionManager);
    const runtimeForker = createPublicPiSdkRuntimeForker({
      sdk: {
        createAgentSession,
        SessionManager: {
          open,
        },
      },
      now: () => "2026-07-03T12:00:00.000Z",
    });

    const result = await runtimeForker({
      sessionId: "app-session-forked",
      projectId: "pig",
      sourcePiSessionId: "pi-session-source",
      sourceSessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-source.jsonl",
      piEntryId: "pi-entry-user-2",
      cwd: "/fallback/cwd",
    });

    expect(open).toHaveBeenCalledWith(
      "/Users/void/.pi/agent/sessions/pig/pi-session-source.jsonl",
    );
    expect(sessionManager.createBranchedSession).toHaveBeenCalledWith(
      "pi-entry-before-user-2",
    );
    expect(createAgentSession).toHaveBeenCalledWith({
      cwd: "/Users/void/code/opensource/Pig",
      sessionManager,
    });
    expect(result.selectedText).toBe("Revise this branch");
    expect(result.runtime.piSessionId).toBe("pi-session-forked");
    expect(result.runtime.sessionFile).toBe(
      "/Users/void/.pi/agent/sessions/pig/pi-session-forked.jsonl",
    );
  });

  it("emits Agent Runtime Event Model payloads from the SDK subscription with prompt trigger attribution", async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const session = {
      sessionId: "sdk-session-1",
      isStreaming: false,
      messages: [],
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe(listener: (event: unknown) => void) {
        listeners.push(listener);

        return vi.fn();
      },
    };
    const runtimeFactory = createPublicPiSdkRuntimeFactory({
      sdk: { createAgentSession: vi.fn(async () => ({ session })) },
      now: () => "2026-07-01T00:00:00.000Z",
    });
    const runtime = await runtimeFactory({
      sessionId: "app-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });
    const events: unknown[] = [];

    runtime.onEvent?.((event) => events.push(event));
    await runtime.sendPrompt("Go");

    const streamingMessage = { role: "assistant", content: [] };
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hi" }],
      stopReason: "stop",
    };

    for (const rawEvent of [
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_start", message: streamingMessage },
      {
        type: "message_update",
        message: streamingMessage,
        assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: streamingMessage },
      },
      {
        type: "message_update",
        message: streamingMessage,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi", partial: streamingMessage },
      },
      {
        type: "message_update",
        message: streamingMessage,
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hi", partial: streamingMessage },
      },
      { type: "message_end", message: finalMessage },
      { type: "turn_end", message: finalMessage, toolResults: [] },
      { type: "agent_end", messages: [finalMessage] },
    ]) {
      listeners[0]?.(rawEvent);
    }

    const runId = "sdk-session-1:run-1";
    const turnId = `${runId}:turn-1`;
    const messageId = `${turnId}:msg-1`;
    const partId = `${messageId}:part-0`;
    const base = { runId, turnId, messageId, partId };

    expect(events).toEqual([
      {
        piSessionId: "sdk-session-1",
        type: "run",
        payload: { type: "run", runId, phase: "start", trigger: "prompt", surface: "hidden", origin: "sdk" },
      },
      {
        piSessionId: "sdk-session-1",
        turnId,
        type: "turn",
        payload: { type: "turn", runId, turnId, phase: "start", surface: "hidden", origin: "sdk" },
      },
      {
        piSessionId: "sdk-session-1",
        turnId,
        type: "message",
        payload: {
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
        piSessionId: "sdk-session-1",
        turnId,
        type: "message_part",
        payload: {
          type: "message_part",
          ...base,
          partType: "text",
          phase: "start",
          bodyMode: "snapshot",
          body: "",
          surface: "chat",
          origin: "sdk",
        },
      },
      {
        piSessionId: "sdk-session-1",
        turnId,
        type: "message_part",
        payload: {
          type: "message_part",
          ...base,
          partType: "text",
          phase: "update",
          bodyMode: "delta",
          body: "Hi",
          surface: "chat",
          origin: "sdk",
        },
      },
      {
        piSessionId: "sdk-session-1",
        turnId,
        type: "message_part",
        payload: {
          type: "message_part",
          ...base,
          partType: "text",
          phase: "end",
          bodyMode: "snapshot",
          body: "Hi",
          surface: "chat",
          origin: "sdk",
        },
      },
      {
        piSessionId: "sdk-session-1",
        turnId,
        type: "message",
        payload: {
          type: "message",
          runId,
          turnId,
          messageId,
          role: "assistant",
          phase: "end",
          parts: [{ partId, partType: "text", body: "Hi" }],
          surface: "chat",
          origin: "sdk",
        },
      },
      {
        piSessionId: "sdk-session-1",
        turnId,
        type: "turn",
        payload: { type: "turn", runId, turnId, phase: "end", surface: "hidden", origin: "sdk" },
      },
      {
        piSessionId: "sdk-session-1",
        type: "run",
        payload: {
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
  });

  it("attributes the Active Run started by a queued follow-up to the follow_up trigger", async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const session = {
      sessionId: "sdk-session-1",
      isStreaming: false,
      messages: [],
      prompt: vi.fn(async () => {}),
      followUp: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe(listener: (event: unknown) => void) {
        listeners.push(listener);

        return vi.fn();
      },
    };
    const runtimeFactory = createPublicPiSdkRuntimeFactory({
      sdk: { createAgentSession: vi.fn(async () => ({ session })) },
      now: () => "2026-07-01T00:00:00.000Z",
    });
    const runtime = await runtimeFactory({
      sessionId: "app-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });
    const events: Array<{ payload?: Record<string, unknown> }> = [];

    runtime.onEvent?.((event) => events.push(event as { payload?: Record<string, unknown> }));
    await runtime.queueFollowUp?.("And then?");
    listeners[0]?.({ type: "agent_start" });

    expect(events).toEqual([
      {
        piSessionId: "sdk-session-1",
        type: "run",
        payload: {
          type: "run",
          runId: "sdk-session-1:run-1",
          phase: "start",
          trigger: "follow_up",
          surface: "hidden",
          origin: "sdk",
        },
      },
    ]);
  });

  it("maps public SDK queue, steer, stop, and usage stats into runtime semantics", async () => {
    const session = {
      sessionId: "sdk-session-1",
      isStreaming: false,
      messages: [],
      model: {
        provider: {
          id: "anthropic",
        },
        id: "claude-opus-4-5",
      },
      thinkingLevel: "high",
      prompt: vi.fn(async () => {}),
      followUp: vi.fn(async () => {}),
      steer: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      clearQueue: vi.fn(() => ({
        steering: ["keep steering"],
        followUp: ["Queued follow-up", "Keep follow-up"],
      })),
      getSessionStats: vi.fn(() => ({
        sessionId: "sdk-session-1",
        tokens: {
          input: 10,
          output: 20,
          cacheRead: 3,
          cacheWrite: 4,
          total: 37,
        },
        cost: 0.0123,
      })),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const runtimeFactory = createPublicPiSdkRuntimeFactory({
      sdk: {
        createAgentSession: vi.fn(async () => ({ session })),
      },
      now: () => "2026-07-01T00:00:00.000Z",
    });
    const runtime = await runtimeFactory({
      sessionId: "app-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });

    await expect(runtime.queueFollowUp?.("Queued follow-up")).resolves.toEqual({
      id: "pi-sdk:sdk-session-1:queued:0",
      piSessionId: "sdk-session-1",
      body: "Queued follow-up",
      status: "pending",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    await expect(
      runtime.withdrawQueuedMessage?.("pi-sdk:sdk-session-1:queued:0"),
    ).resolves.toMatchObject({
      id: "pi-sdk:sdk-session-1:queued:0",
      status: "withdrawn",
      withdrawnAt: "2026-07-01T00:00:00.000Z",
    });
    await runtime.steerRun?.("Steer now");
    await runtime.stopRun?.();

    await expect(runtime.getSnapshot?.()).resolves.toMatchObject({
      status: "completed",
      summary: {
        provider: "anthropic",
        model: "claude-opus-4-5",
        totalTokens: 37,
        totalCostUsd: 0.0123,
      },
    });
    expect(session.followUp).toHaveBeenNthCalledWith(1, "Queued follow-up");
    expect(session.followUp).toHaveBeenNthCalledWith(2, "Keep follow-up");
    expect(session.steer).toHaveBeenNthCalledWith(1, "keep steering");
    expect(session.steer).toHaveBeenNthCalledWith(2, "Steer now");
    expect(session.abort).toHaveBeenCalledTimes(1);
  });

  it("carries the live context-window occupancy into the snapshot and the turn-boundary stream", async () => {
    const listeners: Array<(event: unknown) => void> = [];
    const getContextUsage = vi.fn(() => ({
      tokens: 84_000,
      contextWindow: 200_000,
      percent: 42,
    }));
    const session = {
      sessionId: "sdk-session-1",
      isStreaming: false,
      messages: [],
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      getContextUsage,
      subscribe(listener: (event: unknown) => void) {
        listeners.push(listener);

        return vi.fn();
      },
    };
    const runtimeFactory = createPublicPiSdkRuntimeFactory({
      sdk: { createAgentSession: vi.fn(async () => ({ session })) },
      now: () => "2026-07-01T00:00:00.000Z",
    });
    const runtime = await runtimeFactory({
      sessionId: "app-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });
    const events: Array<{ payload?: Record<string, unknown> }> = [];

    runtime.onEvent?.((event) => events.push(event as { payload?: Record<string, unknown> }));
    listeners[0]?.({ type: "agent_start" });
    listeners[0]?.({ type: "turn_start" });
    listeners[0]?.({ type: "turn_end" });

    await expect(runtime.getSnapshot?.()).resolves.toMatchObject({
      contextUsage: { tokens: 84_000, contextWindow: 200_000, percent: 42 },
    });
    expect(
      events
        .map((event) => event.payload)
        .filter((payload) => payload?.type === "context_usage"),
    ).toEqual([
      {
        type: "context_usage",
        runId: "sdk-session-1:run-1",
        usage: { tokens: 84_000, contextWindow: 200_000, percent: 42 },
        surface: "hidden",
        origin: "sdk",
      },
    ]);
  });

  it("clamps an overflowing context percentage so the label cannot disagree with a full bar", async () => {
    const session = {
      sessionId: "sdk-session-1",
      isStreaming: false,
      messages: [],
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      // Pi estimates context tokens, so the share can run past the window.
      getContextUsage: vi.fn(() => ({
        tokens: 206_000,
        contextWindow: 200_000,
        percent: 103,
      })),
      subscribe: vi.fn(() => vi.fn()),
    };
    const runtimeFactory = createPublicPiSdkRuntimeFactory({
      sdk: { createAgentSession: vi.fn(async () => ({ session })) },
      now: () => "2026-07-01T00:00:00.000Z",
    });
    const runtime = await runtimeFactory({
      sessionId: "app-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });

    await expect(runtime.getSnapshot?.()).resolves.toMatchObject({
      // The raw token estimate stays truthful; only the share is bounded.
      contextUsage: { tokens: 206_000, contextWindow: 200_000, percent: 100 },
    });
  });

  it("omits context usage for runtimes whose SDK does not report it", async () => {
    const session = {
      sessionId: "sdk-session-1",
      isStreaming: false,
      messages: [],
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const runtimeFactory = createPublicPiSdkRuntimeFactory({
      sdk: { createAgentSession: vi.fn(async () => ({ session })) },
      now: () => "2026-07-01T00:00:00.000Z",
    });
    const runtime = await runtimeFactory({
      sessionId: "app-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });

    const snapshot = await runtime.getSnapshot?.();

    expect(snapshot?.contextUsage).toBeUndefined();
  });

  it("passes image attachments through prompt, follow-up, and steer", async () => {
    const session = {
      sessionId: "sdk-session-1",
      isStreaming: false,
      messages: [],
      prompt: vi.fn(async () => {}),
      followUp: vi.fn(async () => {}),
      steer: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const runtimeFactory = createPublicPiSdkRuntimeFactory({
      sdk: {
        createAgentSession: vi.fn(async () => ({ session })),
      },
      now: () => "2026-07-01T00:00:00.000Z",
    });
    const runtime = await runtimeFactory({
      sessionId: "app-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });
    const images = [{ mimeType: "image/png", data: "abc", name: "shot.png" }];
    const piImages = [{ type: "image" as const, mimeType: "image/png", data: "abc" }];

    await runtime.sendPrompt("Look at this", images);
    await runtime.queueFollowUp?.("And then?", images);
    await runtime.steerRun?.("Focus on the screenshot", images);

    expect(session.prompt).toHaveBeenCalledWith("Look at this", { images: piImages });
    expect(session.followUp).toHaveBeenCalledWith("And then?", piImages);
    expect(session.steer).toHaveBeenCalledWith("Focus on the screenshot", piImages);
  });

  it("does not report a queued message withdrawn when the SDK queue no longer contains it", async () => {
    const session = {
      sessionId: "sdk-session-1",
      isStreaming: false,
      messages: [],
      prompt: vi.fn(async () => {}),
      followUp: vi.fn(async () => {}),
      steer: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      clearQueue: vi.fn(() => ({
        steering: [],
        followUp: ["Other follow-up"],
      })),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const runtimeFactory = createPublicPiSdkRuntimeFactory({
      sdk: {
        createAgentSession: vi.fn(async () => ({ session })),
      },
      now: () => "2026-07-01T00:00:00.000Z",
    });
    const runtime = await runtimeFactory({
      sessionId: "app-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });
    const queued = await runtime.queueFollowUp?.("Queued follow-up");

    await expect(runtime.withdrawQueuedMessage?.(queued?.id ?? "")).rejects.toThrow(
      'Pi SDK queued message "pi-sdk:sdk-session-1:queued:0" was not present in the follow-up queue.',
    );
    expect(session.followUp).toHaveBeenNthCalledWith(1, "Queued follow-up");
    expect(session.followUp).toHaveBeenNthCalledWith(2, "Other follow-up");
  });

  it("passes resource, auth, model registry, and model options through public createAgentSession", async () => {
    const session = {
      sessionId: "sdk-session-1",
      isStreaming: false,
      messages: [],
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const createAgentSession = vi.fn(async () => ({ session }));
    const authStorage = { kind: "auth" };
    const modelRegistry = { kind: "registry" };
    const resourceLoader = { kind: "resource-loader" };
    const model = { provider: "anthropic", id: "claude-opus-4-5" };
    const runtimeFactory = createPublicPiSdkRuntimeFactory({
      sdk: { createAgentSession },
      sessionOptions: {
        authStorage,
        modelRegistry,
        resourceLoader,
        model,
        thinkingLevel: "high",
        noTools: "builtin",
      },
    });

    await runtimeFactory({
      sessionId: "app-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });

    expect(createAgentSession).toHaveBeenCalledWith({
      authStorage,
      modelRegistry,
      resourceLoader,
      model,
      thinkingLevel: "high",
      cwd: "/Users/void/code/opensource/Pig",
      noTools: "builtin",
    });
  });

  it("does not disable SDK tools unless the caller explicitly requests it", async () => {
    const session = {
      sessionId: "sdk-session-1",
      isStreaming: false,
      messages: [],
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const createAgentSession = vi.fn(async () => ({ session }));
    const runtimeFactory = createPublicPiSdkRuntimeFactory({
      sdk: { createAgentSession },
    });

    await runtimeFactory({
      sessionId: "app-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });

    expect(createAgentSession).toHaveBeenCalledWith({
      cwd: "/Users/void/code/opensource/Pig",
    });
  });

  it("derives per-model Thinking capabilities and applies a validated pair", async () => {
    const models = [
      {
        provider: "anthropic",
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        reasoning: true,
        thinkingLevelMap: { minimal: null, xhigh: "max" },
        contextWindow: 200_000,
        maxTokens: 64_000,
        input: ["text", "image"],
      },
      {
        provider: "openai",
        id: "gpt-4.1",
        name: "GPT-4.1",
        reasoning: false,
      },
    ];
    let currentModel = models[0];
    let currentThinkingLevel = "high";
    const setModel = vi.fn(async (model: unknown) => {
      currentModel = model as (typeof models)[number];
    });
    const setThinkingLevel = vi.fn((level: unknown) => {
      currentThinkingLevel = String(level);
    });
    const session = {
      sessionId: "sdk-session-controls",
      isStreaming: false,
      messages: [],
      get model() {
        return currentModel;
      },
      get thinkingLevel() {
        return currentThinkingLevel;
      },
      modelRegistry: {
        getAvailable: () => models,
        find: (provider: string, modelId: string) =>
          models.find(
            (model) => model.provider === provider && model.id === modelId,
          ),
      },
      setModel,
      setThinkingLevel,
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const runtime = await createPublicPiSdkRuntimeFactory({
      sdk: { createAgentSession: vi.fn(async () => ({ session })) },
    })({
      sessionId: "app-session-controls",
      projectId: "pig",
      cwd: "/repo",
    });

    expect(runtime.modelControls).toEqual({
      models: [
        {
          provider: "anthropic",
          modelId: "claude-sonnet-4",
          name: "Claude Sonnet 4",
          thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
          // Catalog metadata passes through so the selector can show specs.
          contextWindow: 200_000,
          maxTokens: 64_000,
          input: ["text", "image"],
        },
        {
          // No catalog metadata on the source model: fields stay absent.
          provider: "openai",
          modelId: "gpt-4.1",
          name: "GPT-4.1",
          thinkingLevels: ["off"],
        },
      ],
      selected: {
        provider: "anthropic",
        modelId: "claude-sonnet-4",
        thinkingLevel: "high",
      },
    });

    await expect(
      runtime.configureModel?.({
        provider: "openai",
        modelId: "gpt-4.1",
        thinkingLevel: "off",
      }),
    ).resolves.toMatchObject({
      selected: {
        provider: "openai",
        modelId: "gpt-4.1",
        thinkingLevel: "off",
      },
    });
    await expect(
      runtime.configureModel?.({
        provider: "openai",
        modelId: "gpt-4.1",
        thinkingLevel: "high",
      }),
    ).rejects.toThrow(
      'Thinking level "high" is unavailable for "openai/gpt-4.1".',
    );
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setThinkingLevel).toHaveBeenCalledWith("off");
  });

  it("restores the persisted model pair before exposing a resumed runtime", async () => {
    const models = [
      {
        provider: "anthropic",
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        reasoning: true,
      },
    ];
    let currentThinkingLevel = "off";
    const setModel = vi.fn(async () => {});
    const setThinkingLevel = vi.fn((level: unknown) => {
      currentThinkingLevel = String(level);
    });
    const sessionManager = {
      getCwd: () => "/repo",
      getSessionFile: () => "/sessions/pi-session-restored.jsonl",
    };
    const session = {
      sessionId: "pi-session-restored",
      isStreaming: false,
      messages: [],
      model: models[0],
      get thinkingLevel() {
        return currentThinkingLevel;
      },
      modelRegistry: {
        getAvailable: () => models,
        find: () => models[0],
      },
      setModel,
      setThinkingLevel,
      sessionManager,
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const runtime = await createPublicPiSdkRuntimeResumer({
      sdk: {
        createAgentSession: vi.fn(async () => ({ session })),
        SessionManager: { open: () => sessionManager },
      },
    })({
      sessionId: "app-session-restored",
      projectId: "pig",
      piSessionId: "pi-session-restored",
      cwd: "/repo",
      sessionFile: "/sessions/pi-session-restored.jsonl",
      modelSelection: {
        provider: "anthropic",
        modelId: "claude-sonnet-4",
        thinkingLevel: "high",
      },
    });

    expect(setModel).toHaveBeenCalledWith(models[0]);
    expect(setThinkingLevel).toHaveBeenCalledWith("high");
    expect(runtime.modelControls?.selected).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4",
      thinkingLevel: "high",
    });
  });

  it("falls back to the session default model when the persisted selection is unavailable", async () => {
    // Pi removes/renames models over time (e.g. gpt-5-codex). Resume must not
    // hard-fail on a stale persisted selection — keep the session's own model.
    const sessionDefault = {
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT-5.5",
      reasoning: true,
    };
    const sessionManager = {
      getCwd: () => "/repo",
      getSessionFile: () => "/sessions/pi-session-stale.jsonl",
    };
    const session = {
      sessionId: "pi-session-stale",
      isStreaming: false,
      messages: [],
      model: sessionDefault,
      thinkingLevel: "medium",
      modelRegistry: {
        getAvailable: () => [sessionDefault],
        find: () => undefined, // persisted model no longer exists
      },
      setModel: vi.fn(async () => {}),
      setThinkingLevel: vi.fn(),
      sessionManager,
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };
    const runtime = await createPublicPiSdkRuntimeResumer({
      sdk: {
        createAgentSession: vi.fn(async () => ({ session })),
        SessionManager: { open: () => sessionManager },
      },
    })({
      sessionId: "app-session-stale",
      projectId: "pig",
      piSessionId: "pi-session-stale",
      cwd: "/repo",
      sessionFile: "/sessions/pi-session-stale.jsonl",
      modelSelection: {
        provider: "openai",
        modelId: "gpt-5-codex",
        thinkingLevel: "high",
      },
    });

    expect(runtime.modelControls?.selected).toEqual({
      provider: "openai",
      modelId: "gpt-5.5",
      thinkingLevel: "medium",
    });
  });

  it("reads current tool definitions from the live SDK registry", async () => {
    const bashSchema = {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    };
    const session = {
      sessionId: "sdk-session-1",
      isStreaming: false,
      messages: [],
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      getToolDefinition: vi.fn((name: string) =>
        name === "bash"
          ? {
              name: "bash",
              description: "Execute a shell command",
              parameters: bashSchema,
            }
          : undefined,
      ),
    };
    const runtime = await createPublicPiSdkRuntimeFactory({
      sdk: { createAgentSession: vi.fn(async () => ({ session })) },
    })({
      sessionId: "app-session-1",
      projectId: "pig",
      cwd: "/repo",
    });

    await expect(runtime.resolveToolSchemas?.(["bash", "gone_tool"])).resolves.toEqual({
      schemas: {
        bash: {
          description: "Execute a shell command",
          parameters: bashSchema,
        },
      },
    });
    expect(session.getToolDefinition).toHaveBeenCalledWith("bash");
    expect(session.getToolDefinition).toHaveBeenCalledWith("gone_tool");
  });
});
