// Public Pi SDK → PiSdkSessionRuntime adapter. All event semantics live in
// agent-runtime-event-normalizer; this module only wires the SDK subscription
// into the normalizer and maps SDK session commands to runtime semantics.

import { createAgentRuntimeEventNormalizer } from "../gateway/agent-runtime-event-normalizer";
import type {
  RuntimeContextUsage,
  RuntimeGatewayQueuedMessage,
  RuntimeModelCapability,
  RuntimeModelControls,
  RuntimeModelSelection,
  RuntimePromptImage,
  RuntimeThinkingLevel,
  RuntimeToolSchema,
} from "@pace/core";
import { toPiImageContent } from "@pace/core";
import type {
  PiSdkRuntimeFactory,
  PiSdkRuntimeForker,
  PiSdkRuntimeResumer,
  PiSdkRuntimeEvent,
  PiSdkSessionRuntime,
  PiSdkUserMessageBoundary,
} from "./pi-sdk-driver";
import type {
  CreateRuntimeSessionInput,
  ForkRuntimeSessionInput,
  ResumeRuntimeSessionInput,
} from "../gateway/runtime-gateway";

export type PublicPiSdkModel = {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<RuntimeThinkingLevel, string | null>>;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
};

export type PublicPiSdkModelRegistry = {
  getAvailable(): PublicPiSdkModel[];
  find(provider: string, modelId: string): PublicPiSdkModel | undefined;
};

/**
 * Pi 0.84 replaced the per-session ModelRegistry with a ModelRuntime.
 * The adapter reads models from `modelRuntime` when present and falls back to
 * the legacy `modelRegistry` surface so existing test doubles keep working.
 */
export type PublicPiSdkModelRuntime = {
  getAvailableSnapshot?(): readonly PublicPiSdkModel[];
  getModel?(provider: string, modelId: string): PublicPiSdkModel | undefined;
};

export type PublicPiSdkAgentSession = {
  sessionName?: string;
  sessionId: string;
  isStreaming: boolean;
  messages: readonly unknown[];
  model?: unknown;
  thinkingLevel?: unknown;
  modelRegistry?: PublicPiSdkModelRegistry;
  modelRuntime?: PublicPiSdkModelRuntime;
  agent?: {
    state?: {
      errorMessage?: string;
    };
  };
  prompt(text: string, options?: { images?: ReturnType<typeof toPiImageContent>[] }): Promise<void>;
  followUp?(message: string, images?: ReturnType<typeof toPiImageContent>[]): Promise<void>;
  steer?(message: string, images?: ReturnType<typeof toPiImageContent>[]): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  extensionRunner?: { emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown> };
  subscribe(listener: (event: unknown) => void): () => void;
  bindExtensions?(bindings: {
    onError: (error: { extensionPath: string; event: string; error: string }) => void;
  }): Promise<void>;
  clearQueue?(): {
    steering: string[];
    followUp: string[];
  };
  pendingMessageCount?: number;
  getSteeringMessages?(): readonly string[];
  getFollowUpMessages?(): readonly string[];
  sessionManager?: {
    getCwd?(): string | undefined;
    getSessionFile?(): string | undefined;
    getLeafId?(): string | null;
    getEntry?(entryId: string): unknown;
    getEntries?(): readonly unknown[];
  };
  getSessionStats?(): {
    tokens?: {
      total?: number;
    };
    cost?: number;
  };
  getContextUsage?(): {
    tokens?: number | null;
    contextWindow?: number;
    percent?: number | null;
  } | undefined;
  setModel?(model: unknown): Promise<void>;
  setThinkingLevel?(level: unknown): void;
  cycleModel?(direction?: "forward" | "backward"): Promise<unknown>;
  cycleThinkingLevel?(): unknown;
  getAvailableThinkingLevels?(): unknown[];
  supportsThinking?(): boolean;
  getToolDefinition?(name: string):
    | {
        description?: unknown;
        parameters?: unknown;
      }
    | undefined;
};

