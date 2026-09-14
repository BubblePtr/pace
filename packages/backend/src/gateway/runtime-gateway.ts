import { homedir } from "node:os";
import { access } from "node:fs/promises";
import type {
  RuntimeGatewayEventEnvelope,
  RuntimeGatewayEventInput,
  RuntimeGatewayQueuedMessage,
  RuntimeGatewayRequest,
  RuntimeGatewayResponse,
  RuntimeGatewaySnapshot,
  RuntimeModelControls,
  RuntimeModelSelection,
  RuntimePromptImage,
  RuntimeToolSchemas,
} from "@pace/core";
import {
  CHAT_PROJECT_ID,
  createRuntimeGatewaySequencer,
  parseRuntimePromptImages,
  shouldJournalRuntimeEvent,
} from "@pace/core";
import {
  copiedSessionEventInputsForFork,
  forkMarkerEventInput,
  prepareSessionEventJournalFork,
  resolveDataDir,
  type PreparedSessionEventJournalFork,
  type SessionEventJournal,
} from "../persistence/session-event-journal";
import { ensureChatWorkspace } from "../workspace/chat-workspace";
import {
  mergeSessionProjection,
  projectionFromRuntimeSnapshot,
  type SessionProjectionStore,
  type PersistedSessionProjection,
} from "../persistence/session-projection-store";
import { resolvePersistedListUpdatedAt } from "../persistence/session-list-time";

export type RuntimeGatewayDriverEvent = Omit<RuntimeGatewayEventInput, "sessionId"> & {
  sessionId?: string;
};

export type CreateRuntimeSessionInput = {
  sessionId: string;
  projectId: string;
  cwd: string;
  checkout?: unknown;
};

export type ResumeRuntimeSessionInput = CreateRuntimeSessionInput & {
  piSessionId: string;
  sessionFile: string;
  modelSelection?: RuntimeModelSelection;
};

export type ForkRuntimeSessionInput = CreateRuntimeSessionInput & {
  sourcePiSessionId: string;
  sourceSessionFile: string;
  piEntryId: string;
};

export type ForkRuntimeSessionResult = {
  snapshot: RuntimeGatewaySnapshot;
  selectedText?: string;
};

export type SendPromptInput = {
  piSessionId: string;
  prompt: string;
  images?: RuntimePromptImage[];
};

export type QueueFollowUpInput = {
  piSessionId: string;
  message: string;
  images?: RuntimePromptImage[];
};

export type WithdrawQueuedMessageInput = {
  piSessionId: string;
  queuedMessageId: string;
};

export type SteerRunInput = {
  piSessionId: string;
  message: string;
  images?: RuntimePromptImage[];
};

export type StopRunInput = {
  piSessionId: string;
};

export type ConfigureRuntimeModelInput = RuntimeModelSelection & {
  piSessionId: string;
};

export type ResolveToolSchemasInput = {
  piSessionId: string;
  names: string[];
};

export type PiRuntimeDriver = {
  createSession(input: CreateRuntimeSessionInput): Promise<RuntimeGatewaySnapshot>;
  resumeSession(input: ResumeRuntimeSessionInput): Promise<RuntimeGatewaySnapshot>;
  forkSession(input: ForkRuntimeSessionInput): Promise<ForkRuntimeSessionResult>;
  sendPrompt(input: SendPromptInput): Promise<RuntimeGatewayDriverEvent>;
  queueFollowUp(input: QueueFollowUpInput): Promise<RuntimeGatewayQueuedMessage>;
  withdrawQueuedMessage(input: WithdrawQueuedMessageInput): Promise<RuntimeGatewayQueuedMessage>;
  steerRun(input: SteerRunInput): Promise<RuntimeGatewayDriverEvent>;
  stopRun(input: StopRunInput): Promise<RuntimeGatewayDriverEvent>;
  configureModel?(input: ConfigureRuntimeModelInput): Promise<RuntimeModelControls>;
  resolveToolSchemas?(input: ResolveToolSchemasInput): Promise<RuntimeToolSchemas>;
  getSnapshot(piSessionId: string): Promise<RuntimeGatewaySnapshot>;
  disposeSession?(piSessionId: string): Promise<void>;
  dispose?(): Promise<void>;
  onEvent(listener: (event: RuntimeGatewayDriverEvent) => void): () => void;
};

