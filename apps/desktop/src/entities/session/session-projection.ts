import type {
  ExecutionCheckout,
  PiQueuedMessage,
  PiRuntimeEvent,
  PiRuntimeSummary,
  PiSessionState,
  RuntimeContextUsage,
  RuntimeFollowUpMode,
  RuntimeModelControls,
} from "@/entities/runtime/pi-runtime-bridge";
import {
  addLegacyChatEventToModel,
  applyAgentRuntimeEvent,
  createSessionRuntimeModel,
  sessionStatusFromRuntimeModel,
  settleOpenRuns,
  type AgentRuntimeEventInput,
  type SessionRuntimeModel,
} from "@/entities/session/session-runtime-model";

export type SessionStatus = "creating" | "running" | "waiting" | "failed" | "completed" | "archived";

export type SessionCreationStage =
  | "preparing checkout"
  | "starting runtime"
  | "sending prompt"
  | "accepted"
  | "failed";

export type SessionCreationFailureStage = Exclude<
  SessionCreationStage,
  "accepted" | "failed"
>;

export type SessionCreationFailure = {
  stage: SessionCreationFailureStage;
  message: string;
};

export type SessionProjection = {
  id: string;
  projectId: string;
  initialPrompt: string;
  // Manual title overrides the Pi session name and initial prompt.
  title: string | null;
  sessionName?: string;
  cwd: string | null;
  status: SessionStatus;
  creationStage: SessionCreationStage;
  checkout: ExecutionCheckout | null;
  runtimeId: string | null;
  piSessionId: string | null;
  sessionFile: string | null;
  runtimeEvents: PiRuntimeEvent[];
  // Structured model built from the Agent Runtime Event stream. Once it has
  // seen run events, it owns the Session Status; legacy event kinds only
  // drive status for bridges that don't speak the new model yet.
  runtimeModel: SessionRuntimeModel;
  queuedMessages: PiQueuedMessage[];
  // Consumed ids whose enqueue echo has not arrived yet — apply as processing on add.
  pendingConsumedIds: Readonly<Record<string, string>>;
  summary: PiRuntimeSummary;
  modelControls: RuntimeModelControls | null;
  // Live context-window occupancy; null until the runtime first reports it.
  contextUsage: RuntimeContextUsage | null;
  followUpMode?: RuntimeFollowUpMode;
  stale: boolean;
  staleReason: string | null;
  failure: SessionCreationFailure | null;
  unreadResult: boolean;
  archivedAt: string | null;
  createdAt: string;
  lastUserMessageAt?: string;
  updatedAt: string;
};

export type CreateSessionProjectionInput = {
  id: string;
  projectId: string;
  initialPrompt: string;
  createdAt: string;
};

export type SessionProjectionEvent =
  | {
      type: "creation-stage-changed";
      stage: "starting runtime" | "sending prompt";
      occurredAt: string;
    }
  | {
      type: "checkout-selected";
      stage: "preparing checkout";
      checkout: ExecutionCheckout;
      occurredAt: string;
    }
  | {
      type: "runtime-bound";
      stage: "starting runtime";
      runtimeId: string;
      piSessionId: string;
      summary?: PiRuntimeSummary;
      modelControls?: RuntimeModelControls;
      followUpMode?: RuntimeFollowUpMode;
      occurredAt: string;
    }
  | {
      type: "runtime-event-received";
      stage?: "accepted";
      // Present only on successful user sends, never on runtime echoes or replay.
      submittedAt?: string;
      event: PiRuntimeEvent;
    }
  | {
      type: "agent-event-received";
      entry: AgentRuntimeEventInput;
    }
  | {
      type: "run-completed";
      event: PiRuntimeEvent;
    }
  | {
      type: "run-failed";
      event: PiRuntimeEvent;
    }
  | {
      type: "queued-message-added";
      queuedMessage: PiQueuedMessage;
    }
  | {
      type: "queued-message-withdrawn";
      queuedMessageId: string;
      occurredAt: string;
    }
  | {
      type: "queued-messages-reordered";
      orderedIds: string[];
      occurredAt: string;
    }
  | {
      type: "queued-messages-synced";
      queuedMessages: PiQueuedMessage[];
      occurredAt: string;
    }
  | {
      type: "steer-submitted";
      event: PiRuntimeEvent;
    }
  | {
      type: "run-stopped";
      event: PiRuntimeEvent;
    }
  | {
      type: "run-stop-failed";
      event: PiRuntimeEvent;
    }
  | {
      type: "latest-message-rendered";
      occurredAt: string;
    }
  | {
      type: "session-archived";
      occurredAt: string;
    }
  | {
      type: "projection-marked-stale";
      reason: string;
      occurredAt: string;
    }
  | {
      type: "runtime-state-resynced";
      state: PiSessionState;
    }
  | {
      type: "model-controls-changed";
      modelControls: RuntimeModelControls;
      occurredAt: string;
    }
  | {
      type: "creation-failed";
      stage: SessionCreationFailureStage;
      message: string;
      occurredAt: string;
    };