export type PublicPiSdkSessionManager = {
  getCwd?(): string | undefined;
  getSessionDir?(): string | undefined;
  getSessionFile?(): string | undefined;
  getLeafId?(): string | null;
  getEntry?(entryId: string): unknown;
  createBranchedSession?(leafId: string): string | undefined;
  newSession?(options?: { parentSession?: string }): string | undefined;
};

export type PublicPiSdkCreateAgentSessionOptions = {
  cwd?: string;
  noTools?: "all" | "builtin";
  agentDir?: string;
  authStorage?: unknown;
  modelRegistry?: unknown;
  model?: unknown;
  thinkingLevel?: unknown;
  scopedModels?: unknown;
  tools?: string[];
  excludeTools?: string[];
  customTools?: unknown;
  resourceLoader?: unknown;
  sessionManager?: unknown;
  settingsManager?: unknown;
  sessionStartEvent?: unknown;
};

export type PublicPiSdkModule = {
  createAgentSession(options?: PublicPiSdkCreateAgentSessionOptions): Promise<{
    session: PublicPiSdkAgentSession;
    extensionsResult?: { errors: Array<{ path: string; error: string }> };
  }>;
  SessionManager?: {
    open(path: string): PublicPiSdkSessionManager;
    create?(
      cwd: string,
      sessionDir?: string,
      options?: { parentSession?: string },
    ): PublicPiSdkSessionManager;
  };
};

export type PublicPiSdkRuntimeFactoryOptions = {
  sdk: PublicPiSdkModule;
  now?: () => string;
  sessionOptions?: Omit<PublicPiSdkCreateAgentSessionOptions, "cwd">;
  sessionOptionsFor?(input: CreateRuntimeSessionInput): Promise<Partial<PublicPiSdkCreateAgentSessionOptions>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUserMessageEndEvent(value: unknown) {
  return (
    isRecord(value) &&
    value.type === "message_end" &&
    isRecord(value.message) &&
    value.message.role === "user"
  );
}

/**
 * Count prior user prompts in an SDK session transcript.
 * Used as the high-water mark for both synthetic `user:{n}` ids and Active Run
 * `run-{n}` sequences after resume/fork (DF-008 / ADR-0020 reattach).
 */
export function countSessionUserPrompts(messages: readonly unknown[]): number {
  let count = 0;

  for (const entry of messages) {
    if (!isRecord(entry)) {
      continue;
    }

    if (entry.role === "user") {
      count += 1;
      continue;
    }

    // Some SessionManager transcripts nest the chat message under `.message`.
    if (isRecord(entry.message) && entry.message.role === "user") {
      count += 1;
    }
  }

  return count;
}

function maybeString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function maybeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractUserMessageText(content: unknown) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(
      (part): part is { type: string; text: string } =>
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

function forkEntryDetail(entry: unknown) {
  if (!isRecord(entry)) {
    throw new Error("Invalid entry ID for forking");
  }

  if (entry.type !== "message" || !isRecord(entry.message)) {
    throw new Error("Invalid entry ID for forking");
  }

  if (entry.message.role !== "user") {
    throw new Error("Invalid entry ID for forking");
  }

  return {
    parentId: typeof entry.parentId === "string" ? entry.parentId : null,
    selectedText: extractUserMessageText(entry.message.content),
  };
}

function userEntryIdFromSessionManager(
  sessionManager: PublicPiSdkAgentSession["sessionManager"] | undefined,
) {
  const leafId = sessionManager?.getLeafId?.() ?? null;

  if (!leafId) {
    return undefined;
  }

  if (!sessionManager?.getEntry) {
    return leafId;
  }

  const visited = new Set<string>();
  let entryId: string | null = leafId;

  while (entryId && !visited.has(entryId)) {
    visited.add(entryId);

    const entry = sessionManager.getEntry(entryId);

    if (
      isRecord(entry) &&
      entry.type === "message" &&
      isRecord(entry.message) &&
      entry.message.role === "user"
    ) {
      return typeof entry.id === "string" ? entry.id : entryId;
    }

    entryId =
      isRecord(entry) && typeof entry.parentId === "string"
        ? entry.parentId
        : null;
  }

  return undefined;
}

async function waitForSessionManagerAppend() {
  await Promise.resolve();
}

function modelProvider(model: unknown) {
  if (!isRecord(model)) {
    return null;
  }

  if (isRecord(model.provider)) {
    return (
      maybeString(model.provider.id) ??
      maybeString(model.provider.name) ??
      maybeString(model.provider.provider)
    );
  }

  return maybeString(model.provider) ?? maybeString(model.providerId);
}

function modelId(model: unknown) {
  if (!isRecord(model)) {
    return null;
  }

  return maybeString(model.id) ?? maybeString(model.name);
}

const thinkingLevelOrder: RuntimeThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function isThinkingLevel(value: unknown): value is RuntimeThinkingLevel {
  return thinkingLevelOrder.includes(value as RuntimeThinkingLevel);
}

function thinkingLevelsForModel(model: PublicPiSdkModel): RuntimeThinkingLevel[] {
  if (!model.reasoning) {
    return ["off"];
  }

  return thinkingLevelOrder.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];

    if (mapped === null) {
      return false;
    }

    // xhigh/max are opt-in per model: only offered when explicitly mapped.
    return (level !== "xhigh" && level !== "max") || mapped !== undefined;
  });
}

