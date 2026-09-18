// Pi Runtime Bridge — the renderer contract for live Pi sessions. Electron uses
// the Runtime Gateway adapter by default; the in-memory adapter is the
// non-Electron fallback.

import type {
  AgentRuntimeEvent,
  RuntimeContextUsage,
  RuntimeFollowUpMode,
  RuntimeModelControls,
  RuntimeModelSelection,
  RuntimePromptImage,
} from "@pace/core";

export type {
  RuntimeContextUsage,
  RuntimeFollowUpMode,
  RuntimeModelControls,
  RuntimeModelSelection,
} from "@pace/core";

export type ExecutionCheckout = {
  mode: "foreground-local" | "managed-worktree";
  root: string;
  runtimeCwd: string;
  repoRoot?: string;
  projectRoot?: string;
  projectRelativePath?: string;
  executionCheckoutRoot?: string;
  diffRoot?: string;
  sessionBound?: boolean;
  disposable?: boolean;
  cleanupCandidate?: boolean;
  permanent?: boolean;
  createdAt?: string;
  cleanupMarkedAt?: string;
  promotedAt?: string;
};

export type RuntimeBridgeFailureStage =
  | "loading history"
  | "starting runtime"
  | "sending prompt"
  | "forking session"
  | "queuing message"
  | "withdrawing queued message"
  | "reordering queued messages"
  | "steering queued message"
  | "steering run"
  | "stopping run"
  | "configuring model";

export type PiRuntimeBridgeErrorDetail = {
  stage: RuntimeBridgeFailureStage;
  message: string;
};

export class PiRuntimeBridgeError extends Error {
  stage: RuntimeBridgeFailureStage;

  constructor(detail: PiRuntimeBridgeErrorDetail) {
    super(detail.message);
    this.name = "PiRuntimeBridgeError";
    this.stage = detail.stage;
  }
}

export type PiRuntimeHandle = {
  runtimeId: string;
  sessionId: string;
  projectId: string;
  checkout: ExecutionCheckout;
  status: "ready";
};

export type PiRuntimeSummary = {
  provider: string | null;
  model: string | null;
  totalTokens: number;
  totalCostUsd: number;
};

export type PiRuntimeEvent = {
  id: string;
  piSessionId: string;
  messageId?: string;
  piEntryId?: string;
  toolCallId?: string;
  kind:
    | "message"
    | "thinking"
    | "tool-call"
    | "tool-result"
    | "error"
    | "usage"
    | "status"
    | "control";
  role?: "user" | "assistant";
  title?: string;
  body: string;
  images?: RuntimePromptImage[];
  bodyFormat?: "full" | "delta";
  phase?: "partial" | "delta" | "final";
  timestamp: string;
  summary?: Partial<PiRuntimeSummary>;
  // True on legacy events folded down from Agent Runtime Event payloads; the
  // projection must not mirror those back into the runtime model.
  derivedFromAgentEvent?: boolean;
  fatal?: boolean;
};

export type PiQueuedMessageStatus = "pending" | "processing" | "steered" | "withdrawn";

export type PiQueuedMessage = {
  id: string;
  piSessionId: string;
  body: string;
  images?: RuntimePromptImage[];
  status: PiQueuedMessageStatus;
  createdAt: string;
  processingStartedAt?: string;
  steeredAt?: string;
  withdrawnAt?: string;
};

// One step of a session's replay sequence, in Gateway seq order. Agent events
// rebuild the runtime model; chat entries are Gateway-minted legacy events
// (user echo, steer control, errors) that exist only on the legacy stream
// until the user-message protocol gap is settled (design doc §10).
export type SessionReplayEntry =
  | { kind: "agent"; entry: AgentRuntimeEventEntry }
  | { kind: "chat"; seq: number; event: PiRuntimeEvent };

export type PiSessionState = {
  executionState?: "cold" | "ready";
  sessionName?: string;
  piSessionId: string;
  runtimeId: string;
  projectId: string;
  cwd: string;
  sessionFile?: string;
  status: "idle" | "running" | "failed" | "completed";
  events: PiRuntimeEvent[];
  // Journaled boundary events from the Gateway snapshot; absent on bridges
  // that don't speak the Agent Runtime Event Model.
  replay?: SessionReplayEntry[];
  summary?: PiRuntimeSummary;
  modelControls?: RuntimeModelControls;
  contextUsage?: RuntimeContextUsage;
  followUpMode?: RuntimeFollowUpMode;
  updatedAt: string;
};

export type PiRuntimeAcceptedPrompt = {
  accepted: true;
  piSessionId: string;
  event: PiRuntimeEvent;
  state?: PiSessionState;
};

export type StartRuntimeInput = {
  sessionId: string;
  projectId: string;
  checkout: ExecutionCheckout;
  modelSelection?: RuntimeModelSelection;
};

export type CreatePiSessionStateInput = {
  runtimeId: string;
  projectId: string;
  cwd: string;
};

