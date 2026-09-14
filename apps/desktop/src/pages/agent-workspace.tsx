import { Button } from "@astryxdesign/core/Button";
import { Collapsible, CollapsibleGroup } from "@astryxdesign/core/Collapsible";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { IconButton } from "@astryxdesign/core/IconButton";
import { List, ListItem } from "@astryxdesign/core/List";
import { Popover } from "@astryxdesign/core/Popover";
import { ResizeHandle, useResizable } from "@astryxdesign/core/Resizable";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Selector, SelectorOption } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ChatChainOfThought as ChainOfThought } from "@/shared/ui/chat/chat-chain-of-thought";
import { ChatThoughtMarkdown } from "@/shared/ui/chat/chat-thought-markdown";
import { ChatThoughtStep } from "@/shared/ui/chat/chat-thought-step";
import { ChatToolStep } from "@/shared/ui/chat/chat-tool-step";
import { ChatConversation } from "@/shared/ui/chat/chat-conversation";
import {
  ChatMarkdown as Markdown,
  ChatStreamMarkdown as StreamMarkdown,
} from "@/shared/ui/chat/chat-markdown";
import { ChatRunFailure } from "@/shared/ui/chat/chat-run-failure";
import { ChatMessage, ChatMessageActions } from "@/shared/ui/chat/chat-message";
import { ChatPromptInput as PromptInput } from "@/shared/ui/chat/chat-prompt-input";
import { ChatQueuedMessage } from "@/shared/ui/chat/chat-queued-message";
import { usePresenceList } from "@/shared/ui/chat/use-presence-list";
import { ChatPromptSuggestion as PromptSuggestion } from "@/shared/ui/chat/chat-prompt-suggestion";
import {
  type ChatToolItem,
  type ToolPartState,
} from "@/shared/ui/chat/chat-tool";
import { TextShimmer } from "@/shared/ui/chat/text-shimmer";
import { ContextUsageMeter } from "@/shared/ui/context-usage-meter";
import { ModelSelectorControl } from "@/shared/ui/model-selector/model-selector-control";
import {
  ComposerAttachmentDrawer,
  ComposerInsertMenu,
  buildPromptWithAttachments,
  insertIntoDraft,
  useComposerAttachments,
  useComposerInsertCatalog,
  useFilePicker,
} from "@/shared/ui/composer-attachments";
import {
  SessionDock,
  SessionDockTrigger,
  sessionDockDefaultWidthPx,
  sessionDockResizableBounds,
  useSessionDockMotionState,
  useSessionDockPresence,
} from "@/shared/ui/session-dock/session-dock";
import { SessionSurfaceBar } from "@/shared/ui/session-dock/surface-bar";
import {
  type SessionSurfaceId,
} from "@/shared/ui/session-dock/surface-registry";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import {
  type CSSProperties,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RuntimePromptImage, SessionChangedFile, SessionChanges } from "@pace/core";
import { promptImageDataUrl } from "@pace/core";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { AppFrame, defaultSidebarProjectSessionProjections } from "@/app/app-shell";
import { NoProvidersEmptyState } from "@/entities/session/no-providers-empty-state";
import { useProviderAuthStatus } from "@/entities/session/use-provider-auth-status";
import { invoke } from "@/shared/runtime";
import {
  Stop,
  Box,
  ChatAdd,
  Check,
  ChevronDown,
  Computer,
  FileDiff,
  FolderClosed,
  GitBranch,
  LayoutAlignLeft,
  ListTree,
  RefreshCw,
  Sparkles,
} from "@/shared/ui/icons";
import {
  getBrowserDevelopmentSessionDraft,
  getProjectRegistryWithBrowserDevelopmentFallback,
  shouldUseBrowserDevelopmentData,
} from "@/shared/browser-development-data";
import {
  createExecutionCheckoutManager,
  type ExecutionCheckoutManager,
} from "@/entities/checkout/execution-checkout";
import { createInvokeExecutionCheckoutGitClient } from "@/entities/checkout/execution-checkout-client";
import {
  CHAT_PICKER_LABEL,
  CHAT_PROJECT_ID,
  CHAT_WORKSPACE_DISPLAY_NAME,
  chatWorkspaceListEntry,
  isChatProjectId,
} from "@/entities/project/chat-workspace";
import {
  getProjectRegistry,
  subscribeProjectRegistry,
  type ProjectRegistryEntry,
} from "@/entities/project/project-registry";
import { createDefaultPiRuntimeBridge } from "@/entities/runtime/pi-runtime-factory";
import {
  PiRuntimeBridgeError,
  type ExecutionCheckout,
  type PiRuntimeBridge,
  type PiSessionState,
  type RuntimeModelControls,
  type RuntimeModelSelection,
} from "@/entities/runtime/pi-runtime-bridge";
import {
  isContextCompacting,
  type SessionRuntimeMessage,
  type SessionRuntimeModel,
} from "@/entities/session/session-runtime-model";
import { deriveCotView, type CotStep, type CotView } from "@/entities/session/cot-view";
import {
  createInMemorySessionProjectionStore,
  createSessionFromDraft,
  prepareChatSessionCheckout,
  type CreateSessionFromDraftInput,
  type CreateSessionFromDraftResult,
} from "@/entities/session/session-creation";
import {
  clearFollowUpDraft,
  getFollowUpDraft,
  saveFollowUpDraft,
} from "@/entities/session/follow-up-drafts";
import { subscribeComposerInjections } from "@/entities/session/composer-injections";
import {
  clearSessionDraft,
  ensureSessionDraft,
  getSessionDraft,
  saveSessionDraft,
  setSessionDraftCheckoutMode,
  setSessionDraftTarget,
  subscribeSessionDrafts,
  type SessionDraftCheckoutMode,
  type SessionDraft,
} from "@/entities/session/session-drafts";
import {
  applySessionProjectionEvent,
  createSessionProjection,
  isSessionProjectionArchived,
  getSessionProjectionListItems,
  isSessionProjectionActive,
  type SessionProjection,
} from "@/entities/session/session-projection";
import {
  sessionChangesBadge,
  useSessionChanges,
  type SessionChangesView,
} from "@/entities/session/use-session-changes";
import {
  getLastModelSelection,
  mostRecentSessionModelSelection,
  overlayPreferredModel,
  saveLastModelSelection,
} from "@/entities/session/last-model-preference";
import { getVisibleModels } from "@/entities/model/visible-models";
import {
  findSessionChangeTarget,
  parseSessionChangeLink,
  type SessionChangeLink,
  type SessionChangeTarget,
} from "@/entities/session/session-change-link";
import type { TerminalInstanceInfo } from "@/entities/terminal/terminal-client";
import { SessionBrowserPanel } from "@/pages/session-browser-panel";
import { SessionFilesPanel } from "@/pages/session-files-panel";
import { SessionTerminalPanel } from "@/pages/session-terminal-panel";
import { useSettingsDialog } from "@/shared/settings-navigation";
import {
  sessionProjectionFromPersistedProjection,
  useSessionProjections,
  useSessionProjectionsOptional,
} from "@/entities/session/use-session-projections";


type LiveMessage = {
  id: string;
  role: "user" | "assistant";
  body: string;
  images?: { src: string; name?: string }[];
  runId?: string;
  piEntryId?: string;
  controlLabel?: string;
  isStreaming?: boolean;
  relatedMessageIds?: string[];
  /** The Run's Chain of Thought, derived once with the bubble it belongs to. */
  cotView?: CotView;
};

type RunTimelineItem = {
  id: string;
  kind?: "trace" | "thinking" | "tool";
  title: string;
  meta: string;
  messageId?: string;
  toolCallId?: string;
  toolName?: string;
  toolState?: ToolPartState;
  argsText?: string;
  outputText?: string;
  durationMs?: number;
};

type AgentWorkspaceFixture = {
  id: string;
  name: string;
  projectRoot: string;
  repoRoot: string;
  selectedSessionId: string | null;
  liveMessages: LiveMessage[];
  runTimeline: RunTimelineItem[];
  checkout: {
    mode: string;
    root: string;
    runtimeCwd: string;
  };
  summary: {
    model: string;
    totalCostUsd: number;
    totalTokens: number;
  };
};

type SessionChangesPanelProps = {
  sessionId: string | null;
  target?: SessionChangeTarget | null;
  stale: boolean;
  /** The page owns the read so the rail badge can share it (ADR-0028). */
  changes: SessionChanges | null;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
};


const SessionDiffViewer = lazy(
  () => import("@/entities/session/session-diff-viewer"),
);

type RestorablePiRuntimeBridge = PiRuntimeBridge & {
  restoreSessionState(state: PiSessionState): Promise<PiSessionState>;
};

export type SessionDraftSubmitEvent = {
  projectId: string;
  prompt: string;
  checkoutMode: SessionDraftCheckoutMode;
  modelSelection?: RuntimeModelSelection;
  images?: RuntimePromptImage[];
};

type SessionCreatorInput = Omit<
  CreateSessionFromDraftInput,
  "bridge" | "projections"
>;

type SessionCreator = (
  input: SessionCreatorInput,
) => Promise<CreateSessionFromDraftResult>;

const fixtureWorkspace: AgentWorkspaceFixture = {
  id: "pig",
  name: "Pig",
  projectRoot: "/Users/void/code/opensource/Pig",
  repoRoot: "/Users/void/code/opensource/Pig",
  selectedSessionId: "session-control-plane-shell",
  liveMessages: [
    {
      id: "message-user",
      role: "user",
      body: "Create the Agent Workspace entry shape for this Project.",
    },
    {
      id: "message-assistant",
      role: "assistant",
      body: "Project Sessions keep live Pi work separate from Trajectory and Usage evidence.",
    },
  ],
  runTimeline: [
    {
      id: "timeline-read-context",
      title: "Project context loaded",
      meta: "Pace workspace and recent session evidence",
    },
    {
      id: "timeline-render-shell",
      title: "Workspace view prepared",
      meta: "Session list, live chat, timeline, and action surface",
    },
    {
      id: "timeline-analyze",
      title: "Evidence preserved",
      meta: "Trajectory and Usage stay as historical evidence views",
    },
  ],
  checkout: {
    mode: "Foreground local checkout",
    root: "/Users/void/code/opensource/Pig",
    runtimeCwd: "/Users/void/code/opensource/Pig",
  },
  summary: {
    model: "gpt-5-codex",
    totalCostUsd: 0.042137,
    totalTokens: 18_420,
  },
};

function workspaceFromProject(project: ProjectRegistryEntry): AgentWorkspaceFixture {
  return {
    id: project.id,
    name: project.displayName,
    projectRoot: project.path,
    repoRoot: project.path,
    selectedSessionId: null,
    liveMessages: [],
    runTimeline: [],
    checkout: {
      mode: "Foreground local checkout",
      root: project.path,
      runtimeCwd: project.path,
    },
    summary: {
      model: "Unknown",
      totalCostUsd: 0,
      totalTokens: 0,
    },
  };
}

const modelFirstResponseWatchdogMs = 15_000;
const contactingModelPlaceholder = "Pi is contacting the model...";
const stalledModelResponsePlaceholder =
  "Still waiting for the model response. The provider has not returned a first chunk yet.";

function getVisibleProjectRegistry() {
  return getProjectRegistryWithBrowserDevelopmentFallback(getProjectRegistry());
}

function LiveChatMessage({
  message,
  onForkMessage,
  recovery,
}: {
  message: LiveMessage;
  onForkMessage?: (message: LiveMessage) => void;
  recovery?: ReactNode;
}) {
  if (message.role === "user") {
    const canFork = Boolean(message.piEntryId && onForkMessage);

    return (
      <ChatMessage.User>
        <div className="flex flex-col items-end gap-1">
          {message.images?.length ? (
            <div className="chat-message__images">
              {message.images.map((image, index) => (
                <Thumbnail
                  key={`${message.id}-image-${index}`}
                  alt={image.name ?? "Attached image"}
                  label={image.name ?? "Attached image"}
                  src={image.src}
                />
              ))}
            </div>
          ) : null}
          {message.body || message.controlLabel ? (
            <ChatMessage.Bubble>
              {message.controlLabel ? (
                <p className="mb-1 text-xs font-medium text-muted">
                  {message.controlLabel}
                </p>
              ) : null}
              {message.body ? (
                <ChatMessage.Content>{message.body}</ChatMessage.Content>
              ) : null}
            </ChatMessage.Bubble>
          ) : null}
          {message.body || canFork ? (
            <ChatMessageActions className="shrink-0">
              {message.body ? (
                <ChatMessageActions.Copy
                  aria-label="Copy"
                  tooltip="Copy"
                  onPress={() => {
                    void navigator.clipboard?.writeText(message.body);
                  }}
                />
              ) : null}
              {canFork ? (
                <ChatMessage.Action
                  aria-label="Fork from message"
                  tooltip="Fork from message"
                  onPress={() => onForkMessage?.(message)}
                >
                  <GitBranch className="size-4" />
                </ChatMessage.Action>
              ) : null}
            </ChatMessageActions>
          ) : null}
        </div>
      </ChatMessage.User>
    );
  }

  if (message.controlLabel === "Run failed") {
    return (
      <ChatMessage.Assistant>
        <ChatMessage.Body>{recovery ?? <ChatRunFailure error={message.body} />}</ChatMessage.Body>
      </ChatMessage.Assistant>
    );
  }

  return (
    <ChatMessage.Assistant>
      <ChatMessage.Body>
        {message.controlLabel ? (
          <p className="mb-1 text-xs font-medium text-muted">
            {message.controlLabel}
          </p>
        ) : null}
        {!message.controlLabel && message.cotView ? (
          <AssistantRunTrajectory view={message.cotView} />
        ) : null}
        {message.body ? (
          <ChatMessage.Content>
            <AssistantMessageContent message={message} />
          </ChatMessage.Content>
        ) : null}
        {!message.controlLabel && !message.isStreaming && message.body ? (
          <ChatMessageActions className="chat-message__actions--persist">
            <ChatMessageActions.Copy
              aria-label="Copy"
              tooltip="Copy"
              onPress={() => {
                void navigator.clipboard?.writeText(message.body);
              }}
            />
            <ChatMessageActions.ThumbsUp
              aria-label="Good response"
              tooltip="Good response"
            />
            <ChatMessageActions.ThumbsDown
              aria-label="Bad response"
              tooltip="Bad response"
            />
          </ChatMessageActions>
        ) : null}
      </ChatMessage.Body>
    </ChatMessage.Assistant>
  );
}

/**
 * One Active Run's Chain of Thought. The phase, the clock anchor and the step
 * list all come from `deriveCotView`; this only lays them out, so there is no
 * second opinion about what stage the run is in (ADR-0030 §1).
 */
function AssistantRunTrajectory({ view }: { view: CotView }) {
  if (view.phase === "hidden") {
    return null;
  }

  const ticking = view.phase === "thinking" || view.phase === "acting";

  // Nothing measured and nothing to disclose: a bare "Worked" header would be
  // chrome with nothing behind it.
  if (!ticking && !view.steps.length && view.elapsedMs === undefined) {
    return null;
  }

  return (
    <ChainOfThought
      // While the clock runs the component owns it: it walks the Run's anchor
      // at 100ms rather than the page re-deriving the whole view that often.
      // Every other phase hands over the frozen number (ADR-0030 §6).
      {...(ticking
        ? { startedAtMs: view.anchorMs }
        : { elapsedMs: view.elapsedMs })}
      hasSteps={view.steps.length > 0}
      phase={view.phase}
      outcome={view.outcome}
    >
      <ChainOfThought.Steps>
        {view.steps.map((step) => (
          <ChainOfThought.Step key={step.id}>
            {step.kind === "thinking" ? (
              <ChatThoughtStep step={step} />
            ) : step.kind === "tools" ? (
              <ChatToolStep step={step} />
            ) : (
              // Interim Output is what the model said to the user, so it reads
              // a shade darker than the steps around it (ADR-0030 §7).
              <div
                className="chain-of-thought__interim"
                data-slot="chat-interim-output"
              >
                <ChatThoughtMarkdown text={step.text} />
              </div>
            )}
          </ChainOfThought.Step>
        ))}
      </ChainOfThought.Steps>
    </ChainOfThought>
  );
}

/**
 * Legacy-bridge fallback: the `runtimeEvents` pipeline mints no Message
 * boundaries, so its trace has no Run to phase and no anchor to measure. It
 * settles immediately with an unnumbered header — the same shape, without the
 * timing — and goes away with the pipeline itself.
 */