function capabilityFromModel(model: PublicPiSdkModel): RuntimeModelCapability {
  const capability: RuntimeModelCapability = {
    provider: model.provider,
    modelId: model.id,
    name: model.name,
    thinkingLevels: thinkingLevelsForModel(model),
  };

  if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
    capability.contextWindow = model.contextWindow;
  }

  if (typeof model.maxTokens === "number" && model.maxTokens > 0) {
    capability.maxTokens = model.maxTokens;
  }

  if (Array.isArray(model.input)) {
    const modalities = model.input.filter(
      (modality): modality is "text" | "image" =>
        modality === "text" || modality === "image",
    );

    if (modalities.length > 0) {
      capability.input = modalities;
    }
  }

  return capability;
}

function availableModelsFromSession(
  session: PublicPiSdkAgentSession,
): readonly PublicPiSdkModel[] {
  return (
    session.modelRuntime?.getAvailableSnapshot?.() ??
    session.modelRegistry?.getAvailable() ??
    []
  );
}

function findSessionModel(
  session: PublicPiSdkAgentSession,
  provider: string,
  modelId: string,
): PublicPiSdkModel | undefined {
  return (
    session.modelRuntime?.getModel?.(provider, modelId) ??
    session.modelRegistry?.find(provider, modelId)
  );
}

function modelControlsFromSession(
  session: PublicPiSdkAgentSession,
): RuntimeModelControls | undefined {
  const availableModels = availableModelsFromSession(session);
  const currentProvider = modelProvider(session.model);
  const currentModelId = modelId(session.model);

  if (!availableModels.length && (!currentProvider || !currentModelId)) {
    return undefined;
  }

  return {
    models: availableModels.map(capabilityFromModel),
    selected:
      currentProvider &&
      currentModelId &&
      isThinkingLevel(session.thinkingLevel)
        ? {
            provider: currentProvider,
            modelId: currentModelId,
            thinkingLevel: session.thinkingLevel,
          }
        : null,
  };
}

async function configureSessionModel(
  session: PublicPiSdkAgentSession,
  selection: RuntimeModelSelection,
): Promise<RuntimeModelControls> {
  if (session.isStreaming) {
    throw new Error("Model and Thinking cannot change while a run is active.");
  }

  const availableModels = availableModelsFromSession(session);
  const model = findSessionModel(session, selection.provider, selection.modelId);

  if (
    !model ||
    !availableModels.some(
      (available) =>
        available.provider === selection.provider &&
        available.id === selection.modelId,
    )
  ) {
    throw new Error(
      `Model "${selection.provider}/${selection.modelId}" is unavailable.`,
    );
  }

  if (!thinkingLevelsForModel(model).includes(selection.thinkingLevel)) {
    throw new Error(
      `Thinking level "${selection.thinkingLevel}" is unavailable for "${selection.provider}/${selection.modelId}".`,
    );
  }

  if (!session.setModel || !session.setThinkingLevel) {
    throw new Error("Pi SDK model controls are unavailable.");
  }

  await session.setModel(model);
  session.setThinkingLevel(selection.thinkingLevel);

  const controls = modelControlsFromSession(session);

  if (!controls?.selected) {
    throw new Error("Pi SDK did not expose the selected model configuration.");
  }

  return controls;
}

