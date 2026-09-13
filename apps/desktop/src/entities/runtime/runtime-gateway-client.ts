import type {
  PrepareChatWorkspaceResult,
  AddLocalResourceInput,
  AddLocalResourceResult,
  PackageSourceInput,
  UpdatePackageInput,
  SetResourceEnabledInput,
  PackageActionResult,
  RemovePackageResult,
  CheckPackageUpdatesResult,
  RuntimeGatewayEventEnvelope,
  RuntimeGatewayQueuedMessage,
  RuntimeGatewaySnapshot,
  RuntimeGatewaySummary,
  RuntimeModelControls,
} from "@pace/core";
import { clonePromptImages, parseRuntimePromptImages } from "@pace/core";
import type { BackendRpcEvent } from "@pace/backend";
import {
  PiRuntimeBridgeError,
  cloneSessionState,
  defaultRuntimeSummary,
  type AgentRuntimeEventEntry,
  type PiQueuedMessage,
  type PiRuntimeBridge,
  type PiRuntimeEvent,
  type PiRuntimeHandle,
  type PiRuntimeSummary,
  type PiSessionState,
  type SessionReplayEntry,
} from "@/entities/runtime/pi-runtime-bridge";
import type { AgentRuntimeEvent } from "@pace/core";
import { invoke as invokeRuntime, onBackendEvent as onRuntimeBackendEvent } from "@/shared/runtime";

type InvokeGatewayMethod = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;
type SubscribeBackendEvent = (listener: (event: BackendRpcEvent) => void) => () => void;

type ForkRuntimeGatewayResult = {
  snapshot: RuntimeGatewaySnapshot;
  selectedText?: string;
};

export type RuntimeGatewayClientOptions = {
  invoke?: InvokeGatewayMethod;
  onBackendEvent?: SubscribeBackendEvent;
  now?: () => string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function maybeString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
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

function eventKindFromEnvelope(
  envelope: RuntimeGatewayEventEnvelope,
): PiRuntimeEvent["kind"] {
  const kind = isRecord(envelope.payload) ? envelope.payload.kind : null;

  if (
    kind === "message" ||
    kind === "thinking" ||
    kind === "tool-call" ||
    kind === "tool-result" ||
    kind === "error" ||
    kind === "usage" ||
    kind === "status" ||
    kind === "control"
  ) {
    return kind;
  }

  if (envelope.type === "tool_execution_update") {
    return "tool-call";
  }

  if (envelope.type === "error") {
    return "error";
  }

  if (envelope.type === "status") {
    return "status";
  }

  return "message";
}

function runtimeSummaryFromGateway(
  summary: RuntimeGatewaySummary | Partial<RuntimeGatewaySummary> | undefined,
): PiRuntimeSummary | undefined {
  if (!summary) {
    return undefined;
  }

  return defaultRuntimeSummary(summary);
}

function partialSummaryFromPayload(value: unknown): Partial<PiRuntimeSummary> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const summary: Partial<PiRuntimeSummary> = {};

  if (typeof value.provider === "string" || value.provider === null) {
    summary.provider = value.provider;
  }

  if (typeof value.model === "string" || value.model === null) {
    summary.model = value.model;
  }

  if (typeof value.totalTokens === "number" && Number.isFinite(value.totalTokens)) {
    summary.totalTokens = value.totalTokens;
  }

  if (typeof value.totalCostUsd === "number" && Number.isFinite(value.totalCostUsd)) {
    summary.totalCostUsd = value.totalCostUsd;
  }

  return Object.keys(summary).length ? summary : undefined;
}

function runtimeEventFromEnvelope(envelope: RuntimeGatewayEventEnvelope): PiRuntimeEvent {
  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  const event: PiRuntimeEvent = {
    id: envelope.id,
    piSessionId: envelope.piSessionId,
    kind: eventKindFromEnvelope(envelope),
    body: serializeEventBody(payload.body),
    timestamp: maybeString(payload.timestamp) ?? envelope.ts,
  };
  const role = maybeString(payload.role);
  const title = maybeString(payload.title);
  const messageId = maybeString(payload.messageId);
  const piEntryId = maybeString(payload.piEntryId);
  const toolCallId = maybeString(payload.toolCallId);
  const bodyFormat = maybeString(payload.bodyFormat);
  const phase = maybeString(payload.phase);
  const summary = partialSummaryFromPayload(payload.summary);

  if (messageId) {
    event.messageId = messageId;
  }

  if (piEntryId) {
    event.piEntryId = piEntryId;
  }

  if (toolCallId) {
    event.toolCallId = toolCallId;
  }

  if (role === "user" || role === "assistant") {
    event.role = role;
  }

  if (title) {
    event.title = title;
  }

  if (summary) {
    event.summary = summary;
  }

  if (bodyFormat === "full" || bodyFormat === "delta") {
    event.bodyFormat = bodyFormat;
  }

  if (phase === "partial" || phase === "delta" || phase === "final") {
    event.phase = phase;
  }

  const images = parseRuntimePromptImages(payload.images);

  if (images.length) {
    event.images = images;
  }

  return event;
}

