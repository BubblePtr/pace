import { cloneElement, type ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RuntimeModelControls } from "@pace/core";
import type { TrajectoryRun, TrajectoryStep, TrajectoryTurn } from "@/entities/session/trajectory-model";
import { BrowserSurface } from "@/shared/ui/browser/browser-surface";
import { ChatChainOfThought } from "@/shared/ui/chat/chat-chain-of-thought";
import { ChatChainOfThoughtRail } from "@/shared/ui/chat/chat-chain-of-thought-rail";
import { ChatCodeBlock } from "@/shared/ui/chat/chat-code-block";
import { ChatConversation } from "@/shared/ui/chat/chat-conversation";
import { ChatInlinePager } from "@/shared/ui/chat/chat-inline-pager";
import { ChatMarkdown, ChatStreamMarkdown } from "@/shared/ui/chat/chat-markdown";
import { ChatMessage, ChatMessageActions } from "@/shared/ui/chat/chat-message";
import { ChatPixelLoader } from "@/shared/ui/chat/chat-pixel-loader";
import { ChatPromptInput } from "@/shared/ui/chat/chat-prompt-input";
import { ChatPromptSuggestion } from "@/shared/ui/chat/chat-prompt-suggestion";
import { ChatQueuedMessage } from "@/shared/ui/chat/chat-queued-message";
import { ChatRunFailure } from "@/shared/ui/chat/chat-run-failure";
import { ChatStatusLine } from "@/shared/ui/chat/chat-status-line";
import { ChatThoughtMarkdown } from "@/shared/ui/chat/chat-thought-markdown";
import { ChatThoughtStep } from "@/shared/ui/chat/chat-thought-step";
import { ChatTool, ChatToolDetail, ChatToolGroup } from "@/shared/ui/chat/chat-tool";
import { ChatToolKindIcon } from "@/shared/ui/chat/chat-tool-kind";
import { ChatToolStep } from "@/shared/ui/chat/chat-tool-step";
import { TextShimmer } from "@/shared/ui/chat/text-shimmer";
import { ComposerAttachmentDrawer } from "@/shared/ui/composer-attachments/composer-attachment-drawer";
import { ComposerInsertMenu } from "@/shared/ui/composer-attachments/composer-insert-menu";
import { ContextUsageMeter } from "@/shared/ui/context-usage-meter";
import { DotMatrix } from "@/shared/ui/dot-matrix";
import { Activity, AnimatedHistory } from "@/shared/ui/icons";
import { ModelSelectorControl } from "@/shared/ui/model-selector/model-selector-control";
import { PiHeatmap } from "@/shared/ui/pi-heatmap";
import { PiKpi } from "@/shared/ui/pi-kpi";
import { PiLineChart, PiSparkline } from "@/shared/ui/pi-line-chart";
import { PiTrajectoryInspector } from "@/shared/ui/pi-trajectory-inspector";
import { PiTrajectoryLedger, TrajectoryStepBadge } from "@/shared/ui/pi-trajectory-ledger";
import { PiTrajectoryStrip } from "@/shared/ui/pi-trajectory-strip";
import { SessionDock, SessionDockTrigger } from "@/shared/ui/session-dock/session-dock";
import { SessionSurfaceBar, SessionSurfaceTabs } from "@/shared/ui/session-dock/surface-bar";
import { TerminalView } from "@/shared/ui/terminal/terminal-view";

const PROBE_CLASS = "contract-probe";
const PROBE_TESTID = "contract-root";

function noop() {}

function renderProbed(
  element: ReactElement,
  host?: (node: ReactElement) => ReactElement,
) {
  const probed = cloneElement(element, {
    className: PROBE_CLASS,
    "data-testid": PROBE_TESTID,
  } as never);
  return render(host ? host(probed) : probed);
}

const modelControls: RuntimeModelControls = {
  models: [
    {
      provider: "xai",
      modelId: "grok-4",
      name: "Grok 4",
      thinkingLevels: ["off", "high"],
    },
  ],
  selected: {
    provider: "xai",
    modelId: "grok-4",
    thinkingLevel: "high",
  },
};

const ledgerStep: TrajectoryStep = {
  id: "s1",
  turnIndex: 0,
  stepIndex: 0,
  kind: "text",
  text: "hello",
};

const ledgerTurn: TrajectoryTurn = {
  index: 0,
  runIndex: 0,
  role: "user",
  label: "User",
  hasError: false,
  toolCount: 0,
  steps: [ledgerStep],
};

const ledgerRun: TrajectoryRun = {
  index: 0,
  turns: [ledgerTurn],
  timestamp: "2026-03-22T14:41:00.000Z",
  costUsd: 0,
  totalTokens: 0,
  hasError: false,
};

