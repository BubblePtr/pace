// Public Pi SDK → PiSdkSessionRuntime adapter. All event semantics live in
// agent-runtime-event-normalizer; this module only wires the SDK subscription
// into the normalizer and maps SDK session commands to runtime semantics.

import { createAgentRuntimeEventNormalizer } from "../gateway/agent-runtime-event-normalizer";
import { createTintinwebSubagentShim, piEventBusFromUnknown } from "../subagent/tintinweb";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  AUTO_TITLE_TIMEOUT_MS,
  buildSessionTitlePrompt,
  sanitizeSessionTitle,
  sessionTitleTextFromContent,
  shouldGenerateSessionTitle,
} from "./session-auto-title";
import type {
  RuntimeContextUsage,
  RuntimeGatewayQueuedMessage,
  RuntimeGatewayQueueMutationResult,
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

/**
 * One-shot completion used for background work that is not part of the session
 * transcript. Parameters stay `unknown`: Pi's `Context` / stream-option generics
 * are structurally stricter than anything Pace needs to describe here.
 */
export type PublicPiSdkModelCompleter = {
  complete?(model: unknown, context: unknown, options?: unknown): Promise<{ content?: unknown }>;
};

export type PublicPiSdkModelRegistry = PublicPiSdkModelCompleter & {
  getAvailable(): PublicPiSdkModel[];
  find(provider: string, modelId: string): PublicPiSdkModel | undefined;
};

/**
 * Pi 0.84 replaced the per-session ModelRegistry with a ModelRuntime.
 * The adapter reads models from `modelRuntime` when present and falls back to
 * the legacy `modelRegistry` surface so existing test doubles keep working.
 */
export type PublicPiSdkModelRuntime = PublicPiSdkModelCompleter & {
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
  setSessionName?(name: string): void;
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
  modelRuntime?: PublicPiSdkModelRuntime;
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
  ModelRuntime?: {
    create(options?: { authPath?: string; modelsPath?: string }): Promise<PublicPiSdkModelRuntime>;
  };
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

/**
 * Name untitled sessions from the first exchange. Pi only emits
 * `session_info_changed` when something sets a name, and a bare Pi install has
 * no auto-name extension, so Pace generates the name itself and writes it back
 * through `setSessionName` — Pi then persists it and emits the event Pace
 * already bridges.
 */
function createSessionAutoTitleObserver(session: PublicPiSdkAgentSession): (event: unknown) => void {
  let attempted = false;
  let userText = "";

  return (event) => {
    if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message)) {
      return;
    }

    if (event.message.role === "user") {
      userText ||= sessionTitleTextFromContent(event.message.content);
      return;
    }

    if (event.message.role !== "assistant") {
      return;
    }

    const assistantText = sessionTitleTextFromContent(event.message.content);

    if (!shouldGenerateSessionTitle({ currentName: session.sessionName, attempted, userText, assistantText })) {
      return;
    }

    // Mark before the request: naming is once per session, so a provider
    // failure must not fire another request on the next reply.
    attempted = true;
    void generateSessionTitle(session, buildSessionTitlePrompt({ userText, assistantText }))
      .then((name) => {
        if (name) {
          session.setSessionName?.(name);
        }
      })
      .catch((error) => {
        console.warn("Pace could not name this session automatically.", error);
      });
  };
}

