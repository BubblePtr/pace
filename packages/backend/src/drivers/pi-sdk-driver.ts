import type {
  RuntimeContextUsage,
  RuntimeGatewayQueuedMessage,
  RuntimeGatewaySnapshot,
  RuntimeGatewaySummary,
  RuntimeModelControls,
  RuntimeModelSelection,
  RuntimePromptImage,
  RuntimeToolSchemas,
} from "@pace/core";
import type {
  CreateRuntimeSessionInput,
  ForkRuntimeSessionInput,
  PiRuntimeDriver,
  ResumeRuntimeSessionInput,
  RuntimeGatewayDriverEvent,
} from "../gateway/runtime-gateway";

export type PiSdkPackageModule = typeof import("@earendil-works/pi-coding-agent");

export type PiSdkRuntimeEvent = RuntimeGatewayDriverEvent;

export type PiSdkQueuedMessage = RuntimeGatewayQueuedMessage;

export type PiSdkUserMessageBoundary = {
  piEntryId?: string;
};

export type PiSdkSnapshotPatch = Partial<
  Pick<
    RuntimeGatewaySnapshot,
    "sessionName" | "status" | "events" | "summary" | "modelControls" | "contextUsage" | "updatedAt"
  >
>;

export type PiSdkSessionRuntime = {
  sessionName?: string;
  piSessionId: string;
  runtimeId?: string;
  cwd?: string;
  status?: RuntimeGatewaySnapshot["status"];
  sessionFile?: string;
  summary?: RuntimeGatewaySummary;
  modelControls?: RuntimeModelControls;
  contextUsage?: RuntimeContextUsage;
  /**
   * Next synthetic user message index after reattach (`user:{n}`).
   * Resume/fork must seed this from session history so ids do not collide
   * with journal/projection entries already written (DF-008).
   */
  seedPromptCount?: number;
  sendPrompt(prompt: string, images?: RuntimePromptImage[]): Promise<void>;
  queueFollowUp?(
    message: string,
    images?: RuntimePromptImage[],
  ): Promise<PiSdkQueuedMessage>;
  withdrawQueuedMessage?(queuedMessageId: string): Promise<PiSdkQueuedMessage>;
  steerRun?(message: string, images?: RuntimePromptImage[]): Promise<void>;
  stopRun?(): Promise<void>;
  configureModel?(selection: RuntimeModelSelection): Promise<RuntimeModelControls>;
  resolveToolSchemas?(names: string[]): Promise<RuntimeToolSchemas>;
  getSnapshot?(): Promise<PiSdkSnapshotPatch>;
  getLeafId?(): string | null;
  waitForNextUserMessageBoundary?(): Promise<PiSdkUserMessageBoundary>;
  onEvent?(listener: (event: PiSdkRuntimeEvent) => void): () => void;
  dispose?(): void | Promise<void>;
};

export type PiSdkRuntimeFactory = (
  input: CreateRuntimeSessionInput,
) => Promise<PiSdkSessionRuntime>;

export type PiSdkRuntimeResumer = (
  input: ResumeRuntimeSessionInput,
) => Promise<PiSdkSessionRuntime>;

export type PiSdkRuntimeForkResult = {
  runtime: PiSdkSessionRuntime;
  selectedText?: string;
};

export type PiSdkRuntimeForker = (
  input: ForkRuntimeSessionInput,
) => Promise<PiSdkRuntimeForkResult>;

export type PiSdkDriverOptions = {
  runtimeFactory?: PiSdkRuntimeFactory;
  runtimeResumer?: PiSdkRuntimeResumer;
  runtimeForker?: PiSdkRuntimeForker;
  now?: () => string;
};

export class PiSdkDriverUnsupportedError extends Error {
  capability: string;

  constructor(capability: string, detail: string) {
    super(`Pi SDK driver does not support "${capability}": ${detail}`);
    this.name = "PiSdkDriverUnsupportedError";
    this.capability = capability;
  }
}

