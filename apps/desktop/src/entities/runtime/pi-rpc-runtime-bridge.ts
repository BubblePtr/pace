// Legacy RPC-backed Pi Runtime Bridge adapter. The Electron default now uses
// Runtime Gateway; this adapter remains for injected transport tests and RPC
// driver compatibility checks.

import type { PiRpcRawEvent, PiRpcResponse, PiRpcTransport } from "@pace/core";
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
} from "@/entities/runtime/pi-runtime-bridge";

type PiRpcRuntimeBridgeOptions = {
  transport: PiRpcTransport;
  now?: () => string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function maybeString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (isRecord(part) && typeof part.text === "string") {
        return part.text;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function timestampFrom(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  return fallback;
}

function summaryFromRpcState(state: unknown): PiRuntimeSummary {
  if (!isRecord(state) || !isRecord(state.model)) {
    return defaultRuntimeSummary();
  }

  return defaultRuntimeSummary({
    provider: maybeString(state.model.provider),
    model: maybeString(state.model.id),
  });
}

function numberFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function summaryFromAgentMessage(message: Record<string, unknown>): Partial<PiRuntimeSummary> | null {
  const usage = isRecord(message.usage) ? message.usage : null;
  const cost = usage && isRecord(usage.cost) ? usage.cost : null;
  const summary: Partial<PiRuntimeSummary> = {};
  const provider = maybeString(message.provider);
  const model = maybeString(message.model);
  const totalTokens = numberFrom(usage?.totalTokens);
  const totalCostUsd = numberFrom(cost?.total);

  if (provider) {
    summary.provider = provider;
  }

  if (model) {
    summary.model = model;
  }

  if (totalTokens !== null) {
    summary.totalTokens = totalTokens;
  }

  if (totalCostUsd !== null) {
    summary.totalCostUsd = totalCostUsd;
  }

  return Object.keys(summary).length ? summary : null;
}

function statusFromRpcState(state: unknown): PiSessionState["status"] {
  if (!isRecord(state)) {
    return "idle";
  }

  return state.isStreaming ? "running" : "idle";
}

function queuedMessageIdFromResponse(
  response: PiRpcResponse,
  fallback: string,
): string {
  const data = isRecord(response.data) ? response.data : null;

  return (
    maybeString(data?.queuedMessageId) ??
    maybeString(data?.queueId) ??
    maybeString(data?.id) ??
    fallback
  );
}

function serializeEventBody(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined) {
    return "";
  }

  return JSON.stringify(value);
}

function normalizeRpcEvent(input: {
  rawEvent: PiRpcRawEvent;
  piSessionId: string;
  now: () => string;
  idFactory: () => string;
}): PiRuntimeEvent | null {
  const { rawEvent, piSessionId, now, idFactory } = input;
  const timestamp = timestampFrom(rawEvent.timestamp, now());

  if (rawEvent.type === "message_update") {
    return null;
  }

  if (
    rawEvent.type === "message_start" ||
    rawEvent.type === "message_end" ||
    rawEvent.type === "turn_end"
  ) {
    const message = isRecord(rawEvent.message) ? rawEvent.message : null;
    const role = message?.role === "user" || message?.role === "assistant" ? message.role : null;
    const body = textFromContent(message?.content);

    if (!message || !role || !body) {
      return null;
    }

    return {
      id: maybeString(rawEvent.id) ?? idFactory(),
      piSessionId,
      kind: "message",
      role,
      body,
      timestamp: timestampFrom(message?.timestamp, timestamp),
      summary: summaryFromAgentMessage(message) ?? undefined,
    };
  }

  if (
    rawEvent.type === "tool_execution_start" ||
    rawEvent.type === "tool_execution_update" ||
    rawEvent.type === "tool_execution_end"
  ) {
    const detail =
      rawEvent.type === "tool_execution_end"
        ? rawEvent.result
        : rawEvent.type === "tool_execution_update"
          ? rawEvent.partialResult
          : rawEvent.args;

    const toolCallId = maybeString(rawEvent.toolCallId);

    return {
      id: maybeString(rawEvent.toolCallId) ?? idFactory(),
      piSessionId,
      kind: rawEvent.type === "tool_execution_end" ? "tool-result" : "tool-call",
      ...(toolCallId ? { toolCallId } : {}),
      title: maybeString(rawEvent.toolName) ?? "Tool call",
      body: serializeEventBody(detail),
      timestamp,
    };
  }

  if (rawEvent.type === "agent_end") {
    return {
      id: maybeString(rawEvent.id) ?? idFactory(),
      piSessionId,
      kind: "status",
      title: "Agent run ended",
      body: "Pi Runtime ended the active run.",
      timestamp,
    };
  }

  if (rawEvent.type === "error" || typeof rawEvent.error === "string") {
    return {
      id: maybeString(rawEvent.id) ?? idFactory(),
      piSessionId,
      kind: "error",
      title: "Runtime error",
      body: maybeString(rawEvent.error) ?? "Pi Runtime reported an error.",
      timestamp,
    };
  }

  return null;
}

export function createPiRpcRuntimeBridge(
  options: PiRpcRuntimeBridgeOptions,
): PiRuntimeBridge {
  const now = options.now ?? (() => new Date().toISOString());
  const runtimes = new Map<string, PiRuntimeHandle>();
  const states = new Map<string, PiSessionState>();
  const queuedMessages = new Map<string, PiQueuedMessage>();
  const listeners = new Map<string, Set<(event: PiRuntimeEvent) => void>>();
  let requestCounter = 0;
  let eventCounter = 0;
  let activePiSessionId: string | null = null;

  const nextRequestId = () => {
    requestCounter += 1;

    return `pig-rpc-${requestCounter}`;
  };
  const nextEventId = () => {
    eventCounter += 1;

    return `rpc-event-${eventCounter}`;
  };
  const notify = (event: PiRuntimeEvent) => {
    const state = states.get(event.piSessionId);

    if (state) {
      state.events = [...state.events, event];
      state.updatedAt = event.timestamp;

      if (event.kind === "error") {
        state.status = "failed";
      } else if (event.kind === "status") {
        state.status = "completed";
      } else {
        state.status = "running";
      }
    }

    for (const listener of listeners.get(event.piSessionId) ?? []) {
      listener({ ...event, summary: event.summary ? { ...event.summary } : undefined });
    }
  };

  options.transport.onEvent((rawEvent) => {
    const piSessionId =
      maybeString(rawEvent.piSessionId) ?? maybeString(rawEvent.sessionId) ?? activePiSessionId;

    if (!piSessionId) {
      return;
    }

    const event = normalizeRpcEvent({
      rawEvent,
      piSessionId,
      now,
      idFactory: nextEventId,
    });

    if (event) {
      notify(event);
    }
  });

  return {
    async startRuntime(input) {
      const runtimeId = `pi-rpc:${input.sessionId}`;

      await options.transport.start({
        command: "pi",
        args: ["--mode", "rpc", "--session-id", input.sessionId],
        cwd: input.checkout.runtimeCwd,
      });

      const runtime: PiRuntimeHandle = {
        runtimeId,
        sessionId: input.sessionId,
        projectId: input.projectId,
        checkout: input.checkout,
        status: "ready",
      };

      runtimes.set(runtimeId, runtime);

      return { ...runtime, checkout: { ...runtime.checkout } };
    },

    async createPiSessionState(input) {
      const runtime = runtimes.get(input.runtimeId);

      if (!runtime) {
        throw new PiRuntimeBridgeError({
          stage: "starting runtime",
          message: `Runtime "${input.runtimeId}" was not found.`,
        });
      }

      const response = await options.transport.send({
        id: nextRequestId(),
        type: "get_state",
      });

      if (!response.success) {
        throw new PiRuntimeBridgeError({
          stage: "starting runtime",
          message: response.error ?? "Pi RPC get_state failed.",
        });
      }

      const data = isRecord(response.data) ? response.data : {};
      const piSessionId = maybeString(data.sessionId) ?? runtime.sessionId;
      const state: PiSessionState = {
        piSessionId,
        runtimeId: input.runtimeId,
        projectId: input.projectId,
        cwd: input.cwd,
        status: statusFromRpcState(response.data),
        events: [],
        summary: summaryFromRpcState(response.data),
        updatedAt: now(),
      };

      activePiSessionId = piSessionId;
      states.set(piSessionId, state);

      return cloneSessionState(state);
    },

    async sendInitialPrompt(input) {
      const state = states.get(input.piSessionId);

      if (!state) {
        throw new PiRuntimeBridgeError({
          stage: "sending prompt",
          message: `Pi session "${input.piSessionId}" was not found.`,
        });
      }

      const requestId = nextRequestId();
      const response = await options.transport.send({
        id: requestId,
        type: "prompt",
        message: input.prompt,
        ...(input.images?.length
          ? {
              images: input.images.map((image) => ({
                type: "image",
                mimeType: image.mimeType,
                data: image.data,
              })),
            }
          : {}),
      });

      if (!response.success) {
        throw new PiRuntimeBridgeError({
          stage: "sending prompt",
          message: response.error ?? "Pi RPC rejected the initial prompt.",
        });
      }

      const event: PiRuntimeEvent = {
        id: `runtime-event-${requestId}`,
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

      const requestId = nextRequestId();
      const response = await options.transport.send({
        id: requestId,
        type: "prompt",
        message: input.message,
        streamingBehavior: "followUp",
        ...(input.images?.length
          ? {
              images: input.images.map((image) => ({
                type: "image",
                mimeType: image.mimeType,
                data: image.data,
              })),
            }
          : {}),
      });

      if (!response.success) {
        throw new PiRuntimeBridgeError({
          stage: "queuing message",
          message: response.error ?? "Pi RPC rejected the queued follow-up.",
        });
      }

      const queuedMessage: PiQueuedMessage = {
        id: queuedMessageIdFromResponse(response, `queued-${requestId}`),
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

      const response = await options.transport.send({
        id: nextRequestId(),
        type: "withdraw_follow_up",
        queuedMessageId: input.queuedMessageId,
      });

      if (!response.success) {
        throw new PiRuntimeBridgeError({
          stage: "withdrawing queued message",
          message: response.error ?? "Pi RPC rejected queued message withdrawal.",
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

      const orderedPending = [];
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
      const state = states.get(input.piSessionId);

      if (!state) {
        throw new PiRuntimeBridgeError({
          stage: "steering run",
          message: `Pi session "${input.piSessionId}" was not found.`,
        });
      }

      const requestId = nextRequestId();
      const response = await options.transport.send({
        id: requestId,
        type: "steer",
        message: input.message,
        ...(input.images?.length
          ? {
              images: input.images.map((image) => ({
                type: "image",
                mimeType: image.mimeType,
                data: image.data,
              })),
            }
          : {}),
      });

      if (!response.success) {
        throw new PiRuntimeBridgeError({
          stage: "steering run",
          message: response.error ?? "Pi RPC rejected the steer input.",
        });
      }

      const event: PiRuntimeEvent = {
        id: `runtime-event-${requestId}`,
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
      const state = states.get(input.piSessionId);

      if (!state) {
        throw new PiRuntimeBridgeError({
          stage: "stopping run",
          message: `Pi session "${input.piSessionId}" was not found.`,
        });
      }

      const requestId = nextRequestId();
      const response = await options.transport.send({
        id: requestId,
        type: "abort",
      });

      if (!response.success) {
        throw new PiRuntimeBridgeError({
          stage: "stopping run",
          message: response.error ?? "Pi RPC rejected the stop request.",
        });
      }

      const event: PiRuntimeEvent = {
        id: `runtime-event-${requestId}`,
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