function settledCotViewFromTimeline(timeline: RunTimelineItem[]): CotView {
  const steps: CotStep[] = [];

  for (const item of timeline) {
    if (item.kind !== "tool") {
      steps.push({ kind: "thinking", id: item.id, text: item.meta, live: false });
      continue;
    }

    const tool: ChatToolItem = {
      argsText: item.argsText,
      durationMs: item.durationMs,
      output: item.outputText,
      state: item.toolState ?? "input-available",
      toolCallId: item.toolCallId ?? item.id,
      toolName: item.toolName ?? item.title,
    };
    const last = steps[steps.length - 1];

    // Consecutive calls are one step, exactly as they are on the phase path.
    if (last?.kind === "tools") {
      last.tools.push(tool);
    } else {
      steps.push({ kind: "tools", id: item.id, tools: [tool], live: false });
    }
  }

  return { phase: "settled", steps };
}

function AssistantMessageContent({ message }: { message: LiveMessage }) {
  if (message.controlLabel) {
    return message.body;
  }

  if (message.isStreaming) {
    return (
      <StreamMarkdown isStreaming>
        {message.body}
      </StreamMarkdown>
    );
  }

  return <Markdown>{message.body}</Markdown>;
}

function QueuedMessageList({
  projection,
  onWithdraw,
  onSteer,
}: {
  projection: SessionProjection;
  onWithdraw: (queuedMessageId: string) => void;
  /** Present only while a run is active; queued rows offer Steer then. */
  onSteer?: (queuedMessageId: string) => void;
}) {
  const queuedMessages = projection.queuedMessages.filter(
    (queuedMessage) => queuedMessage.status !== "processing",
  );
  const { present, onExitTransitionEnd } = usePresenceList(
    queuedMessages,
    (queuedMessage) => queuedMessage.id,
    { exitTimeoutMs: 150 },
  );

  if (!present.length) {
    return null;
  }

  return (
    <div
      className="mx-auto mb-3 grid w-full max-w-[44rem] gap-1.5"
      data-testid="queued-message-list"
    >
      {present.map(({ item: queuedMessage, key, motion }) => (
        <ChatQueuedMessage
          body={queuedMessage.body || queuedMessage.images?.[0]?.name || "Attached image"}
          isWithdrawn={queuedMessage.status === "withdrawn"}
          key={key}
          presence={motion}
          onExitTransitionEnd={() => onExitTransitionEnd(key)}
          onSteer={
            onSteer && queuedMessage.status === "pending"
              ? () => onSteer(queuedMessage.id)
              : undefined
          }
          onWithdraw={
            queuedMessage.status === "pending"
              ? () => onWithdraw(queuedMessage.id)
              : undefined
          }
        />
      ))}
    </div>
  );
}

function FullChatComposer({
  queueMode = false,
  isCreating = false,
  isStoppingRun = false,
  projection,
  sessionChanges: providedSessionChanges,
  onPromptSubmit,
  onQueueSubmit,
  onWithdrawQueuedMessage,
  onStopRun,
  onSteerSubmit,
  onModelConfigChange,
  onManageModels,
}: {
  queueMode?: boolean;
  /** Session Creation in flight: the input waits for Pi to accept the initial prompt. */
  isCreating?: boolean;
  isStoppingRun?: boolean;
  projection?: SessionProjection | null;
  sessionChanges?: SessionChangesView;
  onPromptSubmit?: (message: string, images?: RuntimePromptImage[]) => Promise<void> | void;
  onQueueSubmit?: (message: string, images?: RuntimePromptImage[]) => Promise<void> | void;
  onWithdrawQueuedMessage?: (queuedMessageId: string) => Promise<void> | void;
  onStopRun?: () => Promise<void> | void;
  onSteerSubmit?: (message: string, images?: RuntimePromptImage[]) => Promise<void> | void;
  onModelConfigChange?: (selection: RuntimeModelSelection) => Promise<void> | void;
  onManageModels?: () => void;
}) {
  const sessionId = projection?.id ?? null;
  // Read once per mount: Settings owns this set and the composer only remounts
  // after leaving that page (issue #102).
  const [visibleModels] = useState(getVisibleModels);
  const [availableModels, setAvailableModels] = useState<RuntimeModelControls["models"]>([]);
  const needsModelCatalog = Boolean(projection?.piSessionId && !projection.modelControls?.models.length);
  const composerModelControls = projection?.modelControls?.models.length
    ? projection.modelControls
    : availableModels.length
      ? { models: availableModels, selected: projection?.modelControls?.selected ?? null }
      : projection?.modelControls;

  useEffect(() => {
    if (!needsModelCatalog) return;
    let cancelled = false;
    void invoke<RuntimeModelControls>("list_available_model_controls").then((controls) => {
      if (!cancelled) setAvailableModels(controls.models);
    }).catch(() => {
      // An unavailable catalog must not prevent reading history or sending a prompt.
    });
    return () => { cancelled = true; };
  }, [needsModelCatalog, sessionId]);
  const [draft, setDraft] = useState(() =>
    sessionId ? getFollowUpDraft(sessionId)?.message ?? "" : "",
  );
  // What an injection appends to; the subscription below outlives every
  // keystroke and must not resubscribe for each one.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [composerError, setComposerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  // Shelf drawer + footer Add-to-prompt menu. Images ride send_prompt /
  // queue_follow_up / steer_run. Decision: .scratch/composer-attachments/PRD.md
  const attachments = useComposerAttachments();
  const catalog = useComposerInsertCatalog();
  const picker = useFilePicker(attachments.addFiles);
  // Prefer the page-level read (shared with Changes / the rail badge) so Git
  // is only asked once. View-only tests that don't pass it still get a local
  // read, gated on a bound runtime — the same moment the footer exists.
  const localSessionChanges = useSessionChanges({
    sessionId,
    enabled:
      !providedSessionChanges && Boolean(sessionId && projection?.piSessionId) &&
      !isChatProjectId(projection?.projectId ?? ""),
  });
  const promptStatus = isStoppingRun || isCreating || isSubmitting
    ? "submitted"
    : queueMode
      ? "streaming"
      : composerError || attachments.error
        ? "error"
        : "ready";
  const errorMessage = (error: unknown) =>
    error instanceof Error ? error.message : "Pi could not process this input.";
  const updateDraft = (message: string) => {
    setDraft(message);

    if (!sessionId) {
      return;
    }

    if (message.trim()) {
      saveFollowUpDraft(sessionId, message);
    } else {
      clearFollowUpDraft(sessionId);
    }
  };
  const clearSubmittedDraft = () => {
    setDraft("");

    if (sessionId) {
      clearFollowUpDraft(sessionId);
    }
  };

  useEffect(() => {
    setDraft(sessionId ? getFollowUpDraft(sessionId)?.message ?? "" : "");
    setComposerError(null);
    attachments.clear();
  }, [sessionId, attachments.clear]);

  // A surface outside the chat column — today the browser's `Send to composer`
  // (#151) — handing the user something to send. It lands in the draft rather
  // than being sent, so it can be edited, queued or steered like anything the
  // user typed.
  useEffect(() => {
    if (!sessionId) {
      return;
    }

    return subscribeComposerInjections(sessionId, (injection) => {
      const current = draftRef.current;
      const next = current.trim()
        ? `${current.trimEnd()}\n\n${injection.text}`
        : injection.text;

      // Through the ref rather than a state updater: persisting the draft is a
      // side effect, and it also has to be right for a second injection that
      // lands before React has re-rendered the first.
      draftRef.current = next;
      setDraft(next);
      saveFollowUpDraft(sessionId, next);

      if (injection.files?.length) {
        attachments.addFiles(injection.files);
      }
    });
  }, [attachments.addFiles, sessionId]);

  const submitDraft = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      const built = await buildPromptWithAttachments(draft, attachments.items);

      if (!built.ok) {
        setComposerError(built.error);
        return;
      }

      if (queueMode) {
        try {
          await onQueueSubmit?.(built.prompt, built.images);
          setComposerError(null);
          attachments.clear();
          clearSubmittedDraft();
        } catch (error) {
          setComposerError(errorMessage(error));
        }

        return;
      }

      try {
        await onPromptSubmit?.(built.prompt, built.images);
        setComposerError(null);
        attachments.clear();
        clearSubmittedDraft();
      } catch (error) {
        setComposerError(errorMessage(error));
      }
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };
  // Queue-first model: the composer always queues while a run is active, and
  // steering happens from the queued row itself — steer the run with the row's
  // body, then withdraw the row so the queue reflects what was promoted.
  // Decision record: .scratch/composer-redesign/PRD.md
  const steerQueuedMessage = async (queuedMessageId: string) => {
    const queuedMessage = projection?.queuedMessages.find(
      (message) => message.id === queuedMessageId,
    );

    if (!queuedMessage) {
      return;
    }

    try {
      await onSteerSubmit?.(queuedMessage.body, queuedMessage.images);
      await onWithdrawQueuedMessage?.(queuedMessageId);
      setComposerError(null);
    } catch (error) {
      setComposerError(errorMessage(error));
    }
  };

  const sessionChangesView = providedSessionChanges ?? localSessionChanges;
  const sessionGitChanges = sessionChangesView.changes;
  const gitBranchLabel = gitBranchPickerLabelFromChanges(sessionGitChanges);

  const switchSessionBranch = async (branch: string) => {
    try {
      await sessionChangesView.checkoutBranch(branch);
      setComposerError(null);
    } catch (error) {
      setComposerError(errorMessage(error));
    }
  };

  // Context occupancy is session runtime state, so it rides the footer line
  // rather than any composer control. Only a bound runtime has a context
  // window to be a share of. Git branch status sits on the same row, left of
  // the ring, in the same ghost-Selector chrome as the draft Project picker.
  const composerFooter = projection?.piSessionId ? (
    <span className="flex w-full min-w-0 items-center gap-2">
      {gitBranchLabel ? (
        <GitBranchPicker
          branch={gitBranchLabel}
          branches={sessionGitChanges?.branches ?? []}
          occupiedBranches={sessionGitChanges?.occupiedBranches ?? []}
          onBranchChange={(next) => void switchSessionBranch(next)}
        />
      ) : isChatProjectId(projection.projectId) ? (
        <span className="text-xs text-muted" data-testid="live-session-chat-label">
          {CHAT_WORKSPACE_DISPLAY_NAME}
        </span>
      ) : null}
      <span className="ml-auto inline-flex shrink-0">
        <ContextUsageMeter
          isCompacting={isContextCompacting(projection.runtimeModel)}
          usage={projection.contextUsage}
        />
      </span>
    </span>
  ) : undefined;

  return (
    <div
      className="mt-auto shrink-0 px-4 pb-3 pt-3"
      data-testid="full-chat-composer"
    >
      {projection ? (
        <QueuedMessageList
          projection={projection}
          onSteer={
            queueMode && onSteerSubmit
              ? (queuedMessageId) => void steerQueuedMessage(queuedMessageId)
              : undefined
          }
          onWithdraw={(queuedMessageId) =>
            void onWithdrawQueuedMessage?.(queuedMessageId)
          }
        />
      ) : null}
      <PromptInput
        allowSubmitWhileRunning={queueMode && !isSubmitting}
        className="mx-auto w-full max-w-[44rem]"
        drawer={
          <ComposerAttachmentDrawer
            items={attachments.items}
            onRemove={attachments.remove}
          />
        }
        error={attachments.error ?? composerError}
        footer={composerFooter}
        hasAttachments={attachments.items.length > 0}
        lockInputOnRun={!queueMode || isSubmitting}
        startActions={
          <>
            {picker.input}
            <ComposerInsertMenu
              plugins={catalog.plugins}
              skills={catalog.skills}
              onAttach={picker.open}
              onInsert={(text) => updateDraft(insertIntoDraft(draft, text))}
            />
            {composerModelControls && onModelConfigChange ? (
              <ModelSelectorControl
                controls={composerModelControls}
                isDisabled={queueMode || isSubmitting}
                visibleModels={visibleModels}
                onChange={onModelConfigChange}
                onManageModels={onManageModels}
              />
            ) : null}
          </>
        }
        placeholder={
          isCreating
            ? "Starting session…"
            : queueMode
              ? "Queue the next task…"
              : "What do you want to know?"
        }
        status={promptStatus}
        value={draft}
        onFiles={attachments.addFiles}
        onStop={onStopRun ? () => void onStopRun() : undefined}
        onSubmit={submitDraft}
        onValueChange={updateDraft}
      />
      {isSubmitting ? (
        <p role="status" aria-live="polite" className="text-sm text-muted">
          <TextShimmer>Sending message…</TextShimmer>
        </p>
      ) : null}
    </div>
  );
}

// —— Structured runtime model rendering (Agent Runtime Event Model) ——
// Active once run events own the session; bridges that don't speak the new
// model fall back to the legacy runtimeEvents pipeline below.

function runtimeModelIsActive(projection: SessionProjection) {
  return projection.runtimeModel.runs.size > 0;
}

function chatTextFromModelMessage(message: SessionRuntimeMessage) {
  return message.parts
    .filter((part) => part.partType === "text")
    .map((part) => part.body)
    .join("");
}

function chatImagesFromModelMessage(message: SessionRuntimeMessage) {
  return message.parts
    .filter((part) => part.partType === "image" && part.body)
    .map((part) => ({
      src: part.body,
      ...(part.name ? { name: part.name } : {}),
    }));
}

function liveImagesFromPrompt(images?: RuntimePromptImage[]) {
  return images?.map((image) => ({
    src: promptImageDataUrl(image),
    name: image.name,
  }));
}

function latestRuntimeModelRunId(model: SessionRuntimeModel) {
  const runs = [...model.runs.values()];
  const activeRun = [...runs].reverse().find((run) => !run.endedAt);

  return activeRun?.runId ?? runs[runs.length - 1]?.runId;
}

/**
 * While a queued follow-up is `processing`, the queue strip hides it and the
 * runtime may not have emitted a user message yet — bridge that gap so the
 * second (and later) user turns never disappear from live chat (DF-005A).
 */
function appendProcessingQueuedFollowUpsAsUserMessages(
  projection: SessionProjection,
  messages: LiveMessage[],
): LiveMessage[] {
  const existingUserBodies = new Set(
    messages.filter((message) => message.role === "user").map((message) => message.body),
  );

  const processingFollowUps = projection.queuedMessages.filter(
    (queuedMessage) =>
      queuedMessage.status === "processing" &&
      !existingUserBodies.has(queuedMessage.body),
  );

  if (!processingFollowUps.length) {
    return messages;
  }

  return [
    ...messages,
    ...processingFollowUps.map((queuedMessage) => ({
      id: `queued-processing-${queuedMessage.id}`,
      role: "user" as const,
      body: queuedMessage.body,
      ...(queuedMessage.images?.length
        ? { images: liveImagesFromPrompt(queuedMessage.images) }
        : {}),
    })),
  ];
}

function liveMessagesFromRuntimeModel(
  projection: SessionProjection,
  clockNowMs = Date.now(),
): LiveMessage[] | null {
  if (!runtimeModelIsActive(projection)) {
    return null;
  }

  const model = projection.runtimeModel;
  const streamingAllowed = projection.status === "running" && !projection.stale;
  const messages: LiveMessage[] = [];
  // One answer bubble per Active Run, minted at the Run's first model call and
  // never again: agent-core opens a Message per Turn, but only the Final
  // Answer is addressed to the user — every other Turn's text is Interim
  // Output and belongs in the Chain of Thought (ADR-0030 §7).
  const answeredRunIds = new Set<string>();
  let errorCursor = 0;

  for (const entry of model.order) {
    if (entry.kind === "error") {
      const error = model.errors[errorCursor];

      errorCursor += 1;

      if (error) {
        messages.push({
          id: entry.id,
          role: "assistant",
          ...(error.runId ? { runId: error.runId } : {}),
          body: error.body,
          controlLabel: "Run failed",
        });
      }

      continue;
    }

    if (entry.kind !== "message") {
      continue;
    }

    const message = model.messages.get(entry.id);

    if (!message) {
      continue;
    }

    const runId = message.runId;

    if (!runId || message.role !== "assistant" || message.controlLabel) {
      // Abandoned retry partials are closed boundaries, not answers.
      if (message.abandoned) {
        continue;
      }

      const body = chatTextFromModelMessage(message);
      const images = chatImagesFromModelMessage(message);
      const isStreaming = streamingAllowed && message.phase === "streaming";

      if (!body && !images.length && !message.controlLabel && !isStreaming) {
        continue;
      }

      messages.push({
        id: message.messageId,
        role: message.role,
        body,
        ...(images.length ? { images } : {}),
        ...(message.runId ? { runId: message.runId } : {}),
        ...(message.piEntryId ? { piEntryId: message.piEntryId } : {}),
        ...(message.controlLabel ? { controlLabel: message.controlLabel } : {}),
        ...(isStreaming ? { isStreaming: true } : {}),
      });

      continue;
    }

    if (answeredRunIds.has(runId)) {
      continue;
    }

    answeredRunIds.add(runId);

    const cotView = deriveCotView(model, runId, { streamingAllowed, nowMs: clockNowMs });

    // A run whose every model call was abandoned settles with nothing said,
    // nothing to disclose and nothing measured. Its bubble would be an empty
    // gap above the error bubble that already tells the story.
    if (
      cotView.phase === "settled" &&
      !cotView.steps.length &&
      !cotView.answer &&
      cotView.elapsedMs === undefined
    ) {
      continue;
    }

    messages.push({
      // The Run's first Message anchors the bubble's place in the log; an
      // abandoned one still holds it, so a retry does not reorder the chat.
      id: message.messageId,
      role: "assistant",
      runId,
      body: cotView.answer?.text ?? "",
      // Streaming here means "the Run is still in flight": it gates the
      // incremental renderer and holds the ActionBar back until run(end).
      ...(cotView.phase === "settled" ? {} : { isStreaming: true }),
      cotView,
    });
  }

  const messagesWithPlaceholder = appendModelRunningPlaceholder(
    projection,
    messages,
    clockNowMs,
  );
  const hasInitialPromptMessage = messagesWithPlaceholder.some(
    (message) => message.role === "user" && message.body === projection.initialPrompt,
  );

  const withInitial = hasInitialPromptMessage
    ? messagesWithPlaceholder
    : [
        {
          id: `${projection.id}-initial-prompt`,
          role: "user" as const,
          body: projection.initialPrompt,
        },
        ...messagesWithPlaceholder,
      ];

  return appendProcessingQueuedFollowUpsAsUserMessages(projection, withInitial);
}

