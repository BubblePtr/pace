import { describe, expect, it, vi } from "vitest";
import { createInMemoryPiRuntimeBridge } from "@/entities/runtime/in-memory-pi-runtime-bridge";
import { createExecutionCheckoutManager } from "@/entities/checkout/execution-checkout";
import type {
  AgentRuntimeEventEntry,
  PiRuntimeBridge,
  PiRuntimeEvent,
} from "@/entities/runtime/pi-runtime-bridge";
import {
  createInMemorySessionProjectionStore,
  createSessionFromDraft,
} from "@/entities/session/session-creation";

describe("Session Creation state machine", () => {
  it("feeds the structured runtime model when the bridge exposes the Agent Runtime Event stream", async () => {
    const projections = createInMemorySessionProjectionStore();
    const agentListeners = new Set<(entry: AgentRuntimeEventEntry) => void>();
    const emitAgentEvent = (entry: AgentRuntimeEventEntry) => {
      for (const listener of agentListeners) {
        listener(entry);
      }
    };
    const bridge: PiRuntimeBridge = {
      async startRuntime(input) {
        return {
          runtimeId: "runtime-1",
          sessionId: input.sessionId,
          projectId: input.projectId,
          checkout: input.checkout,
          status: "ready",
        };
      },
      async createPiSessionState(input) {
        return {
          piSessionId: "pi-session-1",
          runtimeId: input.runtimeId,
          projectId: input.projectId,
          cwd: input.cwd,
          status: "idle",
          events: [],
          updatedAt: "2026-07-02T10:00:00.000Z",
        };
      },
      async sendInitialPrompt(input) {
        return {
          accepted: true,
          piSessionId: input.piSessionId,
          event: {
            id: "user-echo-1",
            piSessionId: input.piSessionId,
            kind: "message",
            role: "user",
            body: input.prompt,
            timestamp: "2026-07-02T10:00:00.500Z",
          },
        };
      },
      queueFollowUp: () => Promise.reject(new Error("unused")),
      withdrawQueuedMessage: () => Promise.reject(new Error("unused")),
      reorderQueuedMessages: () => Promise.reject(new Error("unused")),
      steerFromQueue: () => Promise.reject(new Error("unused")),
      steerRun: () => Promise.reject(new Error("unused")),
      abortRun: () => Promise.reject(new Error("unused")),
      getSessionState: () => Promise.reject(new Error("unused")),
      subscribeToEvents: () => () => {},
      subscribeToAgentEvents(_piSessionId, listener) {
        agentListeners.add(listener);

        return () => {
          agentListeners.delete(listener);
        };
      },
    };

    const result = await createSessionFromDraft({
      bridge,
      projections,
      draft: {
        projectId: "pig",
        prompt: "Ship the slice",
        updatedAt: "2026-07-02T10:00:00.000Z",
      },
      project: {
        id: "pig",
        projectRoot: "/Users/void/code/opensource/Pig",
      },
      now: () => "2026-07-02T10:00:00.000Z",
      idFactory: () => "session-1",
    });

    const runId = "pi-session-1:run-1";

    emitAgentEvent({
      seq: 1,
      timestamp: "2026-07-02T10:00:01.000Z",
      event: {
        type: "run",
        runId,
        phase: "start",
        trigger: "prompt",
        surface: "hidden",
        origin: "sdk",
      },
    });

    expect(projections.get("session-1")?.status).toBe("running");
    expect(projections.get("session-1")?.runtimeModel.runs.get(runId)).toMatchObject({
      trigger: "prompt",
    });

    if (!result.ok) {
      throw new Error("expected session creation to succeed");
    }

    // Unsubscribing tears down both the legacy and the agent event streams.
    result.unsubscribeRuntimeEvents();
    emitAgentEvent({
      seq: 2,
      timestamp: "2026-07-02T10:00:02.000Z",
      event: {
        type: "run",
        runId,
        phase: "end",
        trigger: "prompt",
        outcome: "completed",
        surface: "hidden",
        origin: "sdk",
      },
    });

    expect(projections.get("session-1")?.status).toBe("running");
  });

  it("submits a draft into a resumable Live Session through the fake Pi Runtime Bridge", async () => {
    const projections = createInMemorySessionProjectionStore();
    const observedStages: string[] = [];

    const result = await createSessionFromDraft({
      bridge: createInMemoryPiRuntimeBridge({
        now: () => "2026-06-26T08:00:03.000Z",
      }),
      projections,
      draft: {
        projectId: "pig",
        prompt: "Create a resumable live session",
        updatedAt: "2026-06-26T08:00:00.000Z",
      },
      project: {
        id: "pig",
        repoRoot: "/Users/void/code/opensource/Pig",
        projectRoot: "/Users/void/code/opensource/Pig",
      },
      now: () => "2026-06-26T08:00:00.000Z",
      idFactory: () => "session-1",
      onProjectionChange: (projection) => {
        observedStages.push(projection.creationStage);
      },
    });

    expect(result).toMatchObject({
      ok: true,
      clearDraft: true,
      projection: {
        id: "session-1",
        projectId: "pig",
        status: "running",
        creationStage: "accepted",
        checkout: {
          mode: "foreground-local",
          root: "/Users/void/code/opensource/Pig",
          runtimeCwd: "/Users/void/code/opensource/Pig",
        },
        runtimeId: "runtime-1",
        piSessionId: "pi-session-1",
        runtimeEvents: [
          expect.objectContaining({
            kind: "message",
            role: "user",
            body: "Create a resumable live session",
          }),
        ],
      },
    });
    expect(projections.get("session-1")).toEqual(result.projection);
    expect(observedStages).toEqual([
      "preparing checkout",
      "preparing checkout",
      "starting runtime",
      "sending prompt",
      "accepted",
    ]);
  });

  it("forwards image attachments on the first prompt and mirrors them into the runtime model", async () => {
    const projections = createInMemorySessionProjectionStore();
    const images = [{ mimeType: "image/png", data: "abc", name: "shot.png" }];

    const result = await createSessionFromDraft({
      bridge: createInMemoryPiRuntimeBridge({
        now: () => "2026-06-26T08:00:03.000Z",
      }),
      projections,
      draft: {
        projectId: "pig",
        prompt: "Look at this",
        updatedAt: "2026-06-26T08:00:00.000Z",
      },
      project: {
        id: "pig",
        projectRoot: "/Users/void/code/opensource/Pig",
      },
      images,
      now: () => "2026-06-26T08:00:00.000Z",
      idFactory: () => "session-image",
    });

    if (!result.ok) {
      throw new Error("expected session creation to succeed");
    }

    expect(result.projection.runtimeEvents[0]).toMatchObject({
      kind: "message",
      role: "user",
      body: "Look at this",
      images,
    });
    expect(
      [...result.projection.runtimeModel.messages.values()][0],
    ).toMatchObject({
      role: "user",
      parts: [
        { partType: "text", body: "Look at this" },
        {
          partType: "image",
          body: "data:image/png;base64,abc",
          name: "shot.png",
        },
      ],
    });
  });

  it("keeps Session Projection in sync with the Runtime Event Stream", async () => {
    const projections = createInMemorySessionProjectionStore();
    const inner = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-26T08:00:00.000Z",
      summary: {
        provider: "openai",
        model: "gpt-5-codex",
      },
    });
    const listeners = new Set<(event: PiRuntimeEvent) => void>();
    const bridge: PiRuntimeBridge = {
      ...inner,
      subscribeToEvents(piSessionId, listener) {
        const unsubscribe = inner.subscribeToEvents(piSessionId, listener);
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
          unsubscribe();
        };
      },
    };
    const emit = (event: PiRuntimeEvent) => {
      for (const listener of listeners) {
        listener(event);
      }
    };

    const result = await createSessionFromDraft({
      bridge,
      projections,
      draft: {
        projectId: "pig",
        prompt: "Create a resumable live session",
        updatedAt: "2026-06-26T08:00:00.000Z",
      },
      project: {
        id: "pig",
        repoRoot: "/Users/void/code/opensource/Pig",
        projectRoot: "/Users/void/code/opensource/Pig",
      },
      now: () => "2026-06-26T08:00:00.000Z",
      idFactory: () => "session-1",
    });

    if (!result.ok) {
      throw new Error("expected session creation to succeed");
    }

    emit({
      id: "runtime-event-assistant",
      piSessionId: result.projection.piSessionId!,
      kind: "message",
      role: "assistant",
      body: "Live session is ready.",
      timestamp: "2026-06-26T08:00:04.000Z",
      summary: {
        provider: "openai",
        model: "gpt-5-codex",
        totalTokens: 1280,
        totalCostUsd: 0.012345,
      },
    });
    emit({
      id: "runtime-event-tool",
      piSessionId: result.projection.piSessionId!,
      kind: "tool-call",
      title: "read",
      body: "{\"path\":\"AGENTS.md\"}",
      timestamp: "2026-06-26T08:00:05.000Z",
    });

    expect(result).toMatchObject({
      ok: true,
      projection: {
        summary: {
          provider: "openai",
          model: "gpt-5-codex",
        },
      },
    });
    expect(projections.get("session-1")).toMatchObject({
      runtimeEvents: [
        expect.objectContaining({
          kind: "message",
          role: "user",
          body: "Create a resumable live session",
        }),
        expect.objectContaining({
          kind: "message",
          role: "assistant",
          body: "Live session is ready.",
        }),
        expect.objectContaining({
          kind: "tool-call",
          title: "read",
          body: "{\"path\":\"AGENTS.md\"}",
        }),
      ],
      summary: {
        provider: "openai",
        model: "gpt-5-codex",
        totalTokens: 1280,
        totalCostUsd: 0.012345,
      },
      updatedAt: "2026-06-26T08:00:05.000Z",
    });
    expect(
      projections
        .get("session-1")
        ?.runtimeEvents.filter((event) => event.role === "assistant"),
    ).toHaveLength(1);

    result.unsubscribeRuntimeEvents();
    emit({
      id: "runtime-event-after-dispose",
      piSessionId: result.projection.piSessionId!,
      kind: "tool-call",
      title: "write",
      body: "{\"path\":\"README.md\"}",
      timestamp: "2026-06-26T08:00:06.000Z",
    });

    expect(projections.get("session-1")?.runtimeEvents).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "write",
        }),
      ]),
    );
  });

  it("keeps multiple Sessions active for one Project and isolates background concurrent checkouts", async () => {
    const projections = createInMemorySessionProjectionStore();
    const bridge = createInMemoryPiRuntimeBridge({
      now: () => "2026-06-27T08:00:03.000Z",
    });
    const createdWorktrees: string[] = [];
    const checkoutManager = createExecutionCheckoutManager({
      worktreesRoot: "/tmp/pig-worktrees",
      gitClient: {
        async isGitRepository() {
          return true;
        },
        async addDetachedWorktree({ checkoutRoot }) {
          createdWorktrees.push(checkoutRoot);
        },
      },
    });
    const project = {
      id: "pig",
      repoRoot: "/Users/void/code/opensource/Pig",
      projectRoot: "/Users/void/code/opensource/Pig/packages/web",
    };

    const foreground = await createSessionFromDraft({
      bridge,
      projections,
      checkoutManager,
      executionMode: "foreground",
      draft: {
        projectId: "pig",
        prompt: "Run in the local checkout",
        updatedAt: "2026-06-27T08:00:00.000Z",
      },
      project,
      now: () => "2026-06-27T08:00:00.000Z",
      idFactory: () => "session-local",
    });
    const background = await createSessionFromDraft({
      bridge,
      projections,
      checkoutManager,
      executionMode: "background",
      draft: {
        projectId: "pig",
        prompt: "Run in an isolated worktree",
        updatedAt: "2026-06-27T08:01:00.000Z",
      },
      project,
      now: () => "2026-06-27T08:01:00.000Z",
      idFactory: () => "session-background",
    });

    expect(foreground).toMatchObject({
      ok: true,
      projection: {
        status: "running",
        checkout: {
          mode: "foreground-local",
          executionCheckoutRoot: "/Users/void/code/opensource/Pig",
          runtimeCwd: "/Users/void/code/opensource/Pig/packages/web",
        },
      },
    });
    expect(background).toMatchObject({
      ok: true,
      projection: {
        status: "running",
        checkout: {
          mode: "managed-worktree",
          projectRelativePath: "packages/web",
          executionCheckoutRoot: "/tmp/pig-worktrees/session-background",
          runtimeCwd: "/tmp/pig-worktrees/session-background/packages/web",
        },
      },
    });
    expect(createdWorktrees).toEqual(["/tmp/pig-worktrees/session-background"]);
    expect(
      projections
        .list()
        .filter((projection) => projection.projectId === "pig" && projection.status === "running"),
    ).toHaveLength(2);
  });

  it("prepares a chat workspace cwd and uses a foreground-local checkout", async () => {
    const projections = createInMemorySessionProjectionStore();
    const prepareChatWorkspace = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      cwd: `/tmp/pigui-chats/${sessionId}`,
    }));
    const bridge = createInMemoryPiRuntimeBridge({
      now: () => "2026-09-07T08:00:03.000Z",
    });
    bridge.prepareChatWorkspace = prepareChatWorkspace;

    const result = await createSessionFromDraft({
      bridge,
      projections,
      executionMode: "background",
      draft: {
        projectId: "chat",
        prompt: "What is a monad?",
        updatedAt: "2026-09-07T08:00:00.000Z",
      },
      project: {
        id: "chat",
        projectRoot: "chat",
      },
      now: () => "2026-09-07T08:00:00.000Z",
      idFactory: () => "session-chat-1",
    });

    expect(prepareChatWorkspace).toHaveBeenCalledWith({ sessionId: "session-chat-1" });
    expect(result).toMatchObject({
      ok: true,
      projection: {
        id: "session-chat-1",
        projectId: "chat",
        checkout: {
          mode: "foreground-local",
          root: "/tmp/pigui-chats/session-chat-1",
          runtimeCwd: "/tmp/pigui-chats/session-chat-1",
        },
      },
    });
  });

  it("builds a non-git chat checkout even when the checkout manager reports git=true", async () => {
    const projections = createInMemorySessionProjectionStore();
    const isGitRepository = vi.fn(async () => true);
    const checkoutManager = createExecutionCheckoutManager({
      gitClient: {
        isGitRepository,
        async addDetachedWorktree() {},
      },
    });
    const prepareChatWorkspace = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      cwd: `/tmp/pigui-chats/${sessionId}`,
    }));
    const bridge = createInMemoryPiRuntimeBridge({
      now: () => "2026-09-07T08:00:03.000Z",
    });
    bridge.prepareChatWorkspace = prepareChatWorkspace;

    const result = await createSessionFromDraft({
      bridge,
      projections,
      checkoutManager,
      executionMode: "background",
      draft: {
        projectId: "chat",
        prompt: "What is a monad?",
        updatedAt: "2026-09-07T08:00:00.000Z",
      },
      project: {
        id: "chat",
        projectRoot: "chat",
      },
      now: () => "2026-09-07T08:00:00.000Z",
      idFactory: () => "session-chat-git",
    });

    expect(result).toMatchObject({
      ok: true,
      projection: {
        checkout: {
          mode: "foreground-local",
          root: "/tmp/pigui-chats/session-chat-git",
          runtimeCwd: "/tmp/pigui-chats/session-chat-git",
        },
      },
    });
    if (!result.ok) {
      throw new Error("expected session creation to succeed");
    }
    expect(result.projection.checkout?.repoRoot).toBeUndefined();
    expect(result.projection.checkout?.diffRoot).toBeUndefined();
    expect(isGitRepository).not.toHaveBeenCalled();
  });

  it.each([
    ["start-runtime", "starting runtime"],
    ["create-pi-session-state", "starting runtime"],
    ["send-initial-prompt", "sending prompt"],
  ] as const)(
    "keeps the draft recoverable and records failure detail when %s fails",
    async (failAt, failureStage) => {
      const projections = createInMemorySessionProjectionStore();
      const observedStages: string[] = [];

      const result = await createSessionFromDraft({
        bridge: createInMemoryPiRuntimeBridge({
          failAt,
          failureMessage: `Failure while ${failureStage}`,
        }),
        projections,
        draft: {
          projectId: "pig",
          prompt: "Create a resumable live session",
          updatedAt: "2026-06-26T08:00:00.000Z",
        },
        project: {
          id: "pig",
          repoRoot: "/Users/void/code/opensource/Pig",
          projectRoot: "/Users/void/code/opensource/Pig",
        },
        now: () => "2026-06-26T08:00:00.000Z",
        idFactory: () => `session-${failAt}`,
        onProjectionChange: (projection) => {
          observedStages.push(projection.creationStage);
        },
      });

      expect(result).toMatchObject({
        ok: false,
        clearDraft: false,
        projection: {
          id: `session-${failAt}`,
          projectId: "pig",
          initialPrompt: "Create a resumable live session",
          status: "failed",
          creationStage: "failed",
          failure: {
            stage: failureStage,
            message: `Failure while ${failureStage}`,
          },
        },
      });
      expect(projections.get(`session-${failAt}`)).toEqual(result.projection);
      expect(observedStages[observedStages.length - 1]).toBe("failed");
    },
  );
});
