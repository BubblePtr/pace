import { describe, expect, it, vi } from "vitest";
import {
  createPublicPiSdkRuntimeForker,
  createPublicPiSdkRuntimeFactory,
  createPublicPiSdkRuntimeResumer,
} from "./pi-sdk-runtime-adapter";

async function createQueuedRuntime(options?: {
  expand?: (text: string) => string;
  followUpMode?: "all" | "one-at-a-time";
}) {
  const expand = options?.expand ?? ((text: string) => text);
  const piFollowUps: Array<{ body: string; stored: string; images?: unknown }> = [];
  const piSteering: Array<{ body: string; stored: string; images?: unknown }> = [];
  const calls: string[] = [];
  const session = {
    sessionId: "sdk-session-1",
    isStreaming: false,
    messages: [],
    prompt: vi.fn(async () => {}),
    followUp: vi.fn(async (message: string, images?: unknown) => {
      calls.push(`followUp:${message}`);
      piFollowUps.push({ body: message, stored: expand(message), images });
    }),
    steer: vi.fn(async (message: string, images?: unknown) => {
      calls.push(`steer:${message}`);
      piSteering.push({ body: message, stored: expand(message), images });
    }),
    getFollowUpMessages: vi.fn(() => piFollowUps.map((item) => item.stored)),
    getSteeringMessages: vi.fn(() => piSteering.map((item) => item.stored)),
    abort: vi.fn(async () => {}),
    clearQueue: vi.fn(() => {
      calls.push("clear");
      const followUp = piFollowUps.map((item) => item.stored);
      const steering = piSteering.map((item) => item.stored);
      piFollowUps.length = 0;
      piSteering.length = 0;
      return { steering, followUp };
    }),
    dispose: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    ...(options?.followUpMode ? { followUpMode: options.followUpMode } : {}),
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
  return {
    session,
    runtime,
    calls,
    piFollowUps,
    piSteering,
    consumeFollowUp: () => piFollowUps.shift(),
    piImagesFrom: (images: Array<{ mimeType: string; data: string; name: string }>) =>
      images.map((image) => ({ type: "image" as const, mimeType: image.mimeType, data: image.data })),
  };
}

describe("Pi SDK public runtime adapter", () => {
  it("creates a new session with the composer model and thinking level overriding defaults", async () => {
    const model = { provider: "custom", id: "composer-model", name: "Composer model", reasoning: true };
    const modelRuntime = {
      getModel: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
      getAvailableSnapshot: () => [model],
    };
    const session = {
      sessionId: "pi-composer", isStreaming: false, messages: [],
      prompt: vi.fn(async () => {}), abort: vi.fn(async () => {}),
      dispose: vi.fn(), subscribe: () => () => {},
    };
    const createAgentSession = vi.fn(async () => ({ session }));
    const createModelRuntime = vi.fn(async () => modelRuntime);
    const factory = createPublicPiSdkRuntimeFactory({
      sdk: { createAgentSession, ModelRuntime: { create: createModelRuntime } },
      sessionOptions: { agentDir: "/custom/agent", model: { id: "settings-default" }, thinkingLevel: "xhigh" },
      sessionOptionsFor: async () => ({ model: { id: "project-default" }, thinkingLevel: "low" }),
    });

    const runtime = await factory({
      sessionId: "app-composer", projectId: "p", cwd: "/repo",
      modelSelection: { provider: "custom", modelId: "composer-model", thinkingLevel: "high" },
    });

    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      model, thinkingLevel: "high", modelRuntime,
    }));
    expect(createModelRuntime).toHaveBeenCalledWith({
      authPath: "/custom/agent/auth.json", modelsPath: "/custom/agent/models.json",
    });
    await runtime.dispose?.();
  });

  it.each(["missing", "unavailable", "unsupported thinking"])("rejects a %s composer selection before creating any Pi session", async (condition) => {
    const model = { provider: "custom", id: "selected", name: "Selected", reasoning: false };
    const createAgentSession = vi.fn();
    const factory = createPublicPiSdkRuntimeFactory({
      sdk: { createAgentSession },
      sessionOptions: { modelRuntime: {
        getModel: () => condition === "missing" ? undefined : model,
        getAvailableSnapshot: () => condition === "unavailable" ? [] : [model],
      } },
    });
    await expect(factory({
      sessionId: "app", projectId: "p", cwd: "/repo",
      modelSelection: { provider: "custom", modelId: "selected", thinkingLevel: "high" },
    })).rejects.toThrow(condition === "unsupported thinking"
      ? 'Thinking level "high" is unavailable for "custom/selected".'
      : 'Model "custom/selected" is unavailable.');
    expect(createAgentSession).not.toHaveBeenCalled();
  });

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

  const autoTitleSession = (overrides: Record<string, unknown>) => {
    const model = { provider: "custom", id: "current", name: "Current", reasoning: false };
    const session = {
      sessionId: "pi-auto-title", sessionName: "", isStreaming: false, messages: [], model,
      setSessionName: vi.fn(function (this: { sessionName: string }, name: string) { this.sessionName = name; }),
      prompt: vi.fn(async () => {}), abort: vi.fn(async () => {}), dispose: vi.fn(),
      subscribe(listener: (event: unknown) => void) { emitToSession = listener; return vi.fn(); },
      ...overrides,
    };

    return session;
  };
  let emitToSession: (event: unknown) => void = () => {};
  const messageEnd = (role: string, text: string) => ({ type: "message_end", message: { role, content: [{ type: "text", text }] } });

  it("names an untitled session from the first reply using the session's current model", async () => {
    const complete = vi.fn(async () => ({ content: [{ type: "text", text: '"Wire up the session dock."' }] }));
    const session = autoTitleSession({ modelRuntime: { complete } });
    const runtime = await createPublicPiSdkRuntimeFactory({ sdk: { createAgentSession: async () => ({ session }) } })({ sessionId: "app-auto-title", projectId: "p", cwd: "/repo" });

    emitToSession(messageEnd("user", "wire up the session dock"));
    emitToSession(messageEnd("assistant", "Done — the dock now mounts."));

    await vi.waitFor(() => expect(session.setSessionName).toHaveBeenCalledWith("Wire up the session dock"));
    expect(complete).toHaveBeenCalledWith(
      session.model,
      { messages: [expect.objectContaining({ role: "user", content: [{ type: "text", text: expect.stringContaining("wire up the session dock") }] })] },
      expect.objectContaining({ reasoningEffort: "low", cacheRetention: "none", sessionId: expect.any(String) }),
    );
    await runtime.dispose?.();
  });

  it("leaves an already named session alone", async () => {
    const complete = vi.fn();
    const session = autoTitleSession({ sessionName: "Named by an extension", modelRuntime: { complete } });
    const runtime = await createPublicPiSdkRuntimeFactory({ sdk: { createAgentSession: async () => ({ session }) } })({ sessionId: "app-named", projectId: "p", cwd: "/repo" });

    emitToSession(messageEnd("user", "wire up the session dock"));
    emitToSession(messageEnd("assistant", "Done."));

    expect(complete).not.toHaveBeenCalled();
    expect(session.setSessionName).not.toHaveBeenCalled();
    await runtime.dispose?.();
  });

  it("swallows a naming failure and does not retry it on later replies", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const complete = vi.fn(async () => { throw new Error("provider is down"); });
    const session = autoTitleSession({ modelRuntime: { complete } });
    const runtime = await createPublicPiSdkRuntimeFactory({ sdk: { createAgentSession: async () => ({ session }) } })({ sessionId: "app-failing", projectId: "p", cwd: "/repo" });

    emitToSession(messageEnd("user", "wire up the session dock"));
    emitToSession(messageEnd("assistant", "Done."));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    emitToSession(messageEnd("user", "now add tests"));
    emitToSession(messageEnd("assistant", "Tests added."));

    expect(complete).toHaveBeenCalledTimes(1);
    expect(session.setSessionName).not.toHaveBeenCalled();
    warn.mockRestore();
    await runtime.dispose?.();
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
    await expect(runtime.queueFollowUp?.("Keep follow-up")).resolves.toMatchObject({
      id: "pi-sdk:sdk-session-1:queued:1",
      body: "Keep follow-up",
      status: "pending",
    });
    await runtime.steerRun?.("keep steering");
    await expect(
      runtime.withdrawQueuedMessage?.("pi-sdk:sdk-session-1:queued:0"),
    ).resolves.toMatchObject({
      ok: true,
      queuedMessages: [
        expect.objectContaining({
          id: "pi-sdk:sdk-session-1:queued:0",
          status: "withdrawn",
        }),
        expect.objectContaining({
          id: "pi-sdk:sdk-session-1:queued:1",
          status: "pending",
        }),
      ],
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
    expect(session.followUp).toHaveBeenNthCalledWith(3, "Keep follow-up");
    expect(session.steer).toHaveBeenNthCalledWith(1, "keep steering");
    expect(session.steer).toHaveBeenNthCalledWith(2, "keep steering");
    expect(session.steer).toHaveBeenNthCalledWith(3, "Steer now");
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
    const stored: string[] = [];
    const session = {
      sessionId: "sdk-session-1",
      isStreaming: false,
      messages: [],
      prompt: vi.fn(async () => {}),
      followUp: vi.fn(async (message: string) => {
        stored.push(message);
      }),
      steer: vi.fn(async () => {}),
      getFollowUpMessages: vi.fn(() => [...stored]),
      abort: vi.fn(async () => {}),
      clearQueue: vi.fn(() => {
        stored.length = 0;
        return {
          steering: [] as string[],
          followUp: ["Other follow-up"],
        };
      }),
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
    stored.length = 0;
    stored.push("Other follow-up");

    await expect(runtime.withdrawQueuedMessage?.(queued?.id ?? "")).rejects.toThrow(
      'Pi SDK queued message "pi-sdk:sdk-session-1:queued:0" was not present in the follow-up queue.',
    );
    expect(session.clearQueue).not.toHaveBeenCalled();
    expect(stored).toEqual(["Other follow-up"]);
  });

  it("withdraws the targeted queued message when two pending follow-ups share a body", async () => {
    const { session, runtime, piImagesFrom } = await createQueuedRuntime();
    const firstImage = [{ mimeType: "image/png", data: "aaa", name: "first.png" }];
    const middleImage = [{ mimeType: "image/png", data: "bbb", name: "middle.png" }];
    const lastImage = [{ mimeType: "image/png", data: "ccc", name: "last.png" }];
    const first = await runtime.queueFollowUp?.("Same body", firstImage);
    const middle = await runtime.queueFollowUp?.("Same body", middleImage);
    await runtime.queueFollowUp?.("Same body", lastImage);

    await expect(runtime.withdrawQueuedMessage?.(middle?.id ?? "")).resolves.toMatchObject({
      ok: true,
      queuedMessages: expect.arrayContaining([
        expect.objectContaining({ id: middle?.id, status: "withdrawn" }),
      ]),
    });

    expect(session.followUp.mock.calls).toEqual([
      ["Same body", piImagesFrom(firstImage)],
      ["Same body", piImagesFrom(middleImage)],
      ["Same body", piImagesFrom(lastImage)],
      ["Same body", piImagesFrom(firstImage)],
      ["Same body", piImagesFrom(lastImage)],
    ]);
    expect(first?.id).not.toBe(middle?.id);
  });

  it("replays follow-ups to Pi in the requested order with the images that belong to each id", async () => {
    const { session, runtime, piImagesFrom } = await createQueuedRuntime();
    const firstImage = [{ mimeType: "image/png", data: "aaa", name: "first.png" }];
    const secondImage = [{ mimeType: "image/png", data: "bbb", name: "second.png" }];
    const first = await runtime.queueFollowUp?.("Same body", firstImage);
    const second = await runtime.queueFollowUp?.("Same body", secondImage);

    await expect(
      runtime.reorderQueuedMessages?.([second?.id ?? "", first?.id ?? ""]),
    ).resolves.toMatchObject({
      ok: true,
      queuedMessages: [
        expect.objectContaining({ id: second?.id, body: "Same body", images: secondImage }),
        expect.objectContaining({ id: first?.id, body: "Same body", images: firstImage }),
      ],
    });

    expect(session.clearQueue).toHaveBeenCalledTimes(1);
    expect(session.followUp.mock.calls).toEqual([
      ["Same body", piImagesFrom(firstImage)],
      ["Same body", piImagesFrom(secondImage)],
      ["Same body", piImagesFrom(secondImage)],
      ["Same body", piImagesFrom(firstImage)],
    ]);
  });

  it("keeps a later withdraw in the reordered follow-up order", async () => {
    const { runtime, calls } = await createQueuedRuntime();
    const first = await runtime.queueFollowUp?.("A");
    const second = await runtime.queueFollowUp?.("B");
    const third = await runtime.queueFollowUp?.("C");

    await expect(
      runtime.reorderQueuedMessages?.([
        third?.id ?? "",
        first?.id ?? "",
        second?.id ?? "",
      ]),
    ).resolves.toMatchObject({
      ok: true,
      queuedMessages: [
        expect.objectContaining({ id: third?.id, body: "C" }),
        expect.objectContaining({ id: first?.id, body: "A" }),
        expect.objectContaining({ id: second?.id, body: "B" }),
      ],
    });

    await runtime.withdrawQueuedMessage?.(first?.id ?? "");
    expect(calls).toEqual([
      "followUp:A",
      "followUp:B",
      "followUp:C",
      "clear",
      "followUp:C",
      "followUp:A",
      "followUp:B",
      "clear",
      "followUp:C",
      "followUp:B",
    ]);

    await runtime.queueFollowUp?.("D");
    await runtime.withdrawQueuedMessage?.(third?.id ?? "");
    expect(calls.slice(-4)).toEqual([
      "followUp:D",
      "clear",
      "followUp:B",
      "followUp:D",
    ]);
  });

  it("does not let a concurrent withdraw interleave with a reorder on the same session", async () => {
    const { session, runtime, calls, piFollowUps } = await createQueuedRuntime();
    const first = await runtime.queueFollowUp?.("First");
    const second = await runtime.queueFollowUp?.("Second");
    const third = await runtime.queueFollowUp?.("Third");
    let releaseReplay!: () => void;
    const replayHeld = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    let noticeReplay!: () => void;
    const replayStarted = new Promise<void>((resolve) => {
      noticeReplay = resolve;
    });
    let holding = false;
    session.followUp.mockImplementation(async (message: string, images?: unknown) => {
      if (calls.includes("clear") && !holding) {
        holding = true;
        noticeReplay();
        await replayHeld;
      }
      calls.push(`followUp:${message}`);
      piFollowUps.push({ body: message, stored: message, images });
    });

    const withdrawn = runtime.withdrawQueuedMessage?.(first?.id ?? "");
    const reordered = runtime.reorderQueuedMessages?.([
      third?.id ?? "",
      second?.id ?? "",
      first?.id ?? "",
    ]);

    await replayStarted;
    // The second write must not have cleared Pi while the first replay is in flight.
    expect(calls.filter((call) => call === "clear")).toHaveLength(1);

    releaseReplay();
    await Promise.allSettled([withdrawn, reordered]);

    expect(calls.join(",")).not.toMatch(/clear,clear/);
  });

  it("skips a consumed follow-up and keeps the remaining order through reorder and withdraw", async () => {
    const { runtime, session, consumeFollowUp, piFollowUps } = await createQueuedRuntime();
    const first = await runtime.queueFollowUp?.("A");
    const second = await runtime.queueFollowUp?.("B");
    const third = await runtime.queueFollowUp?.("C");
    consumeFollowUp();

    await expect(
      runtime.reorderQueuedMessages?.([third?.id ?? "", second?.id ?? ""]),
    ).resolves.toMatchObject({
      ok: true,
      queuedMessages: [
        expect.objectContaining({ id: first?.id, status: "processing" }),
        expect.objectContaining({ id: third?.id, body: "C", status: "pending" }),
        expect.objectContaining({ id: second?.id, body: "B", status: "pending" }),
      ],
    });
    await runtime.withdrawQueuedMessage?.(second?.id ?? "");

    expect(piFollowUps.map((item) => item.stored)).toEqual(["C"]);
    expect(session.followUp.mock.calls.map((call) => call[0])).toEqual([
      "A",
      "B",
      "C",
      "C",
      "B",
      "C",
    ]);
    expect(first?.id).not.toBe(second?.id);
  });

  it("reorders a follow-up whose stored Pi text differs from the raw body", async () => {
    const { runtime, session, piFollowUps } = await createQueuedRuntime({
      expand: (text) => (text.startsWith("/template ") ? `expanded:${text.slice(10)}` : text),
    });
    const templated = await runtime.queueFollowUp?.("/template greet");
    const plain = await runtime.queueFollowUp?.("plain");

    await expect(
      runtime.reorderQueuedMessages?.([plain?.id ?? "", templated?.id ?? ""]),
    ).resolves.toMatchObject({
      ok: true,
      queuedMessages: [
        expect.objectContaining({ id: plain?.id, body: "plain" }),
        expect.objectContaining({ id: templated?.id, body: "/template greet" }),
      ],
    });

    expect(session.followUp.mock.calls.map((call) => call[0])).toEqual([
      "/template greet",
      "plain",
      "plain",
      "/template greet",
    ]);
    expect(piFollowUps.map((item) => item.stored)).toEqual(["plain", "expanded:greet"]);
  });

  it("replays a steered image together with follow-ups on reorder", async () => {
    const { runtime, session, piImagesFrom, piSteering } = await createQueuedRuntime();
    const images = [{ mimeType: "image/png", data: "aaa", name: "steer.png" }];
    await runtime.steerRun?.("Focus", images);
    const first = await runtime.queueFollowUp?.("A");
    const second = await runtime.queueFollowUp?.("B");

    await runtime.reorderQueuedMessages?.([second?.id ?? "", first?.id ?? ""]);

    expect(session.steer.mock.calls).toEqual([
      ["Focus", piImagesFrom(images)],
      ["Focus", piImagesFrom(images)],
    ]);
    expect(piSteering.map((item) => item.stored)).toEqual(["Focus"]);
    expect(session.followUp.mock.calls.map((call) => call[0])).toEqual(["A", "B", "B", "A"]);
  });

  it("does not clear Pi when an unknown string is already in the follow-up queue", async () => {
    const { runtime, session, piFollowUps } = await createQueuedRuntime();
    const first = await runtime.queueFollowUp?.("A");
    const second = await runtime.queueFollowUp?.("B");
    piFollowUps.unshift({ body: "X", stored: "X" });

    await expect(
      runtime.reorderQueuedMessages?.([first?.id ?? "", second?.id ?? ""]),
    ).rejects.toThrow("Pi follow-up queue drifted during reorder.");
    expect(session.clearQueue).not.toHaveBeenCalled();
    expect(piFollowUps.map((item) => item.stored)).toEqual(["X", "A", "B"]);
  });

  it("returns the Pi queue state when a replayed follow-up fails both attempts", async () => {
    const { runtime, session, piFollowUps, piImagesFrom } = await createQueuedRuntime();
    const imageA = [{ mimeType: "image/png", data: "aaa", name: "a.png" }];
    const imageB = [{ mimeType: "image/png", data: "bbb", name: "b.png" }];
    const imageC = [{ mimeType: "image/png", data: "ccc", name: "c.png" }];
    const first = await runtime.queueFollowUp?.("A", imageA);
    const second = await runtime.queueFollowUp?.("B", imageB);
    const third = await runtime.queueFollowUp?.("C", imageC);
    session.followUp.mockImplementation(async (message: string, images?: unknown) => {
      if (session.clearQueue.mock.calls.length > 0 && message === "B") {
        throw new Error("follow-up failed");
      }
      piFollowUps.push({ body: message, stored: message, images });
    });

    await expect(
      runtime.reorderQueuedMessages?.([third?.id ?? "", second?.id ?? "", first?.id ?? ""]),
    ).resolves.toMatchObject({
      ok: false,
      error: "follow-up failed",
      queuedMessages: [
        expect.objectContaining({ id: third?.id, body: "C", status: "pending" }),
        expect.objectContaining({ id: first?.id, body: "A", status: "pending" }),
        expect.objectContaining({ id: second?.id, body: "B", status: "withdrawn" }),
      ],
    });
    expect(piFollowUps).toEqual([
      { body: "C", stored: "C", images: piImagesFrom(imageC) },
      { body: "A", stored: "A", images: piImagesFrom(imageA) },
    ]);
  });

  it("does not re-enqueue a withdrawn target when a later replayed follow-up fails", async () => {
    const { runtime, session, piFollowUps } = await createQueuedRuntime();
    const first = await runtime.queueFollowUp?.("A");
    const second = await runtime.queueFollowUp?.("B");
    const third = await runtime.queueFollowUp?.("C");
    session.followUp.mockImplementation(async (message: string, images?: unknown) => {
      if (session.clearQueue.mock.calls.length > 0 && message === "B") {
        throw new Error("follow-up failed");
      }
      piFollowUps.push({ body: message, stored: message, images });
    });

    await expect(runtime.withdrawQueuedMessage?.(first?.id ?? "")).resolves.toMatchObject({
      ok: false,
      error: "follow-up failed",
      queuedMessages: expect.arrayContaining([
        expect.objectContaining({ id: first?.id, status: "withdrawn" }),
        expect.objectContaining({ id: second?.id, status: "withdrawn" }),
        expect.objectContaining({ id: third?.id, body: "C", status: "pending" }),
      ]),
    });
    expect(piFollowUps.map((item) => item.stored)).toEqual(["C"]);
  });

  it("keeps the appended follow-up pending when Pi consumes the old head during enqueue", async () => {
    const { runtime, session, piFollowUps } = await createQueuedRuntime();
    const first = await runtime.queueFollowUp?.("A");
    session.followUp.mockImplementation(async (message: string, images?: unknown) => {
      piFollowUps.shift();
      piFollowUps.push({ body: message, stored: message, images });
    });
    const second = await runtime.queueFollowUp?.("B");

    expect(second).toMatchObject({ body: "B", status: "pending" });
    await expect(
      runtime.reorderQueuedMessages?.([first?.id ?? "", second?.id ?? ""]),
    ).resolves.toMatchObject({
      ok: true,
      queuedMessages: [
        expect.objectContaining({ id: first?.id, status: "processing" }),
        expect.objectContaining({ id: second?.id, body: "B", status: "pending" }),
      ],
    });
  });

  it("marks a follow-up processing when Pi consumes it during enqueue", async () => {
    const { runtime, session, piFollowUps } = await createQueuedRuntime();
    let consumeNext = true;
    session.followUp.mockImplementation(async (message: string, images?: unknown) => {
      piFollowUps.push({ body: message, stored: message, images });
      if (consumeNext) {
        consumeNext = false;
        piFollowUps.shift();
      }
    });
    const first = await runtime.queueFollowUp?.("A");
    const second = await runtime.queueFollowUp?.("B");
    const third = await runtime.queueFollowUp?.("C");

    expect(first).toMatchObject({ body: "A", status: "processing" });
    await expect(
      runtime.reorderQueuedMessages?.([third?.id ?? "", second?.id ?? ""]),
    ).resolves.toMatchObject({
      ok: true,
      queuedMessages: [
        expect.objectContaining({ id: first?.id, status: "processing" }),
        expect.objectContaining({ id: third?.id, body: "C", status: "pending" }),
        expect.objectContaining({ id: second?.id, body: "B", status: "pending" }),
      ],
    });
    expect(piFollowUps.map((item) => item.stored)).toEqual(["C", "B"]);
    expect(session.followUp.mock.calls.map((call) => call[0])).toEqual(["A", "B", "C", "C", "B"]);
  });

  it("treats an append that replaces a consumed identical-text head as pending", async () => {
    const { runtime, session, piFollowUps, piImagesFrom } = await createQueuedRuntime();
    const imageA = [{ mimeType: "image/png", data: "aaa", name: "a.png" }];
    const imageB = [{ mimeType: "image/png", data: "bbb", name: "b.png" }];
    const first = await runtime.queueFollowUp?.("same", imageA);
    session.followUp.mockImplementation(async (message: string, images?: unknown) => {
      piFollowUps.shift();
      piFollowUps.push({ body: message, stored: message, images });
    });
    const second = await runtime.queueFollowUp?.("same", imageB);

    expect(second).toMatchObject({
      body: "same",
      status: "pending",
      images: imageB,
    });
    expect(piFollowUps).toEqual([
      { body: "same", stored: "same", images: piImagesFrom(imageB) },
    ]);
    await expect(
      runtime.reorderQueuedMessages?.([first?.id ?? "", second?.id ?? ""]),
    ).resolves.toMatchObject({
      ok: true,
      queuedMessages: [
        expect.objectContaining({ id: first?.id, status: "processing" }),
        expect.objectContaining({
          id: second?.id,
          status: "pending",
          images: imageB,
        }),
      ],
    });
  });

  it("continues replaying later steering after an earlier one is consumed", async () => {
    const { runtime, session, piSteering } = await createQueuedRuntime();
    await runtime.steerRun?.("S1");
    await runtime.steerRun?.("S2");
    const queued = await runtime.queueFollowUp?.("A");
    let consumedFirstReplay = false;
    session.steer.mockImplementation(async (message: string, images?: unknown) => {
      piSteering.push({ body: message, stored: message, images });
      if (session.clearQueue.mock.calls.length > 0 && !consumedFirstReplay) {
        consumedFirstReplay = true;
        piSteering.shift();
      }
    });

    await expect(runtime.reorderQueuedMessages?.([queued?.id ?? ""])).resolves.toMatchObject({
      ok: true,
    });
    expect(piSteering.map((item) => item.stored)).toEqual(["S2"]);
    expect(session.steer.mock.calls.map((call) => call[0])).toEqual(["S1", "S2", "S1", "S2"]);
  });

  it("does not clear Pi when withdrawing a follow-up that was already consumed", async () => {
    const { runtime, session, consumeFollowUp } = await createQueuedRuntime();
    const first = await runtime.queueFollowUp?.("A");
    const second = await runtime.queueFollowUp?.("B");
    consumeFollowUp();

    await expect(runtime.withdrawQueuedMessage?.(first?.id ?? "")).resolves.toMatchObject({
      ok: false,
      error: "already processing",
      queuedMessages: [
        expect.objectContaining({ id: first?.id, status: "processing" }),
        expect.objectContaining({ id: second?.id, body: "B", status: "pending" }),
      ],
    });
    expect(session.clearQueue).not.toHaveBeenCalled();
  });

  it("refuses to reorder when Pi follow-up mode is all", async () => {
    const { runtime, session, piFollowUps } = await createQueuedRuntime({
      followUpMode: "all",
    });
    const first = await runtime.queueFollowUp?.("A");
    const second = await runtime.queueFollowUp?.("B");

    await expect(
      runtime.reorderQueuedMessages?.([second?.id ?? "", first?.id ?? ""]),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/follow-up mode is all/),
      queuedMessages: [
        expect.objectContaining({ id: first?.id, body: "A", status: "pending" }),
        expect.objectContaining({ id: second?.id, body: "B", status: "pending" }),
      ],
    });
    expect(session.clearQueue).not.toHaveBeenCalled();
    expect(piFollowUps.map((item) => item.stored)).toEqual(["A", "B"]);
  });

  it("still withdraws a follow-up when Pi follow-up mode is all", async () => {
    const { runtime, session, piFollowUps } = await createQueuedRuntime({
      followUpMode: "all",
    });
    const first = await runtime.queueFollowUp?.("A");
    const second = await runtime.queueFollowUp?.("B");

    await expect(runtime.withdrawQueuedMessage?.(first?.id ?? "")).resolves.toMatchObject({
      ok: true,
      queuedMessages: expect.arrayContaining([
        expect.objectContaining({ id: first?.id, status: "withdrawn" }),
        expect.objectContaining({ id: second?.id, body: "B", status: "pending" }),
      ]),
    });
    expect(session.clearQueue).toHaveBeenCalled();
    expect(piFollowUps.map((item) => item.stored)).toEqual(["B"]);
  });

  it("steers a follow-up into the steering queue and leaves the remaining follow-ups in order", async () => {
    const { runtime, session, piFollowUps, piSteering, piImagesFrom } = await createQueuedRuntime();
    const images = [{ mimeType: "image/png", data: "bbb", name: "b.png" }];
    await runtime.steerRun?.("S1");
    const first = await runtime.queueFollowUp?.("A");
    const second = await runtime.queueFollowUp?.("B", images);
    const third = await runtime.queueFollowUp?.("C");

    const steered = await runtime.steerFromQueue?.(second?.id ?? "");
    expect(steered).toMatchObject({ ok: true });
    expect(steered?.queuedMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first?.id, body: "A", status: "pending" }),
        expect.objectContaining({ id: second?.id, body: "B", status: "steered" }),
        expect.objectContaining({ id: third?.id, body: "C", status: "pending" }),
      ]),
    );
    expect(steered?.queuedMessages).toHaveLength(3);

    expect(piSteering.map((item) => ({ stored: item.stored, images: item.images }))).toEqual([
      { stored: "S1", images: undefined },
      { stored: "B", images: piImagesFrom(images) },
    ]);
    expect(piFollowUps.map((item) => item.stored)).toEqual(["A", "C"]);
    expect(session.steer.mock.calls).toEqual([
      ["S1"],
      ["S1"],
      ["B", piImagesFrom(images)],
    ]);

    await runtime.reorderQueuedMessages?.([third?.id ?? "", first?.id ?? ""]);
    expect(piSteering.map((item) => ({ stored: item.stored, images: item.images }))).toEqual([
      { stored: "S1", images: undefined },
      { stored: "B", images: piImagesFrom(images) },
    ]);
    expect(piFollowUps.map((item) => item.stored)).toEqual(["C", "A"]);
  });

  it("does not clear Pi when steering a follow-up that was already consumed", async () => {
    const { runtime, session, consumeFollowUp } = await createQueuedRuntime();
    const first = await runtime.queueFollowUp?.("A");
    const second = await runtime.queueFollowUp?.("B");
    const third = await runtime.queueFollowUp?.("C");
    consumeFollowUp();
    consumeFollowUp();

    await expect(runtime.steerFromQueue?.(second?.id ?? "")).resolves.toMatchObject({
      ok: false,
      error: "already processing",
      queuedMessages: [
        expect.objectContaining({ id: first?.id, status: "processing" }),
        expect.objectContaining({ id: second?.id, status: "processing" }),
        expect.objectContaining({ id: third?.id, body: "C", status: "pending" }),
      ],
    });
    expect(session.clearQueue).not.toHaveBeenCalled();
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

  it("does not write model changes when reapplying the current model", async () => {
    const model = { provider: "custom", id: "selected", name: "Selected", reasoning: true };
    let thinkingLevel = "low";
    const session = {
      sessionId: "pi-current", isStreaming: false, messages: [], model,
      get thinkingLevel() { return thinkingLevel; },
      modelRuntime: { getModel: () => model, getAvailableSnapshot: () => [model] },
      setModel: vi.fn(async () => {}),
      setThinkingLevel: vi.fn((level: unknown) => { thinkingLevel = String(level); }),
      prompt: vi.fn(async () => {}), abort: vi.fn(async () => {}), dispose: vi.fn(), subscribe: () => () => {},
    };
    const runtime = await createPublicPiSdkRuntimeFactory({
      sdk: { createAgentSession: async () => ({ session }) },
    })({ sessionId: "app", projectId: "p", cwd: "/repo" });
    const selection = { provider: "custom", modelId: "selected", thinkingLevel: "high" as const };
    await expect(runtime.configureModel?.(selection)).resolves.toMatchObject({ selected: selection });
    await runtime.configureModel?.(selection);
    expect(session.setModel).not.toHaveBeenCalled();
    expect(session.setThinkingLevel).toHaveBeenCalledTimes(1);
    await runtime.dispose?.();
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

    expect(setModel).not.toHaveBeenCalled();
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

  it("emits hidden subagent records from tintinweb pi.events correlated with Agent tool calls", async () => {
    const sessionListeners: Array<(event: unknown) => void> = [];
    const eventListeners = new Map<string, Set<(data: unknown) => void>>();
    const eventBus = {
      on(channel: string, handler: (data: unknown) => void) {
        const set = eventListeners.get(channel) ?? new Set();
        set.add(handler);
        eventListeners.set(channel, set);
        return () => set.delete(handler);
      },
    };
    const session = {
      sessionId: "parent-1",
      isStreaming: false,
      messages: [],
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe(listener: (event: unknown) => void) {
        sessionListeners.push(listener);
        return vi.fn();
      },
    };
    const runtime = await createPublicPiSdkRuntimeFactory({
      sdk: { createAgentSession: vi.fn(async () => ({ session })) },
      sessionOptions: { resourceLoader: { eventBus } },
      now: () => "2026-09-15T12:00:00.000Z",
    })({ sessionId: "app", projectId: "p", cwd: "/repo" });
    const events: Array<{ type?: string; payload?: Record<string, unknown> }> = [];
    runtime.onEvent?.((event) => events.push(event as { type?: string; payload?: Record<string, unknown> }));

    for (const listener of sessionListeners) {
      listener({
        type: "tool_execution_start",
        toolCallId: "call-agent",
        toolName: "Agent",
        args: { subagent_type: "Explore", prompt: "look", description: "Look" },
      });
    }
    for (const handler of eventListeners.get("subagents:started") ?? []) {
      handler({ id: "ag-1", type: "Explore", description: "Look" });
    }
    for (const handler of eventListeners.get("subagents:completed") ?? []) {
      handler({
        id: "ag-1",
        usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.001 } },
        sessionFile: "/sessions/child-1.jsonl",
      });
    }

    const subagentEvents = events.filter((event) => event.type === "subagent");
    expect(subagentEvents[0]?.payload).toMatchObject({
      type: "subagent",
      phase: "start",
      surface: "hidden",
      origin: "sdk",
      record: {
        parentSessionId: "parent-1",
        ownerToolCallId: "call-agent",
        sourceAgentId: "ag-1",
        state: "started",
        source: "tintinweb",
      },
    });
    expect(subagentEvents[subagentEvents.length - 1]?.payload).toMatchObject({
      phase: "end",
      record: { state: "completed", childSessionId: "child-1" },
    });
  });
});