/**
 * The wait before the model answers at all. Once a Message opens, the Chain of
 * Thought takes over and says what is happening; until then there is no trace
 * to show, so the wait itself has to be the message (ADR-0030 §5, `hidden`).
 */
function appendModelRunningPlaceholder(
  projection: SessionProjection,
  messages: LiveMessage[],
  clockNowMs: number,
): LiveMessage[] {
  if (projection.status !== "running" || projection.stale) {
    return messages;
  }

  const model = projection.runtimeModel;
  const runId = latestRuntimeModelRunId(model);

  if (!runId) {
    return messages;
  }

  // Scoped to the Run that is actually waiting: an earlier Run's answer says
  // nothing about whether this one has been picked up.
  const runHasModelCall = [...model.messages.values()].some(
    (message) => message.role === "assistant" && message.runId === runId,
  );

  if (runHasModelCall) {
    return messages;
  }

  const latestTimestampMs = Date.parse(model.updatedAt ?? projection.updatedAt);
  const elapsedMs = Number.isFinite(latestTimestampMs)
    ? Math.max(0, clockNowMs - latestTimestampMs)
    : 0;

  return [
    ...messages,
    {
      id: `${projection.id}-running-placeholder`,
      role: "assistant",
      runId,
      body:
        elapsedMs >= modelFirstResponseWatchdogMs
          ? stalledModelResponsePlaceholder
          : contactingModelPlaceholder,
      isStreaming: true,
    },
  ];
}

function liveMessagesFromProjection(
  projection: SessionProjection,
  clockNowMs = Date.now(),
): LiveMessage[] {
  const liveEvents = projection.runtimeEvents
    .filter(isLiveChatRuntimeEvent)
    .reduce<SessionProjection["runtimeEvents"]>((events, event) => {
      const previousEvent = events[events.length - 1];

      if (isAdjacentDuplicateLiveMessageEvent(previousEvent, event)) {
        return [...events.slice(0, -1), event];
      }

      const identity = liveRuntimeMessageIdentity(event);

      if (!identity) {
        return [...events, event];
      }

      const existingIndex = events.findIndex(
        (existingEvent) => liveRuntimeMessageIdentity(existingEvent) === identity,
      );

      if (existingIndex === -1) {
        return [...events, event];
      }

      return events.map((existingEvent, index) =>
        index === existingIndex ? event : existingEvent,
      );
    }, []);
  const projectedMessages = liveEvents
    .map(
      (event): LiveMessage => ({
        id: event.messageId ?? event.id,
        role:
          event.role === "user"
            ? "user"
            : event.role === "assistant"
              ? "assistant"
              : "assistant",
        body: event.body,
        ...(event.images?.length
          ? { images: liveImagesFromPrompt(event.images) }
          : {}),
        ...(event.piEntryId ? { piEntryId: event.piEntryId } : {}),
        controlLabel:
          event.kind === "control" ||
          event.kind === "status" ||
          event.kind === "error"
            ? (event.title ?? "Control")
            : undefined,
      }),
    );
  const collapsedMessages = collapseAssistantRunMessages(projectedMessages);
  const streamingMessageId =
    projection.status === "running" && !projection.stale
      ? [...collapsedMessages]
          .reverse()
          .find(
            (message) =>
              message.role === "assistant" && !message.controlLabel,
          )?.id
      : undefined;
  const visibleMessages = collapsedMessages.map((message) =>
    message.id === streamingMessageId
      ? {
          ...message,
          isStreaming: true,
        }
      : message,
  );
  const messagesWithRunningPlaceholder = appendRunningAssistantPlaceholder(
    projection,
    visibleMessages,
    clockNowMs,
  );
  const hasInitialPromptEvent = projectedMessages.some(
    (message) =>
      message.role === "user" && message.body === projection.initialPrompt,
  );

  const withInitial = hasInitialPromptEvent
    ? messagesWithRunningPlaceholder
    : [
        {
          id: `${projection.id}-initial-prompt`,
          role: "user" as const,
          body: projection.initialPrompt,
        },
        ...messagesWithRunningPlaceholder,
      ];

  return appendProcessingQueuedFollowUpsAsUserMessages(projection, withInitial);
}

function isAssistantAnswerMessage(message: LiveMessage) {
  return message.role === "assistant" && !message.controlLabel;
}

function relatedMessageIdsFor(message: LiveMessage) {
  return message.relatedMessageIds ?? [message.id];
}

// Legacy-fallback only: message boundaries in the runtime-model path come from
// the protocol, so this adjacency heuristic never runs there. Delete together
// with the legacy runtimeEvents pipeline once every bridge speaks the Agent
// Runtime Event Model.
function collapseAssistantRunMessages(messages: LiveMessage[]) {
  return messages.reduce<LiveMessage[]>((collapsedMessages, message) => {
    if (!isAssistantAnswerMessage(message)) {
      return [...collapsedMessages, message];
    }

    const previousMessage = collapsedMessages[collapsedMessages.length - 1];

    if (!previousMessage || !isAssistantAnswerMessage(previousMessage)) {
      return [
        ...collapsedMessages,
        {
          ...message,
          relatedMessageIds: relatedMessageIdsFor(message),
        },
      ];
    }

    return [
      ...collapsedMessages.slice(0, -1),
      {
        ...message,
        relatedMessageIds: [
          ...relatedMessageIdsFor(previousMessage),
          ...relatedMessageIdsFor(message),
        ],
      },
    ];
  }, []);
}

function appendRunningAssistantPlaceholder(
  projection: SessionProjection,
  messages: LiveMessage[],
  clockNowMs: number,
): LiveMessage[] {
  if (projection.status !== "running" || projection.stale) {
    return messages;
  }

  const hasAssistantMessage = messages.some(
    (message) =>
      message.role === "assistant" &&
      !message.controlLabel &&
      message.body.trim().length > 0,
  );

  if (hasAssistantMessage) {
    return messages;
  }

  const traceMessageId = [...projection.runtimeEvents]
    .reverse()
    .find(
      (event) =>
        (event.kind === "thinking" ||
          event.kind === "tool-call" ||
          event.kind === "tool-result") &&
        event.messageId,
    )?.messageId;

  return [
    ...messages,
    {
      id: traceMessageId ?? `${projection.id}-running-placeholder`,
      role: "assistant",
      body: runningAssistantPlaceholderBody(projection, clockNowMs),
      isStreaming: true,
    },
  ];
}

function runningAssistantPlaceholderBody(
  projection: SessionProjection,
  clockNowMs: number,
) {
  const hasModelActivity = projection.runtimeEvents.some(
    (event) =>
      event.kind === "thinking" ||
      event.kind === "tool-call" ||
      event.kind === "tool-result" ||
      (event.kind === "message" && event.role === "assistant"),
  );

  if (hasModelActivity) {
    return "";
  }

  const latestRuntimeTimestamp =
    projection.runtimeEvents[projection.runtimeEvents.length - 1]?.timestamp ??
    projection.updatedAt;
  const latestRuntimeTimeMs = Date.parse(latestRuntimeTimestamp);
  const elapsedMs = Number.isFinite(latestRuntimeTimeMs)
    ? Math.max(0, clockNowMs - latestRuntimeTimeMs)
    : 0;

  return elapsedMs >= modelFirstResponseWatchdogMs
    ? stalledModelResponsePlaceholder
    : contactingModelPlaceholder;
}

function isLiveChatRuntimeEvent(
  event: SessionProjection["runtimeEvents"][number],
) {
  return (
    ((event.kind === "message" || event.kind === "control") &&
      (event.role === "user" || event.role === "assistant")) ||
    event.kind === "error"
  );
}

function liveRuntimeMessageIdentity(
  event: SessionProjection["runtimeEvents"][number],
) {
  if (event.kind !== "message" || !event.messageId) {
    return null;
  }

  return `${event.piSessionId}\u0000${event.messageId}`;
}

function isAdjacentDuplicateLiveMessageEvent(
  previousEvent: SessionProjection["runtimeEvents"][number] | undefined,
  event: SessionProjection["runtimeEvents"][number],
) {
  return (
    previousEvent?.kind === "message" &&
    event.kind === "message" &&
    previousEvent.piSessionId === event.piSessionId &&
    previousEvent.role === "assistant" &&
    event.role === "assistant" &&
    previousEvent.body.trim() !== "" &&
    previousEvent.body === event.body
  );
}

function runTimelineFromProjection(
  projection: SessionProjection,
): RunTimelineItem[] {
  const items: RunTimelineItem[] = [];
  const toolItemIndexes = new Map<string, number>();
  const toolCallTimestamps = new Map<string, string>();

  for (const event of projection.runtimeEvents) {
    if (event.kind === "thinking") {
      items.push({
        id: event.id,
        kind: "thinking",
        title: "Thinking",
        meta: event.body,
        messageId: event.messageId,
      });
      continue;
    }

    if (event.kind !== "tool-call" && event.kind !== "tool-result") {
      continue;
    }

    const toolName = event.title ?? "Tool";
    const toolIdentity = event.toolCallId ?? event.id;
    const existingIndex = toolItemIndexes.get(toolIdentity);

    if (event.kind === "tool-call" && !toolCallTimestamps.has(toolIdentity)) {
      toolCallTimestamps.set(toolIdentity, event.timestamp);
    }

    if (existingIndex === undefined) {
      const item: RunTimelineItem = {
        id: event.id,
        kind: "tool",
        title: `Tool: ${toolName}`,
        meta: event.body,
        messageId: event.messageId,
        toolCallId: event.toolCallId,
        toolName,
        toolState:
          event.kind === "tool-result" ? "output-available" : "input-available",
        argsText: event.kind === "tool-call" ? event.body : undefined,
        outputText: event.kind === "tool-result" ? event.body : undefined,
      };

      toolItemIndexes.set(toolIdentity, items.length);
      items.push(item);
      continue;
    }

    const existingItem = items[existingIndex];
    const callTimestamp = toolCallTimestamps.get(toolIdentity);
    const durationMs =
      event.kind === "tool-result" && callTimestamp
        ? Date.parse(event.timestamp) - Date.parse(callTimestamp)
        : undefined;

    items[existingIndex] = {
      ...existingItem,
      id: `${existingItem.id}:${event.id}`,
      messageId: existingItem.messageId ?? event.messageId,
      toolCallId: existingItem.toolCallId ?? event.toolCallId,
      toolName: existingItem.toolName ?? toolName,
      toolState:
        event.kind === "tool-result" ? "output-available" : existingItem.toolState,
      argsText:
        event.kind === "tool-call" ? event.body : existingItem.argsText,
      outputText:
        event.kind === "tool-result" ? event.body : existingItem.outputText,
      meta: event.kind === "tool-result" ? event.body : existingItem.meta,
      ...(durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0
        ? { durationMs }
        : {}),
    };
  }

  return items;
}

function isReadOnlyProjection(projection: SessionProjection | null) {
  return Boolean(projection && isSessionProjectionArchived(projection));
}

function isRuntimeUnavailableProjection(projection: SessionProjection | null) {
  return Boolean(projection?.stale);
}

const SESSION_DRAFT_SUGGESTED_PROMPTS = [
  {
    Icon: LayoutAlignLeft,
    id: "launch-page",
    label: "Design a launch page",
    prompt: "Design a launch page",
  },
  {
    Icon: ListTree,
    id: "meeting-notes",
    label: "Summarize meeting notes",
    prompt: "Summarize meeting notes",
  },
  {
    Icon: Sparkles,
    id: "sound-brief",
    label: "Generate a sound brief",
    prompt: "Generate a sound brief",
  },
  {
    Icon: Box,
    id: "data-model",
    label: "Plan a data model",
    prompt: "Plan a data model",
  },
] as const;

function createSessionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `session-${crypto.randomUUID()}`;
  }

  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function ProjectPicker({
  projects,
  selectedProjectId,
  onProjectChange,
  error,
}: {
  projects: ProjectRegistryEntry[];
  selectedProjectId: string | null;
  onProjectChange: (projectId: string | null) => void;
  error?: boolean;
}) {
  const selectedProject = isChatProjectId(selectedProjectId)
    ? chatWorkspaceListEntry()
    : projects.find((project) => project.id === selectedProjectId);
  const selectedPickerKey = selectedProject?.id;
  const StartIcon = isChatProjectId(selectedProjectId) ? ChatAdd : FolderClosed;

  return (
    <div className="max-w-full" data-testid="project-picker">
      <Selector
        data-testid="project-picker-trigger"
        isLabelHidden
        label="Project"
        placeholder="Choose a project"
        placement="below"
        status={error ? { type: "error", message: "Choose a project or select No project to continue." } : undefined}
        options={[
          {
            value: CHAT_PROJECT_ID,
            label: CHAT_PICKER_LABEL,
            icon: (
              <ChatAdd
                aria-hidden="true"
                className="pigui-compact-menu-item-icon text-muted"
              />
            ),
          },
          ...projects.map((project) => ({
            value: project.id,
            label: project.displayName,
            icon: (
              <FolderClosed
                aria-hidden="true"
                className="pigui-compact-menu-item-icon text-muted"
              />
            ),
          })),
        ]}
        size="sm"
        startIcon={
          <StartIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted"
            data-testid="project-picker-folder-icon"
          />
        }
        value={selectedPickerKey}
        variant="ghost"
        onChange={(value) => {
          onProjectChange(value);
        }}
      />
    </div>
  );
}

function gitBranchPickerLabel(input: {
  branch: string | null;
  detached: boolean;
  oid: string | null;
}) {
  if (input.branch) {
    return input.branch;
  }

  // Detached HEAD has no branch name; the short oid is the only identity.
  if (input.detached) {
    return input.oid ? input.oid.slice(0, 7) : "HEAD";
  }

  return null;
}

function gitBranchPickerLabelFromChanges(changes: SessionChanges | null) {
  if (!changes || changes.state === "non-git") {
    return null;
  }

  return gitBranchPickerLabel({
    branch: changes.head?.branch ?? null,
    detached: changes.head?.detached ?? false,
    oid: changes.head?.oid ?? null,
  });
}

