import type {
  PiRpcResponse,
  PiRpcTransport,
  RuntimeGatewaySnapshot,
  RuntimeGatewaySummary,
  RuntimePromptImage,
} from "@pace/core";
import { toPiImageContent } from "@pace/core";
import {
  createAgentRuntimeEventNormalizer,
  type AgentRuntimeEventNormalizer,
} from "../gateway/agent-runtime-event-normalizer";
import type {
  PiRuntimeDriver,
  RuntimeGatewayDriverEvent,
} from "../gateway/runtime-gateway";

export type PiRpcProcessDriverOptions = {
  transport: PiRpcTransport;
  now?: () => string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maybeString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function defaultSummary(overrides: Partial<RuntimeGatewaySummary> = {}): RuntimeGatewaySummary {
  return {
    provider: null,
    model: null,
    totalTokens: 0,
    totalCostUsd: 0,
    ...overrides,
  };
}

function summaryFromRpcState(state: unknown): RuntimeGatewaySummary {
  if (!isRecord(state) || !isRecord(state.model)) {
    return defaultSummary();
  }

  return defaultSummary({
    provider: maybeString(state.model.provider),
    model: maybeString(state.model.id),
  });
}

function statusFromRpcState(state: unknown): RuntimeGatewaySnapshot["status"] {
  if (!isRecord(state)) {
    return "idle";
  }

  return state.isStreaming ? "running" : "idle";
}

function rpcImages(images?: RuntimePromptImage[]) {
  return images?.length ? images.map(toPiImageContent) : undefined;
}

function queuedMessageIdFromResponse(response: PiRpcResponse, fallback: string) {
  const data = isRecord(response.data) ? response.data : null;

  return (
    maybeString(data?.queuedMessageId) ??
    maybeString(data?.queueId) ??
    maybeString(data?.id) ??
    fallback
  );
}

export function createPiRpcProcessDriver(
  options: PiRpcProcessDriverOptions,
): PiRuntimeDriver {
  const now = options.now ?? (() => new Date().toISOString());
  const snapshots = new Map<string, RuntimeGatewaySnapshot>();
  // Pi RPC mode streams the same AgentSessionEvent shapes the SDK exposes, so
  // both drivers share one semantic normalizer; only the origin differs.
  const normalizers = new Map<string, AgentRuntimeEventNormalizer>();
  const listeners = new Set<(event: RuntimeGatewayDriverEvent) => void>();
  let requestCounter = 0;
  let activePiSessionId: string | null = null;

  const nextRequestId = () => {
    requestCounter += 1;

    return `runtime-gateway-rpc-${requestCounter}`;
  };
  const emit = (event: RuntimeGatewayDriverEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  options.transport.onEvent((rawEvent) => {
    const piSessionId =
      maybeString(rawEvent.piSessionId) ?? maybeString(rawEvent.sessionId) ?? activePiSessionId;
    const normalizer = piSessionId ? normalizers.get(piSessionId) : null;

    if (!piSessionId || !normalizer) {
      return;
    }

    for (const agentEvent of normalizer.normalize(rawEvent)) {
      emit({
        piSessionId,
        ...("turnId" in agentEvent && agentEvent.turnId ? { turnId: agentEvent.turnId } : {}),
        type: agentEvent.type,
        payload: { ...agentEvent },
      });
    }
  });

  return {
    hasSession: piSessionId => snapshots.has(piSessionId),
    async createSession(input) {
      const runtimeId = `pi-rpc:${input.sessionId}`;

      await options.transport.start({
        command: "pi",
        args: ["--mode", "rpc", "--session-id", input.sessionId],
        cwd: input.cwd,
      });

      const response = await options.transport.send({
        id: nextRequestId(),
        type: "get_state",
      });

      if (!response.success) {
        throw new Error(response.error ?? "Pi RPC get_state failed.");
      }

      const data = isRecord(response.data) ? response.data : {};
      const piSessionId = maybeString(data.sessionId) ?? input.sessionId;
      const snapshot: RuntimeGatewaySnapshot = {
        sessionId: input.sessionId,
        runtimeId,
        piSessionId,
        projectId: input.projectId,
        cwd: input.cwd,
        status: statusFromRpcState(response.data),
        events: [],
        summary: summaryFromRpcState(response.data),
        updatedAt: now(),
      };

      activePiSessionId = piSessionId;
      snapshots.set(piSessionId, snapshot);
      normalizers.set(
        piSessionId,
        createAgentRuntimeEventNormalizer({ piSessionId, origin: "rpc" }),
      );

      return { ...snapshot, events: [...snapshot.events], summary: { ...snapshot.summary! } };
    },

    async resumeSession() {
      throw new Error(
        'Pi RPC driver does not support "resume_session": SessionManager is only available through the SDK driver.',
      );
    },

    async forkSession() {
      throw new Error(
        'Pi RPC driver does not support "fork_session": SessionManager is only available through the SDK driver.',
      );
    },

    async sendPrompt(input) {
      normalizers.get(input.piSessionId)?.noteRunTrigger("prompt");
      const images = rpcImages(input.images);

      const response = await options.transport.send({
        id: nextRequestId(),
        type: "prompt",
        message: input.prompt,
        ...(images ? { images } : {}),
      });

      if (!response.success) {
        throw new Error(response.error ?? "Pi RPC rejected the prompt.");
      }

      return {
        piSessionId: input.piSessionId,
        type: "message_update",
        payload: {
          kind: "message",
          role: "user",
          body: input.prompt,
          ...(input.images?.length ? { images: input.images } : {}),
        },
      };
    },

    async queueFollowUp(input) {
      normalizers.get(input.piSessionId)?.noteRunTrigger("follow_up");

      const requestId = nextRequestId();
      const images = rpcImages(input.images);
      const response = await options.transport.send({
        id: requestId,
        type: "prompt",
        message: input.message,
        streamingBehavior: "followUp",
        ...(images ? { images } : {}),
      });

      if (!response.success) {
        throw new Error(response.error ?? "Pi RPC rejected the queued follow-up.");
      }

      return {
        id: queuedMessageIdFromResponse(response, `queued-${requestId}`),
        piSessionId: input.piSessionId,
        body: input.message,
        ...(input.images?.length ? { images: input.images } : {}),
        status: "pending",
        createdAt: now(),
      };
    },

    async withdrawQueuedMessage(input) {
      const response = await options.transport.send({
        id: nextRequestId(),
        type: "withdraw_follow_up",
        queuedMessageId: input.queuedMessageId,
      });

      if (!response.success) {
        throw new Error(response.error ?? "Pi RPC rejected queued message withdrawal.");
      }

      return {
        ok: true as const,
        queuedMessages: [
          {
            id: input.queuedMessageId,
            piSessionId: input.piSessionId,
            body: "",
            status: "withdrawn" as const,
            createdAt: now(),
            withdrawnAt: now(),
          },
        ],
      };
    },

    async reorderQueuedMessages() {
      throw new Error("Pi RPC driver does not support reorder_queued_messages.");
    },

    async steerFromQueue() {
      throw new Error("Pi RPC driver does not support steer_from_queue.");
    },

    async steerRun(input) {
      const images = rpcImages(input.images);
      const response = await options.transport.send({
        id: nextRequestId(),
        type: "steer",
        message: input.message,
        ...(images ? { images } : {}),
      });

      if (!response.success) {
        throw new Error(response.error ?? "Pi RPC rejected the steer input.");
      }

      return {
        piSessionId: input.piSessionId,
        type: "control",
        payload: {
          kind: "control",
          role: "user",
          title: "Steer",
          body: input.message,
          ...(input.images?.length ? { images: input.images } : {}),
        },
      };
    },

    async stopRun(input) {
      const response = await options.transport.send({
        id: nextRequestId(),
        type: "abort",
      });

      if (!response.success) {
        throw new Error(response.error ?? "Pi RPC rejected the stop request.");
      }

      return {
        piSessionId: input.piSessionId,
        type: "status",
        payload: {
          kind: "status",
          title: "Stopped",
          body: "Pi stopped the active run.",
        },
      };
    },

    async sendSubagent() {
      throw new Error('Pi RPC driver does not support "send_subagent".');
    },

    async stopSubagent() {
      throw new Error('Pi RPC driver does not support "stop_subagent".');
    },

    async configureModel() {
      throw new Error(
        'Pi RPC driver does not support "configure_model": capability discovery is only available through the SDK driver.',
      );
    },

    async getSnapshot(piSessionId) {
      const snapshot = snapshots.get(piSessionId);

      if (!snapshot) {
        throw new Error(`Pi session "${piSessionId}" was not found.`);
      }

      return {
        ...snapshot,
        events: [...snapshot.events],
        summary: snapshot.summary ? { ...snapshot.summary } : undefined,
      };
    },

    onEvent(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}
