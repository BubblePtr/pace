import { describe, expect, it, vi } from "vitest";
import {
  PiSdkDriverUnsupportedError,
  createPiSdkDriver,
  type PiSdkRuntimeEvent,
  type PiSdkSessionRuntime,
} from "./pi-sdk-driver";

describe("Pi SDK driver", () => {
  it("drains in-flight session creation during shutdown and rejects new work", async () => {
    let release!: (runtime: PiSdkSessionRuntime) => void;
    const factory = vi.fn(() => new Promise<PiSdkSessionRuntime>(resolve => { release = resolve; }));
    const driver = createPiSdkDriver({ runtimeFactory: factory });
    const creating = driver.createSession({ sessionId: "app", projectId: "p", cwd: "/repo" });
    const rejected = expect(creating).rejects.toThrow("closing");
    let done = false;
    const closing = driver.dispose!().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    const runtime: PiSdkSessionRuntime = { piSessionId: "pi-new", runtimeId: "new", status: "idle", sendPrompt: async () => {}, dispose: vi.fn() };
    release(runtime);
    await rejected;
    await closing;
    expect(runtime.dispose).toHaveBeenCalledOnce();
    await expect(driver.createSession({ sessionId: "late", projectId: "p", cwd: "/repo" })).rejects.toThrow("closing");
    expect(factory).toHaveBeenCalledOnce();
  });

  it("reattaches to a live root without replacing its child-session owner", async () => {
    const runtime: PiSdkSessionRuntime = { piSessionId: "pi-live", runtimeId: "runtime-live", status: "idle", sendPrompt: async () => {}, getSnapshot: async () => ({ status: "running" }) };
    const resume = vi.fn(async () => runtime);
    const driver = createPiSdkDriver({ runtimeFactory: async () => runtime, runtimeResumer: resume });
    await driver.createSession({ sessionId: "app", projectId: "p", cwd: "/repo" });
    const snapshot = await driver.resumeSession({ sessionId: "app", projectId: "p", cwd: "/repo", piSessionId: "pi-live", sessionFile: "/session.jsonl" });
    expect(snapshot.status).toBe("running");
    expect(resume).not.toHaveBeenCalled();
    await driver.dispose?.();
  });

  it("constructs without a real SDK runtime and reports unsupported setup errors", async () => {
    const driver = createPiSdkDriver();

    await expect(
      driver.createSession({
        sessionId: "session-1",
        projectId: "pig",
        cwd: "/Users/void/code/opensource/Pig",
      }),
    ).rejects.toMatchObject({
      name: "PiSdkDriverUnsupportedError",
      capability: "create_session",
    });
  });

  it("adapts an injected SDK runtime to the Pi Runtime Driver contract", async () => {
    const sdkEventListeners: Array<(event: PiSdkRuntimeEvent) => void> = [];
    const sendPrompt = vi.fn(async () => {});
    const stopRun = vi.fn(async () => {});
    const runtime: PiSdkSessionRuntime = {
      piSessionId: "pi-sdk-session-1",
      runtimeId: "pi-sdk:session-1",
      status: "idle",
      summary: {
        provider: "openai",
        model: "gpt-5-codex",
        totalTokens: 0,
        totalCostUsd: 0,
      },
      sendPrompt,
      stopRun,
      async getSnapshot() {
        return {
          status: "completed",
          summary: {
            provider: "openai",
            model: "gpt-5-codex",
            totalTokens: 42,
            totalCostUsd: 0.001,
          },
        };
      },
      onEvent(listener) {
        sdkEventListeners.push(listener);

        return () => {};
      },
    };
    const driver = createPiSdkDriver({
      now: () => "2026-06-29T12:00:00.000Z",
      runtimeFactory: vi.fn(async () => runtime),
    });
    const events: unknown[] = [];

    driver.onEvent((event) => {
      events.push(event);
    });

    await expect(
      driver.createSession({
        sessionId: "session-1",
        projectId: "pig",
        cwd: "/Users/void/code/opensource/Pig",
      }),
    ).resolves.toEqual({
      sessionId: "session-1",
      runtimeId: "pi-sdk:session-1",
      piSessionId: "pi-sdk-session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
      status: "idle",
      events: [],
      summary: {
        provider: "openai",
        model: "gpt-5-codex",
        totalTokens: 0,
        totalCostUsd: 0,
      },
      updatedAt: "2026-06-29T12:00:00.000Z",
    });
    await expect(
      driver.sendPrompt({
        piSessionId: "pi-sdk-session-1",
        prompt: "Build through SDK",
      }),
    ).resolves.toMatchObject({
      piSessionId: "pi-sdk-session-1",
      type: "message_update",
      payload: {
        kind: "message",
        role: "user",
        body: "Build through SDK",
        bodyFormat: "full",
        messageId: "pi-sdk:pi-sdk-session-1:user:0",
        phase: "synthetic",
      },
    });

    sdkEventListeners[0]?.({
      piSessionId: "pi-sdk-session-1",
      turnId: "turn-1",
      type: "message_update",
      payload: {
        kind: "message",
        role: "assistant",
        body: "SDK runtime event",
      },
    });

    await expect(driver.stopRun({ piSessionId: "pi-sdk-session-1" })).resolves.toMatchObject({
      piSessionId: "pi-sdk-session-1",
      type: "status",
      payload: {
        kind: "status",
        title: "Stopped",
      },
    });
    await expect(driver.getSnapshot("pi-sdk-session-1")).resolves.toMatchObject({
      status: "completed",
      summary: {
        totalTokens: 42,
        totalCostUsd: 0.001,
      },
    });
    expect(sendPrompt).toHaveBeenCalledWith("Build through SDK");
    expect(stopRun).toHaveBeenCalled();

    await expect(
      driver.sendPrompt({
        piSessionId: "pi-sdk-session-1",
        prompt: "Look at this",
        images: [{ mimeType: "image/png", data: "abc", name: "shot.png" }],
      }),
    ).resolves.toMatchObject({
      payload: {
        body: "Look at this",
        images: [{ mimeType: "image/png", data: "abc", name: "shot.png" }],
      },
    });
    expect(sendPrompt).toHaveBeenCalledWith("Look at this", [
      { mimeType: "image/png", data: "abc", name: "shot.png" },
    ]);
    expect(events).toEqual([
      {
        piSessionId: "pi-sdk-session-1",
        turnId: "turn-1",
        type: "message_update",
        payload: {
          kind: "message",
          role: "assistant",
          body: "SDK runtime event",
        },
      },
    ]);
  });

  it("returns the synthetic user message before the SDK prompt finishes", async () => {
    let resolvePrompt: (() => void) | undefined;
    const driver = createPiSdkDriver({
      runtimeFactory: async () => ({
        piSessionId: "pi-sdk-session-1",
        sendPrompt: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              resolvePrompt = resolve;
            }),
        ),
      }),
    });

    await driver.createSession({
      sessionId: "session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });

    const response = driver.sendPrompt({
      piSessionId: "pi-sdk-session-1",
      prompt: "Build through SDK",
    });

    try {
      await expect(
        Promise.race([
          response,
          new Promise((resolve) => {
            setTimeout(() => resolve("pending"), 0);
          }),
        ]),
      ).resolves.toMatchObject({
        piSessionId: "pi-sdk-session-1",
        payload: {
          kind: "message",
          role: "user",
          body: "Build through SDK",
          messageId: "pi-sdk:pi-sdk-session-1:user:0",
        },
      });
    } finally {
      resolvePrompt?.();
      await response.catch(() => undefined);
    }
  });

  it("waits for the SDK user boundary before stamping Pi entry ids", async () => {
    let resolveBoundary:
      | ((boundary: { piEntryId?: string }) => void)
      | undefined;
    let resolvePrompt: (() => void) | undefined;
    const runtime = {
      piSessionId: "pi-sdk-session-1",
      sendPrompt: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolvePrompt = resolve;
          }),
      ),
      waitForNextUserMessageBoundary: vi.fn(
        () =>
          new Promise<{ piEntryId?: string }>((resolve) => {
            resolveBoundary = resolve;
          }),
      ),
    };
    const driver = createPiSdkDriver({
      runtimeFactory: async () => runtime,
    });

    await driver.createSession({
      sessionId: "session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });

    const response = driver.sendPrompt({
      piSessionId: "pi-sdk-session-1",
      prompt: "Build through SDK",
    });

    try {
      await expect(
        Promise.race([
          response,
          new Promise((resolve) => {
            setTimeout(() => resolve("pending"), 0);
          }),
        ]),
      ).resolves.toBe("pending");

      resolveBoundary?.({ piEntryId: "pi-entry-user-1" });

      await expect(response).resolves.toMatchObject({
        payload: {
          kind: "message",
          role: "user",
          body: "Build through SDK",
          piEntryId: "pi-entry-user-1",
        },
      });
    } finally {
      resolvePrompt?.();
      await response.catch(() => undefined);
    }
  });

  it("continues synthetic user message ids from seedPromptCount after resume (DF-008)", async () => {
    const driver = createPiSdkDriver({
      runtimeResumer: async () => ({
        piSessionId: "pi-sdk-session-resumed",
        seedPromptCount: 2,
        sendPrompt: vi.fn(async () => {}),
      }),
    });

    await driver.resumeSession({
      sessionId: "session-resumed",
      projectId: "pig",
      piSessionId: "pi-sdk-session-resumed",
      cwd: "/Users/void/code/opensource/Pig",
      sessionFile: "/Users/void/.pi/session.jsonl",
    });

    await expect(
      driver.sendPrompt({
        piSessionId: "pi-sdk-session-resumed",
        prompt: "Third prompt after resume",
      }),
    ).resolves.toMatchObject({
      payload: {
        role: "user",
        body: "Third prompt after resume",
        messageId: "pi-sdk:pi-sdk-session-resumed:user:2",
      },
    });
  });

  it("matches consecutive prompts to consecutive SDK user boundaries", async () => {
    const boundaryResolvers: Array<
      (boundary: { piEntryId?: string }) => void
    > = [];
    const runtime = {
      piSessionId: "pi-sdk-session-1",
      sendPrompt: vi.fn(async () => {}),
      waitForNextUserMessageBoundary: vi.fn(
        () =>
          new Promise<{ piEntryId?: string }>((resolve) => {
            boundaryResolvers.push(resolve);
          }),
      ),
    };
    const driver = createPiSdkDriver({
      runtimeFactory: async () => runtime,
    });

    await driver.createSession({
      sessionId: "session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });

    const first = driver.sendPrompt({
      piSessionId: "pi-sdk-session-1",
      prompt: "First prompt",
    });

    boundaryResolvers.shift()?.({ piEntryId: "pi-entry-user-1" });

    await expect(first).resolves.toMatchObject({
      payload: {
        body: "First prompt",
        messageId: "pi-sdk:pi-sdk-session-1:user:0",
        piEntryId: "pi-entry-user-1",
      },
    });

    const second = driver.sendPrompt({
      piSessionId: "pi-sdk-session-1",
      prompt: "Second prompt",
    });

    boundaryResolvers.shift()?.({ piEntryId: "pi-entry-user-2" });

    await expect(second).resolves.toMatchObject({
      payload: {
        body: "Second prompt",
        messageId: "pi-sdk:pi-sdk-session-1:user:1",
        piEntryId: "pi-entry-user-2",
      },
    });
  });

  it("forks an SDK runtime and keeps the forked session addressable", async () => {
    const sendPrompt = vi.fn(async () => {});
    const runtimeForker = vi.fn(async () => ({
      selectedText: "Revise this branch",
      runtime: {
        piSessionId: "pi-session-forked",
        runtimeId: "pi-sdk:session-forked",
        cwd: "/Users/void/code/opensource/Pig",
        sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-forked.jsonl",
        sendPrompt,
      },
    }));
    const driver = createPiSdkDriver({
      now: () => "2026-07-03T12:00:00.000Z",
      runtimeForker,
    });

    await expect(
      driver.forkSession({
        sessionId: "session-forked",
        projectId: "pig",
        sourcePiSessionId: "pi-session-source",
        sourceSessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-source.jsonl",
        piEntryId: "pi-entry-user-2",
        cwd: "/Users/void/code/opensource/Pig",
      }),
    ).resolves.toEqual({
      selectedText: "Revise this branch",
      snapshot: expect.objectContaining({
        sessionId: "session-forked",
        runtimeId: "pi-sdk:session-forked",
        piSessionId: "pi-session-forked",
        projectId: "pig",
        cwd: "/Users/void/code/opensource/Pig",
        sessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-forked.jsonl",
      }),
    });
    expect(runtimeForker).toHaveBeenCalledWith({
      sessionId: "session-forked",
      projectId: "pig",
      sourcePiSessionId: "pi-session-source",
      sourceSessionFile: "/Users/void/.pi/agent/sessions/pig/pi-session-source.jsonl",
      piEntryId: "pi-entry-user-2",
      cwd: "/Users/void/code/opensource/Pig",
    });

    await driver.sendPrompt({
      piSessionId: "pi-session-forked",
      prompt: "Continue fork",
    });
    expect(sendPrompt).toHaveBeenCalledWith("Continue fork");
  });

  it("delegates queued message and steering controls to the injected SDK runtime", async () => {
    const queueFollowUp = vi.fn(async (message: string) => ({
      id: "queued-1",
      piSessionId: "pi-sdk-session-1",
      body: message,
      status: "pending" as const,
      createdAt: "2026-07-01T00:00:00.000Z",
    }));
    const withdrawQueuedMessage = vi.fn(async (queuedMessageId: string) => ({
      id: queuedMessageId,
      piSessionId: "pi-sdk-session-1",
      body: "Queue through SDK",
      status: "withdrawn" as const,
      createdAt: "2026-07-01T00:00:00.000Z",
      withdrawnAt: "2026-07-01T00:00:01.000Z",
    }));
    const steerRun = vi.fn(async () => {});
    const driver = createPiSdkDriver({
      runtimeFactory: async () => ({
        piSessionId: "pi-sdk-session-1",
        sendPrompt: async () => {},
        queueFollowUp,
        withdrawQueuedMessage,
        steerRun,
      }),
    });

    await driver.createSession({
      sessionId: "session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });

    await expect(
      driver.queueFollowUp({
        piSessionId: "pi-sdk-session-1",
        message: "Queue through SDK",
      }),
    ).resolves.toMatchObject({
      id: "queued-1",
      status: "pending",
    });
    await expect(
      driver.withdrawQueuedMessage({
        piSessionId: "pi-sdk-session-1",
        queuedMessageId: "queued-1",
      }),
    ).resolves.toMatchObject({
      id: "queued-1",
      status: "withdrawn",
    });
    await expect(
      driver.steerRun({
        piSessionId: "pi-sdk-session-1",
        message: "Steer through SDK",
      }),
    ).resolves.toMatchObject({
      piSessionId: "pi-sdk-session-1",
      type: "control",
      payload: {
        kind: "control",
        role: "user",
        title: "Steer",
        body: "Steer through SDK",
      },
    });
    expect(queueFollowUp).toHaveBeenCalledWith("Queue through SDK");
    expect(withdrawQueuedMessage).toHaveBeenCalledWith("queued-1");
    expect(steerRun).toHaveBeenCalledWith("Steer through SDK");

    const images = [{ mimeType: "image/png", data: "abc", name: "shot.png" }];

    await driver.queueFollowUp({
      piSessionId: "pi-sdk-session-1",
      message: "Queue with image",
      images,
    });
    await driver.steerRun({
      piSessionId: "pi-sdk-session-1",
      message: "Steer with image",
      images,
    });
    expect(queueFollowUp).toHaveBeenCalledWith("Queue with image", images);
    expect(steerRun).toHaveBeenCalledWith("Steer with image", images);
  });

  it("emits prompt failures as visible runtime errors instead of hidden status events", async () => {
    const driver = createPiSdkDriver({
      runtimeFactory: async () => ({
        piSessionId: "pi-sdk-session-1",
        sendPrompt: vi.fn(async () => {
          throw new Error("Provider request failed.");
        }),
      }),
    });
    const events: PiSdkRuntimeEvent[] = [];

    driver.onEvent((event) => {
      events.push(event);
    });
    await driver.createSession({
      sessionId: "session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });
    await driver.sendPrompt({
      piSessionId: "pi-sdk-session-1",
      prompt: "Trigger provider failure",
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(events).toEqual([
      {
        piSessionId: "pi-sdk-session-1",
        type: "error",
        payload: {
          kind: "error",
          title: "SDK prompt failed",
          body: "Provider request failed.",
        },
      },
    ]);
  });

  it("returns attributable unsupported errors for SDK capabilities that are not wired yet", async () => {
    const driver = createPiSdkDriver({
      runtimeFactory: async () => ({
        piSessionId: "pi-sdk-session-1",
        sendPrompt: async () => {},
      }),
    });

    await driver.createSession({
      sessionId: "session-1",
      projectId: "pig",
      cwd: "/Users/void/code/opensource/Pig",
    });

    await expect(
      driver.queueFollowUp({
        piSessionId: "pi-sdk-session-1",
        message: "Queue through SDK",
      }),
    ).rejects.toBeInstanceOf(PiSdkDriverUnsupportedError);
  });

  it("configures one model pair while idle and rejects changes during a run", async () => {
    let status: "idle" | "running" = "idle";
    let exposeLiveSnapshot = true;
    const configureModel = vi.fn(async (selection) => ({
      models: [
        {
          provider: selection.provider,
          modelId: selection.modelId,
          name: "Claude Sonnet 4",
          thinkingLevels: ["off" as const, "high" as const],
        },
      ],
      selected: { ...selection },
    }));
    const driver = createPiSdkDriver({
      runtimeFactory: async () => ({
        piSessionId: "pi-sdk-session-controls",
        sendPrompt: async () => {},
        configureModel,
        getSnapshot: async () =>
          exposeLiveSnapshot
            ? {
                status,
                summary: {
                  provider: "openai",
                  model: "gpt-5-codex",
                  totalTokens: 4_200,
                  totalCostUsd: 0.04,
                },
              }
            : { status },
      }),
    });

    await driver.createSession({
      sessionId: "session-controls",
      projectId: "pig",
      cwd: "/repo",
    });
    await expect(
      driver.configureModel?.({
        piSessionId: "pi-sdk-session-controls",
        provider: "anthropic",
        modelId: "claude-sonnet-4",
        thinkingLevel: "high",
      }),
    ).resolves.toMatchObject({
      selected: {
        provider: "anthropic",
        modelId: "claude-sonnet-4",
        thinkingLevel: "high",
      },
    });
    exposeLiveSnapshot = false;
    await expect(driver.getSnapshot("pi-sdk-session-controls")).resolves.toMatchObject({
      summary: {
        provider: "anthropic",
        model: "claude-sonnet-4",
        totalTokens: 4_200,
        totalCostUsd: 0.04,
      },
    });

    status = "running";
    await expect(
      driver.configureModel?.({
        piSessionId: "pi-sdk-session-controls",
        provider: "anthropic",
        modelId: "claude-sonnet-4",
        thinkingLevel: "off",
      }),
    ).rejects.toThrow("Model and Thinking cannot change while a run is active.");
    expect(configureModel).toHaveBeenCalledTimes(1);
  });

  it("resolves tool schemas from a live SDK runtime and returns none without one", async () => {
    const bashSchema = {
      description: "Execute a shell command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    };
    const runtime: PiSdkSessionRuntime = {
      piSessionId: "pi-sdk-session-1",
      sendPrompt: vi.fn(async () => {}),
      resolveToolSchemas: vi.fn(async (names) => {
        const schemas: Record<string, typeof bashSchema> = {};

        if (names.includes("bash")) {
          schemas.bash = bashSchema;
        }

        return { schemas };
      }),
    };
    const driver = createPiSdkDriver({
      runtimeFactory: vi.fn(async () => runtime),
    });

    await expect(
      driver.resolveToolSchemas?.({
        piSessionId: "pi-sdk-session-1",
        names: ["bash"],
      }),
    ).resolves.toEqual({ schemas: {} });

    await driver.createSession({
      sessionId: "session-1",
      projectId: "pig",
      cwd: "/repo",
    });

    await expect(
      driver.resolveToolSchemas?.({
        piSessionId: "pi-sdk-session-1",
        names: ["bash", "gone_tool"],
      }),
    ).resolves.toEqual({
      schemas: { bash: bashSchema },
    });
    expect(runtime.resolveToolSchemas).toHaveBeenCalledWith(["bash", "gone_tool"]);
  });
});
