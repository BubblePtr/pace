// In-memory Pi Runtime Bridge adapter — a transport-free implementation of the
// PiRuntimeBridge port. The composition root (pi-runtime-factory.ts) selects it
// as the non-Electron fallback, and tests drive it directly. It ships: this is a
// real adapter, not a test-only double.

import {
  PiRuntimeBridgeError,
  cloneSessionState,
  defaultRuntimeSummary,
  type PiQueuedMessage,
  type PiRuntimeBridge,
  type PiRuntimeEvent,
  type PiRuntimeHandle,
  type PiRuntimeSummary,
  type PiSessionState,
  type RuntimeBridgeFailureStage,
} from "@/entities/runtime/pi-runtime-bridge";

export type InMemoryPiRuntimeBridge = PiRuntimeBridge & {
  restoreSessionState(state: PiSessionState): Promise<PiSessionState>;
};

type InMemoryBridgeFailurePoint =
  | "start-runtime"
  | "create-pi-session-state"
  | "send-initial-prompt"
  | "steer-run"
  | "stop-run";

export type InMemoryPiRuntimeBridgeOptions = {
  now?: () => string;
  failAt?: InMemoryBridgeFailurePoint;
  failureMessage?: string;
  summary?: Partial<PiRuntimeSummary>;
};