const inspectorTurn: TrajectoryTurn = {
  index: 0,
  runIndex: 0,
  role: "assistant",
  label: "Assistant",
  model: "grok-4",
  hasError: false,
  toolCount: 1,
  steps: [],
};

const cases: Array<{
  name: string;
  ui: ReactElement;
  host?: (node: ReactElement) => ReactElement;
}> = [
  { name: "Activity", ui: <Activity /> },
  { name: "DotMatrix", ui: <DotMatrix /> },
  { name: "PiKpi", ui: <PiKpi label="Cost" value={1} /> },
  { name: "PiLineChart", ui: <PiLineChart aria-label="Trend" points={[]} /> },
  { name: "PiSparkline", ui: <PiSparkline values={[1, 2]} /> },
  {
    name: "PiHeatmap",
    ui: <PiHeatmap aria-label="Grid" cellLabel={() => "cell"} columns={[{ key: "0" }]} levelOf={() => 0} rows={[{ key: "r" }]} values={[[0]]} />,
  },
  { name: "ContextUsageMeter", ui: <ContextUsageMeter usage={null} /> },
  {
    name: "TrajectoryStepBadge",
    ui: <TrajectoryStepBadge type={{ label: "tool", color: "var(--pigui-data-orange)" }} />,
  },
  { name: "PiTrajectoryLedger", ui: <PiTrajectoryLedger runs={[]} /> },
  {
    name: "PiTrajectoryLedger.Run",
    ui: <PiTrajectoryLedger.Run run={ledgerRun} />,
    host: (node) => <PiTrajectoryLedger>{node}</PiTrajectoryLedger>,
  },
  {
    name: "PiTrajectoryStrip",
    ui: (
      <PiTrajectoryStrip
        turns={[]}
        widthMode="steps"
        onSelect={noop}
        onWidthModeChange={noop}
      />
    ),
  },
  {
    name: "PiTrajectoryInspector",
    ui: (
      <PiTrajectoryInspector
        step={ledgerStep}
        turn={inspectorTurn}
        tab="Summary"
        onTabChange={noop}
        onClose={noop}
      />
    ),
  },
  {
    name: "BrowserSurface",
    ui: (
      <BrowserSurface state={{ kind: "live" }}>
        <p>surface</p>
      </BrowserSurface>
    ),
  },
  {
    name: "SessionDock",
    ui: (
      <SessionDock activeSurfaceId="changes" onActiveSurfaceChange={noop}>
        <p>surface</p>
      </SessionDock>
    ),
  },
  {
    name: "SessionDockTrigger",
    ui: <SessionDockTrigger isOpen={false} onOpenChange={noop} />,
  },
  {
    name: "SessionSurfaceBar",
    ui: <SessionSurfaceBar>status</SessionSurfaceBar>,
  },
  {
    name: "SessionSurfaceTabs",
    ui: (
      <SessionSurfaceTabs
        activeId="a"
        addLabel="New tab"
        icon={Activity}
        items={[{ id: "a", label: "Tab 1" }]}
        aria-label="Instances"
        onActiveChange={noop}
        onAdd={noop}
        onClose={noop}
      />
    ),
  },
  {
    name: "ModelSelectorControl",
    ui: (
      <ModelSelectorControl controls={modelControls} isDisabled={false} onChange={noop} />
    ),
  },
  {
    name: "ComposerAttachmentDrawer",
    ui: (
      <ComposerAttachmentDrawer
        items={[{ id: "1", kind: "text", name: "notes.md" }]}
        onRemove={noop}
      />
    ),
  },
  {
    name: "ComposerInsertMenu",
    ui: <ComposerInsertMenu onAttach={noop} onInsert={noop} />,
  },
  { name: "TerminalView", ui: <TerminalView /> },
  { name: "ChatQueuedMessage", ui: <ChatQueuedMessage body="queued" /> },
  { name: "ChatRunFailure", ui: <ChatRunFailure error="boom" /> },
  { name: "ChatThoughtMarkdown", ui: <ChatThoughtMarkdown text="thought" /> },
  {
    name: "ChatToolDetail",
    ui: <ChatToolDetail tool={{ state: "output-available", argsText: "{}" }} />,
  },
  {
    name: "ChatTool",
    ui: <ChatTool state="input-streaming" toolName="search" />,
  },
  {
    name: "ChatToolGroup",
    ui: <ChatToolGroup tools={[{ state: "input-streaming", toolName: "search" }]} />,
  },
  {
    name: "ChatConversation",
    ui: (
      <ChatConversation>
        <p>hello</p>
      </ChatConversation>
    ),
  },
  {
    name: "ChatConversation.Content",
    ui: (
      <ChatConversation.Content>
        <p>hello</p>
      </ChatConversation.Content>
    ),
  },
  { name: "ChatMessage.User", ui: <ChatMessage.User>hi</ChatMessage.User> },
  { name: "ChatMessage.Assistant", ui: <ChatMessage.Assistant>hi</ChatMessage.Assistant> },
  { name: "ChatMessage.Bubble", ui: <ChatMessage.Bubble>hi</ChatMessage.Bubble> },
  { name: "ChatMessage.Body", ui: <ChatMessage.Body>hi</ChatMessage.Body> },
  { name: "ChatMessage.Content", ui: <ChatMessage.Content>hi</ChatMessage.Content> },
  {
    name: "ChatMessage.Action",
    ui: <ChatMessage.Action aria-label="Act">x</ChatMessage.Action>,
  },
  { name: "ChatMessageActions", ui: <ChatMessageActions>x</ChatMessageActions> },
  { name: "ChatPromptInput", ui: <ChatPromptInput value="" /> },
  { name: "ChatPromptSuggestion", ui: <ChatPromptSuggestion>hint</ChatPromptSuggestion> },
  {
    name: "ChatPromptSuggestion.Items",
    ui: <ChatPromptSuggestion.Items>items</ChatPromptSuggestion.Items>,
  },
  {
    name: "ChatPromptSuggestion.Item",
    ui: <ChatPromptSuggestion.Item>Try this</ChatPromptSuggestion.Item>,
  },
  { name: "ChatChainOfThought", ui: <ChatChainOfThought phase="settled" /> },
  {
    name: "ChatChainOfThoughtRail",
    ui: <ChatChainOfThoughtRail parts={[]} summary="Thought" />,
  },
  { name: "ChatPixelLoader", ui: <ChatPixelLoader /> },
  { name: "ChatInlinePager", ui: <ChatInlinePager>page</ChatInlinePager> },
  {
    name: "ChatThoughtStep",
    ui: <ChatThoughtStep step={{ kind: "thinking", id: "t1", live: false, text: "" }} />,
  },
  {
    name: "ChatToolStep",
    ui: (
      <ChatToolStep
        step={{
          kind: "tools",
          id: "s1",
          live: false,
          tools: [{ state: "output-available", toolName: "bash" }],
        }}
      />
    ),
  },
  { name: "AnimatedHistory", ui: <AnimatedHistory /> },
  { name: "ChatToolKindIcon", ui: <ChatToolKindIcon kind="tool" /> },
  { name: "ChatStatusLine", ui: <ChatStatusLine phase="thinking" /> },
  { name: "TextShimmer", ui: <TextShimmer>loading</TextShimmer> },
  { name: "ChatCodeBlock", ui: <ChatCodeBlock code="const x = 1;" /> },
  { name: "ChatMarkdown", ui: <ChatMarkdown>hello</ChatMarkdown> },
  { name: "ChatStreamMarkdown", ui: <ChatStreamMarkdown>hello</ChatStreamMarkdown> },
];