function summaryFromSession(session: PublicPiSdkAgentSession) {
  const stats = session.getSessionStats?.();
  // Pi owns accounting, including any usage its tools choose to report.
  const summary = {
    provider: modelProvider(session.model),
    model: modelId(session.model),
    totalTokens: maybeNumber(stats?.tokens?.total) ?? 0,
    totalCostUsd: maybeNumber(stats?.cost) ?? 0,
  };

  if (
    summary.provider ||
    summary.model ||
    summary.totalTokens > 0 ||
    summary.totalCostUsd > 0
  ) {
    return summary;
  }

  return undefined;
}

/**
 * A context window is the only field that must be a real number: without it
 * there is nothing to be a percentage of. `tokens`/`percent` stay nullable —
 * Pi reports them as unknown until the first LLM response after a compaction.
 *
 * `percent` is bounded here because Pi *estimates* context tokens and can
 * report more than the window holds; an unbounded share would print "103%"
 * beside a bar that any meter clamps to full.
 */
function contextUsageFromSession(
  session: PublicPiSdkAgentSession,
): RuntimeContextUsage | undefined {
  const usage = session.getContextUsage?.();
  const contextWindow = maybeNumber(usage?.contextWindow);

  if (!usage || contextWindow === null || contextWindow <= 0) {
    return undefined;
  }

  const percent = maybeNumber(usage.percent);

  return {
    // The raw estimate stays truthful; only its share of the window is bounded.
    tokens: maybeNumber(usage.tokens),
    contextWindow,
    percent: percent === null ? null : Math.min(100, Math.max(0, percent)),
  };
}

function schemasFromSession(session: PublicPiSdkAgentSession, names: string[]) {
  const schemas: Record<string, RuntimeToolSchema> = {};

  for (const name of names) {
    const schema = toolSchemaFromDefinition(session.getToolDefinition?.(name));

    if (schema) {
      schemas[name] = schema;
    }
  }

  return schemas;
}

function toolSchemaFromDefinition(value: unknown): RuntimeToolSchema | undefined {
  if (!isRecord(value) || typeof value.description !== "string") {
    return undefined;
  }

  try {
    return {
      description: value.description,
      parameters: JSON.parse(JSON.stringify(value.parameters ?? {})),
    };
  } catch {
    return undefined;
  }
}

function statusFromSession(input: {
  session: PublicPiSdkAgentSession;
  promptCompleted: boolean;
  stopped: boolean;
}) {
  if (input.session.agent?.state?.errorMessage) {
    return "failed";
  }

  if (input.session.isStreaming) {
    return "running";
  }

  return input.promptCompleted || input.stopped ? "completed" : "idle";
}

export function createPublicPiSdkRuntimeFactory(
  options: PublicPiSdkRuntimeFactoryOptions,
): PiSdkRuntimeFactory {
  const now = options.now ?? (() => new Date().toISOString());

  return async (input) =>
    createPublicPiSdkRuntime({
      input,
      now,
      ...(await options.sdk.createAgentSession({
        ...options.sessionOptions,
        ...await options.sessionOptionsFor?.(input),
        cwd: input.cwd,
      })),
    });
}