export type SendInitialPromptInput = {
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

export type ReorderQueuedMessagesInput = {
  piSessionId: string;
  orderedIds: string[];
};

export type SteerFromQueueInput = {
  piSessionId: string;
  queuedMessageId: string;
};

export type ReorderQueuedMessagesResult =
  | {
      ok: true;
      queuedMessages: PiQueuedMessage[];
    }
  | {
      ok: false;
      queuedMessages: PiQueuedMessage[];
      error: string;
    };

export type SteerRunInput = {
  piSessionId: string;
  message: string;
  images?: RuntimePromptImage[];
};

export type AbortRunInput = {
  piSessionId: string;
};

export type ConfigureModelInput = RuntimeModelSelection & {
  sessionId: string;
  piSessionId: string;
};

export type ResumeSessionInput = {
  sessionId: string;
  projectId: string;
  piSessionId: string;
  cwd: string;
  sessionFile: string;
  checkout: ExecutionCheckout | null;
};

export type ForkSessionInput = {
  sessionId: string;
  projectId: string;
  sourcePiSessionId: string;
  sourceSessionFile: string;
  piEntryId: string;
  cwd: string;
  checkout: ExecutionCheckout | null;
};

export type ForkSessionResult = {
  state: PiSessionState;
  selectedText?: string;
};

// One Agent Runtime Event as delivered to the renderer: the protocol event
// plus the Gateway envelope ordering metadata the projection keys on.
export type AgentRuntimeEventEntry = {
  seq: number;
  timestamp: string;
  event: AgentRuntimeEvent;
};

export type PiRuntimeBridge = {
  startRuntime(input: StartRuntimeInput): Promise<PiRuntimeHandle>;
  createPiSessionState(input: CreatePiSessionStateInput): Promise<PiSessionState>;
  sendInitialPrompt(input: SendInitialPromptInput): Promise<PiRuntimeAcceptedPrompt>;
  queueFollowUp(input: QueueFollowUpInput): Promise<PiQueuedMessage>;
  withdrawQueuedMessage(input: WithdrawQueuedMessageInput): Promise<ReorderQueuedMessagesResult>;
  reorderQueuedMessages(input: ReorderQueuedMessagesInput): Promise<ReorderQueuedMessagesResult>;
  steerFromQueue(input: SteerFromQueueInput): Promise<ReorderQueuedMessagesResult>;
  steerRun(input: SteerRunInput): Promise<PiRuntimeEvent>;
  abortRun(input: AbortRunInput): Promise<PiRuntimeEvent>;
  configureModel?(input: ConfigureModelInput): Promise<RuntimeModelControls>;
  getSessionState(piSessionId: string): Promise<PiSessionState>;
  loadSession?(input: { sessionId: string; piSessionId: string }): Promise<PiSessionState>;
  resumeSession?(input: ResumeSessionInput): Promise<PiSessionState>;
  forkSession?(input: ForkSessionInput): Promise<ForkSessionResult>;
  prepareChatWorkspace?(input: { sessionId: string }): Promise<{ cwd: string }>;
  subscribeToEvents(piSessionId: string, listener: (event: PiRuntimeEvent) => void): () => void;
  // Optional until every bridge speaks the Agent Runtime Event Model; the
  // legacy PiRuntimeEvent stream above remains the compatibility surface.
  subscribeToAgentEvents?(
    piSessionId: string,
    listener: (entry: AgentRuntimeEventEntry) => void,
  ): () => void;
};

// Domain helpers shared by both adapters — pure operations on the contract types.

export function defaultRuntimeSummary(
  overrides: Partial<PiRuntimeSummary> = {},
): PiRuntimeSummary {
  return {
    provider: null,
    model: null,
    totalTokens: 0,
    totalCostUsd: 0,
    ...overrides,
  };
}

function cloneReplayEntry(entry: SessionReplayEntry): SessionReplayEntry {
  if (entry.kind === "agent") {
    return { kind: "agent", entry: { ...entry.entry } };
  }

  return { kind: "chat", seq: entry.seq, event: { ...entry.event } };
}

export function cloneSessionState(state: PiSessionState): PiSessionState {
  return {
    ...state,
    events: state.events.map((event) => ({ ...event })),
    ...(state.replay ? { replay: state.replay.map(cloneReplayEntry) } : {}),
    summary: state.summary ? { ...state.summary } : undefined,
    modelControls: state.modelControls
      ? {
          models: state.modelControls.models.map((model) => ({
            ...model,
            thinkingLevels: [...model.thinkingLevels],
          })),
          selected: state.modelControls.selected
            ? { ...state.modelControls.selected }
            : null,
        }
      : undefined,
    contextUsage: state.contextUsage ? { ...state.contextUsage } : undefined,
    ...(state.followUpMode ? { followUpMode: state.followUpMode } : {}),
  };
}