// —— Agent Runtime Event Model compatibility ——
// The Gateway now carries AgentRuntimeEvent payloads (ADR-0020). Until the
// projection consumes the new model directly, this mapper folds them back
// into the legacy PiRuntimeEvent shapes the current UI understands. Hidden
// lifecycle events (run/turn/message boundaries, queue, usage) return null.

type AgentEventCompatMapper = (
  envelope: RuntimeGatewayEventEnvelope,
) => PiRuntimeEvent | null;

function isAgentRuntimeEventPayload(payload: unknown): payload is Record<string, unknown> {
  return (
    isRecord(payload) &&
    typeof payload.type === "string" &&
    (payload.origin === "sdk" || payload.origin === "rpc")
  );
}

const AGENT_STATUS_TITLES: Record<string, string> = {
  retrying: "Retrying",
  retry_succeeded: "Retry complete",
  retry_failed: "Retry failed",
  compacting: "Compacting",
  compaction_done: "Compaction complete",
  compaction_aborted: "Compaction interrupted",
  runtime_unavailable: "Runtime unavailable",
  first_token_timeout: "Model timeout",
  model_changed: "Model changed",
  thinking_level_changed: "Thinking level changed",
};

function createAgentEventCompatMapper(): AgentEventCompatMapper {
  const partBodies = new Map<string, string>();

  const mapAgentEnvelope: AgentEventCompatMapper = (envelope) => {
    const payload = isRecord(envelope.payload) ? envelope.payload : {};

    if (payload.type === "message_part") {
      const partType = maybeString(payload.partType);
      const messageId = maybeString(payload.messageId);
      const partId = maybeString(payload.partId);

      // tool_call parts stay hidden here: the tool execution events carry the
      // legacy tool-call/tool-result projection.
      if (partType === "tool_call" || partType === "image" || !messageId || !partId) {
        return null;
      }

      const key = `${envelope.piSessionId}\u0000${partId}`;
      const fragment = maybeString(payload.body) ?? "";
      const body =
        payload.bodyMode === "delta" ? (partBodies.get(key) ?? "") + fragment : fragment;

      partBodies.set(key, body);

      if (!body) {
        return null;
      }

      return {
        id: envelope.id,
        piSessionId: envelope.piSessionId,
        kind: partType === "thinking" ? "thinking" : "message",
        role: "assistant",
        messageId,
        body,
        bodyFormat: "full",
        phase: payload.phase === "end" ? "final" : "delta",
        timestamp: envelope.ts,
      };
    }

    if (payload.type === "tool") {
      const toolCallId = maybeString(payload.toolCallId);
      const isStart = payload.phase === "start";
      const event: PiRuntimeEvent = {
        id: envelope.id,
        piSessionId: envelope.piSessionId,
        kind: isStart ? "tool-call" : "tool-result",
        title: maybeString(payload.name) ?? "Tool call",
        body: serializeEventBody(isStart ? payload.args : payload.result),
        phase: payload.phase === "end" ? "final" : "partial",
        timestamp: envelope.ts,
      };

      if (toolCallId) {
        event.toolCallId = toolCallId;
      }

      return event;
    }

    if (payload.type === "status") {
      const code = maybeString(payload.code) ?? "status";

      return {
        id: envelope.id,
        piSessionId: envelope.piSessionId,
        kind: "status",
        title: AGENT_STATUS_TITLES[code] ?? code,
        body: maybeString(payload.body) ?? "",
        timestamp: envelope.ts,
      };
    }

    if (payload.type === "error") {
      return {
        id: envelope.id,
        piSessionId: envelope.piSessionId,
        kind: "error",
        title: payload.fatal === false ? "Extension error" : "Run failed",
        ...(payload.fatal === false ? { fatal: false } : {}),
        body: maybeString(payload.body) ?? "",
        timestamp: envelope.ts,
      };
    }

    if (payload.type === "run" && payload.phase === "end") {
      // A failed run already surfaced its chat error; emitting the legacy
      // Completed status here would flip the session back to completed.
      if (payload.outcome === "failed") {
        return null;
      }

      return {
        id: envelope.id,
        piSessionId: envelope.piSessionId,
        kind: "status",
        title: "Completed",
        body: "Pi SDK runtime ended the active run.",
        timestamp: envelope.ts,
      };
    }

    return null;
  };

  // Everything folded down from an Agent Runtime Event is marked so the
  // projection never mirrors it back into the runtime model.
  return (envelope) => {
    const event = mapAgentEnvelope(envelope);

    return event ? { ...event, derivedFromAgentEvent: true } : null;
  };
}