export function createPublicPiSdkRuntimeResumer(
  options: PublicPiSdkRuntimeFactoryOptions,
): PiSdkRuntimeResumer {
  const now = options.now ?? (() => new Date().toISOString());

  return async (input) => {
    const sessionManager = options.sdk.SessionManager?.open(input.sessionFile);

    if (!sessionManager) {
      throw new Error("Pi SDK SessionManager.open is unavailable.");
    }

    const { session, extensionsResult } = await options.sdk.createAgentSession({
      ...options.sessionOptions,
      ...await options.sessionOptionsFor?.({ ...input, cwd: sessionManager.getCwd?.() || input.cwd }),
      cwd: sessionManager.getCwd?.() || input.cwd,
      sessionManager,
    });

    if (input.modelSelection) {
      // The persisted selection may reference a model Pi has since removed or
      // renamed (e.g. gpt-5-codex). Resume must not hard-fail — keep whatever
      // model the session itself restored.
      await configureSessionModel(session, input.modelSelection).catch(() => {});
    }

    return createPublicPiSdkRuntime({
      input,
      now,
      session,
      extensionsResult,
    });
  };
}

export function createPublicPiSdkRuntimeForker(
  options: PublicPiSdkRuntimeFactoryOptions,
): PiSdkRuntimeForker {
  return async (input) => {
    const sourceSessionManager = options.sdk.SessionManager?.open(
      input.sourceSessionFile,
    );

    if (!sourceSessionManager) {
      throw new Error("Pi SDK SessionManager.open is unavailable.");
    }

    const entry = sourceSessionManager.getEntry?.(input.piEntryId);
    const { parentId, selectedText } = forkEntryDetail(entry);
    let sessionManager = sourceSessionManager;

    if (parentId) {
      const forkedSessionFile =
        sourceSessionManager.createBranchedSession?.(parentId);

      if (!forkedSessionFile) {
        throw new Error("Failed to create forked session");
      }
    } else {
      const sourceSessionFile =
        sourceSessionManager.getSessionFile?.() ?? input.sourceSessionFile;
      const createdSessionManager = options.sdk.SessionManager?.create?.(
        sourceSessionManager.getCwd?.() || input.cwd,
        sourceSessionManager.getSessionDir?.(),
        { parentSession: sourceSessionFile },
      );

      if (createdSessionManager) {
        sessionManager = createdSessionManager;
      } else {
        sourceSessionManager.newSession?.({ parentSession: sourceSessionFile });
      }
    }

    const { session, extensionsResult } = await options.sdk.createAgentSession({
      ...options.sessionOptions,
      ...await options.sessionOptionsFor?.({ ...input, cwd: sessionManager.getCwd?.() || input.cwd }),
      cwd: sessionManager.getCwd?.() || input.cwd,
      sessionManager,
    });

    return {
      runtime: await createPublicPiSdkRuntime({
        input,
        now: options.now ?? (() => new Date().toISOString()),
        session,
        extensionsResult,
      }),
      selectedText,
    };
  };
}

function piImagesFromPrompt(images?: RuntimePromptImage[]) {
  return images?.length ? images.map(toPiImageContent) : undefined;
}