describe("shared/ui contract", () => {
  it.each(cases)("$name forwards className and data-testid to the root", ({ ui, host }) => {
    renderProbed(ui, host);
    const root = screen.getByTestId(PROBE_TESTID);
    expect(root).toHaveClass(PROBE_CLASS);
  });

  it("does not leak unknown PiTrajectoryLedger props onto Run", () => {
    render(
      cloneElement(<PiTrajectoryLedger runs={[ledgerRun]} selectedStepId="s1" />, {
        className: PROBE_CLASS,
        "data-testid": PROBE_TESTID,
        "data-contract-probe": "ledger",
      } as never),
    );

    expect(screen.getByTestId(PROBE_TESTID)).toHaveAttribute("data-contract-probe", "ledger");
    expect(document.querySelector('[data-slot="trajectory-ledger-run"]')).not.toHaveAttribute(
      "data-contract-probe",
    );
  });

  it("renders Schema tab copy in English", () => {
    const textStep: TrajectoryStep = {
      id: "text-1",
      turnIndex: 0,
      stepIndex: 0,
      kind: "text",
      text: "hi",
    };
    const { rerender } = render(
      <PiTrajectoryInspector
        step={textStep}
        turn={inspectorTurn}
        tab="Schema"
        onTabChange={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByText("This is not a tool step.")).toBeInTheDocument();

    rerender(
      <PiTrajectoryInspector
        step={{ ...textStep, kind: "tool", name: "bash" }}
        turn={inspectorTurn}
        tab="Schema"
        onTabChange={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByText(/This tool's current definition is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("参数")).not.toBeInTheDocument();
  });
});