function mapEnvelopeToRuntimeEvent(
  envelope: RuntimeGatewayEventEnvelope,
  compat: AgentEventCompatMapper,
): PiRuntimeEvent | null {
  if (envelope.type === "subagent_record" || envelope.payload.type === "subagent_record") return null;
  if (isAgentRuntimeEventPayload(envelope.payload)) {
    return compat(envelope);
  }

  return runtimeEventFromEnvelope(envelope);
}

function stateFromSnapshot(snapshot: RuntimeGatewaySnapshot): PiSessionState {
  // Snapshot replay gets its own accumulator so live-stream part state never
  // double-accumulates replayed deltas.
  const compat = createAgentEventCompatMapper();
  const events: PiRuntimeEvent[] = [];
  const replay: SessionReplayEntry[] = [];

  for (const envelope of snapshot.events) {
    if (envelope.payload.type === "session_info_changed") continue;
    if (isAgentRuntimeEventPayload(envelope.payload)) {
      replay.push({
        kind: "agent",
        entry: {
          seq: envelope.seq,
          timestamp: envelope.ts,
          event: envelope.payload as unknown as AgentRuntimeEvent,
        },
      });
    } else {
      // Gateway-minted legacy envelopes carry the chat entries the projection
      // mirrors into the runtime model (user echo, steer control, errors).
      replay.push({
        kind: "chat",
        seq: envelope.seq,
        event: runtimeEventFromEnvelope(envelope),
      });
    }

    const event = mapEnvelopeToRuntimeEvent(envelope, compat);

    if (event) {
      events.push(event);
    }
  }

  const state: PiSessionState = {
    piSessionId: snapshot.piSessionId,
    sessionName: snapshot.sessionName,
    runtimeId: snapshot.runtimeId,
    projectId: snapshot.projectId,
    cwd: snapshot.cwd,
    ...(snapshot.sessionFile ? { sessionFile: snapshot.sessionFile } : {}),
    status: snapshot.status,
    events,
    ...(replay.length ? { replay } : {}),
    ...(snapshot.modelControls
      ? {
          modelControls: {
            models: snapshot.modelControls.models.map((model) => ({
              ...model,
              thinkingLevels: [...model.thinkingLevels],
            })),
            selected: snapshot.modelControls.selected
              ? { ...snapshot.modelControls.selected }
              : null,
          },
        }
      : {}),
    ...(snapshot.contextUsage ? { contextUsage: { ...snapshot.contextUsage } } : {}),
    updatedAt: snapshot.updatedAt,
  };
  const summary = runtimeSummaryFromGateway(snapshot.summary);

  if (summary) {
    state.summary = summary;
  }

  return state;
}

function cloneRuntimeEvent(event: PiRuntimeEvent): PiRuntimeEvent {
  const cloned: PiRuntimeEvent = {
    id: event.id,
    piSessionId: event.piSessionId,
    kind: event.kind,
    body: event.body,
    timestamp: event.timestamp,
  };

  if (event.role) {
    cloned.role = event.role;
  }

  if (event.title) {
    cloned.title = event.title;
  }

  if (event.messageId) {
    cloned.messageId = event.messageId;
  }

  if (event.piEntryId) {
    cloned.piEntryId = event.piEntryId;
  }

  if (event.toolCallId) {
    cloned.toolCallId = event.toolCallId;
  }

  if (event.summary) {
    cloned.summary = { ...event.summary };
  }

  if (event.bodyFormat) {
    cloned.bodyFormat = event.bodyFormat;
  }

  if (event.phase) {
    cloned.phase = event.phase;
  }

  if (event.derivedFromAgentEvent) {
    cloned.derivedFromAgentEvent = true;
  }
  if (event.fatal === false) {
    cloned.fatal = false;
  }

  const images = clonePromptImages(event.images);

  if (images) {
    cloned.images = images;
  }

  return cloned;
}