export type SessionProjectionListItem = {
  id: string;
  title: string;
  active: boolean;
  unread: boolean;
  archived: boolean;
  updatedAt: string;
  projection: SessionProjection;
};

export type GetSessionProjectionListItemsOptions = {
  includeArchived?: boolean;
};

export function createSessionProjection(
  input: CreateSessionProjectionInput,
): SessionProjection {
  return {
    id: input.id,
    projectId: input.projectId,
    initialPrompt: input.initialPrompt,
    title: null,
    cwd: null,
    status: "creating",
    creationStage: "preparing checkout",
    checkout: null,
    runtimeId: null,
    piSessionId: null,
    sessionFile: null,
    runtimeEvents: [],
    runtimeModel: createSessionRuntimeModel(),
    queuedMessages: [],
    pendingConsumedIds: {},
    summary: {
      provider: null,
      model: null,
      totalTokens: 0,
      totalCostUsd: 0,
    },
    modelControls: null,
    contextUsage: null,
    stale: false,
    staleReason: null,
    failure: null,
    unreadResult: false,
    archivedAt: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function isSessionProjectionActive(projection: SessionProjection): boolean {
  return projection.status === "creating" || projection.status === "running";
}

export function isSessionProjectionArchived(projection: SessionProjection): boolean {
  return projection.status === "archived" || projection.archivedAt !== null;
}

export function canArchiveSessionProjection(projection: SessionProjection): boolean {
  return !isSessionProjectionActive(projection);
}

function maxIsoTimestamp(left: string | null | undefined, right: string): string {
  return left && left > right ? left : right;
}

/**
 * Last chat activity (user/assistant message, control echo, or run error)
 * for projection freshness — never "last opened" / resume wall clock.
 * DF-010.
 */
export function lastChatActivityAt(
  projection: SessionProjection,
  options: {
    events?: readonly PiRuntimeEvent[];
  } = {},
): string {
  let latest: string | null = null;

  for (const message of projection.runtimeModel.messages.values()) {
    latest = maxIsoTimestamp(latest, message.updatedAt);
  }

  for (const error of projection.runtimeModel.errors) {
    latest = maxIsoTimestamp(latest, error.at);
  }

  for (const event of options.events ?? projection.runtimeEvents) {
    if (
      event.kind === "message" ||
      event.kind === "error" ||
      event.kind === "control"
    ) {
      latest = maxIsoTimestamp(latest, event.timestamp);
    }
  }

  return latest ?? projection.updatedAt;
}

function lastUserMessageAt(projection: SessionProjection): string {
  // Explicit submissions survive cold hydration and delayed queue processing echoes.
  if (projection.lastUserMessageAt) return projection.lastUserMessageAt;

  let latest = projection.createdAt;
  for (const message of projection.runtimeModel.messages.values()) {
    if (message.role === "user") {
      latest = maxIsoTimestamp(latest, message.startedAt ?? message.updatedAt);
    }
  }
  for (const event of projection.runtimeEvents) {
    if (event.role === "user" && (event.kind === "message" || event.kind === "control")) {
      latest = maxIsoTimestamp(latest, event.timestamp);
    }
  }
  return latest;
}

export function getSessionProjectionListItems(
  projections: SessionProjection[],
  options: GetSessionProjectionListItemsOptions = {},
): SessionProjectionListItem[] {
  return projections
    .filter(
      (projection) => options.includeArchived || !isSessionProjectionArchived(projection),
    )
    .map((projection) => ({
      id: projection.id,
      title: projection.title ?? (projection.sessionName?.trim() || projection.initialPrompt),
      active: isSessionProjectionActive(projection),
      unread: projection.unreadResult,
      archived: isSessionProjectionArchived(projection),
      updatedAt: lastUserMessageAt(projection),
      projection,
    }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function sessionStatusFromRuntimeState(state: PiSessionState): SessionStatus {
  switch (state.status) {
    case "idle":
      return "waiting";
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "completed":
      return "completed";
  }
}

function mergeRuntimeSummary(
  current: PiRuntimeSummary,
  next: Partial<PiRuntimeSummary> | undefined,
): PiRuntimeSummary {
  if (!next) {
    return current;
  }

  return {
    provider: next.provider ?? current.provider,
    model: next.model ?? current.model,
    totalTokens: next.totalTokens ?? current.totalTokens,
    totalCostUsd: next.totalCostUsd ?? current.totalCostUsd,
  };
}

function unreadResultFromRuntimeEvent(
  projection: SessionProjection,
  event: PiRuntimeEvent,
) {
  return event.role === "assistant" ? true : projection.unreadResult;
}

function queuedMessagesAfterConsumed(
  queuedMessages: SessionProjection["queuedMessages"],
  queuedMessageId: string,
  consumedAt: string,
) {
  return queuedMessages.map((queuedMessage) =>
    queuedMessage.id === queuedMessageId && queuedMessage.status === "pending"
      ? {
          ...queuedMessage,
          status: "processing" as const,
          processingStartedAt: consumedAt,
        }
      : queuedMessage,
  );
}

function applyQueuedMessageConsumed(
  queuedMessages: SessionProjection["queuedMessages"],
  pendingConsumedIds: SessionProjection["pendingConsumedIds"],
  queuedMessageId: string,
  consumedAt: string,
  rememberUnmatched = true,
): Pick<SessionProjection, "queuedMessages" | "pendingConsumedIds"> {
  if (queuedMessages.some((queuedMessage) => queuedMessage.id === queuedMessageId)) {
    return {
      queuedMessages: queuedMessagesAfterConsumed(queuedMessages, queuedMessageId, consumedAt),
      pendingConsumedIds,
    };
  }

  if (!rememberUnmatched || pendingConsumedIds[queuedMessageId]) {
    return { queuedMessages, pendingConsumedIds };
  }

  return {
    queuedMessages,
    pendingConsumedIds: { ...pendingConsumedIds, [queuedMessageId]: consumedAt },
  };
}

// Gateway-minted chat events (user echo, steer control, driver/renderer
// errors) exist only on the legacy stream; mirror them into the runtime model
// so chat can render entirely from it. Compat-derived events already reached
// the model through the agent stream.
function runtimeModelAfterLegacyEvent(
  model: SessionRuntimeModel,
  event: PiRuntimeEvent,
): SessionRuntimeModel {
  if (event.derivedFromAgentEvent) {
    return model;
  }

  if (
    (event.kind === "message" && event.role === "user") ||
    event.kind === "control" ||
    event.kind === "error"
  ) {
    return addLegacyChatEventToModel(model, {
      id: event.id,
      kind: event.kind,
      role: event.role,
      title: event.title,
      body: event.body,
      images: event.images,
      messageId: event.messageId,
      piEntryId: event.piEntryId,
      timestamp: event.timestamp,
    });
  }

  return model;
}

// Replay includes journal boundaries and any live deltas buffered during the
// read. A cold snapshot supersedes deltas left in memory by a dead process.
// Legacy bridges without replay keep the model accumulated live.
function runtimeModelFromReplay(
  current: SessionRuntimeModel,
  state: PiSessionState,
): SessionRuntimeModel {
  if (!state.replay?.length) {
    return state.executionState === "cold" ? createSessionRuntimeModel() : current;
  }

  let model = createSessionRuntimeModel();

  for (const step of state.replay) {
    model =
      step.kind === "agent"
        ? applyAgentRuntimeEvent(model, step.entry)
        : runtimeModelAfterLegacyEvent(model, step.event);
  }

  return state.executionState !== "cold" && current.lastSeq > model.lastSeq ? current : model;
}

function runtimeEventIdentity(event: PiRuntimeEvent): string | null {
  if (
    (event.kind === "message" || event.kind === "thinking") &&
    event.messageId
  ) {
    return `${event.piSessionId}\u0000${event.kind}\u0000${event.messageId}`;
  }

  if (
    (event.kind === "tool-call" || event.kind === "tool-result") &&
    event.toolCallId
  ) {
    return `${event.piSessionId}\u0000${event.kind}\u0000${event.toolCallId}`;
  }

  return null;
}

function upsertRuntimeEvent(
  events: PiRuntimeEvent[],
  event: PiRuntimeEvent,
): PiRuntimeEvent[] {
  const identity = runtimeEventIdentity(event);

  if (!identity) {
    return [...events, { ...event }];
  }

  const existingIndex = events.findIndex(
    (existingEvent) => runtimeEventIdentity(existingEvent) === identity,
  );

  if (existingIndex === -1) {
    return [...events, { ...event }];
  }

  return events.map((existingEvent, index) =>
    index === existingIndex ? { ...event } : existingEvent,
  );
}

function normalizedRuntimeEvents(events: PiRuntimeEvent[]): PiRuntimeEvent[] {
  return events.reduce<PiRuntimeEvent[]>(
    (normalizedEvents, runtimeEvent) =>
      upsertRuntimeEvent(normalizedEvents, runtimeEvent),
    [],
  );
}

export function applySessionProjectionEvent(
  projection: SessionProjection,
  event: SessionProjectionEvent,
): SessionProjection {
  switch (event.type) {
    case "creation-stage-changed":
      return {
        ...projection,
        creationStage: event.stage,
        updatedAt: event.occurredAt,
      };
    case "checkout-selected":
      return {
        ...projection,
        creationStage: event.stage,
        checkout: { ...event.checkout },
        updatedAt: event.occurredAt,
      };
    case "runtime-bound":
      return {
        ...projection,
        creationStage: event.stage,
        runtimeId: event.runtimeId,
        piSessionId: event.piSessionId,
        summary: event.summary ? { ...event.summary } : projection.summary,
        modelControls: event.modelControls
          ? {
              models: event.modelControls.models.map((model) => ({
                ...model,
                thinkingLevels: [...model.thinkingLevels],
              })),
              selected: event.modelControls.selected
                ? { ...event.modelControls.selected }
                : null,
            }
          : projection.modelControls,
        followUpMode: event.followUpMode ?? projection.followUpMode,
        updatedAt: event.occurredAt,
      };
    case "runtime-event-received":
      return {
        ...projection,
        // Once Active Run events own the status, legacy kinds stop guessing —
        // a compat "Retrying" status must not complete a running Session.
        status:
          projection.runtimeModel.runs.size > 0
            ? projection.status
            : event.event.kind === "error"
              ? "failed"
              : event.event.kind === "status"
                ? "completed"
                : "running",
        creationStage: event.stage ?? projection.creationStage,
        lastUserMessageAt: event.submittedAt
          ? maxIsoTimestamp(projection.lastUserMessageAt, event.submittedAt)
          : projection.lastUserMessageAt,
        runtimeEvents: upsertRuntimeEvent(projection.runtimeEvents, event.event),
        runtimeModel: runtimeModelAfterLegacyEvent(projection.runtimeModel, event.event),
        summary: mergeRuntimeSummary(projection.summary, event.event.summary),
        unreadResult: unreadResultFromRuntimeEvent(projection, event.event),
        updatedAt: event.event.timestamp,
      };
    case "agent-event-received": {
      const agentEvent = event.entry.event;
      const consumed =
        agentEvent.type === "queued-message-consumed"
          ? applyQueuedMessageConsumed(
              projection.queuedMessages,
              projection.pendingConsumedIds,
              agentEvent.queuedMessageId,
              agentEvent.consumedAt,
            )
          : null;
      const queuedMessages = consumed?.queuedMessages ?? projection.queuedMessages;
      const pendingConsumedIds = consumed?.pendingConsumedIds ?? projection.pendingConsumedIds;
      const runtimeModel = applyAgentRuntimeEvent(projection.runtimeModel, event.entry);

      if (
        runtimeModel === projection.runtimeModel &&
        queuedMessages === projection.queuedMessages &&
        pendingConsumedIds === projection.pendingConsumedIds
      ) {
        return projection;
      }

      const finalizedAssistantAnswer =
        agentEvent.type === "message" &&
        agentEvent.phase === "end" &&
        agentEvent.role === "assistant" &&
        !agentEvent.abandoned;

      return {
        ...projection,
        status: sessionStatusFromRuntimeModel(runtimeModel) ?? projection.status,
        runtimeModel,
        summary:
          agentEvent.type === "usage"
            ? mergeRuntimeSummary(projection.summary, agentEvent.summary)
            : projection.summary,
        contextUsage:
          agentEvent.type === "context_usage"
            ? { ...agentEvent.usage }
            : projection.contextUsage,
        queuedMessages,
        pendingConsumedIds,
        unreadResult: finalizedAssistantAnswer ? true : projection.unreadResult,
        updatedAt: event.entry.timestamp,
      };
    }
    case "run-completed":
      return {
        ...projection,
        status: "completed",
        runtimeEvents: upsertRuntimeEvent(projection.runtimeEvents, event.event),
        runtimeModel: runtimeModelAfterLegacyEvent(projection.runtimeModel, event.event),
        summary: mergeRuntimeSummary(projection.summary, event.event.summary),
        unreadResult: true,
        updatedAt: event.event.timestamp,
      };
    case "run-failed":
      return {
        ...projection,
        status: "failed",
        runtimeEvents: upsertRuntimeEvent(projection.runtimeEvents, event.event),
        runtimeModel: runtimeModelAfterLegacyEvent(projection.runtimeModel, event.event),
        summary: mergeRuntimeSummary(projection.summary, event.event.summary),
        unreadResult: true,
        updatedAt: event.event.timestamp,
      };
    case "queued-message-added": {
      const consumedAt = projection.pendingConsumedIds[event.queuedMessage.id];
      const queuedMessage =
        consumedAt !== undefined
          ? {
              ...event.queuedMessage,
              status: "processing" as const,
              processingStartedAt: consumedAt,
            }
          : { ...event.queuedMessage };
      const pendingConsumedIds = { ...projection.pendingConsumedIds };
      delete pendingConsumedIds[event.queuedMessage.id];

      return {
        ...projection,
        lastUserMessageAt: maxIsoTimestamp(projection.lastUserMessageAt, event.queuedMessage.createdAt),
        queuedMessages: [...projection.queuedMessages, queuedMessage],
        pendingConsumedIds,
        updatedAt: event.queuedMessage.createdAt,
      };
    }
    case "queued-message-withdrawn":
      return {
        ...projection,
        queuedMessages: projection.queuedMessages.map((queuedMessage) => {
          if (queuedMessage.id !== event.queuedMessageId) {
            return queuedMessage;
          }

          if (queuedMessage.status !== "pending") {
            throw new Error("Queued message can no longer be withdrawn.");
          }

          return {
            ...queuedMessage,
            status: "withdrawn",
            withdrawnAt: event.occurredAt,
          };
        }),
        updatedAt: event.occurredAt,
      };
    case "queued-messages-reordered": {
      const byId = new Map(
        projection.queuedMessages.map((queuedMessage) => [queuedMessage.id, queuedMessage]),
      );
      const reordered = event.orderedIds.map((id) => {
        const queuedMessage = byId.get(id);
        if (!queuedMessage) {
          throw new Error(`Queued message "${id}" was not found.`);
        }
        return queuedMessage;
      });
      const placed = new Set(event.orderedIds);
      const leftover = projection.queuedMessages.filter(
        (queuedMessage) => !placed.has(queuedMessage.id),
      );

      return {
        ...projection,
        queuedMessages: [...reordered, ...leftover],
        updatedAt: event.occurredAt,
      };
    }
    case "queued-messages-synced": {
      const localById = new Map(
        projection.queuedMessages.map((queuedMessage) => [queuedMessage.id, queuedMessage]),
      );
      const rank = { pending: 0, processing: 1, steered: 2, withdrawn: 2 } as const;
      const merged = event.queuedMessages.map((incoming) => {
        const local = localById.get(incoming.id);
        if (!local) {
          return { ...incoming };
        }
        if (
          rank[local.status] > rank[incoming.status] ||
          (rank[local.status] === rank[incoming.status] && local.status !== incoming.status)
        ) {
          return {
            ...incoming,
            status: local.status,
            ...(local.processingStartedAt
              ? { processingStartedAt: local.processingStartedAt }
              : {}),
            ...(local.steeredAt ? { steeredAt: local.steeredAt } : {}),
            ...(local.withdrawnAt ? { withdrawnAt: local.withdrawnAt } : {}),
          };
        }
        if (
          incoming.status === "processing" &&
          local.processingStartedAt &&
          !incoming.processingStartedAt
        ) {
          return { ...incoming, processingStartedAt: local.processingStartedAt };
        }
        return { ...incoming };
      });

      return {
        ...projection,
        queuedMessages: merged,
        updatedAt: event.occurredAt,
      };
    }
    case "steer-submitted":
      return {
        ...projection,
        lastUserMessageAt: maxIsoTimestamp(projection.lastUserMessageAt, event.event.timestamp),
        status: "running",
        runtimeEvents: upsertRuntimeEvent(projection.runtimeEvents, event.event),
        runtimeModel: runtimeModelAfterLegacyEvent(projection.runtimeModel, event.event),
        summary: mergeRuntimeSummary(projection.summary, event.event.summary),
        unreadResult: unreadResultFromRuntimeEvent(projection, event.event),
        updatedAt: event.event.timestamp,
      };
    case "run-stopped":
      return {
        ...projection,
        status: "completed",
        runtimeEvents: upsertRuntimeEvent(projection.runtimeEvents, event.event),
        runtimeModel: runtimeModelAfterLegacyEvent(projection.runtimeModel, event.event),
        summary: mergeRuntimeSummary(projection.summary, event.event.summary),
        unreadResult: true,
        updatedAt: event.event.timestamp,
      };
    case "run-stop-failed":
      return {
        ...projection,
        status: projection.status,
        runtimeEvents: upsertRuntimeEvent(projection.runtimeEvents, event.event),
        runtimeModel: runtimeModelAfterLegacyEvent(projection.runtimeModel, event.event),
        summary: mergeRuntimeSummary(projection.summary, event.event.summary),
        unreadResult: unreadResultFromRuntimeEvent(projection, event.event),
        updatedAt: event.event.timestamp,
      };
    case "latest-message-rendered":
      return {
        ...projection,
        unreadResult: false,
      };
    case "session-archived":
      if (!canArchiveSessionProjection(projection)) {
        throw new Error("Cannot archive an active Session.");
      }

      return {
        ...projection,
        archivedAt: event.occurredAt,
      };
    case "projection-marked-stale":
      // Opening/reconnect health is not chat activity — keep list time stable.
      return {
        ...projection,
        stale: true,
        staleReason: event.reason,
      };
    case "runtime-state-resynced": {
      const replayed = runtimeModelFromReplay(projection.runtimeModel, event.state);
      const snapshotSeq = (event.state.replay ?? []).reduce(
        (latest, step) => Math.max(latest, step.kind === "agent" ? step.entry.seq : step.seq),
        0,
      );
      const hasNewerLiveEvents = projection.runtimeModel.lastSeq > snapshotSeq;
      // The driver is the authority on what is running now: a journal whose
      // `run(end)` never made it to disk would otherwise keep a dead run's
      // Chain of Thought live the moment the Session becomes executable again
      // (#170). Live deltas the snapshot predates are the one exception — the
      // run they opened is younger than the state being reported.
      const driverIdle =
        event.state.executionState === "cold" || event.state.status !== "running";
      const runtimeModel =
        driverIdle && !hasNewerLiveEvents ? settleOpenRuns(replayed) : replayed;
      const runtimeEvents = normalizedRuntimeEvents(event.state.events);
      let queuedMessages = projection.queuedMessages;
      let pendingConsumedIds = projection.pendingConsumedIds;
      for (const step of event.state.replay ?? []) {
        if (step.kind !== "agent" || step.entry.event.type !== "queued-message-consumed") {
          continue;
        }
        const applied = applyQueuedMessageConsumed(
          queuedMessages,
          pendingConsumedIds,
          step.entry.event.queuedMessageId,
          step.entry.event.consumedAt,
          false,
        );
        queuedMessages = applied.queuedMessages;
        pendingConsumedIds = applied.pendingConsumedIds;
      }
      // Resume snapshots stamp updatedAt=now(); list time must stay on last
      // message, not last open (DF-010).
      const resyncedProjection: SessionProjection = {
        ...projection,
        // Once the rebuilt model has Active Runs it owns the Session Status;
        // otherwise the bridge-reported state remains the truth.
        status: event.state.executionState === "cold" ? sessionStatusFromRuntimeState(event.state)
          : hasNewerLiveEvents ? projection.status
          : sessionStatusFromRuntimeModel(runtimeModel) ?? sessionStatusFromRuntimeState(event.state),
        runtimeId: event.state.runtimeId,
        piSessionId: event.state.piSessionId,
        cwd: event.state.cwd,
        sessionFile: event.state.sessionFile ?? projection.sessionFile,
        sessionName: event.state.sessionName ?? projection.sessionName,
        runtimeEvents,
        runtimeModel,
        summary: event.state.summary ? { ...event.state.summary } : projection.summary,
        modelControls: event.state.modelControls
          ? {
              models: event.state.modelControls.models.map((model) => ({
                ...model,
                thinkingLevels: [...model.thinkingLevels],
              })),
              selected: event.state.modelControls.selected
                ? { ...event.state.modelControls.selected }
                : null,
            }
          : projection.modelControls,
        contextUsage: event.state.contextUsage
          ? { ...event.state.contextUsage }
          : projection.contextUsage,
        followUpMode: event.state.followUpMode ?? projection.followUpMode,
        queuedMessages,
        pendingConsumedIds,
        stale: false,
        staleReason: null,
      };

      return {
        ...resyncedProjection,
        updatedAt: lastChatActivityAt(resyncedProjection, {
          events: runtimeEvents,
        }),
      };
    }
    case "model-controls-changed":
      // Model/thinking changes are not chat messages — do not bump list time.
      return {
        ...projection,
        modelControls: {
          models: event.modelControls.models.map((model) => ({
            ...model,
            thinkingLevels: [...model.thinkingLevels],
          })),
          selected: event.modelControls.selected
            ? { ...event.modelControls.selected }
            : null,
        },
        summary: event.modelControls.selected
          ? {
              ...projection.summary,
              provider: event.modelControls.selected.provider,
              model: event.modelControls.selected.modelId,
            }
          : projection.summary,
      };
    case "creation-failed":
      return {
        ...projection,
        status: "failed",
        creationStage: "failed",
        failure: {
          stage: event.stage,
          message: event.message,
        },
        updatedAt: event.occurredAt,
      };
  }
}
