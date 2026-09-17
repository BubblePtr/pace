import type { RuntimePromptImage } from "./prompt-image";

// Registry project ids are absolute paths (they start with `/`); this sentinel cannot collide.
export const CHAT_PROJECT_ID = "chat";

export type PrepareChatWorkspaceResult = { cwd: string };

export type RuntimeGatewayRequest = {
  id: string;
  method: string;
  params?: unknown;
};

export type RuntimeGatewayResponse = {
  id: string;
  result?: unknown;
  error?: string;
};

export type RuntimeGatewayEventPayload = Record<string, unknown>;

export type WorkspaceInvalidatedPayload = {
  checkoutId: string;
  sessionIds: string[];
  source: "tool" | "git-watch" | "focus" | "reconnect";
};

export type RuntimeGatewayEventEnvelope = {
  id: string;
  seq: number;
  sessionId: string;
  piSessionId: string;
  turnId?: string;
  type: string;
  ts: string;
  payload: RuntimeGatewayEventPayload;
};

export type RuntimeGatewayEventInput = {
  sessionId: string;
  piSessionId: string;
  turnId?: string;
  type: string;
  ts?: string;
  payload: RuntimeGatewayEventPayload;
};

export type RuntimeGatewaySummary = {
  provider: string | null;
  model: string | null;
  totalTokens: number;
  totalCostUsd: number;
};

/**
 * Live context-window occupancy of the active runtime, mirroring Pi's
 * `ContextUsage`. `tokens`/`percent` are null right after a compaction, before
 * the next LLM response — an unknown count, never a zero.
 */
export type RuntimeContextUsage = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

export type RuntimeThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type RuntimeModelInputModality = "text" | "image";

export type RuntimeModelCapability = {
  provider: string;
  modelId: string;
  name: string;
  thinkingLevels: RuntimeThinkingLevel[];
  /** Context window in tokens; absent when the source doesn't report it. */
  contextWindow?: number;
  /** Max output tokens; absent when the source doesn't report it. */
  maxTokens?: number;
  /** Supported input modalities; absent when the source doesn't report it. */
  input?: RuntimeModelInputModality[];
};

export type RuntimeModelSelection = {
  provider: string;
  modelId: string;
  thinkingLevel: RuntimeThinkingLevel;
};

export type RuntimeModelControls = {
  models: RuntimeModelCapability[];
  selected: RuntimeModelSelection | null;
};

/** Current-runtime tool definition. Absent names are omitted, not invented. */
export type RuntimeToolSchema = {
  description: string;
  parameters: unknown;
};

export type RuntimeToolSchemas = {
  schemas: Record<string, RuntimeToolSchema>;
};

export type RuntimeGatewaySnapshot = {
  // Absent on legacy drivers. Cold snapshots contain presentation history only.
  executionState?: "cold" | "ready";
  sessionName?: string;
  sessionId: string;
  runtimeId: string;
  piSessionId: string;
  projectId: string;
  cwd: string;
  status: "idle" | "running" | "failed" | "completed";
  sessionFile?: string;
  checkout?: unknown;
  events: RuntimeGatewayEventEnvelope[];
  summary?: RuntimeGatewaySummary;
  modelControls?: RuntimeModelControls;
  contextUsage?: RuntimeContextUsage;
  updatedAt: string;
};

export type RuntimeGatewayQueuedMessage = {
  id: string;
  piSessionId: string;
  body: string;
  images?: RuntimePromptImage[];
  status: "pending" | "processing" | "withdrawn";
  createdAt: string;
  processingStartedAt?: string;
  withdrawnAt?: string;
};

export type RuntimeGatewayQueueMutationResult =
  | {
      ok: true;
      queuedMessages: RuntimeGatewayQueuedMessage[];
    }
  | {
      ok: false;
      queuedMessages: RuntimeGatewayQueuedMessage[];
      error: string;
    };

export type RuntimeGatewaySequencerOptions = {
  now?: () => string;
  idFactory?: () => string;
};

export type RuntimeGatewaySequencer = {
  (event: RuntimeGatewayEventInput): RuntimeGatewayEventEnvelope;
  advanceTo(seq: number): void;
};

export function createRuntimeGatewaySequencer(
  options: RuntimeGatewaySequencerOptions = {},
): RuntimeGatewaySequencer {
  const now = options.now ?? (() => new Date().toISOString());
  const idFactory =
    options.idFactory ??
    (() =>
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? `evt-${crypto.randomUUID()}`
        : `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let seq = 0;

  const nextEvent = (event: RuntimeGatewayEventInput): RuntimeGatewayEventEnvelope => {
    seq += 1;

    return {
      id: idFactory(),
      seq,
      sessionId: event.sessionId,
      piSessionId: event.piSessionId,
      turnId: event.turnId,
      type: event.type,
      ts: event.ts ?? now(),
      payload: { ...event.payload },
    };
  };

  nextEvent.advanceTo = (nextSeq: number) => {
    if (Number.isSafeInteger(nextSeq) && nextSeq > seq) {
      seq = nextSeq;
    }
  };

  return nextEvent;
}

export type PackageSourceInput = { source: string };
export type UpdatePackageInput = { source?: string };
export type SetResourceEnabledInput = {
  packageSource?: string;
  kind: "extension" | "skill" | "prompt" | "theme";
  /** Absolute resource path from ConfigInventory. */
  path: string;
  enabled: boolean;
};

export type PackageProgressEvent = {
  type: "start" | "progress" | "complete" | "error";
  action: "install" | "remove" | "update" | "clone" | "pull";
  source: string;
  message?: string;
};
export type PackageActionResult = { progress: PackageProgressEvent[] };
export type RemovePackageResult = PackageActionResult & { removed: boolean };
export type CheckPackageUpdatesResult = PackageActionResult & {
  updates: Array<{ source: string; displayName: string; type: "npm" | "git"; scope: "user" | "project" }>;
};

export type AddLocalResourceInput = { path: string; overwrite?: boolean };
export type AddLocalResourceResult = { path: string; kind: "extension" | "skill" | "prompt" | "theme"; conflict: boolean };