function cloneQueuedMessage(message: PiQueuedMessage): PiQueuedMessage {
  const cloned: PiQueuedMessage = { ...message };
  const images = clonePromptImages(message.images);

  if (images) {
    cloned.images = images;
  } else {
    delete cloned.images;
  }

  return cloned;
}

function queuedMessageFromGateway(message: RuntimeGatewayQueuedMessage): PiQueuedMessage {
  const queued: PiQueuedMessage = {
    id: message.id,
    piSessionId: message.piSessionId,
    body: message.body,
    status: message.status,
    createdAt: message.createdAt,
  };
  const images = clonePromptImages(message.images);

  if (images) {
    queued.images = images;
  }

  if (message.processingStartedAt) {
    queued.processingStartedAt = message.processingStartedAt;
  }

  if (message.withdrawnAt) {
    queued.withdrawnAt = message.withdrawnAt;
  }

  return queued;
}

function echoFingerprint(event: Pick<PiRuntimeEvent, "piSessionId" | "kind" | "role" | "title" | "body">) {
  return [
    event.piSessionId,
    event.kind,
    event.role ?? "",
    event.title ?? "",
    event.body,
  ].join("\u0000");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createRuntimeGatewayClient(
  options: RuntimeGatewayClientOptions = {},
): PiRuntimeBridge & {
  addLocalResource(input: AddLocalResourceInput): Promise<AddLocalResourceResult>;
  removeLocalResource(input: { path: string }): Promise<PackageActionResult>;
  installPackage(input: PackageSourceInput): Promise<PackageActionResult>;
  removePackage(input: PackageSourceInput): Promise<RemovePackageResult>;
  updatePackage(input?: UpdatePackageInput): Promise<PackageActionResult>;
  setResourceEnabled(input: SetResourceEnabledInput): Promise<PackageActionResult>;
  checkPackageUpdates(): Promise<CheckPackageUpdatesResult>;
  prepareChatWorkspace(input: { sessionId: string }): Promise<PrepareChatWorkspaceResult>;
} {
  const invoke = options.invoke ?? invokeRuntime;
  const onBackendEvent = options.onBackendEvent ?? onRuntimeBackendEvent;
  const now = options.now ?? (() => new Date().toISOString());
  const runtimes = new Map<string, PiRuntimeHandle>();
  const states = new Map<string, PiSessionState>();
  const queuedMessages = new Map<string, PiQueuedMessage>();
  const listeners = new Map<string, Set<(event: PiRuntimeEvent) => void>>();
  const agentListeners = new Map<string, Set<(entry: AgentRuntimeEventEntry) => void>>();
  const seenEventIds = new Map<string, Set<string>>();
  const pendingEchoFingerprints = new Set<string>();
  const suppressedEnvelopeIds = new Set<string>();
  const liveCompatMapper = createAgentEventCompatMapper();
  let unsubscribeBackendEvent: (() => void) | null = null;

  const rememberState = (state: PiSessionState) => {
    states.set(state.piSessionId, cloneSessionState(state));
  };
  const rememberSeen = (event: PiRuntimeEvent) => {
    const seen = seenEventIds.get(event.piSessionId) ?? new Set<string>();

    if (seen.has(event.id)) {
      return false;
    }

    seen.add(event.id);
    seenEventIds.set(event.piSessionId, seen);

    return true;
  };
  const recordEvent = (event: PiRuntimeEvent, notifyListeners: boolean) => {
    if (!rememberSeen(event)) {
      return;
    }

    const state = states.get(event.piSessionId);

    if (state) {
      state.events = [...state.events, cloneRuntimeEvent(event)];
      state.updatedAt = event.timestamp;

      if (event.summary) {
        state.summary = defaultRuntimeSummary({
          ...(state.summary ?? defaultRuntimeSummary()),
          ...event.summary,
        });
      }

      if (event.kind === "error") {
        if (event.fatal !== false) state.status = "failed";
      } else if (event.kind === "status") {
        state.status = "completed";
      } else {
        state.status = "running";
      }
    }

    if (!notifyListeners) {
      return;
    }

    for (const listener of listeners.get(event.piSessionId) ?? []) {
      listener(cloneRuntimeEvent(event));
    }
  };
  const ensureBackendSubscription = () => {
    if (unsubscribeBackendEvent) {
      return;
    }

    unsubscribeBackendEvent = onBackendEvent((event) => {
      if (event.type !== "event") {
        return;
      }

      // Ephemeral workspace and terminal signals never belong to runtime truth.
      if (["workspace.invalidated", "terminal_output", "terminal_exit"].includes(event.event.type)) {
        return;
      }

      if (event.event.type === "subagent_record" || event.event.payload.type === "subagent_record") return;

      // Session metadata is consumed by the list provider, not the run timeline.
      if (event.event.payload.type === "session_info_changed") {
        const state = states.get(event.event.piSessionId);
        if (state && typeof event.event.payload.name === "string") {
          state.sessionName = event.event.payload.name;
        }
        return;
      }

      if (isAgentRuntimeEventPayload(event.event.payload)) {
        const entry: AgentRuntimeEventEntry = {
          seq: event.event.seq,
          timestamp: event.event.ts,
          event: event.event.payload as unknown as AgentRuntimeEvent,
        };

        for (const listener of agentListeners.get(event.event.piSessionId) ?? []) {
          listener(entry);
        }
      }

      const runtimeEvent = mapEnvelopeToRuntimeEvent(event.event, liveCompatMapper);

      if (!runtimeEvent) {
        return;
      }

      const fingerprint = echoFingerprint(runtimeEvent);

      if (suppressedEnvelopeIds.has(event.event.id)) {
        suppressedEnvelopeIds.delete(event.event.id);
        return;
      }

      if (pendingEchoFingerprints.has(fingerprint)) {
        pendingEchoFingerprints.delete(fingerprint);
        suppressedEnvelopeIds.add(event.event.id);
        return;
      }

      recordEvent(runtimeEvent, true);
    });
  };
  const releaseBackendSubscriptionIfIdle = () => {
    const hasListeners =
      [...listeners.values()].some((sessionListeners) => sessionListeners.size > 0) ||
      [...agentListeners.values()].some((sessionListeners) => sessionListeners.size > 0);

    if (hasListeners || !unsubscribeBackendEvent) {
      return;
    }

    unsubscribeBackendEvent();
    unsubscribeBackendEvent = null;
  };
  const invokeEventCommand = async (
    method: string,
    args: Record<string, unknown>,
    expectedEcho: Pick<PiRuntimeEvent, "piSessionId" | "kind" | "role" | "title" | "body">,
  ) => {
    const fingerprint = echoFingerprint(expectedEcho);
    pendingEchoFingerprints.add(fingerprint);

    try {
      const envelope = await invoke<RuntimeGatewayEventEnvelope>(method, args);
      suppressedEnvelopeIds.add(envelope.id);

      return envelope;
    } finally {
      pendingEchoFingerprints.delete(fingerprint);
    }
  };

  return {
    async startRuntime(input) {
      try {
        const snapshot = await invoke<RuntimeGatewaySnapshot>("create_session", {
          sessionId: input.sessionId,
          projectId: input.projectId,
          cwd: input.checkout.runtimeCwd,
          checkout: input.checkout,
        });
        const runtime: PiRuntimeHandle = {
          runtimeId: snapshot.runtimeId,
          sessionId: input.sessionId,
          projectId: input.projectId,
          checkout: input.checkout,
          status: "ready",
        };

        runtimes.set(runtime.runtimeId, { ...runtime, checkout: { ...runtime.checkout } });
        rememberState(stateFromSnapshot(snapshot));

        return { ...runtime, checkout: { ...runtime.checkout } };
      } catch (error) {
        throw new PiRuntimeBridgeError({
          stage: "starting runtime",
          message: errorMessage(error),
        });
      }
    },

    async createPiSessionState(input) {
      const runtime = runtimes.get(input.runtimeId);

      if (!runtime) {
        throw new PiRuntimeBridgeError({
          stage: "starting runtime",
          message: `Runtime "${input.runtimeId}" was not found.`,
        });
      }

      const state = [...states.values()].find((candidate) => candidate.runtimeId === input.runtimeId);

      if (!state) {
        throw new PiRuntimeBridgeError({
          stage: "starting runtime",
          message: `Runtime snapshot "${input.runtimeId}" was not found.`,
        });
      }

      state.projectId = input.projectId;
      state.cwd = input.cwd;

      return cloneSessionState(state);
    },

    async sendInitialPrompt(input) {
      try {
        const envelope = await invokeEventCommand(
          "send_prompt",
          {
            piSessionId: input.piSessionId,
            prompt: input.prompt,
            ...(input.images?.length ? { images: input.images } : {}),
          },
          {
            piSessionId: input.piSessionId,
            kind: "message",
            role: "user",
            body: input.prompt,
          },
        );
        const event = runtimeEventFromEnvelope(envelope);

        recordEvent(event, false);

        return {
          accepted: true,
          piSessionId: input.piSessionId,
          event: cloneRuntimeEvent(event),
        };
      } catch (error) {
        throw new PiRuntimeBridgeError({
          stage: "sending prompt",
          message: errorMessage(error),
        });
      }
    },

    async queueFollowUp(input) {
      try {
        const queuedMessage = queuedMessageFromGateway(
          await invoke<RuntimeGatewayQueuedMessage>("queue_follow_up", {
            piSessionId: input.piSessionId,
            message: input.message,
            ...(input.images?.length ? { images: input.images } : {}),
          }),
        );

        queuedMessages.set(queuedMessage.id, queuedMessage);

        return cloneQueuedMessage(queuedMessage);
      } catch (error) {
        throw new PiRuntimeBridgeError({
          stage: "queuing message",
          message: errorMessage(error),
        });
      }
    },

    async withdrawQueuedMessage(input) {
      try {
        const withdrawnMessage = queuedMessageFromGateway(
          await invoke<RuntimeGatewayQueuedMessage>("withdraw_queued_message", {
            piSessionId: input.piSessionId,
            queuedMessageId: input.queuedMessageId,
          }),
        );

        queuedMessages.set(withdrawnMessage.id, withdrawnMessage);

        return cloneQueuedMessage(withdrawnMessage);
      } catch (error) {
        throw new PiRuntimeBridgeError({
          stage: "withdrawing queued message",
          message: errorMessage(error),
        });
      }
    },

    async steerRun(input) {
      try {
        const envelope = await invokeEventCommand(
          "steer_run",
          {
            piSessionId: input.piSessionId,
            message: input.message,
            ...(input.images?.length ? { images: input.images } : {}),
          },
          {
            piSessionId: input.piSessionId,
            kind: "control",
            role: "user",
            title: "Steer",
            body: input.message,
          },
        );
        const event = runtimeEventFromEnvelope(envelope);

        recordEvent(event, false);

        return cloneRuntimeEvent(event);
      } catch (error) {
        throw new PiRuntimeBridgeError({
          stage: "steering run",
          message: errorMessage(error),
        });
      }
    },

    async abortRun(input) {
      try {
        const envelope = await invokeEventCommand(
          "stop_run",
          {
            piSessionId: input.piSessionId,
          },
          {
            piSessionId: input.piSessionId,
            kind: "status",
            title: "Stopped",
            body: "Pi stopped the active run.",
          },
        );
        const event = runtimeEventFromEnvelope(envelope);

        recordEvent(event, false);

        return cloneRuntimeEvent(event);
      } catch (error) {
        throw new PiRuntimeBridgeError({
          stage: "stopping run",
          message: errorMessage(error),
        });
      }
    },

    async configureModel(input) {
      try {
        const controls = await invoke<RuntimeModelControls>("configure_model", {
          sessionId: input.sessionId,
          piSessionId: input.piSessionId,
          provider: input.provider,
          modelId: input.modelId,
          thinkingLevel: input.thinkingLevel,
        });
        const state = states.get(input.piSessionId);

        if (state) {
          state.modelControls = {
            models: controls.models.map((model) => ({
              ...model,
              thinkingLevels: [...model.thinkingLevels],
            })),
            selected: controls.selected ? { ...controls.selected } : null,
          };
          state.summary = defaultRuntimeSummary({
            ...(state.summary ?? defaultRuntimeSummary()),
            provider: controls.selected?.provider ?? null,
            model: controls.selected?.modelId ?? null,
          });
          state.updatedAt = now();
          rememberState(state);
        }

        return {
          models: controls.models.map((model) => ({
            ...model,
            thinkingLevels: [...model.thinkingLevels],
          })),
          selected: controls.selected ? { ...controls.selected } : null,
        };
      } catch (error) {
        throw new PiRuntimeBridgeError({
          stage: "configuring model",
          message: errorMessage(error),
        });
      }
    },

    async getSessionState(piSessionId) {
      const localState = states.get(piSessionId);

      try {
        const remoteState = stateFromSnapshot(
          await invoke<RuntimeGatewaySnapshot>("get_runtime_snapshot", {
            piSessionId,
          }),
        );
        const localEvents = localState?.events ?? [];

        remoteState.events =
          remoteState.events.length >= localEvents.length
            ? remoteState.events
            : localEvents.map(cloneRuntimeEvent);
        if (localState?.summary) {
          remoteState.summary = defaultRuntimeSummary({
            ...remoteState.summary,
            ...localState.summary,
          });
        }
        rememberState(remoteState);

        return cloneSessionState(remoteState);
      } catch (error) {
        if (localState) {
          return cloneSessionState(localState);
        }

        throw new PiRuntimeBridgeError({
          stage: "starting runtime",
          message: errorMessage(error),
        });
      }
    },

    async resumeSession(input) {
      try {
        const snapshot = await invoke<RuntimeGatewaySnapshot>("resume_session", {
          sessionId: input.sessionId,
          projectId: input.projectId,
          piSessionId: input.piSessionId,
          cwd: input.cwd,
          sessionFile: input.sessionFile,
          checkout: input.checkout,
        });

        if (input.checkout) {
          runtimes.set(snapshot.runtimeId, {
            runtimeId: snapshot.runtimeId,
            sessionId: input.sessionId,
            projectId: input.projectId,
            checkout: { ...input.checkout },
            status: "ready",
          });
        }

        const state = stateFromSnapshot(snapshot);

        rememberState(state);

        return cloneSessionState(state);
      } catch (error) {
        throw new PiRuntimeBridgeError({
          stage: "starting runtime",
          message: errorMessage(error),
        });
      }
    },

    async forkSession(input) {
      try {
        const result = await invoke<ForkRuntimeGatewayResult>("fork_session", {
          sessionId: input.sessionId,
          projectId: input.projectId,
          sourcePiSessionId: input.sourcePiSessionId,
          sourceSessionFile: input.sourceSessionFile,
          piEntryId: input.piEntryId,
          cwd: input.cwd,
          checkout: input.checkout,
        });
        const state = stateFromSnapshot(result.snapshot);

        if (input.checkout) {
          runtimes.set(result.snapshot.runtimeId, {
            runtimeId: result.snapshot.runtimeId,
            sessionId: input.sessionId,
            projectId: input.projectId,
            checkout: { ...input.checkout },
            status: "ready",
          });
        }

        rememberState(state);

        return {
          state: cloneSessionState(state),
          ...(result.selectedText ? { selectedText: result.selectedText } : {}),
        };
      } catch (error) {
        throw new PiRuntimeBridgeError({
          stage: "forking session",
          message: errorMessage(error),
        });
      }
    },

    subscribeToEvents(piSessionId, listener) {
      ensureBackendSubscription();

      const sessionListeners = listeners.get(piSessionId) ?? new Set();

      sessionListeners.add(listener);
      listeners.set(piSessionId, sessionListeners);

      return () => {
        sessionListeners.delete(listener);
        releaseBackendSubscriptionIfIdle();
      };
    },

    subscribeToAgentEvents(piSessionId, listener) {
      ensureBackendSubscription();

      const sessionListeners = agentListeners.get(piSessionId) ?? new Set();

      sessionListeners.add(listener);
      agentListeners.set(piSessionId, sessionListeners);

      return () => {
        sessionListeners.delete(listener);
        releaseBackendSubscriptionIfIdle();
      };
    },

    addLocalResource: input => invoke<AddLocalResourceResult>("add_local_resource", input),
    removeLocalResource: input => invoke<PackageActionResult>("remove_local_resource", input),
    installPackage: input => invoke<PackageActionResult>("install_package", input),
    removePackage: input => invoke<RemovePackageResult>("remove_package", input),
    updatePackage: input => invoke<PackageActionResult>("update_package", input),
    setResourceEnabled: input => invoke<PackageActionResult>("set_resource_enabled", input),
    checkPackageUpdates: () => invoke<CheckPackageUpdatesResult>("check_package_updates"),

    async prepareChatWorkspace(input) {
      return invoke<PrepareChatWorkspaceResult>("prepare_chat_workspace", {
        sessionId: input.sessionId,
      });
    },
  };
}