export type RuntimeGatewayBackendEvent = {
  type: "event";
  event: RuntimeGatewayEventEnvelope;
};

export type RuntimeGatewayService = {
  publish(event: RuntimeGatewayEventInput): RuntimeGatewayEventEnvelope | null;
  advanceSequence(events: RuntimeGatewayEventEnvelope[]): void;
  flush(): Promise<void>;
  handleRequest(request: RuntimeGatewayRequest): Promise<RuntimeGatewayResponse>;
  onEvent(listener: (event: RuntimeGatewayBackendEvent) => void): () => void;
};

export type RuntimeGatewayServiceOptions = {
  driver: PiRuntimeDriver;
  // Boundary-event journal backing snapshot replay; without it snapshots
  // fall back to whatever events the driver reports (historically none).
  journal?: SessionEventJournal;
  projections?: SessionProjectionStore;
  now?: () => string;
  idFactory?: () => string;
  dataDir?: string;
};

export function createRuntimeGatewayService(
  options: RuntimeGatewayServiceOptions,
): RuntimeGatewayService {
  const listeners = new Set<(event: RuntimeGatewayBackendEvent) => void>();
  const sessionIdsByPiSessionId = new Map<string, string>();
  const now = options.now ?? (() => new Date().toISOString());
  const dataDir = options.dataDir ?? resolveDataDir(process.env, homedir());
  const nextEvent = createRuntimeGatewaySequencer({
    now,
    idFactory: options.idFactory,
  });
  const projectionWrites = createRuntimeEventProjectionWriter(options.projections);
  const initializationEvents = new Map<string, RuntimeGatewayDriverEvent[]>();
  const requests = new Map<string, Promise<void>>();

  const emit = (event: RuntimeGatewayDriverEvent) => {
    const sessionId =
      event.sessionId ?? sessionIdsByPiSessionId.get(event.piSessionId);

    if (!sessionId) {
      return null;
    }

    const envelope = nextEvent({
      sessionId,
      piSessionId: event.piSessionId,
      turnId: event.turnId,
      type: event.type,
      ts: event.ts,
      payload: event.payload,
    });
    const backendEvent: RuntimeGatewayBackendEvent = {
      type: "event",
      event: envelope,
    };

    if (options.journal && shouldJournalRuntimeEvent(envelope.payload)) {
      options.journal.append(envelope);
    }

    projectionWrites.enqueue(envelope);

    for (const listener of listeners) {
      listener(backendEvent);
    }

    return envelope;
  };
  const appendJournalEvent = (event: RuntimeGatewayEventInput) => {
    const envelope = nextEvent(event);

    options.journal?.append(envelope);

    return envelope;
  };

  options.driver.onEvent((event) => {
    const sessionId = event.sessionId ?? sessionIdsByPiSessionId.get(event.piSessionId);
    const pending = sessionId ? initializationEvents.get(sessionId) : undefined;
    if (pending) pending.push(event);
    else emit(event);
  });

  return {
    publish: emit,
    advanceSequence(events) { nextEvent.advanceTo(events.reduce((seq, event) => Math.max(seq, event.seq), 0)); },
    flush: () => projectionWrites.flush(),
    async handleRequest(request) {
      const params = paramsRecord(request.params);
      const piSessionId = typeof params.piSessionId === "string" ? params.piSessionId : undefined;
      const bypassQueue = request.method === "stop_run";
      const key = bypassQueue ? undefined : typeof params.sessionId === "string" ? params.sessionId
        : piSessionId ? sessionIdsByPiSessionId.get(piSessionId) ?? piSessionId : undefined;
      let release: (() => void) | undefined;
      let current: Promise<void> | undefined;
      let previous: Promise<void> | undefined;
      let pendingClose: Promise<void> | undefined;
      if (key) {
        previous = requests.get(key);
        current = new Promise<void>(resolve => { release = resolve; });
        requests.set(key, current);
        // Input hooks can await a child before accepting the user's prompt.
        // Cancel that work before waiting on its metadata request to finish.
        if (previous && request.method === "delete_session" && options.driver.disposeSession) {
          const rootPiId = [...sessionIdsByPiSessionId].find(([, id]) => id === key)?.[0];
          if (rootPiId) pendingClose = options.driver.disposeSession(rootPiId);
        }
      }
      let initializingSessionId: string | undefined;
      try {
        await Promise.all([previous, pendingClose]);
        if (["create_session", "resume_session", "fork_session"].includes(request.method)) {
          initializingSessionId = requiredString(paramsRecord(request.params).sessionId, "sessionId");
          initializationEvents.set(initializingSessionId, []);
        }
        let result = await dispatchRuntimeGatewayRequest({
          request,
          driver: options.driver,
          flushProjections: () => projectionWrites.flush(),
          journal: options.journal,
          projections: options.projections,
          dataDir,
          emit,
          appendJournalEvent,
          now,
          recordUserSubmission(piSessionId, submittedAt) {
            const sessionId = sessionIdsByPiSessionId.get(piSessionId);
            if (sessionId) projectionWrites.recordUserSubmission(sessionId, submittedAt);
          },
          advanceEventSequence(events) {
            nextEvent.advanceTo(
              events.reduce((highestSeq, event) => Math.max(highestSeq, event.seq), 0),
            );
          },
          rememberSession(snapshot) {
            sessionIdsByPiSessionId.set(snapshot.piSessionId, snapshot.sessionId);
          },
          resolveSessionId(piSessionId) {
            return sessionIdsByPiSessionId.get(piSessionId) ?? null;
          },
        });

        if (initializingSessionId) {
          const pending = initializationEvents.get(initializingSessionId) ?? [];
          initializationEvents.delete(initializingSessionId);
          // Fork history and the session projection must exist before startup
          // events are sequenced. Include them in the first response: the
          // renderer cannot subscribe to a session it has not received yet.
          const events = pending.map(emit).filter((event): event is RuntimeGatewayEventEnvelope => event !== null);
          if (events.length > 0) {
            if (request.method === "fork_session") {
              const fork = result as ForkRuntimeSessionResult;
              result = { ...fork, snapshot: { ...fork.snapshot, events: [...fork.snapshot.events, ...events] } };
            } else {
              const snapshot = result as RuntimeGatewaySnapshot;
              result = { ...snapshot, events: [...snapshot.events, ...events] };
            }
          }
        }
        await projectionWrites.flush();

        return {
          id: request.id,
          result,
        };
      } catch (error) {
        return {
          id: request.id,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (initializingSessionId) initializationEvents.delete(initializingSessionId);
        release?.();
        if (key && requests.get(key) === current) requests.delete(key);
      }
    },

    onEvent(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

async function dispatchRuntimeGatewayRequest(input: {
  request: RuntimeGatewayRequest;
  driver: PiRuntimeDriver;
  journal?: SessionEventJournal;
  projections?: SessionProjectionStore;
  dataDir: string;
  emit: (event: RuntimeGatewayDriverEvent) => RuntimeGatewayEventEnvelope | null;
  appendJournalEvent: (event: RuntimeGatewayEventInput) => RuntimeGatewayEventEnvelope;
  now: () => string;
  recordUserSubmission: (piSessionId: string, submittedAt: string) => void;
  advanceEventSequence: (events: RuntimeGatewayEventEnvelope[]) => void;
  rememberSession: (snapshot: RuntimeGatewaySnapshot) => void;
  resolveSessionId: (piSessionId: string) => string | null;
  flushProjections: () => Promise<void>;
}) {
  const params = paramsRecord(input.request.params);

  switch (input.request.method) {
    case "prepare_chat_workspace": {
      const sessionId = requiredString(params.sessionId, "sessionId");
      const cwd = await ensureChatWorkspace(input.dataDir, sessionId);
      return { cwd };
    }
    case "create_session": {
      const snapshot = await input.driver.createSession({
        sessionId: requiredString(params.sessionId, "sessionId"),
        projectId: requiredString(params.projectId, "projectId"),
        cwd: requiredString(params.cwd, "cwd"),
        checkout: params.checkout,
      });

      input.rememberSession(snapshot);
      await saveSnapshotProjection({
        store: input.projections,
        snapshot,
        patch: { lastUserMessageAt: snapshot.updatedAt },
      });

      return snapshot;
    }
    case "resume_session": {
      const sessionId = requiredString(params.sessionId, "sessionId");
      const piSessionId = requiredString(params.piSessionId, "piSessionId");
      const projectId = requiredString(params.projectId, "projectId");
      const { cwd, rebuilt } = await resolveChatRuntimeCwd({
        dataDir: input.dataDir,
        projectId,
        sessionId,
        cwd: requiredString(params.cwd, "cwd"),
      });
      const journaled = (await input.journal?.read(piSessionId)) ?? [];
      const persistedProjection = await input.projections?.get(sessionId);

      input.advanceEventSequence(journaled);

      const snapshot = await input.driver.resumeSession({
        sessionId,
        projectId,
        piSessionId,
        sessionFile: requiredString(params.sessionFile, "sessionFile"),
        cwd,
        checkout: rebuilt
          ? rewriteRebuiltCheckoutPaths(params.checkout, cwd)
          : params.checkout,
        modelSelection: persistedProjection?.modelSelection,
      });
      const snapshotWithEvents = journaled.length
        ? { ...snapshot, events: journaled }
        : snapshot;

      input.rememberSession(snapshotWithEvents);
      await saveSnapshotProjection({
        store: input.projections,
        snapshot: snapshotWithEvents,
      });

      return snapshotWithEvents;
    }
    case "fork_session": {
      const sessionId = requiredString(params.sessionId, "sessionId");
      const projectId = requiredString(params.projectId, "projectId");
      const sourcePiSessionId = requiredString(
        params.sourcePiSessionId,
        "sourcePiSessionId",
      );
      const piEntryId = requiredString(params.piEntryId, "piEntryId");
      const preparedForkJournal = await prepareForkJournal({
        journal: input.journal,
        sourcePiSessionId,
        piEntryId,
      });
      const { cwd, rebuilt } = await resolveChatRuntimeCwd({
        dataDir: input.dataDir,
        projectId,
        sessionId,
        cwd: requiredString(params.cwd, "cwd"),
      });
      const result = await input.driver.forkSession({
        sessionId,
        projectId,
        sourcePiSessionId,
        sourceSessionFile: requiredString(
          params.sourceSessionFile,
          "sourceSessionFile",
        ),
        piEntryId,
        cwd,
        checkout: rebuilt
          ? rewriteRebuiltCheckoutPaths(params.checkout, cwd)
          : params.checkout,
      });
      const journaled = await copyJournalForFork({
        appendJournalEvent: input.appendJournalEvent,
        preparedForkJournal,
        sourcePiSessionId,
        targetSessionId: result.snapshot.sessionId,
        targetPiSessionId: result.snapshot.piSessionId,
        piEntryId,
      });
      const snapshotWithEvents = journaled.length
        ? { ...result.snapshot, events: journaled }
        : result.snapshot;

      input.rememberSession(snapshotWithEvents);
      await saveSnapshotProjection({
        store: input.projections,
        snapshot: snapshotWithEvents,
        patch: {
          ...(result.selectedText ? { initialPrompt: result.selectedText } : {}),
          // A new fork belongs at creation time, not at an inherited message's time.
          lastUserMessageAt: result.snapshot.updatedAt,
        },
      });

      return {
        snapshot: snapshotWithEvents,
        ...(result.selectedText ? { selectedText: result.selectedText } : {}),
      };
    }
    case "send_prompt": {
      const submittedAt = input.now();
      const prompt = parsePromptText(params.prompt, params.images, "prompt");
      await setProjectionInitialPrompt({
        store: input.projections,
        sessionId: input.resolveSessionId(requiredString(params.piSessionId, "piSessionId")),
        piSessionId: requiredString(params.piSessionId, "piSessionId"),
        prompt: prompt.text || prompt.images[0]?.name || "Attached image",
      });

      const event = await input.driver.sendPrompt({
        piSessionId: requiredString(params.piSessionId, "piSessionId"),
        prompt: prompt.text,
        ...(prompt.images.length ? { images: prompt.images } : {}),
      });
      input.recordUserSubmission(event.piSessionId, submittedAt);
      return input.emit(event);
    }
    case "queue_follow_up": {
      const submittedAt = input.now();
      const followUp = parsePromptText(params.message, params.images, "message");
      const queued = await input.driver.queueFollowUp({
        piSessionId: requiredString(params.piSessionId, "piSessionId"),
        message: followUp.text,
        ...(followUp.images.length ? { images: followUp.images } : {}),
      });
      input.recordUserSubmission(queued.piSessionId, submittedAt);
      return queued;
    }
    case "withdraw_queued_message":
      return input.driver.withdrawQueuedMessage({
        piSessionId: requiredString(params.piSessionId, "piSessionId"),
        queuedMessageId: requiredString(params.queuedMessageId, "queuedMessageId"),
      });
    case "steer_run": {
      const submittedAt = input.now();
      const steer = parsePromptText(params.message, params.images, "message");
      const event = await input.driver.steerRun({
        piSessionId: requiredString(params.piSessionId, "piSessionId"),
        message: steer.text,
        ...(steer.images.length ? { images: steer.images } : {}),
      });
      input.recordUserSubmission(event.piSessionId, submittedAt);
      return input.emit(event);
    }
    case "stop_run":
      return input.emit(
        await input.driver.stopRun({
          piSessionId: requiredString(params.piSessionId, "piSessionId"),
        }),
      );
    case "configure_model": {
      if (!input.driver.configureModel) {
        throw new Error('Runtime driver does not support "configure_model".');
      }

      const sessionId = requiredString(params.sessionId, "sessionId");
      const piSessionId = requiredString(params.piSessionId, "piSessionId");
      const mappedSessionId = input.resolveSessionId(piSessionId);
      const persistedProjection = await input.projections?.get(sessionId);

      if (mappedSessionId && mappedSessionId !== sessionId) {
        throw new Error(
          `Pi session "${piSessionId}" does not belong to Session "${sessionId}".`,
        );
      }

      if (input.projections && !persistedProjection) {
        throw new Error(`Session "${sessionId}" was not found.`);
      }

      if (
        persistedProjection &&
        persistedProjection.piSessionId !== piSessionId
      ) {
        throw new Error(
          `Pi session "${piSessionId}" does not belong to Session "${sessionId}".`,
        );
      }

      const controls = await input.driver.configureModel({
        piSessionId,
        provider: requiredString(params.provider, "provider"),
        modelId: requiredString(params.modelId, "modelId"),
        thinkingLevel: requiredThinkingLevel(params.thinkingLevel),
      });

      await persistModelSelection({
        store: input.projections,
        sessionId,
        selection: controls.selected,
        updatedAt: input.now(),
      });

      return controls;
    }
    case "archive_session": {
      return archiveSessionProjection({
        store: input.projections,
        sessionId: requiredString(params.sessionId, "sessionId"),
        archivedAt: input.now(),
      });
    }
    case "rename_session":
      return renameSessionProjection({
        store: input.projections,
        sessionId: requiredString(params.sessionId, "sessionId"),
        title: requiredString(params.title, "title").trim(),
      });
    case "delete_session":
      return deleteSessionProjection({
        dispose: input.driver.disposeSession ? async piSessionId => {
          await input.driver.disposeSession!(piSessionId);
          await input.flushProjections();
        } : undefined,
        store: input.projections,
        sessionId: requiredString(params.sessionId, "sessionId"),
      });
    case "resolve_tool_schemas": {
      const piSessionId = requiredString(params.piSessionId, "piSessionId");
      const names = requiredStringArray(params.names, "names");

      if (!input.driver.resolveToolSchemas) {
        return { schemas: {} };
      }

      return input.driver.resolveToolSchemas({ piSessionId, names });
    }
    case "get_runtime_snapshot": {
      const piSessionId = requiredString(params.piSessionId, "piSessionId");
      const journaled = (await input.journal?.read(piSessionId)) ?? [];

      input.advanceEventSequence(journaled);

      const snapshot = await input.driver.getSnapshot(piSessionId);
      const snapshotWithEvents = journaled.length
        ? { ...snapshot, events: journaled }
        : snapshot;

      // The journal is the Gateway's event truth; drivers only own
      // status/summary. Fall back to driver events when nothing was journaled.
      await saveSnapshotProjection({
        store: input.projections,
        snapshot: snapshotWithEvents,
      });

      return snapshotWithEvents;
    }
    default:
      throw new Error(`Unknown Runtime Gateway method "${input.request.method}".`);
  }
}

function createRuntimeEventProjectionWriter(store?: SessionProjectionStore) {
  const pendingWrites = new Map<string, Promise<void>>();

  const enqueueUpdate = (
    sessionId: string,
    update: (current: PersistedSessionProjection) => PersistedSessionProjection,
  ) => {
    if (!store) return;

    const previousWrite = pendingWrites.get(sessionId) ?? Promise.resolve();
    const write = previousWrite
      .then(async () => {
        const current = await store.get(sessionId);

        if (!current) {
          return;
        }

        const next = update(current);

        if (next !== current) {
          await store.save(next);
        }
      })
      .catch((error) => {
        console.error(
          `Pace failed to persist Session Projection "${sessionId}":`,
          error,
        );
      });

    pendingWrites.set(sessionId, write);
    void write.finally(() => {
      if (pendingWrites.get(sessionId) === write) {
        pendingWrites.delete(sessionId);
      }
    });
  };

  return {
    enqueue(event: RuntimeGatewayEventEnvelope) {
      if (projectionPatchFromRuntimeEvent(event)) {
        enqueueUpdate(event.sessionId, (current) => projectionAfterRuntimeEvent(current, event));
      }
    },
    recordUserSubmission(sessionId: string, submittedAt: string) {
      // Serialize with runtime writes so streaming updates cannot erase a submission.
      enqueueUpdate(sessionId, (current) => ({
        ...current,
        lastUserMessageAt:
          current.lastUserMessageAt && current.lastUserMessageAt > submittedAt
            ? current.lastUserMessageAt
            : submittedAt,
      }));
    },
    async flush() {
      await Promise.all([...pendingWrites.values()]);
    },
  };
}

function projectionPatchFromRuntimeEvent(event: RuntimeGatewayEventEnvelope) {
  const payload = event.payload;

  if (payload.type === "session_info_changed" && typeof payload.name === "string") {
    return { sessionName: payload.name.trim() };
  }

  if (payload.type === "run") {
    if (payload.phase === "start") {
      return { status: "running" as const };
    }

    if (payload.phase === "end") {
      return {
        status: payload.outcome === "failed" ? ("failed" as const) : ("completed" as const),
      };
    }
  }

  if (payload.type === "error") {
    return payload.fatal === false ? null : { status: "failed" as const };
  }

  if (payload.type === "usage") {
    return { summary: runtimeSummaryPatch(payload.summary) };
  }

  if (payload.kind === "error") {
    return { status: "failed" as const };
  }

  if (payload.kind === "status") {
    return { status: "completed" as const };
  }

  if (payload.kind === "message" || payload.kind === "control") {
    return {
      status: "running" as const,
      summary: runtimeSummaryPatch(payload.summary),
    };
  }

  return null;
}

function projectionAfterRuntimeEvent(
  current: PersistedSessionProjection,
  event: RuntimeGatewayEventEnvelope,
) {
  const patch = projectionPatchFromRuntimeEvent(event);

  if (!patch) {
    return current;
  }

  return mergeSessionProjection(current, {
    ...current,
    ...patch,
    summary: patch.summary
      ? {
          provider: patch.summary.provider ?? current.summary?.provider ?? null,
          model: patch.summary.model ?? current.summary?.model ?? null,
          totalTokens: patch.summary.totalTokens ?? current.summary?.totalTokens ?? 0,
          totalCostUsd:
            patch.summary.totalCostUsd ?? current.summary?.totalCostUsd ?? 0,
        }
      : current.summary,
    updatedAt: event.payload.type === "session_info_changed" ? current.updatedAt : event.ts,
  });
}

function runtimeSummaryPatch(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    provider:
      typeof value.provider === "string" || value.provider === null
        ? value.provider
        : undefined,
    model:
      typeof value.model === "string" || value.model === null
        ? value.model
        : undefined,
    totalTokens:
      typeof value.totalTokens === "number" && Number.isFinite(value.totalTokens)
        ? value.totalTokens
        : undefined,
    totalCostUsd:
      typeof value.totalCostUsd === "number" && Number.isFinite(value.totalCostUsd)
        ? value.totalCostUsd
        : undefined,
  };
}

async function archiveSessionProjection(input: {
  store?: SessionProjectionStore;
  sessionId: string;
  archivedAt: string;
}) {
  const { store, projection } = await requireProjection(input);

  if (projection.status === "running") {
    throw new Error("Cannot archive an active Session.");
  }

  if (projection.status === "archived") {
    return projection;
  }

  const archived: PersistedSessionProjection = {
    ...projection,
    status: "archived",
    archivedAt: input.archivedAt,
    updatedAt: input.archivedAt,
  };

  await store.save(archived);

  return archived;
}

async function renameSessionProjection(input: {
  store?: SessionProjectionStore;
  sessionId: string;
  title: string;
}) {
  const { store, projection } = await requireProjection(input);
  // A rename is not chat activity — leave updatedAt so list order stays put.
  const renamed: PersistedSessionProjection = {
    ...projection,
    title: input.title,
  };

  await store.save(renamed);

  return renamed;
}

async function deleteSessionProjection(input: {
  dispose?: (piSessionId: string) => Promise<void>;
  store?: SessionProjectionStore;
  sessionId: string;
}) {
  const { store, projection } = await requireProjection(input);

  if (input.dispose) await input.dispose(projection.piSessionId);
  else if (projection.status === "running") {
    throw new Error("Cannot delete an active Session.");
  }

  // Pi owns Session truth; Pace only drops its own projection record.
  await store.remove(input.sessionId);

  return projection;
}

async function requireProjection(input: {
  store?: SessionProjectionStore;
  sessionId: string;
}) {
  if (!input.store) {
    throw new Error("Session Projection persistence is unavailable.");
  }

  const projection = await input.store.get(input.sessionId);

  if (!projection) {
    throw new Error(`Session "${input.sessionId}" was not found.`);
  }

  return { store: input.store, projection };
}

async function getProjectionBySessionId(input: {
  store: SessionProjectionStore;
  sessionId: string;
}) {
  return input.store.get(input.sessionId);
}

async function saveMergedProjection(input: {
  store?: SessionProjectionStore;
  projection: PersistedSessionProjection;
}) {
  if (!input.store) {
    return;
  }

  const current = await getProjectionBySessionId({
    store: input.store,
    sessionId: input.projection.sessionId,
  });

  await input.store.save(mergeSessionProjection(current, input.projection));
}

async function saveSnapshotProjection(input: {
  store?: SessionProjectionStore;
  snapshot: RuntimeGatewaySnapshot;
  patch?: Partial<PersistedSessionProjection>;
}) {
  if (!input.store) {
    return;
  }

  const current = await getProjectionBySessionId({
    store: input.store,
    sessionId: input.snapshot.sessionId,
  });
  const base = projectionFromRuntimeSnapshot(input.snapshot);
  // Drivers stamp snapshot.updatedAt = now() on every resume/getSnapshot.
  // List time must stay on last chat activity (DF-010/DF-012).
  const updatedAt = resolvePersistedListUpdatedAt({
    events: input.snapshot.events,
    previousUpdatedAt: current?.updatedAt,
    snapshotUpdatedAt: base.updatedAt,
  });

  await input.store.save(
    mergeSessionProjection(current, {
      ...base,
      ...input.patch,
      updatedAt,
    }),
  );
}

async function persistModelSelection(input: {
  store?: SessionProjectionStore;
  sessionId: string;
  selection: RuntimeModelSelection | null;
  updatedAt: string;
}) {
  if (!input.store) {
    return;
  }

  const current = await input.store.get(input.sessionId);

  if (!current) {
    throw new Error(`Session "${input.sessionId}" was not found.`);
  }

  // Model/thinking changes are not chat activity — keep list time stable.
  void input.updatedAt;
  await input.store.save({
    ...current,
    ...(input.selection ? { modelSelection: { ...input.selection } } : {}),
  });
}

async function prepareForkJournal(input: {
  journal?: SessionEventJournal;
  sourcePiSessionId: string;
  piEntryId: string;
}): Promise<PreparedSessionEventJournalFork | null> {
  if (!input.journal) {
    return null;
  }

  return prepareSessionEventJournalFork({
    journal: input.journal,
    sourcePiSessionId: input.sourcePiSessionId,
    piEntryId: input.piEntryId,
  });
}

async function copyJournalForFork(input: {
  appendJournalEvent: (event: RuntimeGatewayEventInput) => RuntimeGatewayEventEnvelope;
  preparedForkJournal: PreparedSessionEventJournalFork | null;
  sourcePiSessionId: string;
  targetSessionId: string;
  targetPiSessionId: string;
  piEntryId: string;
}) {
  if (!input.preparedForkJournal) {
    return [];
  }

  const copied = copiedSessionEventInputsForFork({
    prepared: input.preparedForkJournal,
    sourcePiSessionId: input.sourcePiSessionId,
    targetSessionId: input.targetSessionId,
    targetPiSessionId: input.targetPiSessionId,
  }).map(input.appendJournalEvent);

  copied.push(
    input.appendJournalEvent(
      forkMarkerEventInput({
        prepared: input.preparedForkJournal,
        sourcePiSessionId: input.sourcePiSessionId,
        targetSessionId: input.targetSessionId,
        targetPiSessionId: input.targetPiSessionId,
        piEntryId: input.piEntryId,
      }),
    ),
  );

  return copied;
}

async function setProjectionInitialPrompt(input: {
  store?: SessionProjectionStore;
  sessionId: string | null;
  piSessionId: string;
  prompt: string;
}) {
  if (!input.store) {
    return;
  }

  const projection = input.sessionId
    ? await input.store.get(input.sessionId)
    : (await input.store.list()).find(
        (candidate) => candidate.piSessionId === input.piSessionId,
      );

  if (!projection || projection.initialPrompt) {
    return;
  }

  await input.store.save({
    ...projection,
    initialPrompt: input.prompt,
  });
}

function paramsRecord(params: unknown) {
  return isRecord(params) ? params : {};
}

const checkoutPathKeys = [
  "root",
  "runtimeCwd",
  "diffRoot",
  "repoRoot",
  "projectRoot",
  "executionCheckoutRoot",
] as const;

// Terminal and Changes persist checkout.root / diffRoot, so a rebuilt chat cwd
// has to heal those fields or they keep pointing at the deleted directory.
function rewriteRebuiltCheckoutPaths(checkout: unknown, cwd: string) {
  if (!isRecord(checkout)) {
    return checkout;
  }

  const next: Record<string, unknown> = { ...checkout };
  for (const key of checkoutPathKeys) {
    if (typeof next[key] === "string") {
      next[key] = cwd;
    }
  }

  return next;
}

async function resolveChatRuntimeCwd(input: {
  dataDir: string;
  projectId: string;
  sessionId: string;
  cwd: string;
}) {
  if (input.projectId !== CHAT_PROJECT_ID) {
    return { cwd: input.cwd, rebuilt: false };
  }

  try {
    await access(input.cwd);
    return { cwd: input.cwd, rebuilt: false };
  } catch {
    return {
      cwd: await ensureChatWorkspace(input.dataDir, input.sessionId),
      rebuilt: true,
    };
  }
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function requiredStringArray(value: unknown, name: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function parsePromptText(
  text: unknown,
  images: unknown,
  fieldName: "prompt" | "message",
): { text: string; images: RuntimePromptImage[] } {
  const parsedImages = parseRuntimePromptImages(images);
  const parsedText = typeof text === "string" ? text : "";

  if (!parsedText.trim() && parsedImages.length === 0) {
    throw new Error(`${fieldName} is required`);
  }

  return { text: parsedText, images: parsedImages };
}

function requiredThinkingLevel(value: unknown) {
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }

  throw new Error("thinkingLevel is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