async function generateSessionTitle(session: PublicPiSdkAgentSession, prompt: string): Promise<string> {
  // Pi 0.84 moved completions from the ModelRegistry onto the ModelRuntime.
  const completer = session.modelRuntime?.complete ? session.modelRuntime : session.modelRegistry;

  if (!session.model || !completer?.complete) {
    return "";
  }

  const response = await withTimeout(
    completer.complete(
      session.model,
      { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
      // A fresh session id keeps this side request out of the session's own
      // context and cache; the reply is one short line, so no cache retention.
      { reasoningEffort: "low", cacheRetention: "none", sessionId: randomUUID() },
    ),
    AUTO_TITLE_TIMEOUT_MS,
  );

  return sanitizeSessionTitle(sessionTitleTextFromContent(response?.content));
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms.`)), timeoutMs);
    // Background work must never keep the session process alive on its own.
    timer.unref?.();
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
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

  // Pi's setModel appends a model_change even when the model already matches.
  if (modelProvider(session.model) !== selection.provider || modelId(session.model) !== selection.modelId) {
    await session.setModel(model);
  }
  if (session.thinkingLevel !== selection.thinkingLevel) {
    session.setThinkingLevel(selection.thinkingLevel);
  }

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

  return async (input) => {
    const sessionOptions = {
      ...options.sessionOptions,
      ...await options.sessionOptionsFor?.(input),
      cwd: input.cwd,
    };
    if (input.modelSelection) {
      const selection = input.modelSelection;
      const agentDir = sessionOptions.agentDir;
      // Resolve against the same catalog/auth runtime Pi will use, before it
      // records the initial model and thinking entries in the new session.
      const modelRuntime = sessionOptions.modelRuntime ?? await options.sdk.ModelRuntime?.create({
        authPath: agentDir ? join(agentDir, "auth.json") : undefined,
        modelsPath: agentDir ? join(agentDir, "models.json") : undefined,
      });
      const model = modelRuntime?.getModel?.(selection.provider, selection.modelId);
      if (!model || !modelRuntime?.getAvailableSnapshot?.().some(
        (available) => available.provider === selection.provider && available.id === selection.modelId,
      )) {
        throw new Error(`Model "${selection.provider}/${selection.modelId}" is unavailable.`);
      }
      if (!thinkingLevelsForModel(model).includes(selection.thinkingLevel)) {
        throw new Error(`Thinking level "${selection.thinkingLevel}" is unavailable for "${selection.provider}/${selection.modelId}".`);
      }
      sessionOptions.modelRuntime = modelRuntime;
      sessionOptions.model = model;
      sessionOptions.thinkingLevel = selection.thinkingLevel;
    }
    return createPublicPiSdkRuntime({
      input,
      now,
      resourceLoader: sessionOptions.resourceLoader,
      ...(await options.sdk.createAgentSession(sessionOptions)),
    });
  };
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

    const sessionOptions = {
      ...options.sessionOptions,
      ...await options.sessionOptionsFor?.({ ...input, cwd: sessionManager.getCwd?.() || input.cwd }),
      cwd: sessionManager.getCwd?.() || input.cwd,
      sessionManager,
    };
    const { session, extensionsResult } = await options.sdk.createAgentSession(sessionOptions);

    if (input.modelSelection) {
      // The persisted selection may reference a model Pi has since removed or
      // renamed (e.g. gpt-5-codex). Resume must not hard-fail — keep whatever
      // model the session itself restored.
      await configureSessionModel(session, input.modelSelection).catch(() => {});
    }

    return createPublicPiSdkRuntime({
      input,
      now,
      resourceLoader: sessionOptions.resourceLoader,
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

    const sessionOptions = {
      ...options.sessionOptions,
      ...await options.sessionOptionsFor?.({ ...input, cwd: sessionManager.getCwd?.() || input.cwd }),
      cwd: sessionManager.getCwd?.() || input.cwd,
      sessionManager,
    };
    const { session, extensionsResult } = await options.sdk.createAgentSession(sessionOptions);

    return {
      runtime: await createPublicPiSdkRuntime({
        input,
        now: options.now ?? (() => new Date().toISOString()),
        resourceLoader: sessionOptions.resourceLoader,
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

function suffixStart(pending: string[], actual: string[]): number | null {
  if (actual.length > pending.length) {
    return null;
  }

  const start = pending.length - actual.length;
  for (let i = 0; i < actual.length; i += 1) {
    if (pending[start + i] !== actual[i]) {
      return null;
    }
  }
  return start;
}

function readBackEnqueue(
  before: readonly string[],
  after: readonly string[] | undefined,
  fallback: string,
): { kind: "pending"; piText: string } | { kind: "consumed" } {
  const next = after ?? [];
  if (next.length === 0) {
    return { kind: "consumed" };
  }
  const consumedCount = before.length + 1 - next.length;
  if (consumedCount < 0) {
    return { kind: "pending", piText: fallback };
  }
  const piText = next[next.length - 1]!;
  const expected = [...before.slice(consumedCount), piText];
  if (
    expected.length !== next.length ||
    expected.some((value, index) => value !== next[index])
  ) {
    return { kind: "pending", piText: fallback };
  }
  return { kind: "pending", piText };
}

function childSessionIdFromSessionFileHeader(sessionFile: string): string | undefined {
  try {
    const line = readFileSync(sessionFile, "utf8").split(/\r?\n/, 1)[0];
    if (!line) {
      return undefined;
    }
    const record = JSON.parse(line) as { type?: unknown; id?: unknown };
    return record.type === "session" && typeof record.id === "string" ? record.id : undefined;
  } catch {
    return undefined;
  }
}

async function createPublicPiSdkRuntime(context: {
  input:
    | CreateRuntimeSessionInput
    | ResumeRuntimeSessionInput
    | ForkRuntimeSessionInput;
  now: () => string;
  session: PublicPiSdkAgentSession;
  extensionsResult?: { errors: Array<{ path: string; error: string }> };
  resourceLoader?: unknown;
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
    // One SDK subscribe, many Pace listeners. AgentSession.subscribe is not
    // guaranteed to fan out, and tests often keep only the last listener.
    const sessionEventListeners = new Set<(event: unknown) => void>();
    const unsubscribe = session.subscribe((event) => {
      for (const listener of sessionEventListeners) {
        listener(event);
      }
    });
    sessionEventListeners.add((event) => {
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
    sessionEventListeners.add(createSessionAutoTitleObserver(session));
    const subagentShim = createTintinwebSubagentShim({
      events: piEventBusFromUnknown(context.resourceLoader) ?? piEventBusFromUnknown(session),
      subscribeSession: (listener) => {
        sessionEventListeners.add(listener);
        return () => {
          sessionEventListeners.delete(listener);
        };
      },
      now,
      resolveChildSessionId: childSessionIdFromSessionFileHeader,
    });
    const unsubscribeSubagentShim = subagentShim.observe({
      parentSessionId: session.sessionId,
      onRecord(record, phase) {
        emit({
          piSessionId: session.sessionId,
          type: "subagent",
          payload: {
            type: "subagent",
            phase,
            record,
            surface: "hidden",
            origin: "sdk",
          },
        });
      },
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
      async sendSubagent(input) {
        assertOpen();
        if (!subagentShim.send) {
          throw new Error("This runtime has no subagent send adapter.");
        }
        await subagentShim.send(input);
      },
      async stopSubagent(input) {
        assertOpen();
        if (!subagentShim.stop) {
          throw new Error("This runtime has no subagent stop adapter.");
        }
        await subagentShim.stop(input);
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
          unsubscribeSubagentShim();
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

    type LocalQueued = RuntimeGatewayQueuedMessage & { piText?: string };
    type SteeringRecord = {
      body: string;
      piText?: string;
      images?: RuntimePromptImage[];
    };
    const queuedMessages = new Map<string, LocalQueued>();
    const steeringRecords: SteeringRecord[] = [];
    // One lock for this session: clear+replay must not interleave with
    // another queue write, or Pi would consume a half-rebuilt FIFO.
    let queueWrite: Promise<unknown> = Promise.resolve();
    const withQueueWrite = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = queueWrite.then(fn, fn);
      queueWrite = run.then(() => undefined, () => undefined);
      return run;
    };
    const pendingQueuedMessages = () =>
      [...queuedMessages.values()].filter((item) => item.status === "pending");
    const publicQueued = (message: LocalQueued): RuntimeGatewayQueuedMessage => {
      const { piText: _piText, ...published } = message;
      return published;
    };
    const sendFollowUp = async (body: string, images?: RuntimePromptImage[]) => {
      const piImages = piImagesFromPrompt(images);
      if (piImages) {
        await session.followUp?.(body, piImages);
      } else {
        await session.followUp?.(body);
      }
    };
    const sendSteer = async (body: string, images?: RuntimePromptImage[]) => {
      const piImages = piImagesFromPrompt(images);
      if (piImages) {
        await session.steer?.(body, piImages);
      } else {
        await session.steer?.(body);
      }
    };
    const captureFollowUpText = async (body: string, images?: RuntimePromptImage[]) => {
      if (!session.getFollowUpMessages) {
        await sendFollowUp(body, images);
        return { kind: "pending" as const, piText: body };
      }
      const before = [...session.getFollowUpMessages()];
      await sendFollowUp(body, images);
      return readBackEnqueue(before, session.getFollowUpMessages(), body);
    };
    const captureSteerText = async (body: string, images?: RuntimePromptImage[]) => {
      if (!session.getSteeringMessages) {
        await sendSteer(body, images);
        return { kind: "pending" as const, piText: body };
      }
      const before = [...session.getSteeringMessages()];
      await sendSteer(body, images);
      return readBackEnqueue(before, session.getSteeringMessages(), body);
    };
    const adoptPendingOrder = (order: LocalQueued[]) => {
      for (const message of order) {
        queuedMessages.delete(message.id);
      }
      for (const message of order) {
        queuedMessages.set(message.id, message);
      }
    };
    const publishedQueue = (): RuntimeGatewayQueuedMessage[] =>
      [...queuedMessages.values()].map(publicQueued);
    const replayQueue = async (keep: LocalQueued[], omittedIds: ReadonlySet<string> = new Set()) => {
      // Pi follow-up mode `all` drains the whole queue into the agent loop at
      // once while the display list shrinks per message_start; a reorder in
      // that window would re-enqueue already-drained messages. Default mode
      // is one-at-a-time.
      const pending = pendingQueuedMessages();
      const followDisplay = [
        ...(session.getFollowUpMessages?.() ?? pending.map((item) => item.piText ?? item.body)),
      ];
      const steerDisplay = [
        ...(session.getSteeringMessages?.() ??
          steeringRecords.map((item) => item.piText ?? item.body)),
      ];
      const followStart = suffixStart(
        pending.map((item) => item.piText ?? item.body),
        followDisplay,
      );
      const steerStart = suffixStart(
        steeringRecords.map((item) => item.piText ?? item.body),
        steerDisplay,
      );

      if (followStart === null || steerStart === null) {
        return { drifted: true as const };
      }

      const remaining = pending.slice(followStart);
      const nextKeep = keep.filter((item) => remaining.some((entry) => entry.id === item.id));
      if (
        remaining.some(
          (item) => !nextKeep.some((entry) => entry.id === item.id) && !omittedIds.has(item.id),
        )
      ) {
        throw new Error("Queued message order must list each pending follow-up exactly once.");
      }

      const consumed = pending.slice(0, followStart);
      for (const message of consumed) {
        queuedMessages.set(message.id, {
          ...message,
          status: "processing",
          processingStartedAt: now(),
        });
      }
      steeringRecords.splice(0, steerStart);
      const remainingSteering = [...steeringRecords];
      session.clearQueue?.();

      const inPi: LocalQueued[] = [];
      const failed: LocalQueued[] = [];
      let error: string | undefined;
      const attemptFollowUp = async (message: LocalQueued) => {
        try {
          const captured = await captureFollowUpText(message.body, message.images);
          if (captured.kind === "consumed") {
            message.status = "processing";
            message.processingStartedAt = now();
          } else {
            message.status = "pending";
            message.piText = captured.piText;
            delete message.withdrawnAt;
          }
          if (!inPi.some((entry) => entry.id === message.id)) {
            inPi.push(message);
          }
        } catch (caught) {
          error = error ?? (caught instanceof Error ? caught.message : String(caught));
          message.status = "withdrawn";
          message.withdrawnAt = now();
          if (!failed.some((entry) => entry.id === message.id)) {
            failed.push(message);
          }
        }
        queuedMessages.set(message.id, message);
      };
      const attemptSteer = async (entry: SteeringRecord) => {
        try {
          const captured = await captureSteerText(entry.body, entry.images);
          if (captured.kind === "pending") {
            entry.piText = captured.piText;
            return "queued" as const;
          }
          return "consumed" as const;
        } catch (caught) {
          error = error ?? (caught instanceof Error ? caught.message : String(caught));
          return "failed" as const;
        }
      };

      const keptSteering: SteeringRecord[] = [];
      const finishedSteering = new Set<SteeringRecord>();
      for (const entry of remainingSteering) {
        const outcome = await attemptSteer(entry);
        if (outcome === "queued") {
          keptSteering.push(entry);
        }
        if (outcome === "failed") {
          break;
        }
        finishedSteering.add(entry);
      }
      if (error) {
        for (const entry of remainingSteering.filter((item) => !finishedSteering.has(item))) {
          const outcome = await attemptSteer(entry);
          if (outcome === "queued") {
            keptSteering.push(entry);
          }
        }
      }
      steeringRecords.length = 0;
      steeringRecords.push(...keptSteering);

      for (const message of nextKeep) {
        await attemptFollowUp(message);
        if (error) {
          break;
        }
      }
      if (error) {
        const leftover = remaining.filter(
          (item) =>
            !inPi.some((entry) => entry.id === item.id) && !omittedIds.has(item.id),
        );
        for (const message of leftover) {
          await attemptFollowUp(message);
        }
        adoptPendingOrder([...inPi, ...failed.filter((item) => item.status === "withdrawn")]);
        return { drifted: false as const, ok: false as const, error };
      }

      adoptPendingOrder(nextKeep);
      return { drifted: false as const, ok: true as const };
    };

    if (session.followUp) {
      runtime.queueFollowUp = (message, images) => withQueueWrite(async () => {
        assertOpen();
        const queuedMessage: LocalQueued = {
          id: `pi-sdk:${session.sessionId}:queued:${queuedSequence}`,
          piSessionId: session.sessionId,
          body: message,
          ...(images?.length ? { images } : {}),
          status: "pending",
          createdAt: now(),
        };
        queuedSequence += 1;
        normalizer.noteRunTrigger("follow_up");

        const captured = await captureFollowUpText(message, images);
        if (captured.kind === "consumed") {
          queuedMessage.status = "processing";
          queuedMessage.processingStartedAt = now();
        } else {
          queuedMessage.piText = captured.piText;
        }
        queuedMessages.set(queuedMessage.id, queuedMessage);

        return publicQueued(queuedMessage);
      });
    }

    if (session.clearQueue && session.followUp && session.steer) {
      runtime.withdrawQueuedMessage = (queuedMessageId) => withQueueWrite(async () => {
        assertOpen();
        const queuedMessage = queuedMessages.get(queuedMessageId);

        if (!queuedMessage || queuedMessage.status !== "pending") {
          throw new Error(`Pi SDK queued message "${queuedMessageId}" was not found.`);
        }

        const pending = pendingQueuedMessages();
        const followDisplay = [
          ...(session.getFollowUpMessages?.() ?? pending.map((item) => item.piText ?? item.body)),
        ];
        const followStart = suffixStart(
          pending.map((item) => item.piText ?? item.body),
          followDisplay,
        );
        if (followStart === null) {
          throw new Error(
            `Pi SDK queued message "${queuedMessageId}" was not present in the follow-up queue.`,
          );
        }
        const remaining = pending.slice(followStart);
        if (!remaining.some((item) => item.id === queuedMessageId)) {
          for (const message of pending.slice(0, followStart)) {
            queuedMessages.set(message.id, {
              ...message,
              status: "processing",
              processingStartedAt: now(),
            });
          }
          return {
            ok: false,
            queuedMessages: publishedQueue(),
            error: "already processing",
          };
        }

        const keep = pending.filter((item) => item.id !== queuedMessageId);
        const replayed = await replayQueue(keep, new Set([queuedMessageId]));

        if (replayed.drifted) {
          throw new Error(
            `Pi SDK queued message "${queuedMessageId}" was not present in the follow-up queue.`,
          );
        }

        const withdrawn: LocalQueued = {
          ...queuedMessage,
          status: "withdrawn",
          withdrawnAt: now(),
        };
        queuedMessages.set(queuedMessage.id, withdrawn);

        if (!replayed.ok) {
          return {
            ok: false,
            queuedMessages: publishedQueue(),
            error: replayed.error,
          };
        }

        return {
          ok: true,
          queuedMessages: publishedQueue(),
        };
      });

      runtime.reorderQueuedMessages = (orderedIds) => withQueueWrite(async (): Promise<RuntimeGatewayQueueMutationResult> => {
        assertOpen();
        if (new Set(orderedIds).size !== orderedIds.length) {
          throw new Error("Queued message order must list each pending follow-up exactly once.");
        }

        const keep: LocalQueued[] = [];
        for (const id of orderedIds) {
          const message = queuedMessages.get(id);
          if (!message || message.status === "withdrawn") {
            throw new Error(`Pi SDK queued message "${id}" was not found.`);
          }
          if (message.status === "processing") {
            continue;
          }
          keep.push(message);
        }

        const replayed = await replayQueue(keep);

        if (replayed.drifted) {
          throw new Error("Pi follow-up queue drifted during reorder.");
        }

        if (!replayed.ok) {
          return {
            ok: false,
            queuedMessages: publishedQueue(),
            error: replayed.error,
          };
        }

        return {
          ok: true,
          queuedMessages: publishedQueue(),
        };
      });
    }

    if (session.steer) {
      runtime.steerRun = (message, images) => withQueueWrite(async () => {
        assertOpen();
        const captured = await captureSteerText(message, images);
        if (captured.kind === "consumed") {
          return;
        }
        steeringRecords.push({
          body: message,
          piText: captured.piText,
          ...(images?.length ? { images } : {}),
        });
      });
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