export function createInMemoryPiRuntimeBridge(
  options: InMemoryPiRuntimeBridgeOptions = {},
): InMemoryPiRuntimeBridge {
  const now = options.now ?? (() => new Date().toISOString());
  const summary = defaultRuntimeSummary(options.summary);
  const runtimes = new Map<string, PiRuntimeHandle>();
  const states = new Map<string, PiSessionState>();
  const queuedMessages = new Map<string, PiQueuedMessage>();
  const listeners = new Map<string, Set<(event: PiRuntimeEvent) => void>>();
  let runtimeCounter = 0;
  let sessionCounter = 0;
  let eventCounter = 0;
  let queuedMessageCounter = 0;

  const fail = (stage: RuntimeBridgeFailureStage): never => {
    throw new PiRuntimeBridgeError({
      stage,
      message: options.failureMessage ?? `Fake Pi Runtime Bridge failed while ${stage}.`,
    });
  };

  return {
    async startRuntime(input) {
      if (options.failAt === "start-runtime") {
        fail("starting runtime");
      }

      runtimeCounter += 1;
      const runtime: PiRuntimeHandle = {
        runtimeId: `runtime-${runtimeCounter}`,
        sessionId: input.sessionId,
        projectId: input.projectId,
        checkout: input.checkout,
        status: "ready",
      };

      runtimes.set(runtime.runtimeId, runtime);

      return { ...runtime, checkout: { ...runtime.checkout } };
    },

    async createPiSessionState(input) {
      if (options.failAt === "create-pi-session-state") {
        fail("starting runtime");
      }

      if (!runtimes.has(input.runtimeId)) {
        throw new PiRuntimeBridgeError({
          stage: "starting runtime",
          message: `Runtime "${input.runtimeId}" was not found.`,
        });
      }

      sessionCounter += 1;
      const state: PiSessionState = {
        piSessionId: `pi-session-${sessionCounter}`,
        runtimeId: input.runtimeId,
        projectId: input.projectId,
        cwd: input.cwd,
        status: "idle",
        events: [],
        summary,
        updatedAt: now(),
      };

      states.set(state.piSessionId, state);

      return cloneSessionState(state);
    },

    async sendInitialPrompt(input) {
      if (options.failAt === "send-initial-prompt") {
        fail("sending prompt");
      }

      const state = states.get(input.piSessionId);

      if (!state) {
        throw new PiRuntimeBridgeError({
          stage: "sending prompt",
          message: `Pi session "${input.piSessionId}" was not found.`,
        });
      }

      eventCounter += 1;
      const event: PiRuntimeEvent = {
        id: `runtime-event-${eventCounter}`,
        piSessionId: input.piSessionId,
        kind: "message",
        role: "user",
        body: input.prompt,
        ...(input.images?.length ? { images: input.images } : {}),
        timestamp: now(),
      };

      state.status = "running";
      state.updatedAt = event.timestamp;
      state.events = [...state.events, event];

      return {
        accepted: true,
        piSessionId: input.piSessionId,
        event: { ...event },
      };
    },

    async queueFollowUp(input) {
      const state = states.get(input.piSessionId);

      if (!state) {
        throw new PiRuntimeBridgeError({
          stage: "queuing message",
          message: `Pi session "${input.piSessionId}" was not found.`,
        });
      }

      queuedMessageCounter += 1;
      const queuedMessage: PiQueuedMessage = {
        id: `queued-message-${queuedMessageCounter}`,
        piSessionId: input.piSessionId,
        body: input.message,
        ...(input.images?.length ? { images: input.images } : {}),
        status: "pending",
        createdAt: now(),
      };

      queuedMessages.set(queuedMessage.id, queuedMessage);

      return { ...queuedMessage };
    },

    async withdrawQueuedMessage(input) {
      const queuedMessage = queuedMessages.get(input.queuedMessageId);

      if (!queuedMessage || queuedMessage.piSessionId !== input.piSessionId) {
        throw new PiRuntimeBridgeError({
          stage: "withdrawing queued message",
          message: `Queued message "${input.queuedMessageId}" was not found.`,
        });
      }

      if (queuedMessage.status !== "pending") {
        throw new PiRuntimeBridgeError({
          stage: "withdrawing queued message",
          message: "Queued message can no longer be withdrawn.",
        });
      }

      const withdrawnMessage: PiQueuedMessage = {
        ...queuedMessage,
        status: "withdrawn",
        withdrawnAt: now(),
      };

      queuedMessages.set(withdrawnMessage.id, withdrawnMessage);

      return {
        ok: true as const,
        queuedMessages: [...queuedMessages.values()]
          .filter((message) => message.piSessionId === input.piSessionId)
          .map((message) => ({ ...message })),
      };
    },

    async reorderQueuedMessages(input) {
      const pending = [...queuedMessages.values()].filter(
        (message) => message.piSessionId === input.piSessionId && message.status === "pending",
      );
      const pendingIds = new Set(pending.map((message) => message.id));

      if (
        input.orderedIds.length !== pending.length ||
        new Set(input.orderedIds).size !== input.orderedIds.length
      ) {
        throw new PiRuntimeBridgeError({
          stage: "reordering queued messages",
          message: "Queued message order must list each pending follow-up exactly once.",
        });
      }

      const orderedPending: PiQueuedMessage[] = [];
      for (const id of input.orderedIds) {
        const queuedMessage = queuedMessages.get(id);
        if (!queuedMessage || !pendingIds.has(id)) {
          throw new PiRuntimeBridgeError({
            stage: "reordering queued messages",
            message: `Queued message "${id}" was not found.`,
          });
        }
        orderedPending.push(queuedMessage);
      }
      for (const message of orderedPending) {
        queuedMessages.delete(message.id);
      }
      for (const message of orderedPending) {
        queuedMessages.set(message.id, message);
      }

      return {
        ok: true as const,
        queuedMessages: [...queuedMessages.values()]
          .filter((message) => message.piSessionId === input.piSessionId)
          .map((message) => ({ ...message })),
      };
    },

    async steerRun(input) {
      if (options.failAt === "steer-run") {
        fail("steering run");
      }

      const state = states.get(input.piSessionId);

      if (!state) {
        throw new PiRuntimeBridgeError({
          stage: "steering run",
          message: `Pi session "${input.piSessionId}" was not found.`,
        });
      }

      eventCounter += 1;
      const event: PiRuntimeEvent = {
        id: `runtime-event-${eventCounter}`,
        piSessionId: input.piSessionId,
        kind: "control",
        role: "user",
        title: "Steer",
        body: input.message,
        ...(input.images?.length ? { images: input.images } : {}),
        timestamp: now(),
      };

      state.status = "running";
      state.updatedAt = event.timestamp;
      state.events = [...state.events, event];

      return { ...event };
    },

    async abortRun(input) {
      if (options.failAt === "stop-run") {
        fail("stopping run");
      }

      const state = states.get(input.piSessionId);

      if (!state) {
        throw new PiRuntimeBridgeError({
          stage: "stopping run",
          message: `Pi session "${input.piSessionId}" was not found.`,
        });
      }

      eventCounter += 1;
      const event: PiRuntimeEvent = {
        id: `runtime-event-${eventCounter}`,
        piSessionId: input.piSessionId,
        kind: "status",
        title: "Stopped",
        body: "Pi stopped the active run.",
        timestamp: now(),
      };

      state.status = "completed";
      state.updatedAt = event.timestamp;
      state.events = [...state.events, event];

      return { ...event };
    },

    async getSessionState(piSessionId) {
      const state = states.get(piSessionId);

      if (!state) {
        throw new PiRuntimeBridgeError({
          stage: "starting runtime",
          message: `Pi session "${piSessionId}" was not found.`,
        });
      }

      return cloneSessionState(state);
    },

    async prepareChatWorkspace(input) {
      return { cwd: `/tmp/pigui-chats/${input.sessionId}` };
    },

    async restoreSessionState(state) {
      const restoredState = cloneSessionState(state);

      states.set(restoredState.piSessionId, restoredState);

      return cloneSessionState(restoredState);
    },

    subscribeToEvents(piSessionId, listener) {
      const sessionListeners = listeners.get(piSessionId) ?? new Set();

      sessionListeners.add(listener);
      listeners.set(piSessionId, sessionListeners);

      return () => {
        sessionListeners.delete(listener);
      };
    },
  };
}