function unsupported(capability: string, detail: string): never {
  throw new PiSdkDriverUnsupportedError(capability, detail);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function cloneSummary(summary: RuntimeGatewaySummary): RuntimeGatewaySummary {
  return { ...summary };
}

function cloneContextUsage(usage: RuntimeContextUsage): RuntimeContextUsage {
  return { ...usage };
}

function cloneModelControls(controls: RuntimeModelControls): RuntimeModelControls {
  return {
    models: controls.models.map((model) => ({
      ...model,
      thinkingLevels: [...model.thinkingLevels],
    })),
    selected: controls.selected ? { ...controls.selected } : null,
  };
}

function cloneSnapshot(snapshot: RuntimeGatewaySnapshot): RuntimeGatewaySnapshot {
  const cloned: RuntimeGatewaySnapshot = {
    ...snapshot,
    events: [...snapshot.events],
  };

  if (snapshot.summary) {
    cloned.summary = cloneSummary(snapshot.summary);
  }

  if (snapshot.modelControls) {
    cloned.modelControls = cloneModelControls(snapshot.modelControls);
  }

  if (snapshot.contextUsage) {
    cloned.contextUsage = cloneContextUsage(snapshot.contextUsage);
  }

  return cloned;
}

function snapshotFromRuntime(input: {
  appSession: CreateRuntimeSessionInput | ResumeRuntimeSessionInput;
  runtime: PiSdkSessionRuntime;
  now: () => string;
}): RuntimeGatewaySnapshot {
  const sessionFile =
    input.runtime.sessionFile ??
    ("sessionFile" in input.appSession ? input.appSession.sessionFile : undefined);
  const snapshot: RuntimeGatewaySnapshot = {
    sessionId: input.appSession.sessionId,
    sessionName: input.runtime.sessionName,
    runtimeId: input.runtime.runtimeId ?? `pi-sdk:${input.appSession.sessionId}`,
    piSessionId: input.runtime.piSessionId,
    projectId: input.appSession.projectId,
    cwd: input.runtime.cwd ?? input.appSession.cwd,
    status: input.runtime.status ?? "idle",
    sessionFile,
    checkout: input.appSession.checkout,
    events: [],
    updatedAt: input.now(),
  };

  if (input.runtime.summary) {
    snapshot.summary = cloneSummary(input.runtime.summary);
  }


  if (input.runtime.modelControls) {
    snapshot.modelControls = cloneModelControls(input.runtime.modelControls);
  }

  if (input.runtime.contextUsage) {
    snapshot.contextUsage = cloneContextUsage(input.runtime.contextUsage);
  }

  return snapshot;
}

function mergeSnapshotPatch(
  snapshot: RuntimeGatewaySnapshot,
  patch: PiSdkSnapshotPatch,
): RuntimeGatewaySnapshot {
  const merged = cloneSnapshot(snapshot);

  if (patch.sessionName !== undefined) merged.sessionName = patch.sessionName;

  if (patch.status) {
    merged.status = patch.status;
  }

  if (patch.events) {
    merged.events = [...patch.events];
  }

  if (patch.summary) {
    merged.summary = cloneSummary(patch.summary);
  }

  if (patch.modelControls) {
    merged.modelControls = cloneModelControls(patch.modelControls);
  }

  if (patch.contextUsage) {
    merged.contextUsage = cloneContextUsage(patch.contextUsage);
  }

  if (patch.updatedAt) {
    merged.updatedAt = patch.updatedAt;
  }

  return merged;
}

export function createPiSdkDriver(options: PiSdkDriverOptions = {}): PiRuntimeDriver {
  const now = options.now ?? (() => new Date().toISOString());
  const runtimes = new Map<string, PiSdkSessionRuntime>();
  const snapshots = new Map<string, RuntimeGatewaySnapshot>();
  const promptCounts = new Map<string, number>();
  const listeners = new Set<(event: RuntimeGatewayDriverEvent) => void>();

  let closing = false;
  let disposal: Promise<void> | undefined;
  const creations = new Set<Promise<unknown>>();
  async function trackCreation<T>(create: () => Promise<T>): Promise<T> {
    if (closing) throw new Error("Pi runtime driver is closing.");
    const operation = create();
    creations.add(operation);
    try { return await operation; } finally { creations.delete(operation); }
  }
  async function acceptRuntime(runtime: PiSdkSessionRuntime) {
    if (!closing) return;
    await runtime.dispose?.();
    throw new Error("Pi runtime driver is closing.");
  }
  const runtimeFor = (piSessionId: string, capability: string) => {
    if (closing) throw new Error("Pi runtime driver is closing.");
    const runtime = runtimes.get(piSessionId);

    if (!runtime) {
      throw new Error(`Pi SDK session "${piSessionId}" was not found for "${capability}".`);
    }

    return runtime;
  };
  const emit = (event: RuntimeGatewayDriverEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };
  const disposeSession = async (piSessionId: string) => {
    const runtime = runtimes.get(piSessionId);
    if (!runtime) return;
    await runtime.dispose?.();
    runtimes.delete(piSessionId);
    snapshots.delete(piSessionId);
    promptCounts.delete(piSessionId);
  };
  const rememberRuntime = (
    input: CreateRuntimeSessionInput | ResumeRuntimeSessionInput,
    runtime: PiSdkSessionRuntime,
  ) => {
    const snapshot = snapshotFromRuntime({ appSession: input, runtime, now });

    runtimes.set(runtime.piSessionId, runtime);
    snapshots.set(runtime.piSessionId, snapshot);
    // Continue the synthetic user-id counter from session high water (resume/
    // fork). Resetting to 0 reuses user:0 and overwrites earlier turns in the
    // runtime model (DF-008 message order corruption).
    const seed =
      typeof runtime.seedPromptCount === "number" &&
      Number.isFinite(runtime.seedPromptCount) &&
      runtime.seedPromptCount > 0
        ? Math.floor(runtime.seedPromptCount)
        : 0;
    promptCounts.set(runtime.piSessionId, seed);
    runtime.onEvent?.((event) => {
      emit({
        ...event,
        piSessionId: event.piSessionId ?? runtime.piSessionId,
      });
    });

    return snapshot;
  };

  return {
    async createSession(input) {
      return trackCreation(async () => {
        if (!options.runtimeFactory) {
          unsupported("create_session", "no SDK runtime factory is configured");
        }

        const runtime = await options.runtimeFactory(input);
        await acceptRuntime(runtime);
        const snapshot = rememberRuntime(input, runtime);

        return cloneSnapshot(snapshot);
      });
    },

    async resumeSession(input) {
      return trackCreation(async () => {
        const existing = runtimes.get(input.piSessionId);
        const previous = snapshots.get(input.piSessionId);
        if (existing && previous) {
          if (previous.sessionId !== input.sessionId) throw new Error("A live Pi session belongs to a different Pace session.");
          const snapshot = mergeSnapshotPatch(previous, await existing.getSnapshot?.() ?? {});
          snapshots.set(input.piSessionId, snapshot);
          return cloneSnapshot(snapshot);
        }
        if (!options.runtimeResumer) {
          unsupported("resume_session", "no SDK runtime resumer is configured");
        }

        const runtime = await options.runtimeResumer(input);
        await acceptRuntime(runtime);
        const snapshot = rememberRuntime(input, runtime);

        return cloneSnapshot(snapshot);
      });
    },

    async forkSession(input) {
      return trackCreation(async () => {
        if (!options.runtimeForker) {
          unsupported("fork_session", "no SDK runtime forker is configured");
        }

        const result = await options.runtimeForker(input);
        await acceptRuntime(result.runtime);
        const snapshot = rememberRuntime(input, result.runtime);

        return {
          snapshot: cloneSnapshot(snapshot),
          ...(result.selectedText ? { selectedText: result.selectedText } : {}),
        };
      });
    },

    async sendPrompt(input) {
      const runtime = runtimeFor(input.piSessionId, "send_prompt");
      const promptIndex = promptCounts.get(input.piSessionId) ?? 0;
      const boundaryPromise = runtime.waitForNextUserMessageBoundary?.();

      promptCounts.set(input.piSessionId, promptIndex + 1);
      const promptTask = (
        input.images?.length
          ? runtime.sendPrompt(input.prompt, input.images)
          : runtime.sendPrompt(input.prompt)
      ).catch((error) => {
        emit({
          piSessionId: input.piSessionId,
          type: "error",
          payload: {
            kind: "error",
            title: "SDK prompt failed",
            body: errorMessage(error),
          },
        });

        return null;
      });
      const boundary = boundaryPromise
        ? await Promise.race([
            boundaryPromise,
            promptTask.then(() => null),
          ])
        : null;

      return {
        piSessionId: input.piSessionId,
        type: "message_update",
        payload: {
          kind: "message",
          role: "user",
          body: input.prompt,
          ...(input.images?.length ? { images: input.images } : {}),
          bodyFormat: "full",
          messageId: `pi-sdk:${input.piSessionId}:user:${promptIndex}`,
          ...(boundary?.piEntryId ? { piEntryId: boundary.piEntryId } : {}),
          phase: "synthetic",
        },
      };
    },

    async queueFollowUp(input) {
      const runtime = runtimeFor(input.piSessionId, "queue_follow_up");

      if (!runtime.queueFollowUp) {
        unsupported("queue_follow_up", "the injected SDK runtime has no queueFollowUp adapter");
      }

      return input.images?.length
        ? runtime.queueFollowUp(input.message, input.images)
        : runtime.queueFollowUp(input.message);
    },

    async withdrawQueuedMessage(input) {
      const runtime = runtimeFor(input.piSessionId, "withdraw_queued_message");

      if (!runtime.withdrawQueuedMessage) {
        unsupported(
          "withdraw_queued_message",
          "the injected SDK runtime has no withdrawQueuedMessage adapter",
        );
      }

      return runtime.withdrawQueuedMessage(input.queuedMessageId);
    },

    async steerRun(input) {
      const runtime = runtimeFor(input.piSessionId, "steer_run");

      if (!runtime.steerRun) {
        unsupported("steer_run", "the injected SDK runtime has no steerRun adapter");
      }

      await (input.images?.length
        ? runtime.steerRun(input.message, input.images)
        : runtime.steerRun(input.message));

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
      const runtime = runtimeFor(input.piSessionId, "stop_run");

      if (!runtime.stopRun) {
        unsupported("stop_run", "the injected SDK runtime has no stopRun adapter");
      }

      await runtime.stopRun();

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

    async configureModel(input) {
      const runtime = runtimeFor(input.piSessionId, "configure_model");
      const snapshot = snapshots.get(input.piSessionId);

      if (!snapshot) {
        throw new Error(`Pi SDK snapshot "${input.piSessionId}" was not found.`);
      }

      const livePatch = await runtime.getSnapshot?.();

      if ((livePatch?.status ?? snapshot.status) === "running") {
        throw new Error("Model and Thinking cannot change while a run is active.");
      }

      if (!runtime.configureModel) {
        unsupported("configure_model", "the injected SDK runtime has no model adapter");
      }

      const modelControls = await runtime.configureModel({
        provider: input.provider,
        modelId: input.modelId,
        thinkingLevel: input.thinkingLevel,
      });
      const selected = modelControls.selected;
      const baseSnapshot = mergeSnapshotPatch(snapshot, livePatch ?? {});
      const nextSnapshot: RuntimeGatewaySnapshot = {
        ...baseSnapshot,
        modelControls: cloneModelControls(modelControls),
        summary: selected
          ? {
              ...(baseSnapshot.summary ?? {
                provider: null,
                model: null,
                totalTokens: 0,
                totalCostUsd: 0,
              }),
              provider: selected.provider,
              model: selected.modelId,
            }
          : baseSnapshot.summary,
        updatedAt: now(),
      };

      snapshots.set(input.piSessionId, nextSnapshot);

      return cloneModelControls(modelControls);
    },

    async resolveToolSchemas(input) {
      const runtime = runtimes.get(input.piSessionId);

      if (!runtime?.resolveToolSchemas) {
        return { schemas: {} };
      }

      return runtime.resolveToolSchemas(input.names);
    },

    disposeSession,
    dispose() {
      closing = true;
      disposal ??= (async () => {
        await Promise.allSettled([...creations]);
        await Promise.all([...runtimes.keys()].map(disposeSession));
      })().catch(error => { disposal = undefined; throw error; });
      return disposal;
    },

    async getSnapshot(piSessionId) {
      const runtime = runtimeFor(piSessionId, "get_runtime_snapshot");
      const snapshot = snapshots.get(piSessionId);

      if (!snapshot) {
        throw new Error(`Pi SDK snapshot "${piSessionId}" was not found.`);
      }

      if (!runtime.getSnapshot) {
        return cloneSnapshot(snapshot);
      }

      const merged = mergeSnapshotPatch(snapshot, await runtime.getSnapshot());

      snapshots.set(piSessionId, merged);

      return cloneSnapshot(merged);
    },

    onEvent(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}