async function createPublicPiSdkRuntime(context: {
  input:
    | CreateRuntimeSessionInput
    | ResumeRuntimeSessionInput
    | ForkRuntimeSessionInput;
  now: () => string;
  session: PublicPiSdkAgentSession;
  extensionsResult?: { errors: Array<{ path: string; error: string }> };
}): Promise<PiSdkSessionRuntime> {
    const { session } = context;
    const now = context.now;
    // Reattach high-water: prior user prompts already have synthetic ids
    // user:0..user:n-1 and runs run-1..run-n in the journal/projection.
    // Seed both counters so the next prompt does not reuse those identities.
    const priorUserPrompts = countSessionUserPrompts(session.messages ?? []);
    // One normalizer per session: its lifecycle counters are the identity
    // source for runId/turnId/messageId. The driver subscribes exactly once.
    const normalizer = createAgentRuntimeEventNormalizer({
      piSessionId: session.sessionId,
      origin: "sdk",
      initialRunSeq: priorUserPrompts,
      readContextUsage: () => contextUsageFromSession(session),
    });
    const pendingUserBoundaries: PiSdkUserMessageBoundary[] = [];
    const userBoundaryWaiters: Array<(boundary: PiSdkUserMessageBoundary) => void> = [];
    let promptCompleted = false;
    let stopped = false;
    let queuedSequence = 0;
    const queuedMessages = new Map<string, RuntimeGatewayQueuedMessage>();
    const listeners = new Set<(event: PiSdkRuntimeEvent) => void>();
    const pendingEvents: PiSdkRuntimeEvent[] = [];
    let disposed = false;
    let disposal: Promise<void> | undefined;
    const assertOpen = () => { if (disposed) throw new Error("Session is closing or closed."); };
    const emit = (event: PiSdkRuntimeEvent) => {
      if (listeners.size === 0) {
        // Startup precedes the driver's subscription and the Gateway's Pi-id
        // mapping. Keep both the events and their App identity for journal replay.
        pendingEvents.push({ ...event, sessionId: context.input.sessionId });
      } else {
        for (const listener of listeners) {
          listener(event);
        }
      }
    };
    const unsubscribe = session.subscribe((event) => {
      if (
        isRecord(event) &&
        event.type === "session_info_changed" &&
        (event.name === undefined || typeof event.name === "string")
      ) {
        emit({
          piSessionId: session.sessionId,
          type: "session_info_changed",
          payload: {
            type: "session_info_changed",
            name: event.name ?? "",
            surface: "hidden",
            origin: "sdk",
          },
        });
        return;
      }
      if (isUserMessageEndEvent(event)) {
        void waitForSessionManagerAppend().then(() => {
          const piEntryId = userEntryIdFromSessionManager(session.sessionManager);
          const boundary = piEntryId ? { piEntryId } : {};
          const waiter = userBoundaryWaiters.shift();
          if (waiter) {
            waiter(boundary);
          } else {
            pendingUserBoundaries.push(boundary);
          }
        });
      }
      for (const agentEvent of normalizer.normalize(event)) {
        emit({
          piSessionId: session.sessionId,
          ...("turnId" in agentEvent && agentEvent.turnId ? { turnId: agentEvent.turnId } : {}),
          type: agentEvent.type,
          payload: { ...agentEvent },
        });
      }
    });
    const runtime: PiSdkSessionRuntime = {
      piSessionId: session.sessionId,
      runtimeId: `pi-sdk:${context.input.sessionId}`,
      sessionName: session.sessionName ?? "",
      cwd: session.sessionManager?.getCwd?.() ?? context.input.cwd,
      status: session.isStreaming ? "running" : "idle",
      sessionFile: session.sessionManager?.getSessionFile?.(),
      modelControls: modelControlsFromSession(session),
      contextUsage: contextUsageFromSession(session),
      seedPromptCount: priorUserPrompts,
      getLeafId() {
        return session.sessionManager?.getLeafId?.() ?? null;
      },
      async waitForNextUserMessageBoundary() {
        const pendingBoundary = pendingUserBoundaries.shift();

        if (pendingBoundary) {
          return pendingBoundary;
        }

        return new Promise((resolve) => {
          userBoundaryWaiters.push(resolve);
        });
      },
      async sendPrompt(prompt, images) {
        assertOpen();
        normalizer.noteRunTrigger("prompt");
        const piImages = piImagesFromPrompt(images);

        if (piImages) {
          await session.prompt(prompt, { images: piImages });
        } else {
          await session.prompt(prompt);
        }

        promptCompleted = true;
      },
      async stopRun() {
        await session.abort();
        stopped = true;
      },
      async getSnapshot() {
        return {
          sessionName: session.sessionName ?? "",
          status: statusFromSession({ session, promptCompleted, stopped }),
          summary: summaryFromSession(session),
          modelControls: modelControlsFromSession(session),
          contextUsage: contextUsageFromSession(session),
          updatedAt: now(),
        };
      },
      async configureModel(selection) {
        assertOpen();
        return configureSessionModel(session, selection);
      },
      async resolveToolSchemas(names) {
        return { schemas: schemasFromSession(session, names) };
      },
      onEvent(listener) {
        listeners.add(listener);
        for (const event of pendingEvents.splice(0)) {
          listener(event);
        }
        return () => {
          listeners.delete(listener);
        };
      },
      dispose() {
        if (disposed) return disposal;
        disposed = true;
        let released = false;
        const release = () => {
          released = true;
          unsubscribe();
          listeners.clear();
          pendingEvents.length = 0;
          session.dispose();
        };
        if (!session.extensionRunner && !session.isStreaming) {
          release();
          return;
        }
        disposal = (async () => {
          await session.abort();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            if (session.extensionRunner) await Promise.race([
              session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Session shutdown did not finish.")), 20_000);
                timer.unref?.();
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
            release();
          }
        })().catch(error => {
          // A timed-out cancellation still owns live work; allow cleanup retry.
          if (!released) disposed = false;
          disposal = undefined;
          throw error;
        });
        return disposal;
      },
    };

    if (session.followUp) {
      runtime.queueFollowUp = async (message, images) => {
        assertOpen();
        const queuedMessage = {
          id: `pi-sdk:${session.sessionId}:queued:${queuedSequence}`,
          piSessionId: session.sessionId,
          body: message,
          ...(images?.length ? { images } : {}),
          status: "pending" as const,
          createdAt: now(),
        };
        const piImages = piImagesFromPrompt(images);

        queuedSequence += 1;
        normalizer.noteRunTrigger("follow_up");

        if (piImages) {
          await session.followUp?.(message, piImages);
        } else {
          await session.followUp?.(message);
        }

        queuedMessages.set(queuedMessage.id, queuedMessage);

        return queuedMessage;
      };
    }

    if (session.clearQueue && session.followUp && session.steer) {
      runtime.withdrawQueuedMessage = async (queuedMessageId) => {
        assertOpen();
        const queuedMessage = queuedMessages.get(queuedMessageId);

        if (!queuedMessage) {
          throw new Error(`Pi SDK queued message "${queuedMessageId}" was not found.`);
        }

        const cleared = session.clearQueue?.() ?? {
          steering: [],
          followUp: [],
        };
        let removedFollowUp = false;

        for (const steering of cleared.steering) {
          await session.steer?.(steering);
        }

        for (const followUp of cleared.followUp) {
          if (!removedFollowUp && followUp === queuedMessage.body) {
            removedFollowUp = true;
            continue;
          }

          const stored = [...queuedMessages.values()].find(
            (item) =>
              item.status === "pending" &&
              item.id !== queuedMessageId &&
              item.body === followUp,
          );
          const piImages = piImagesFromPrompt(stored?.images);

          if (piImages) {
            await session.followUp?.(followUp, piImages);
          } else {
            await session.followUp?.(followUp);
          }
        }

        if (!removedFollowUp) {
          throw new Error(
            `Pi SDK queued message "${queuedMessageId}" was not present in the follow-up queue.`,
          );
        }

        const withdrawn = {
          ...queuedMessage,
          status: "withdrawn" as const,
          withdrawnAt: now(),
        };

        queuedMessages.set(queuedMessage.id, withdrawn);

        return withdrawn;
      };
    }

    if (session.steer) {
      runtime.steerRun = async (message, images) => {
        assertOpen();
        const piImages = piImagesFromPrompt(images);

        if (piImages) {
          await session.steer?.(message, piImages);
        } else {
          await session.steer?.(message);
        }
      };
    }

    const reportExtensionError = (code: string, path: string, detail: string) =>
      emit({
        sessionId: context.input.sessionId,
        piSessionId: session.sessionId,
        type: "error",
        payload: {
          type: "error",
          code,
          body: `${path}: ${detail}`,
          fatal: false,
          surface: "chat",
          origin: "sdk",
        },
      });
    try {
      for (const error of context.extensionsResult?.errors ?? []) {
        reportExtensionError("extension_load_error", error.path, error.error);
      }
      await session.bindExtensions?.({
        onError: (error) => reportExtensionError(
          "extension_error",
          error.extensionPath,
          `${error.event}: ${error.error}`,
        ),
      });
      runtime.status = statusFromSession({ session, promptCompleted, stopped });
      runtime.modelControls = modelControlsFromSession(session);
      runtime.summary = summaryFromSession(session);
    } catch (error) {
      await runtime.dispose?.();
      throw error;
    }
    return runtime;
}