function checkoutPathLabel(path: string) {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

function occupiedBranchHint(path: string) {
  return `Already checked out in ${checkoutPathLabel(path)}`;
}

function gitBranchPickerOptions(
  branch: string,
  branches: string[],
  occupiedBranches: Array<{ branch: string; path: string }>,
) {
  const occupied = new Map(
    occupiedBranches.map((item) => [item.branch, item.path]),
  );
  const names = [branch, ...branches.filter((name) => name !== branch)];

  return names.map((name) => ({
    value: name,
    label: name,
    disabled: occupied.has(name),
  }));
}

/**
 * Live-composer counterpart of ProjectPicker's ghost chip, with the searchable
 * menu chrome of ModelSelectorControl: `gap-1 p-1` around the field and list,
 * balanced rows so names are not flush against the popover edge. Selecting a
 * remote-only name creates a local tracking branch; occupied worktrees stay
 * visible but unselectable.
 */
function GitBranchPicker({
  branch,
  branches,
  occupiedBranches,
  onBranchChange,
}: {
  branch: string;
  branches: string[];
  occupiedBranches: Array<{ branch: string; path: string }>;
  onBranchChange: (branch: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const options = gitBranchPickerOptions(branch, branches, occupiedBranches);
  const needle = query.trim().toLowerCase();
  const listed = needle
    ? options.filter((option) => option.label.toLowerCase().includes(needle))
    : options;

  return (
    <div className="min-w-0 max-w-full" data-testid="git-branch-status">
      <Popover
        alignment="start"
        isOpen={isOpen}
        label="Git branch"
        placement="above"
        content={
          <div
            className="flex w-full flex-col gap-1 p-1"
            data-testid="git-branch-status-menu"
          >
            <TextInput
              isLabelHidden
              label="Search branches"
              placeholder="Search branches..."
              size="sm"
              value={query}
              width="100%"
              onChange={setQuery}
            />
            <List
              aria-label="Git branch"
              className="max-h-72 overflow-y-auto"
              density="balanced"
            >
              {listed.map((option) => {
                const occupied = occupiedBranches.find(
                  (item) => item.branch === option.value,
                );
                return (
                  <ListItem
                    description={
                      occupied ? occupiedBranchHint(occupied.path) : undefined
                    }
                    endContent={
                      option.value === branch ? (
                        <Check aria-hidden="true" className="size-4 shrink-0" />
                      ) : undefined
                    }
                    isDisabled={option.disabled}
                    isSelected={option.value === branch}
                    key={option.value}
                    label={option.label}
                    role="option"
                    startContent={
                      <GitBranch
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted"
                      />
                    }
                    onClick={() => {
                      if (option.disabled || option.value === branch) {
                        return;
                      }

                      onBranchChange(option.value);
                      setIsOpen(false);
                      setQuery("");
                    }}
                  />
                );
              })}
            </List>
          </div>
        }
        onOpenChange={(open) => {
          setIsOpen(open);
          if (!open) {
            setQuery("");
          }
        }}
      >
        <Button
          className="min-w-0 max-w-full flex-nowrap gap-1.5 px-2 text-muted"
          data-testid="git-branch-status-trigger"
          label="Git branch"
          size="sm"
          variant="ghost"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <GitBranch
              aria-hidden="true"
              className="size-4 shrink-0"
              data-testid="git-branch-status-icon"
            />
            <span className="truncate">{branch}</span>
            <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
          </span>
        </Button>
      </Popover>
    </div>
  );
}

const checkoutModeLabels: Record<SessionDraftCheckoutMode, string> = {
  local: "Project folder",
  worktree: "Git worktree",
};

function checkoutModeToExecutionMode(
  checkoutMode: SessionDraftCheckoutMode,
): CreateSessionFromDraftInput["executionMode"] {
  return checkoutMode === "worktree" ? "background" : "foreground";
}

function CheckoutStrategyPicker({
  selectedCheckoutMode,
  onCheckoutModeChange,
}: {
  selectedCheckoutMode: SessionDraftCheckoutMode;
  onCheckoutModeChange: (checkoutMode: SessionDraftCheckoutMode) => void;
}) {
  return (
    <div className="max-w-full" data-testid="checkout-strategy-picker">
      <Selector
        data-testid="checkout-strategy-trigger"
        isLabelHidden
        label="Where to work"
        placement="below"
        renderOption={(option) => (
          <SelectorOption label={option.label} icon={option.icon}
            description={option.value === "local"
              ? "Edit files directly in the selected project."
              : "Create a separate Git worktree for this chat."} />
        )}
        options={[
          {
            value: "local",
            label: checkoutModeLabels.local,
            icon: (
              <Computer
                aria-hidden="true"
                className="pigui-compact-menu-item-icon text-muted"
                data-testid="checkout-strategy-local-icon"
              />
            ),
          },
          {
            value: "worktree",
            label: checkoutModeLabels.worktree,
            icon: (
              <GitBranch
                aria-hidden="true"
                className="pigui-compact-menu-item-icon text-muted"
              />
            ),
          },
        ]}
        size="sm"
        startIcon={
          selectedCheckoutMode === "worktree" ? (
            <GitBranch aria-hidden="true" className="size-4 shrink-0 text-muted" />
          ) : (
            <Computer
              aria-hidden="true"
              className="size-4 shrink-0 text-muted"
              data-testid="checkout-strategy-local-icon"
            />
          )
        }
        value={selectedCheckoutMode}
        variant="ghost"
        onChange={(value) => {
          onCheckoutModeChange(value === "worktree" ? "worktree" : "local");
        }}
      />
    </div>
  );
}

/**
 * Mirrors `--duration-medium` (410ms): how long the Live Session keeps the
 * handoff attributes after leaving the draft, so the transform never outlives
 * the transition (docs/design/typography-motion.md rule 2).
 */
const draftHandoffMs = 410;

function SessionCreationFailureDetail({
  failure,
  action,
}: {
  failure: NonNullable<SessionProjection["failure"]>;
  action?: ReactNode;
}) {
  return (
    <>
      <p className="font-medium text-foreground">Session creation failed</p>
      <dl className="mt-2 grid gap-1">
        <div className="flex items-center gap-2">
          <dt className="text-muted">Stage</dt>
          <dd className="font-medium text-foreground">{failure.stage}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="text-muted">Error</dt>
          <dd className="text-foreground">{failure.message}</dd>
        </div>
      </dl>
      {action ? <div className="mt-3">{action}</div> : null}
    </>
  );
}

function SessionDraftComposer({
  draft,
  projects,
  creationProjection,
  recommendedCheckoutMode,
  onDraftChange,
  onDraftCheckoutModeChange,
  onDraftTargetChange,
  onDraftSubmit,
  onManageModels,
}: {
  draft: SessionDraft;
  projects: ProjectRegistryEntry[];
  creationProjection: SessionProjection | null;
  recommendedCheckoutMode: SessionDraftCheckoutMode;
  onDraftChange: (prompt: string) => void;
  onDraftCheckoutModeChange: (checkoutMode: SessionDraftCheckoutMode) => void;
  onDraftTargetChange: (projectId: string | null) => void;
  onDraftSubmit: (event: SessionDraftSubmitEvent) => void;
  onManageModels?: () => void;
}) {
  const [targetValidationRequested, setTargetValidationRequested] = useState(false);
  const targetError = targetValidationRequested && !draft.projectId;
  const draftInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [visibleModels] = useState(getVisibleModels);
  const selectedCheckoutMode = draft.checkoutMode ?? recommendedCheckoutMode;
  const { loading: providerAuthLoading, configured: providersConfigured } =
    useProviderAuthStatus();
  const [draftModelControls, setDraftModelControls] =
    useState<RuntimeModelControls | null>(null);
  const sessionProjectionsStore = useSessionProjectionsOptional();
  const recentSessionModel = mostRecentSessionModelSelection(
    sessionProjectionsStore?.sessionProjections ?? [],
  );
  const recentSessionModelKey = recentSessionModel
    ? `${recentSessionModel.provider}:${recentSessionModel.modelId}:${recentSessionModel.thinkingLevel}`
    : "";
  const attachments = useComposerAttachments();
  const catalog = useComposerInsertCatalog();
  const picker = useFilePicker(attachments.addFiles);

  useEffect(() => {
    if (providerAuthLoading || !providersConfigured) {
      setDraftModelControls(null);
      return;
    }

    let cancelled = false;

    void invoke<RuntimeModelControls>("list_available_model_controls")
      .then((controls) => {
        if (!cancelled) {
          setDraftModelControls(
            overlayPreferredModel(controls, [
              getLastModelSelection(),
              recentSessionModel,
            ]),
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDraftModelControls(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [providerAuthLoading, providersConfigured, recentSessionModelKey]);

  const applySuggestedPrompt = (prompt: string) => {
    onDraftChange(prompt);
    draftInputRef.current?.focus();
    draftInputRef.current?.setSelectionRange(prompt.length, prompt.length);
  };
  const submitDraft = async () => {
    if (!providerAuthLoading && !providersConfigured) {
      return;
    }

    if (!draft.projectId) {
      setTargetValidationRequested(true);
      return;
    }

    const built = await buildPromptWithAttachments(
      draft.prompt,
      attachments.items,
    );

    if (!built.ok) {
      attachments.setError(built.error);
      return;
    }

    onDraftSubmit({
      projectId: draft.projectId,
      prompt: built.prompt,
      checkoutMode: selectedCheckoutMode,
      ...(built.images.length ? { images: built.images } : {}),
      ...(draftModelControls?.selected
        ? { modelSelection: draftModelControls.selected }
        : {}),
    });
    attachments.clear();
  };

  if (!providerAuthLoading && !providersConfigured) {
    return (
      <section
        className="flex h-full min-h-0 flex-col items-center justify-center px-6 py-8"
        data-testid="session-draft-composer"
      >
        <NoProvidersEmptyState testId="session-draft-no-models-gate" />
      </section>
    );
  }

  return (
    <section
      className="flex h-full min-h-0 flex-col items-center justify-center px-6 py-8"
      data-testid="session-draft-composer"
    >
      <div
        className="flex w-full max-w-[46rem] flex-col items-center justify-center gap-6"
        data-testid="session-draft-empty-state"
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="text-center text-3xl font-normal tracking-tight text-foreground">
            Build something useful with{" "}
            <span className="text-muted">
              <TextShimmer>Pace</TextShimmer>
            </span>
          </h2>
        </div>
        <div className="flex w-full flex-col gap-3">
          <PromptInput
            className="w-full"
            drawer={
              <ComposerAttachmentDrawer
                items={attachments.items}
                onRemove={attachments.remove}
              />
            }
            error={attachments.error}
            hasAttachments={attachments.items.length > 0}
            inputRef={draftInputRef}
            placeholder="Do anything with Pi"
            startActions={
              <>
                {picker.input}
                <ComposerInsertMenu
                  plugins={catalog.plugins}
                  skills={catalog.skills}
                  onAttach={picker.open}
                  onInsert={(text) =>
                    onDraftChange(insertIntoDraft(draft.prompt, text))
                  }
                />
                {draftModelControls?.selected ? (
                  <ModelSelectorControl
                    controls={draftModelControls}
                    isDisabled={false}
                    visibleModels={visibleModels}
                    onManageModels={onManageModels}
                    onChange={(selection) => {
                      saveLastModelSelection(selection);
                      setDraftModelControls((current) =>
                        current
                          ? {
                              ...current,
                              selected: selection,
                            }
                          : current,
                      );
                    }}
                  />
                ) : null}
              </>
            }
            value={draft.prompt}
            onFiles={attachments.addFiles}
            onSubmit={submitDraft}
            onValueChange={onDraftChange}
          />
          <div
            className="flex w-full flex-wrap justify-start gap-2"
            data-testid="session-draft-project-picker"
          >
            <ProjectPicker
              error={targetError}
              projects={projects}
              selectedProjectId={draft.projectId}
              onProjectChange={(projectId) => {
                onDraftTargetChange(projectId);
              }}
            />
            {!draft.projectId || isChatProjectId(draft.projectId) ? null : (
              <CheckoutStrategyPicker
                selectedCheckoutMode={selectedCheckoutMode}
                onCheckoutModeChange={onDraftCheckoutModeChange}
              />
            )}
          </div>
          {creationProjection ? (
            <div
              aria-live="polite"
              className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
              data-testid="session-creation-status"
            >
              {creationProjection.failure ? (
                <SessionCreationFailureDetail failure={creationProjection.failure} />
              ) : (
                <p className="font-medium text-foreground">
                  {creationProjection.creationStage}
                </p>
              )}
            </div>
          ) : null}
        </div>
        <PromptSuggestion className="w-full max-w-[35rem]">
          <PromptSuggestion.Items className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {SESSION_DRAFT_SUGGESTED_PROMPTS.map(({ Icon, id, label, prompt }) => (
              <PromptSuggestion.Item
                key={id}
                className="items-center justify-start"
                showEndIcon={false}
                onPress={() => applySuggestedPrompt(prompt)}
              >
                <span className="inline-flex min-w-0 items-center gap-2">
                  <Icon
                    aria-hidden="true"
                    className="size-4 shrink-0"
                    data-testid="session-draft-suggestion-icon"
                  />
                  <span className="truncate">{label}</span>
                </span>
              </PromptSuggestion.Item>
            ))}
          </PromptSuggestion.Items>
        </PromptSuggestion>
      </div>
    </section>
  );
}

function checkoutModeLabel(mode: string) {
  if (mode === "foreground-local") {
    return "Foreground local checkout";
  }

  if (mode === "managed-worktree") {
    return "Pace-managed worktree";
  }

  return mode;
}

function changeKindLabel(kind: SessionChangedFile["kind"]) {
  switch (kind) {
    case "type-changed":
      return "Type changed";
    case "conflicted":
      return "Conflict";
    default:
      return `${kind[0]?.toUpperCase()}${kind.slice(1)}`;
  }
}

function changeStageLabel(file: SessionChangedFile) {
  if (file.kind === "untracked") return "Working tree";
  if (file.staged && file.unstaged) return "Staged + unstaged";
  if (file.staged) return "Staged";
  return "Working tree";
}

/**
 * One line of working-tree state for the Changes bar, or nothing when there is
 * none to state. A failed read says nothing here: the alert below already
 * carries the message, and a stale count beside it would contradict it.
 */
function sessionChangesStatus({
  changes,
  error,
  loading,
}: Pick<SessionChangesPanelProps, "changes" | "error" | "loading">): ReactNode {
  if (error) {
    return null;
  }

  if (!changes) {
    return loading ? "Loading…" : null;
  }

  if (changes.state === "non-git") {
    return "Not a Git repository";
  }

  // Same predicate the file list below uses, so the row and the list can never
  // disagree about whether there is anything to review.
  if (changes.state === "clean" || changes.files.length === 0) {
    return "Working tree clean";
  }

  return (
    <>
      {changes.totals.files} files ·{" "}
      <span className="text-success">+{changes.totals.additions}</span>{" "}
      <span className="text-danger">-{changes.totals.deletions}</span>
    </>
  );
}

export function SessionChangesPanel({
  sessionId,
  target,
  stale,
  changes,
  error,
  loading,
  onRefresh,
}: SessionChangesPanelProps) {
  // Fold state is the set of *closed* paths: a file the reviewer has not
  // touched is open, so a fresh read (new files included) needs no
  // bookkeeping to come up expanded, and only explicit folds are remembered.
  const [closedPaths, setClosedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const sectionRefs = useRef(new Map<string, HTMLDivElement>());

  // Another Session is another review; its folds start from scratch.
  useEffect(() => {
    setClosedPaths(new Set());
    setCurrentPath(null);
  }, [sessionId]);

  // Each read yields a new object; keep folds for files that survived and let
  // the rest go so a path that comes back later is open again.
  useEffect(() => {
    if (!changes) return;

    const present = new Set(changes.files.map((file) => file.path));
    setClosedPaths((current) => {
      const next = new Set([...current].filter((path) => present.has(path)));
      return next.size === current.size ? current : next;
    });
    setCurrentPath((current) =>
      current !== null && present.has(current) ? current : null,
    );
  }, [changes]);

  const files = changes?.files ?? [];
  const openPaths = files
    .map((file) => file.path)
    .filter((path) => !closedPaths.has(path));
  const anyOpen = openPaths.length > 0;

  const toggleAll = () => {
    setClosedPaths(anyOpen ? new Set(files.map((file) => file.path)) : new Set());
  };

  const navigateTo = useCallback((path: string) => {
    setClosedPaths((current) => {
      if (!current.has(path)) return current;
      const next = new Set(current);
      next.delete(path);
      return next;
    });
    setCurrentPath(path);
    // The section root stays mounted while folded, so it can be scrolled to
    // before React has re-rendered the expanded body. jsdom has no
    // scrollIntoView, hence the optional call.
    const section = sectionRefs.current.get(path);
    section?.scrollIntoView?.({ block: "start" });
    // Continue keyboard navigation from the diff after an outline jump.
    section?.querySelector("button")?.focus({ preventScroll: true });
  }, []);

  const status = sessionChangesStatus({ changes, error, loading });
  const hasReview =
    Boolean(sessionId) &&
    !error &&
    changes?.state === "ready" &&
    files.length > 0;

  useEffect(() => {
    if (hasReview && target?.sessionId === sessionId) navigateTo(target.path);
  }, [hasReview, target, sessionId, navigateTo]);

  return (
    <section aria-label="Session changes" className="flex h-full min-h-0 flex-col">
      {/* The surface's first row (ADR-0028): working-tree state on the left,
          actions on the right — the slot Session-scoped checkout / commit /
          push actions (ADR-0008) will land in. A Session without a checkout
          has neither, so it gets no band at all. */}
      {sessionId ? (
        <SessionSurfaceBar
          actions={
            <>
              {hasReview ? (
                <>
                  <Button
                    className="pigui-pressable"
                    label={anyOpen ? "Collapse all" : "Expand all"}
                    size="sm"
                    variant="ghost"
                    onClick={toggleAll}
                  />
                </>
              ) : null}
              <IconButton
                className="pigui-pressable"
                icon={<RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />}
                isDisabled={loading}
                label="Refresh Session changes"
                size="sm"
                tooltip="Refresh changes"
                variant="ghost"
                onClick={onRefresh}
              />
            </>
          }
        >
          {status ? (
            <p className="min-w-0 truncate text-xs text-muted">{status}</p>
          ) : null}
        </SessionSurfaceBar>
      ) : null}

      {/* Keep scrolling and size containment below the window's header band.
          The bar must stay in the root stacking context above its drag region. */}
      <div className="@container/changes flex min-h-0 flex-1 flex-col overflow-hidden">
        {stale ? (
          <p className="mt-3 bg-warning/5 px-3 py-2 text-sm text-foreground">
            Runtime state is stale. This diff is fresh, but the Session status may be outdated.
          </p>
        ) : null}

        {!sessionId ? (
          <EmptyState
            className="flex-1 justify-center px-4"
            title="No changes to review"
            description="Start a session in a project to review its file changes here."
            icon={<FileDiff className="size-5 text-muted" />}
            isCompact
          />
        ) : loading && !changes ? (
          <div className="mt-3 grid gap-2" aria-label="Loading Session changes">
            <div className="h-8 animate-pulse motion-reduce:animate-none bg-default/40" />
            <div className="h-24 animate-pulse motion-reduce:animate-none bg-default/30" />
          </div>
        ) : error ? (
          <div
            className="mt-3 bg-danger/5 px-3 py-3"
            role="alert"
          >
            <p className="text-sm text-danger">{error}</p>
            <Button
              className="mt-3"
              label="Retry"
              size="sm"
              variant="secondary"
              onClick={onRefresh}
            />
          </div>
        ) : changes?.state === "non-git" ? (
          <EmptyState
            className="flex-1 justify-center px-4"
            title="No Git repository"
            description="This session’s working directory is not a Git repository. File changes appear here for Git projects."
            icon={<FileDiff className="size-5 text-muted" />}
            isCompact
          />
        ) : changes?.state === "clean" || !changes?.files.length ? (
          <EmptyState
            className="flex-1 justify-center px-4"
            title="No changes yet"
            description="Your working tree is clean. Staged, unstaged, and new files will appear here as you work."
            icon={<FileDiff className="size-5 text-muted" />}
            isCompact
          />
        ) : (
          <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_min(40%,13rem)] grid-rows-[minmax(0,1fr)]">
            {/* Every diff, top to bottom: the reviewer scrolls instead of
                switching. Each section is one file; a folded one drops its
                viewer so a wide tree never keeps hundreds of renderers alive. */}
            <CollapsibleGroup
              className="min-h-0 min-w-0 overflow-y-auto overscroll-contain bg-surface"
              density="compact"
              hasDividers
              type="multiple"
              value={openPaths}
              onChange={(value) => {
                const open = new Set(Array.isArray(value) ? value : [value]);
                setClosedPaths(
                  new Set(
                    files.map((file) => file.path).filter((path) => !open.has(path)),
                  ),
                );
              }}
            >
              {changes.files.map((file) => {
                const isOpen = !closedPaths.has(file.path);

                return (
                  <Collapsible
                    key={`${file.previousPath ?? ""}:${file.path}`}
                    className="pigui-change-section shrink-0"
                    data-testid="session-change-section"
                    ref={(node) => {
                      if (node) sectionRefs.current.set(file.path, node);
                      else sectionRefs.current.delete(file.path);
                    }}
                    trigger={
                      <span className="flex w-full min-w-0 items-center gap-3 text-left">
                        <span
                          className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
                          title={file.path}
                        >
                          {file.path}
                        </span>
                        <span
                          className="hidden min-w-0 shrink truncate text-xs text-muted @sm/changes:inline"
                          title={changeStageLabel(file)}
                        >
                          {changeKindLabel(file.kind)} · {changeStageLabel(file)}
                        </span>
                        <ChangeCounts file={file} />
                      </span>
                    }
                    value={file.path}
                  >
                    {isOpen ? (
                      <>
                        {file.kind === "conflicted" ? (
                          <p className="bg-warning/5 px-3 py-3 text-sm text-foreground">
                            This file has unresolved merge conflicts. Resolve it in the
                            checkout before reviewing a normal patch.
                          </p>
                        ) : file.binary ? (
                          <EmptyState
                            className="px-4 py-6"
                            title="Diff unavailable"
                            description="Binary file changed. A textual diff is not available."
                            icon={<FileDiff className="size-5 text-muted" />}
                            isCompact
                          />
                        ) : file.patchTruncated ? (
                          <p className="bg-warning/5 px-3 py-3 text-sm text-foreground">
                            This patch exceeds the review limit and was omitted. Open the
                            checkout for the full diff.
                          </p>
                        ) : file.patch ? (
                          <Suspense
                            fallback={
                              <div
                                className="h-40 animate-pulse motion-reduce:animate-none bg-default/30"
                                aria-label="Loading diff renderer"
                              />
                            }
                          >
                            <SessionDiffViewer
                              cacheKey={`${changes.sessionId}:${changes.generatedAt}:${file.path}`}
                              patch={file.patch}
                              line={target?.sessionId === sessionId && target.path === file.path ? target.line : undefined}
                              style="unified"
                            />
                          </Suspense>
                        ) : (
                          <EmptyState
                            className="px-4 py-6"
                            title="No textual changes"
                            description="No textual patch is available for this file."
                            icon={<FileDiff className="size-5 text-muted" />}
                            isCompact
                          />
                        )}
                      </>
                    ) : null}
                  </Collapsible>
                );
              })}
            </CollapsibleGroup>

            {/* Both columns own their scroll position, including in narrow docks. */}
            <nav
              aria-label="Changed files"
              className="flex min-h-0 min-w-0 flex-col border-l border-separator bg-surface"
            >
              <p className="shrink-0 px-2 py-1 text-xs font-medium text-muted">
                {changes.files.length} files
              </p>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                {changes.files.map((file) => (
                  <button
                    key={`${file.previousPath ?? ""}:${file.path}`}
                    data-current={file.path === currentPath ? "true" : undefined}
                    className={`w-full min-w-0 px-2 py-1.5 text-left transition-colors ${
                      file.path === currentPath
                        ? "bg-default/70 text-foreground"
                        : "text-muted hover:bg-default/40 hover:text-foreground"
                    }`}
                    type="button"
                    onClick={() => navigateTo(file.path)}
                  >
                    <span className="block truncate text-sm" title={file.path}>
                      {file.path}
                    </span>
                    <span className="mt-0.5 flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate" title={changeStageLabel(file)}>
                        {changeKindLabel(file.kind)} · {changeStageLabel(file)}
                      </span>
                      <ChangeCounts file={file} />
                    </span>
                  </button>
                ))}
              </div>
            </nav>
          </div>
        )}
        {hasReview && changes?.truncated ? (
          <p className="shrink-0 bg-warning/5 px-3 py-2 text-sm text-foreground">
            Review is bounded. {changes.omittedFileCount > 0
              ? `${changes.omittedFileCount} additional files were omitted.`
              : "One or more oversized patches were omitted."}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** The +A −D tail of a file row, or what stands in for it. */
function ChangeCounts({ file }: { file: SessionChangedFile }) {
  if (file.kind === "conflicted") {
    return <span className="shrink-0 text-xs">Resolve</span>;
  }
  if (file.binary) {
    return <span className="shrink-0 text-xs">Binary</span>;
  }
  return (
    <span className="shrink-0 text-xs">
      <span className="text-success">+{file.additions ?? 0}</span>{" "}
      <span className="text-danger">-{file.deletions ?? 0}</span>
    </span>
  );
}

/** Renders the active surface inside the shared dock panel. */
function SessionSurfaceContent({
  surfaceId,
  projection,
  changeTarget,
  sessionChanges,
  docked = false,
  onTerminalInstancesChange,
  onBrowserInstancesChange,
}: {
  surfaceId: SessionSurfaceId;
  projection?: SessionProjection | null;
  changeTarget?: SessionChangeTarget | null;
  sessionChanges: SessionChangesView;
  /** Whether the surface can host a native browser view. */
  docked?: boolean;
  onTerminalInstancesChange?: (instances: TerminalInstanceInfo[]) => void;
  onBrowserInstancesChange?: (instances: import("@/shared/browser-protocol").BrowserTabState[]) => void;
}) {

  if (surfaceId === "changes") {
    return (
      <SessionChangesPanel
        target={changeTarget}
        changes={sessionChanges.changes}
        error={sessionChanges.error}
        loading={sessionChanges.loading}
        sessionId={projection?.id ?? null}
        stale={projection?.stale ?? false}
        onRefresh={sessionChanges.refresh}
      />
    );
  }

  if (surfaceId === "files") {
    // No projection means no checkout, so there is no tree to browse.
    if (!projection) {
      return null;
    }

    return <SessionFilesPanel sessionId={projection.id} />;
  }

  if (surfaceId === "terminal") {
    // No projection means no checkout, so there is nothing to host a shell in.
    if (!projection) {
      return null;
    }

    return (
      <SessionTerminalPanel
        sessionId={projection.id}
        onInstancesChange={onTerminalInstancesChange}
      />
    );
  }

  if (surfaceId === "browser") {
    // The remembered preview URL is keyed by Project, so a Session without a
    // projection has nothing to restore.
    if (!projection) {
      return null;
    }

    return (
      <SessionBrowserPanel
        docked={docked}
        projectId={projection.projectId}
        sessionId={projection.id}
        onInstancesChange={onBrowserInstancesChange}
      />
    );
  }

  return null;
}


function isRestorablePiRuntimeBridge(
  bridge: PiRuntimeBridge,
): bridge is RestorablePiRuntimeBridge {
  return (
    "restoreSessionState" in bridge &&
    typeof bridge.restoreSessionState === "function"
  );
}

function runtimeStateStatusFromProjection(
  projection: SessionProjection,
): PiSessionState["status"] {
  switch (projection.status) {
    case "failed":
      return "failed";
    case "completed":
    case "archived":
      return "completed";
    case "waiting":
      return "idle";
    case "creating":
    case "running":
      return "running";
  }
}

function messageFromError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Pi could not stop the active run.";
}

function historyLoadErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Pace could not load session history.";
}

async function restoreProjectionRuntimeState(input: {
  bridge: PiRuntimeBridge;
  projection: SessionProjection;
  workspace: AgentWorkspaceFixture;
}) {
  const { bridge, projection, workspace } = input;

  if (
    !projection.piSessionId ||
    !projection.runtimeId ||
    !isRestorablePiRuntimeBridge(bridge)
  ) {
    return;
  }

  await bridge.restoreSessionState({
    piSessionId: projection.piSessionId,
    runtimeId: projection.runtimeId,
    projectId: projection.projectId,
    cwd: projection.checkout?.runtimeCwd ?? workspace.checkout.runtimeCwd,
    status: runtimeStateStatusFromProjection(projection),
    events: projection.runtimeEvents,
    summary: projection.summary,
    updatedAt: projection.updatedAt,
  });
}

export function SessionToolbarActions({
  dockOpen = false,
  onDockOpenChange = () => {},
}: {
  dockOpen?: boolean;
  onDockOpenChange?: (isOpen: boolean) => void;
}) {
  return <SessionDockTrigger alignToRail isOpen={dockOpen} onOpenChange={onDockOpenChange} />;
}

function LiveSessionColumn({
  workspace,
  projectId,
  showDraft,
  onDraftSubmit,
  onSessionCreationStarted,
  onSessionCreated,
  onReopenDraft,
  sessionCreator,
  checkoutManager,
  getRuntimeBridge,
  recommendedCheckoutMode,
  sessionProjection,
  sessionChanges,
  clockNowMs,
  onProjectionChange,
  onLatestMessageRendered,
  onManageModels,
  onOpenProviderSettings,
  runtimeGeneration,
}: {
  workspace: AgentWorkspaceFixture;
  projectId: string;
  showDraft: boolean;
  onDraftSubmit: (event: SessionDraftSubmitEvent) => void;
  /** The `creating` projection exists; the view can leave the draft now. */
  onSessionCreationStarted?: (projection: SessionProjection) => void;
  onSessionCreated?: (projection: SessionProjection) => void;
  /** Return to the kept Session Draft after a failed creation. */
  onReopenDraft?: (projection: SessionProjection) => void;
  sessionCreator: SessionCreator;
  checkoutManager: ExecutionCheckoutManager;
  getRuntimeBridge: () => PiRuntimeBridge;
  recommendedCheckoutMode: SessionDraftCheckoutMode;
  sessionProjection?: SessionProjection | null;
  sessionChanges?: SessionChangesView;
  clockNowMs?: number;
  onProjectionChange?: (projection: SessionProjection) => void;
  onLatestMessageRendered?: (sessionId: string) => void;
  onManageModels?: () => void;
  onOpenProviderSettings?: () => void;
  runtimeGeneration: number;
}) {
  const [registryProjects, setRegistryProjects] = useState(() =>
    getVisibleProjectRegistry(),
  );
  const fallbackProject: ProjectRegistryEntry = isChatProjectId(projectId)
    ? chatWorkspaceListEntry()
    : {
        id: projectId,
        path: workspace.projectRoot,
        displayName: workspace.name,
        addedAt: "1970-01-01T00:00:00.000Z",
      };
  const usingRegistryProjects = registryProjects.length > 0;
  const projects = usingRegistryProjects
    ? registryProjects
    : isChatProjectId(projectId)
      ? []
      : [fallbackProject];
  const projectIds = projects.map((project) => project.id);
  const projectIdsKey = projectIds.join("\n");
  const getVisibleSessionDraft = () =>
    getSessionDraft({ projectIds }) ??
    (showDraft ? getBrowserDevelopmentSessionDraft(projectIds) : null);
  const [sessionDraft, setSessionDraft] = useState<SessionDraft | null>(() =>
    getVisibleSessionDraft(),
  );
  const [creationProjection, setCreationProjection] =
    useState<SessionProjection | null>(null);
  const [interactionProjection, setInteractionProjection] =
    useState<SessionProjection | null>(null);
  // Set by a draft submit in this column; consumed when the route leaves the
  // draft so only that handoff plays the composer settle, not a sidebar click.
  const draftHandoffPendingRef = useRef(false);
  const [draftHandoff, setDraftHandoff] = useState<"measure" | "run" | null>(null);
  const columnRef = useRef<HTMLElement | null>(null);
  const [stoppingRun, setStoppingRun] = useState(false);
  const [liveClockNowMs, setLiveClockNowMs] = useState(() => Date.now());
  const historyLoadedKeysRef = useRef(new Set<string>());
  const viewedHistoryKeyRef = useRef<string | null>(null);
  const pendingHistoryRequestsRef = useRef(new Map<string, Promise<PiSessionState>>());
  const historyFailedKeysRef = useRef(new Set<string>());
  const [historyRetryNonce, setHistoryRetryNonce] = useState(0);
  // A pending history read is independent of execution preparation.
  const [pendingHistoryKey, setPendingHistoryKey] = useState<string | null>(null);

  useEffect(
    () =>
      subscribeProjectRegistry(() =>
        setRegistryProjects(getVisibleProjectRegistry()),
      ),
    [],
  );

  useEffect(() => {
    setSessionDraft(getVisibleSessionDraft());
    setCreationProjection(null);
    setInteractionProjection(null);

    return subscribeSessionDrafts(() => {
      setSessionDraft(getVisibleSessionDraft());
    });
  }, [projectId, projectIdsKey, showDraft]);

  useEffect(() => {
    if (showDraft || !draftHandoffPendingRef.current) {
      return;
    }

    draftHandoffPendingRef.current = false;
    setDraftHandoff("measure");
  }, [showDraft]);

  // First frame: park the composer where the draft composer sat (vertically
  // centred). Next frame: release it so the transition carries it down.
  useLayoutEffect(() => {
    if (draftHandoff !== "measure") {
      return;
    }

    const column = columnRef.current;
    const composer = column?.querySelector<HTMLElement>(
      '[data-testid="full-chat-composer"]',
    );

    if (column && composer) {
      const offset = Math.max(0, (column.clientHeight - composer.offsetHeight) / 2);
      column.style.setProperty("--pigui-draft-handoff-offset", `${-offset}px`);
    }

    const frame = requestAnimationFrame(() => setDraftHandoff("run"));

    return () => cancelAnimationFrame(frame);
  }, [draftHandoff]);

  useEffect(() => {
    if (draftHandoff !== "run") {
      return;
    }

    const timer = setTimeout(() => {
      columnRef.current?.style.removeProperty("--pigui-draft-handoff-offset");
      setDraftHandoff(null);
    }, draftHandoffMs);

    return () => clearTimeout(timer);
  }, [draftHandoff]);

  useEffect(() => {
    setInteractionProjection(null);
    setStoppingRun(false);
  }, [sessionProjection?.id]);

  useEffect(() => {
    if (!sessionProjection) {
      return;
    }

    const syncProjection = (currentProjection: SessionProjection | null) => {
      if (currentProjection?.id !== sessionProjection.id) {
        return null;
      }

      // A queued parent effect can run after the subscription applied a newer
      // event. Rewinding here would erase tool results before the next event.
      if (
        currentProjection.piSessionId === sessionProjection.piSessionId &&
        currentProjection.runtimeModel.lastSeq > sessionProjection.runtimeModel.lastSeq
      ) {
        return currentProjection;
      }

      return sessionProjection;
    };

    setCreationProjection(syncProjection);
    setInteractionProjection(syncProjection);
  }, [sessionProjection]);

  useEffect(() => {
    if (!showDraft && sessionProjection?.unreadResult) {
      onLatestMessageRendered?.(sessionProjection.id);
    }
  }, [
    onLatestMessageRendered,
    sessionProjection?.id,
    sessionProjection?.unreadResult,
    showDraft,
  ]);

  const historyKeyForProjection = (
    projection: SessionProjection,
    retryNonce: number,
  ) =>
    projection.piSessionId
      ? `${projection.id}\u0000${projection.piSessionId}\u0000${projection.sessionFile}\u0000${runtimeGeneration}\u0000${retryNonce}`
      : null;

  useEffect(() => {
    if (
      showDraft ||
      !sessionProjection?.piSessionId
    ) {
      viewedHistoryKeyRef.current = null;
      return;
    }

    const bridge = getRuntimeBridge();

    if (!bridge.loadSession) {
      return;
    }

    const historyKey = historyKeyForProjection(
      sessionProjection,
      historyRetryNonce,
    );

    if (viewedHistoryKeyRef.current !== historyKey) {
      if (historyKey) historyLoadedKeysRef.current.delete(historyKey);
      viewedHistoryKeyRef.current = historyKey;
    }

    if (!historyKey || historyFailedKeysRef.current.has(historyKey)) {
      return;
    }

    if (historyLoadedKeysRef.current.has(historyKey)) {
      return;
    }

    let cancelled = false;
    let request = pendingHistoryRequestsRef.current.get(historyKey);
    if (!request) {
      request = bridge.loadSession({
        sessionId: sessionProjection.id,
        piSessionId: sessionProjection.piSessionId,
      });
      pendingHistoryRequestsRef.current.set(historyKey, request);
    }
    setPendingHistoryKey(historyKey);

    // Projection refreshes cancel the old effect, but the current view must
    // still receive its pending history without duplicating the read.
    void request
      .then((state) => {
        if (cancelled) {
          return;
        }

        historyLoadedKeysRef.current.add(historyKey);
        historyFailedKeysRef.current.delete(historyKey);

        // Re-base on the freshest projection: prompt/queue handlers may have
        // committed echoes while the history RPC was in flight, and resync
        // replaces runtimeEvents wholesale from a snapshot that predates
        // them. Fall back to the prop when the view switched Sessions.
        const latest = liveProjectionRef.current ?? sessionProjection;
        const base =
          latest?.piSessionId === sessionProjection.piSessionId
            ? latest
            : sessionProjection;
        let next = applySessionProjectionEvent(base, {
          type: "runtime-state-resynced",
          state,
        });
        const snapshotEventIds = new Set(
          state.events.map((snapshotEvent) => snapshotEvent.id),
        );

        // Gateway reads already merge concurrent events in sequence. Only
        // legacy bridges need to retain echoes absent from their snapshots.
        for (const event of state.replay ? [] : base.runtimeEvents) {
          if (!snapshotEventIds.has(event.id)) {
            next = applySessionProjectionEvent(next, {
              type: "runtime-event-received",
              event,
            });
          }
        }

        commitInteractionProjection(next);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        historyLoadedKeysRef.current.delete(historyKey);
        historyFailedKeysRef.current.add(historyKey);
        commitInteractionProjection(
          applySessionProjectionEvent(sessionProjection, {
            type: "projection-marked-stale",
            reason: historyLoadErrorMessage(error),
            occurredAt: new Date().toISOString(),
          }),
        );
      })
      .finally(() => {
        pendingHistoryRequestsRef.current.delete(historyKey);
        setPendingHistoryKey((current) => (current === historyKey ? null : current));
      });

    return () => {
      cancelled = true;
    };
  }, [
    getRuntimeBridge,
    runtimeGeneration,
    historyRetryNonce,
    sessionProjection,
    showDraft,
    workspace.checkout.runtimeCwd,
  ]);

  const handleDraftChange = (prompt: string) => {
    setSessionDraft(saveSessionDraft(sessionDraft?.projectId ?? null, prompt));
  };
  const handleDraftCheckoutModeChange = (
    checkoutMode: SessionDraftCheckoutMode,
  ) => {
    setSessionDraft(setSessionDraftCheckoutMode(checkoutMode));
  };
  const handleDraftTargetChange = (targetProjectId: string | null) => {
    setSessionDraft(setSessionDraftTarget(targetProjectId));
  };
  const handleDraftSubmit = async (event: SessionDraftSubmitEvent) => {
    const draft = getSessionDraft({ projectIds });

    if (!draft?.projectId) {
      return;
    }

    const targetProject = isChatProjectId(draft.projectId)
      ? chatWorkspaceListEntry()
      : projects.find((project) => project.id === draft.projectId);

    if (!targetProject) {
      return;
    }

    onDraftSubmit(event);

    const chatTarget = isChatProjectId(draft.projectId);
    const targetProjectRoot = chatTarget
      ? CHAT_PROJECT_ID
      : usingRegistryProjects
        ? targetProject.path
        : workspace.projectRoot;
    const targetRepoRoot = chatTarget
      ? undefined
      : usingRegistryProjects
        ? undefined
        : workspace.repoRoot;

    let creationStarted = false;
    const result = await sessionCreator({
      draft: {
        ...draft,
        prompt: event.prompt,
      },
      project: {
        id: targetProject.id,
        repoRoot: targetRepoRoot,
        projectRoot: targetProjectRoot,
      },
      executionMode: chatTarget
        ? "foreground"
        : checkoutModeToExecutionMode(event.checkoutMode),
      ...(event.modelSelection ? { modelSelection: event.modelSelection } : {}),
      ...(event.images?.length ? { images: event.images } : {}),
      onProjectionChange: (projection) => {
        const isStarting = !creationStarted;
        // Runtime subscriptions outlive creation. Once navigation clears the
        // local owner, background events must not reclaim the draft's state.
        setCreationProjection((current) =>
          isStarting || current?.id === projection.id ? projection : current,
        );
        onProjectionChange?.(projection);

        if (isStarting) {
          creationStarted = true;
          draftHandoffPendingRef.current = true;
          onSessionCreationStarted?.(projection);
        }
      },
    });

    setCreationProjection((current) =>
      current?.id === result.projection.id ? result.projection : current,
    );
    onProjectionChange?.(result.projection);

    if (result.clearDraft) {
      clearSessionDraft(draft.projectId);
      setSessionDraft(null);
      onSessionCreated?.(result.projection);
    }
  };
  const commitInteractionProjection = (
    nextProjection: SessionProjection,
    { follow = false }: { follow?: boolean } = {},
  ) => {
    const current = liveProjectionRef.current;
    // Async resolutions can land after the view switched Sessions: they still
    // reach the store, but only the Session still on screen may reclaim the
    // local projection. `follow` is for commits that intentionally move the
    // view to a new Session (fork).
    if (follow || !current || current.id === nextProjection.id) {
      liveProjectionRef.current = nextProjection;
      setInteractionProjection(nextProjection);
    }
    onProjectionChange?.(nextProjection);
  };
  const liveProjection =
    interactionProjection ?? creationProjection ?? sessionProjection ?? null;
  // Keep a mutable pointer so live event listeners can chain applies without
  // waiting for React to re-render (and without dropping mid-stream events).
  const liveProjectionRef = useRef(liveProjection);
  liveProjectionRef.current = liveProjection;
  // Every interaction handler awaits an RPC and then commits. The projection
  // it captured before the await is stale by then: the live subscription keeps
  // applying Gateway events (a Run's answer, the closure of an aborted Run)
  // into the ref during the round-trip, and committing on top of the snapshot
  // would silently drop them. Commit on the ref instead, falling back to the
  // snapshot only when the view switched to another Session mid-flight.
  const latestProjectionFor = (snapshot: SessionProjection) => {
    const latest = liveProjectionRef.current;

    return latest?.piSessionId === snapshot.piSessionId ? latest : snapshot;
  };

  const onProjectionChangeRef = useRef(onProjectionChange);
  onProjectionChangeRef.current = onProjectionChange;

  // DF-009: create path subscribes in sessionCreator, but resume/open of an
  // existing session only resynced once and never re-subscribed. Follow-ups
  // still hit the backend/journal while the UI only applied the user echo —
  // looks like "must start a new chat". Subscribe for any viewed piSessionId.
  useEffect(() => {
    const piSessionId = liveProjection?.piSessionId;

    if (showDraft || !piSessionId) {
      return;
    }

    const bridge = getRuntimeBridge();

    const applyLiveProjectionEvent = (
      event: Parameters<typeof applySessionProjectionEvent>[1],
    ) => {
      const base = liveProjectionRef.current;

      if (!base || base.piSessionId !== piSessionId) {
        return;
      }

      const next = applySessionProjectionEvent(base, event);
      liveProjectionRef.current = next;
      setInteractionProjection(next);
      onProjectionChangeRef.current?.(next);
    };

    const unsubscribeLegacyEvents = bridge.subscribeToEvents(
      piSessionId,
      (event) => {
        applyLiveProjectionEvent({
          type: "runtime-event-received",
          event,
        });
      },
    );
    const unsubscribeAgentEvents = bridge.subscribeToAgentEvents?.(
      piSessionId,
      (entry) => {
        applyLiveProjectionEvent({
          type: "agent-event-received",
          entry,
        });
      },
    );

    return () => {
      unsubscribeLegacyEvents();
      unsubscribeAgentEvents?.();
    };
  }, [getRuntimeBridge, liveProjection?.piSessionId, showDraft]);

  const historyInFlight =
    pendingHistoryKey !== null &&
    Boolean(sessionProjection) &&
    sessionProjection != null &&
    historyKeyForProjection(sessionProjection, historyRetryNonce) === pendingHistoryKey;
  const canRetryHistoryLoad = Boolean(
    liveProjection?.piSessionId &&
      getRuntimeBridge().loadSession,
  );
  const handleRetryHistoryLoad = () => {
    if (!liveProjection) {
      return;
    }

    const historyKey = historyKeyForProjection(liveProjection, historyRetryNonce);

    if (historyKey) {
      historyLoadedKeysRef.current.delete(historyKey);
      historyFailedKeysRef.current.delete(historyKey);
    }

    setHistoryRetryNonce((currentNonce) => currentNonce + 1);
  };
  const shouldTickLiveClock =
    clockNowMs === undefined &&
    Boolean(liveProjection && isSessionProjectionActive(liveProjection));

  useEffect(() => {
    if (!shouldTickLiveClock) {
      return;
    }

    const interval = window.setInterval(() => {
      setLiveClockNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(interval);
  }, [shouldTickLiveClock, liveProjection?.id]);

  const effectiveClockNowMs = clockNowMs ?? liveClockNowMs;
  const projectionMessages = liveProjection
    ? (liveMessagesFromRuntimeModel(liveProjection, effectiveClockNowMs) ??
      liveMessagesFromProjection(liveProjection, effectiveClockNowMs))
    : [];
  const liveMessages = projectionMessages.length
    ? projectionMessages
    : workspace.liveMessages;
  // Only the legacy pipeline still routes a trace through timeline items; the
  // runtime-model path derives its view with the bubble it belongs to.
  const runTimeline = !liveProjection
    ? workspace.runTimeline
    : runtimeModelIsActive(liveProjection)
      ? []
      : runTimelineFromProjection(liveProjection);
  const fallbackTraceMessageId = runTimeline.some((item) => !item.messageId)
    ? [...liveMessages]
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" && !message.controlLabel,
        )?.id
    : undefined;
  // Legacy pipeline only: the runtime-model path derives its view alongside
  // the bubble, so there is nothing here to attach.
  const withLegacyCotView = (message: LiveMessage) => {
    if (message.cotView || !isAssistantAnswerMessage(message)) {
      return message;
    }

    const relatedMessageIds = new Set(relatedMessageIdsFor(message));

    return {
      ...message,
      cotView: settledCotViewFromTimeline(
        runTimeline.filter((item) =>
          item.messageId
            ? relatedMessageIds.has(item.messageId)
            : message.id === fallbackTraceMessageId,
        ),
      ),
    };
  };
  const readOnlyProjection = isReadOnlyProjection(liveProjection);
  const runtimeUnavailableProjection =
    isRuntimeUnavailableProjection(liveProjection) ? liveProjection : null;
  // Session Creation owns the column until Pi accepts the initial prompt: no
  // queueing before the first prompt exists, no follow-up input either.
  const creating = liveProjection?.status === "creating";
  const creationFailure =
    liveProjection?.status === "failed" ? liveProjection.failure : null;
  const pendingInitialPrompt =
    liveProjection &&
    (creating || creationFailure) &&
    !liveMessages.some((message) => message.role === "user")
      ? liveProjection.initialPrompt
      : null;
  const queueMode =
    Boolean(liveProjection?.piSessionId) &&
    Boolean(liveProjection && isSessionProjectionActive(liveProjection)) &&
    !creating &&
    !readOnlyProjection;
  const handleQueueSubmit = async (
    message: string,
    images?: RuntimePromptImage[],
  ) => {
    const projection = liveProjectionRef.current ?? liveProjection;

    if (!projection?.piSessionId || !queueMode) {
      return;
    }

    const queuedMessage = await getRuntimeBridge().queueFollowUp({
      piSessionId: projection.piSessionId,
      message,
      ...(images?.length ? { images } : {}),
    });

    const next = applySessionProjectionEvent(latestProjectionFor(projection), {
      type: "queued-message-added",
      queuedMessage,
    });
    commitInteractionProjection(next);
  };
  const pendingPromptsRef = useRef(new Map<string, { content: string; promise: Promise<void> }>());
  const handlePromptSubmit = async (
    message: string,
    images?: RuntimePromptImage[],
  ) => {
    const projection = liveProjectionRef.current ?? liveProjection;

    if (!projection?.piSessionId || readOnlyProjection) {
      return;
    }

    const piSessionId = projection.piSessionId;
    const content = JSON.stringify({ message, images });
    const pending = pendingPromptsRef.current.get(projection.piSessionId);
    if (pending) {
      if (pending.content !== content) throw new Error("Wait for the pending message before sending another.");
      return pending.promise;
    }
    const sending = (async () => {
      await restoreProjectionRuntimeState({
        bridge: getRuntimeBridge(),
        projection,
        workspace,
      });

      const submittedAt = new Date().toISOString();
      const accepted = await getRuntimeBridge().sendInitialPrompt({
        piSessionId,
        prompt: message,
        ...(images?.length ? { images } : {}),
      });

      const current = accepted.state
        ? applySessionProjectionEvent(latestProjectionFor(projection), { type: "runtime-state-resynced", state: accepted.state })
        : latestProjectionFor(projection);
      const next = applySessionProjectionEvent(current, {
        type: "runtime-event-received",
        submittedAt,
        event: accepted.event,
      });
      commitInteractionProjection(next);
    })();
    pendingPromptsRef.current.set(projection.piSessionId, { content, promise: sending });
    try {
      await sending;
    } finally {
      pendingPromptsRef.current.delete(projection.piSessionId);
    }
  };
  const modelChangeInFlight = useRef<Promise<void> | null>(null);
  const lastMessage = liveMessages[liveMessages.length - 1];
  const latestFailure = lastMessage?.controlLabel === "Run failed" ? lastMessage : undefined;
  const failedRequest = latestFailure
    ? [...liveMessages].reverse().find((message) => message.role === "user" && !message.controlLabel)
    : undefined;
  const retryImages = failedRequest?.images?.map((image) => {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(image.src);
    return match ? { mimeType: match[1], data: match[2], ...(image.name ? { name: image.name } : {}) } : null;
  });
  const canRetryRequest = Boolean(
    failedRequest && liveProjection?.piSessionId && !queueMode &&
    !readOnlyProjection && !retryImages?.includes(null),
  );
  const retryFailedRequest = async () => {
    // A retry must use the model the user just chose, even during its RPC.
    await modelChangeInFlight.current;
    const current = liveProjectionRef.current ?? liveProjection;
    if (!canRetryRequest || !failedRequest || !current || isSessionProjectionActive(current)) return;
    await handlePromptSubmit(failedRequest.body, retryImages as RuntimePromptImage[] | undefined);
  };

  const handleModelConfigChange = async (
    selection: RuntimeModelSelection,
  ) => {
    if (!liveProjection?.piSessionId || queueMode) {
      return;
    }

    const bridge = getRuntimeBridge();

    if (!bridge.configureModel) {
      throw new Error("Runtime model controls are unavailable.");
    }

    const change = bridge.configureModel({
      sessionId: liveProjection.id,
      piSessionId: liveProjection.piSessionId,
      ...selection,
    }).then((modelControls) => {
      if (modelControls.selected) {
        saveLastModelSelection(modelControls.selected);
      }
      const next = applySessionProjectionEvent(latestProjectionFor(liveProjection), {
        type: "model-controls-changed",
        modelControls,
        occurredAt: new Date().toISOString(),
      });
      commitInteractionProjection(next);
    });
    modelChangeInFlight.current = change;
    try {
      await change;
    } finally {
      if (modelChangeInFlight.current === change) modelChangeInFlight.current = null;
    }
  };
  const handleWithdrawQueuedMessage = async (queuedMessageId: string) => {
    const projection = liveProjectionRef.current ?? liveProjection;

    if (!projection?.piSessionId) {
      return;
    }

    await getRuntimeBridge().withdrawQueuedMessage({
      piSessionId: projection.piSessionId,
      queuedMessageId,
    });

    const next = applySessionProjectionEvent(latestProjectionFor(projection), {
      type: "queued-message-withdrawn",
      queuedMessageId,
      occurredAt: new Date().toISOString(),
    });
    commitInteractionProjection(next);
  };
  const handleSteerSubmit = async (
    message: string,
    images?: RuntimePromptImage[],
  ) => {
    const projection = liveProjectionRef.current ?? liveProjection;

    if (!projection?.piSessionId || !queueMode) {
      return;
    }

    const event = await getRuntimeBridge().steerRun({
      piSessionId: projection.piSessionId,
      message,
      ...(images?.length ? { images } : {}),
    });

    const next = applySessionProjectionEvent(latestProjectionFor(projection), {
      type: "steer-submitted",
      event,
    });
    commitInteractionProjection(next);
  };
  const handleStopRun = async () => {
    const projection = liveProjectionRef.current ?? liveProjection;

    if (!projection?.piSessionId || !queueMode || stoppingRun) {
      return;
    }

    const { piSessionId } = projection;

    setStoppingRun(true);

    try {
      await restoreProjectionRuntimeState({
        bridge: getRuntimeBridge(),
        projection,
        workspace,
      });

      const event = await getRuntimeBridge().abortRun({ piSessionId });
      const next = applySessionProjectionEvent(latestProjectionFor(projection), {
        type: "run-stopped",
        event,
      });

      commitInteractionProjection(next);
    } catch (error) {
      const next = applySessionProjectionEvent(latestProjectionFor(projection), {
        type: "run-stop-failed",
        event: {
          id: `stop-failed-${Date.now()}`,
          piSessionId,
          kind: "error",
          title: "Stop failed",
          body: messageFromError(error),
          timestamp: new Date().toISOString(),
        },
      });

      commitInteractionProjection(next);
    } finally {
      setStoppingRun(false);
    }
  };
  const handleForkMessage = async (message: LiveMessage) => {
    if (
      !message.piEntryId ||
      !liveProjection?.piSessionId ||
      !liveProjection.sessionFile
    ) {
      return;
    }

    const bridge = getRuntimeBridge();

    if (!bridge.forkSession) {
      return;
    }

    const chatFork = isChatProjectId(liveProjection.projectId);
    const confirmed = window.confirm(
      chatFork
        ? [
            "Fork this message into a new Session?",
            "",
            "Pace will create a separate Chat Session from this message boundary.",
            "The selected message text will be pre-filled in the new composer.",
          ].join("\n")
        : [
            "Fork this message into a new Session?",
            "",
            "Pace will create a separate Session from this message boundary.",
            "Git Projects use a managed worktree; non-Git Projects may reuse the foreground directory.",
            "The selected message text will be pre-filled in the new composer.",
          ].join("\n"),
    );

    if (!confirmed) {
      return;
    }

    const targetProject = chatFork
      ? chatWorkspaceListEntry()
      : projects.find((candidate) => candidate.id === liveProjection.projectId) ??
        projects.find((candidate) => candidate.id === projectId) ??
        fallbackProject;
    const forkSessionId = createSessionId();
    const now = () => new Date().toISOString();
    const targetProjectRoot = chatFork
      ? CHAT_PROJECT_ID
      : usingRegistryProjects
        ? targetProject.path
        : workspace.projectRoot;
    const targetRepoRoot = chatFork
      ? undefined
      : usingRegistryProjects
        ? undefined
        : workspace.repoRoot;
    let forkProjection = createSessionProjection({
      id: forkSessionId,
      projectId: targetProject.id,
      initialPrompt: message.body,
      createdAt: now(),
    });
    const commitForkProjection = (nextProjection: SessionProjection) => {
      forkProjection = nextProjection;
      commitInteractionProjection(nextProjection, { follow: true });
    };

    if (message.body.trim()) {
      saveFollowUpDraft(forkSessionId, message.body);
    }
    commitForkProjection(forkProjection);

    try {
      const checkout = chatFork
        ? await prepareChatSessionCheckout({
            sessionId: forkSessionId,
            bridge,
            checkoutManager,
            now,
          })
        : await checkoutManager.prepareCheckout({
            sessionId: forkSessionId,
            strategy: "background-managed",
            project: {
              id: targetProject.id,
              repoRoot: targetRepoRoot,
              projectRoot: targetProjectRoot,
            },
            now,
          });

      commitForkProjection(
        applySessionProjectionEvent(forkProjection, {
          type: "checkout-selected",
          stage: "preparing checkout",
          checkout,
          occurredAt: now(),
        }),
      );

      const fork = await bridge.forkSession({
        sessionId: forkSessionId,
        projectId: targetProject.id,
        sourcePiSessionId: liveProjection.piSessionId,
        sourceSessionFile: liveProjection.sessionFile,
        piEntryId: message.piEntryId,
        cwd: checkout.runtimeCwd,
        checkout,
      });
      const selectedText = fork.selectedText ?? message.body;

      if (selectedText.trim()) {
        saveFollowUpDraft(forkSessionId, selectedText);
      }

      forkProjection = applySessionProjectionEvent(forkProjection, {
        type: "runtime-bound",
        stage: "starting runtime",
        runtimeId: fork.state.runtimeId,
        piSessionId: fork.state.piSessionId,
        summary: fork.state.summary,
        modelControls: fork.state.modelControls,
        occurredAt: now(),
      });
      forkProjection = applySessionProjectionEvent(forkProjection, {
        type: "runtime-state-resynced",
        state: fork.state,
      });
      commitForkProjection({
        ...forkProjection,
        initialPrompt: selectedText,
        creationStage: "accepted",
      });
    } catch (error) {
      commitForkProjection(
        applySessionProjectionEvent(forkProjection, {
          type: "creation-failed",
          stage:
            error instanceof PiRuntimeBridgeError &&
            error.stage === "forking session"
              ? "starting runtime"
              : "preparing checkout",
          message: messageFromError(error),
          occurredAt: now(),
        }),
      );
    }

    // Forked Sessions used to take over via the selection side effect on
    // every projection commit; selection is explicit now, so the fork lands
    // the view itself (failure state included, matching prior behavior).
    onSessionCreated?.(forkProjection);
  };

  return (
    <main
      ref={columnRef}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-testid="live-session-column"
      data-draft-handoff={draftHandoff ?? undefined}
    >
      {showDraft && sessionDraft ? (
        <SessionDraftComposer
          draft={sessionDraft}
          projects={projects}
          creationProjection={creationProjection}
          recommendedCheckoutMode={recommendedCheckoutMode}
          onDraftChange={handleDraftChange}
          onDraftCheckoutModeChange={handleDraftCheckoutModeChange}
          onDraftTargetChange={handleDraftTargetChange}
          onDraftSubmit={(event) => void handleDraftSubmit(event)}
          onManageModels={onManageModels}
        />
      ) : (
        <>
          {runtimeUnavailableProjection ? (
            <div
              className="flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2 text-sm text-muted"
              data-testid="runtime-fallback-banner"
            >
              <span>
                Runtime unavailable.{" "}
                {runtimeUnavailableProjection.staleReason ??
                  "Showing read-only session data."}
              </span>
              {canRetryHistoryLoad ? (
                <Button
                  label="Retry"
                  size="sm"
                  variant="secondary"
                  onClick={handleRetryHistoryLoad}
                />
              ) : null}
            </div>
          ) : null}
          <ChatConversation
            aria-label="Live Chat messages"
            className="pigui-draft-handoff__chat min-h-0 flex-1"
            isStreaming={liveMessages.some((message) => message.isStreaming)}
          >
            {/* Tight at the top: the pane already carries the header's own
                offset, so a second 24px band only pushed the first message
                down. The bottom keeps its distance from the composer. */}
            <ChatConversation.Content className="mx-auto flex w-full max-w-[44rem] flex-col gap-8 px-4 pb-6 pt-2">
              {pendingInitialPrompt && liveProjection ? (
                <LiveChatMessage
                  message={{
                    id: `${liveProjection.id}:pending-initial-prompt`,
                    role: "user",
                    body: pendingInitialPrompt,
                  }}
                />
              ) : null}
              {liveMessages.map((message) => (
                <LiveChatMessage
                  key={message.id}
                  message={withLegacyCotView(message)}
                  recovery={message.controlLabel === "Run failed" ? (
                    <ChatRunFailure error={message.body}
                      onOpenProviderSettings={onOpenProviderSettings}
                      onRetry={message.id === latestFailure?.id && canRetryRequest ? retryFailedRequest : undefined}
                      modelControl={message.id === latestFailure?.id && canRetryRequest && liveProjection?.modelControls ? (
                        <ModelSelectorControl controls={liveProjection.modelControls} isDisabled={queueMode}
                          visibleModels={getVisibleModels()} onManageModels={onManageModels} onChange={handleModelConfigChange} />
                      ) : undefined} />
                  ) : undefined}
                  onForkMessage={
                    liveProjection?.sessionFile &&
                    liveProjection.piSessionId &&
                    getRuntimeBridge().forkSession
                      ? (forkMessage) => void handleForkMessage(forkMessage)
                      : undefined
                  }
                />
              ))}
              {historyInFlight ? (
                <p
                  aria-live="polite"
                  className="text-sm text-muted"
                  data-testid="session-history-status"
                  role="status"
                >
                  <TextShimmer>Loading history…</TextShimmer>
                </p>
              ) : null}
              {creating && liveProjection ? (
                <p
                  aria-live="polite"
                  className="text-sm text-muted"
                  data-testid="session-creation-status"
                  role="status"
                >
                  {liveProjection.creationStage}…
                </p>
              ) : null}
            </ChatConversation.Content>
          </ChatConversation>

          {creationFailure && liveProjection ? (
            <div
              className="mt-auto shrink-0 px-4 pb-3 pt-3"
              data-testid="session-creation-failure"
              role="alert"
            >
              <div className="mx-auto w-full max-w-[44rem] rounded-md border border-border bg-surface px-3 py-2 text-sm">
                <SessionCreationFailureDetail
                  failure={creationFailure}
                  action={
                    onReopenDraft ? (
                      <Button
                        label="Back to draft"
                        size="sm"
                        variant="secondary"
                        onClick={() => onReopenDraft(liveProjection)}
                      />
                    ) : undefined
                  }
                />
              </div>
            </div>
          ) : readOnlyProjection ? null : (
            <div className="pigui-draft-handoff__composer mt-auto flex shrink-0 flex-col">
            <FullChatComposer
              key={liveProjection?.id}
              isCreating={creating}
              isStoppingRun={stoppingRun}
              queueMode={queueMode}
              projection={liveProjection}
              sessionChanges={sessionChanges}
              onPromptSubmit={handlePromptSubmit}
              onQueueSubmit={handleQueueSubmit}
              onWithdrawQueuedMessage={handleWithdrawQueuedMessage}
              onStopRun={handleStopRun}
              onSteerSubmit={handleSteerSubmit}
              onModelConfigChange={handleModelConfigChange}
              onManageModels={onManageModels}
            />
            </div>
          )}
        </>
      )}
    </main>
  );
}

/**
 * What the resize handle takes out of the width Chat and the panel share: only
 * the 1px divider it draws between them. Its 16px grab zone and pill are
 * absolutely positioned over both panes, so they cost no layout width.
 */
const resizeHandleGutterPx = 1;

/**
 * The 40px row under the fixed header chrome on the Chat side. The dock
 * fills the same band with its own header; the hairline under both is drawn
 * once by the sessions view.
 */
function TitlebarBand() {
  return (
    <div
      aria-hidden="true"
      className="h-10 shrink-0"
      data-testid="session-workspace-titlebar-band"
    />
  );
}

export function AgentWorkspaceSessionsView({
  projectId = fixtureWorkspace.id,
  showDraft = false,
  workspace = fixtureWorkspace,
  aside,
  asideOpen = true,
  onDraftSubmit = () => {},
  onSessionCreationStarted,
  onSessionCreated,
  onReopenDraft,
  sessionCreator,
  checkoutManager,
  runtimeBridge,
  sessionProjection,
  sessionChanges,
  clockNowMs,
  onProjectionChange,
  onLatestMessageRendered,
  onManageModels,
  onOpenProviderSettings,
  runtimeGeneration = 0,
}: {
  projectId?: string;
  showDraft?: boolean;
  workspace?: AgentWorkspaceFixture;
  aside?: ReactNode;
  /** False while the dock plays its exit; the pane closes on the same clock. */
  asideOpen?: boolean;
  onDraftSubmit?: (event: SessionDraftSubmitEvent) => void;
  onSessionCreationStarted?: (projection: SessionProjection) => void;
  onSessionCreated?: (projection: SessionProjection) => void;
  onReopenDraft?: (projection: SessionProjection) => void;
  sessionCreator?: SessionCreator;
  checkoutManager?: ExecutionCheckoutManager;
  runtimeBridge?: PiRuntimeBridge;
  sessionProjection?: SessionProjection | null;
  sessionChanges?: SessionChangesView;
  clockNowMs?: number;
  onProjectionChange?: (projection: SessionProjection) => void;
  onLatestMessageRendered?: (sessionId: string) => void;
  onManageModels?: () => void;
  onOpenProviderSettings?: () => void;
  runtimeGeneration?: number;
}) {
  const [getDefaultRuntimeBridge] = useState(() => {
    let bridge: PiRuntimeBridge | null = null;

    return () => {
      bridge ??= createDefaultPiRuntimeBridge();

      return bridge;
    };
  });
  const getActiveRuntimeBridge = runtimeBridge
    ? () => runtimeBridge
    : getDefaultRuntimeBridge;
  const [defaultProjectionStore] = useState(() =>
    createInMemorySessionProjectionStore(),
  );
  const [defaultCheckoutManager] = useState(() =>
    createExecutionCheckoutManager({
      gitClient: createInvokeExecutionCheckoutGitClient(),
    }),
  );
  const activeCheckoutManager = checkoutManager ?? defaultCheckoutManager;
  const defaultSessionCreator: SessionCreator = (input: SessionCreatorInput) =>
    createSessionFromDraft({
      ...input,
      bridge: getActiveRuntimeBridge(),
      checkoutManager: activeCheckoutManager,
      executionMode: input.executionMode ?? "foreground",
      projections: defaultProjectionStore,
    });
  const liveSession = (
    <LiveSessionColumn
      projectId={projectId}
      showDraft={showDraft}
      workspace={workspace}
      onDraftSubmit={onDraftSubmit}
      onSessionCreationStarted={onSessionCreationStarted}
      onSessionCreated={onSessionCreated}
      onReopenDraft={onReopenDraft}
      sessionCreator={sessionCreator ?? defaultSessionCreator}
      checkoutManager={activeCheckoutManager}
      getRuntimeBridge={getActiveRuntimeBridge}
      recommendedCheckoutMode="local"
      sessionProjection={sessionProjection}
      sessionChanges={sessionChanges}
      clockNowMs={clockNowMs}
      onProjectionChange={onProjectionChange}
      onLatestMessageRendered={onLatestMessageRendered}
      onManageModels={onManageModels}
      onOpenProviderSettings={onOpenProviderSettings}
      runtimeGeneration={runtimeGeneration}
    />
  );
  // The panel's ceiling is whatever Chat's minimum does not need, so it has to
  // follow the split container rather than resolve once at mount.
  const [splitElement, setSplitElement] = useState<HTMLDivElement | null>(null);
  const [splitWidth, setSplitWidth] = useState(() =>
    typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth : 1280,
  );

  useEffect(() => {
    if (!splitElement || typeof window === "undefined") {
      return;
    }

    const measure = () => setSplitWidth(splitElement.getBoundingClientRect().width);
    const observer = new ResizeObserver(measure);

    measure();
    observer.observe(splitElement);

    return () => observer.disconnect();
  }, [splitElement]);

  const asideSizeBounds = sessionDockResizableBounds(
    Math.max(0, splitWidth - resizeHandleGutterPx),
  );
  const asideResizable = useResizable({
    defaultSize: sessionDockDefaultWidthPx,
    minSizePx: asideSizeBounds.minSizePx,
    maxSizePx: asideSizeBounds.maxSizePx,
  });
  const { resize: resizeAside, size: asideSize } = asideResizable;
  // The split view mounts with the dock, so a mount always plays the enter.
  const asideMotion = useSessionDockMotionState(asideOpen, true);

  // `useResizable` clamps each drag against the current bounds but keeps the
  // size it already holds, so a window that shrank under the panel has to be
  // given its room back explicitly.
  useEffect(() => {
    if (asideSize > asideSizeBounds.maxSizePx) {
      resizeAside(asideSizeBounds.maxSizePx);
    }
  }, [asideSize, asideSizeBounds.maxSizePx, resizeAside]);

  return (
    <article
      className="relative -mt-10 flex h-[calc(100%+2.5rem)] min-h-0 min-w-0 flex-col overflow-hidden pb-0"
      data-testid="project-sessions-view"
    >
      {/* One hairline under the titlebar band for the whole view. Drawn once
          here rather than per column so it does not break at the resize
          handle between Chat and the dock. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-10 z-10 h-px bg-separator"
        data-testid="session-workspace-titlebar-rule"
      />
      {/* Both layouts span the full width: Chat centers itself via its own
          max-width, so an outer centered box would only strand the docked
          dock's rail (ADR-0028) and Chat's scrollbar short of the
          window edge. */}
      {aside ? (
        <div
          className="flex h-full min-h-0 w-full flex-row"
          data-slot="resizable"
          data-testid="session-workspace-split-view"
          ref={setSplitElement}
        >
          <div
            className="h-full min-h-0 min-w-0 flex-1"
            data-slot="resizable-panel"
          >
            <div
              className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
              data-testid="session-workspace-main-pane"
            >
              <TitlebarBand />
              <div className="min-h-0 flex-1">{liveSession}</div>
            </div>
          </div>
          <ResizeHandle
            direction="horizontal"
            hasDivider
            isReversed
            label="Resize Session dock"
            // Astryx 0.3.0 `hitAreaOffsetX` carries a `-50%` Y translate meant
            // for vertical handles, so a side-biased pill shifts the grab zone
            // up by half its height and only the divider's top half is
            // draggable. Centering the pill skips that offset entirely.
            pillPlacement="center"
            resizable={asideResizable.props}
          />
          {/* Width, not transform, on purpose: the divider and Chat's column
              have to move with the dock's edge, and only a layout change
              does that. It runs solely while the dock is in motion, so drags
              stay 1:1; the inner box keeps the full width so the sliding
              content is clipped, never squeezed. */}
          <div
            className="pigui-session-dock-pane h-full min-h-0 shrink-0"
            data-motion={asideMotion.moving ? "true" : undefined}
            data-open={asideOpen ? "true" : "false"}
            data-slot="resizable-panel"
            style={
              {
                "--pigui-session-dock-width": `${asideResizable.size}px`,
              } as CSSProperties
            }
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget) {
                asideMotion.settle();
              }
            }}
          >
            <div
              className="h-full min-h-0 overflow-hidden"
              data-testid="session-workspace-aside-pane"
              style={{ width: asideResizable.size }}
            >
              {aside}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex h-full min-h-0 w-full flex-col">
          <TitlebarBand />
          <div className="min-h-0 flex-1">{liveSession}</div>
        </div>
      )}
    </article>
  );
}

export function AgentWorkspaceSessionsPage() {
  const navigate = useNavigate();
  const { openSettings } = useSettingsDialog();
  const { projectId } = useParams({ from: "/projects/$projectId/sessions" });
  const showDraft = useRouterState({
    select: (state) => {
      const search = state.location.search as { view?: string };

      return search.view === "draft";
    },
  });
  const [browserDevelopmentData] = useState(() =>
    shouldUseBrowserDevelopmentData(),
  );
  const [registryProjects, setRegistryProjects] = useState(() =>
    getVisibleProjectRegistry(),
  );
  const [runtimeBridge] = useState(() => createDefaultPiRuntimeBridge());
  const {
    sessionProjections,
    sessionsHydrated,
    backendGeneration,
    setSessionProjections,
  } = useSessionProjections();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  // Browser/vitest fixture sessions live in the same app-wide store as Electron hydrate.
  useEffect(() => {
    if (!browserDevelopmentData) {
      return;
    }

    setSessionProjections((current) =>
      current.length > 0 ? current : defaultSidebarProjectSessionProjections,
    );
  }, [browserDevelopmentData, setSessionProjections]);
  // Shell count for the Terminal rail badge, reported up by the Terminal
  // surface while it is mounted; reset per Session below.
  const [terminalInstanceCount, setTerminalInstanceCount] = useState(0);
  const [browserInstanceCount, setBrowserInstanceCount] = useState(0);
  // Open state and the active surface are Workspace-level, so switching
  // Sessions keeps the dock where the user left it.
  const [dockOpen, setDockOpen] = useState(false);
  // Terminal/Browser own live pty / WebContentsView instances, so the closed
  // dock cannot stay mounted; keep it only through the exit transition.
  const dockMounted = useSessionDockPresence(dockOpen);
  const [activeSurfaceId, setActiveSurfaceId] =
    useState<SessionSurfaceId>("changes");
  const [pendingChangeLink, setPendingChangeLink] = useState<{
    sessionId: string;
    link: SessionChangeLink;
  } | null>(null);
  const [changeTarget, setChangeTarget] = useState<SessionChangeTarget | null>(null);
  const project = isChatProjectId(projectId)
    ? chatWorkspaceListEntry()
    : registryProjects.find((candidate) => candidate.id === projectId) ?? null;
  const workspace = project ? workspaceFromProject(project) : null;
  const selectedSessionProjection =
    sessionProjections.find(
      (projection) =>
        projection.id === selectedSessionId && projection.projectId === projectId,
    ) ?? null;
  const emptyChatDraft =
    registryProjects.length === 0 &&
    isChatProjectId(projectId) &&
    showDraft &&
    !sessionProjections.some((projection) => isChatProjectId(projection.projectId));
  // One read for the composer git-branch chip, the Changes panel, and the
  // rail badge. The docked rail carries the Changes count whatever surface
  // is showing, so it needs the diff even on Terminal. The composer footer
  // needs the branch whenever a live Session is on screen, which is why this
  // is no longer gated on the dock being open.
  // Draft handoff precedes worktree creation; the backend projection is only
  // queryable once create_session returns and the runtime is bound.
  const sessionChanges = useSessionChanges({
    sessionId: selectedSessionProjection?.id ?? null,
    enabled:
      Boolean(selectedSessionProjection?.piSessionId) &&
      !showDraft &&
      !isChatProjectId(projectId),
  });

  // Resolve only after the click's fresh read. The initial composer read may
  // predate this run's edits; matching it would silently miss newly changed files.
  useEffect(() => {
    if (!pendingChangeLink) return;
    if (showDraft || pendingChangeLink.sessionId !== selectedSessionProjection?.id) {
      setPendingChangeLink(null);
      return;
    }
    if (sessionChanges.loading || sessionChanges.refreshing) return;
    const target = sessionChanges.changes
      ? findSessionChangeTarget(
          pendingChangeLink.link,
          sessionChanges.changes,
          selectedSessionProjection.checkout?.diffRoot ?? selectedSessionProjection.cwd ?? undefined,
        )
      : null;
    setPendingChangeLink(null);
    if (target) {
      setChangeTarget(target);
      setActiveSurfaceId("changes");
      setDockOpen(true);
    }
  }, [pendingChangeLink, sessionChanges.changes, sessionChanges.loading, sessionChanges.refreshing, selectedSessionProjection, showDraft]);

  useEffect(
    () =>
      subscribeProjectRegistry(() =>
        setRegistryProjects(getVisibleProjectRegistry()),
      ),
    [],
  );

  useEffect(() => {
    setTerminalInstanceCount(0);
    setBrowserInstanceCount(0);
    setChangeTarget(null);
  }, [selectedSessionId]);

  useEffect(() => {
    if (registryProjects.length > 0 || isChatProjectId(projectId)) {
      return;
    }

    if (!getSessionDraft()) ensureSessionDraft(CHAT_PROJECT_ID);
    void navigate({
      to: "/projects/$projectId/sessions",
      params: { projectId: CHAT_PROJECT_ID },
      search: { view: "draft" } as never,
      replace: true,
      resetScroll: false,
    });
  }, [navigate, projectId, registryProjects.length]);

  // After hydrate (or when project sessions appear), select the first valid session.
  useEffect(() => {
    if (selectedSessionId) {
      return;
    }

    const nextSessionId = firstSessionIdForProject(sessionProjections, projectId);
    if (nextSessionId) {
      setSelectedSessionId(nextSessionId);
    }
  }, [projectId, selectedSessionId, sessionProjections]);

  useEffect(() => {
    if (!selectedSessionProjection) {
      setDockOpen(false);
    }
  }, [selectedSessionProjection?.id]);

  // Store updates only: projection commits also arrive for Sessions the user
  // is not viewing (a created Session's runtime subscription outlives the
  // view), so this must never move the selection. Selection changes are
  // explicit: sidebar clicks, the first-session fallback, and Session takeovers.
  const handleProjectionChange = (nextProjection: SessionProjection) => {
    setSessionProjections((projections) => {
      const projectionExists = projections.some(
        (projection) => projection.id === nextProjection.id,
      );

      if (!projectionExists) {
        return [nextProjection, ...projections];
      }

      return projections.map((projection) =>
        projection.id === nextProjection.id ? nextProjection : projection,
      );
    });
  };
  const handleLatestMessageRendered = (sessionId: string) => {
    setSessionProjections((projections) =>
      projections.map((projection) =>
        projection.id === sessionId
          ? applySessionProjectionEvent(projection, {
              type: "latest-message-rendered",
              occurredAt: new Date().toISOString(),
            })
          : projection,
      ),
    );
  };
  // The Live Session takes over as soon as the `creating` projection exists:
  // waiting for Pi to accept the prompt left the draft on screen for as long
  // as extensions held the user-message boundary. Also fires on success so a
  // retargeted draft lands on its Project route.
  const enterLiveSession = (projection: SessionProjection) => {
    setSelectedSessionId(projection.id);
    void navigate({
      to: "/projects/$projectId/sessions",
      params: { projectId: projection.projectId },
      search: ((previous: Record<string, unknown>) => {
        const { view: _view, ...search } = previous;
        return search;
      }) as never,
      hash: true,
      replace: true,
      resetScroll: false,
    });
  };
  const handleReopenDraft = (projection: SessionProjection) => {
    if (!getSessionDraft()?.prompt.trim()) {
      saveSessionDraft(projection.projectId, projection.initialPrompt);
    }

    void navigate({
      to: "/projects/$projectId/sessions",
      params: { projectId: projection.projectId },
      search: { view: "draft" } as never,
      resetScroll: false,
    });
  };
  const handleTerminalInstancesChange = (instances: TerminalInstanceInfo[]) => {
    setTerminalInstanceCount(instances.length);
  };

  if (!workspace) {
    return (
      <AppFrame
        sessionProjections={sessionProjections}
        sessionsHydrated={sessionsHydrated}
        selectedSessionId={null}
        onSelectedSessionIdChange={setSelectedSessionId}
      >
        {registryProjects.length === 0 ? null : (
          <section
            className="flex h-full min-h-0 min-w-0 flex-col items-center justify-center px-6 text-center"
            data-testid="project-not-found-state"
          >
            <h2 className="text-lg font-semibold text-foreground">Project not found</h2>
            <p className="mt-2 max-w-sm text-sm leading-6 text-muted">
              Choose an existing Project from the sidebar.
            </p>
          </section>
        )}
      </AppFrame>
    );
  }

  return (
    <AppFrame
      sessionProjections={sessionProjections}
      sessionsHydrated={sessionsHydrated}
      selectedSessionId={selectedSessionId}
      onSelectedSessionIdChange={setSelectedSessionId}
      toolbarActions={!showDraft && selectedSessionProjection ? (
        <SessionToolbarActions
          dockOpen={dockOpen}
          onDockOpenChange={setDockOpen}
        />
      ) : undefined}
    >
      <div
        className="flex h-full min-h-0 min-w-0 flex-col"
        data-testid={emptyChatDraft ? "empty-workspace-state" : undefined}
        onClick={(event) => {
          // Delegate within Chat only, covering settled and streaming Markdown
          // without coupling the shared renderer to Session/Dock state.
          if (event.defaultPrevented || showDraft || !selectedSessionProjection?.piSessionId || isChatProjectId(projectId)) return;
          const anchor = event.target instanceof Element
            ? event.target.closest<HTMLAnchorElement>('[data-slot="chat-conversation"] a[href]')
            : null;
          const cwd = selectedSessionProjection.checkout?.runtimeCwd ?? selectedSessionProjection.cwd;
          const link = anchor && cwd ? parseSessionChangeLink(anchor.getAttribute("href")!, cwd) : null;
          if (!link) return;
          event.preventDefault();
          setChangeTarget(null);
          setPendingChangeLink({ sessionId: selectedSessionProjection.id, link });
          sessionChanges.refresh();
        }}
      >
      <AgentWorkspaceSessionsView
        sessionChanges={sessionChanges}
        asideOpen={!showDraft && dockOpen}
        aside={
          !showDraft && dockMounted ? (
            <SessionDock
              activeSurfaceId={activeSurfaceId}
              badges={{
                changes: sessionChangesBadge(sessionChanges.changes),
                terminal:
                  terminalInstanceCount > 0 ? String(terminalInstanceCount) : undefined,
                browser: browserInstanceCount > 0 ? String(browserInstanceCount) : undefined,
              }}
              mountMotion
              isOpen={dockOpen}
              onActiveSurfaceChange={setActiveSurfaceId}
            >
              <SessionSurfaceContent
                docked
                changeTarget={changeTarget}
                sessionChanges={sessionChanges}
                surfaceId={activeSurfaceId}
                projection={selectedSessionProjection}
                onTerminalInstancesChange={handleTerminalInstancesChange}
                onBrowserInstancesChange={(tabs) => setBrowserInstanceCount(tabs.length)}
              />
            </SessionDock>
          ) : undefined
        }
        projectId={projectId}
        showDraft={showDraft}
        workspace={workspace}
        runtimeBridge={runtimeBridge}
        runtimeGeneration={backendGeneration}
        sessionProjection={selectedSessionProjection}
        onProjectionChange={handleProjectionChange}
        onSessionCreationStarted={enterLiveSession}
        onSessionCreated={enterLiveSession}
        onReopenDraft={handleReopenDraft}
        onLatestMessageRendered={handleLatestMessageRendered}
        onManageModels={() => openSettings("models")}
        onOpenProviderSettings={() => openSettings("providers")}
      />
      </div>
    </AppFrame>
  );
}

function firstSessionIdForProject(
  projections: SessionProjection[],
  projectId: string,
) {
  return (
    getSessionProjectionListItems(
      projections.filter((projection) => projection.projectId === projectId),
    )[0]?.id ?? null
  );
}
