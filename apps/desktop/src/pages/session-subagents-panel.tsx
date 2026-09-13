import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { IconButton } from "@astryxdesign/core/IconButton";
import { List, ListItem } from "@astryxdesign/core/List";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import {
  isSubagentActive,
  type AgentRuntimeEvent,
  type SubagentRecord,
} from "@pace/core";
import { subagentsClient } from "@/entities/runtime/subagents-client";
import { useSubagentSnapshot } from "@/entities/runtime/use-subagents";
import {
  subagentTrajectoryTurns,
  subagentTree,
} from "@/entities/runtime/subagents-view-model";
import {
  applyAgentRuntimeEvent,
  createSessionRuntimeModel,
} from "@/entities/session/session-runtime-model";
import { buildTrajectoryRuns } from "@/entities/session/trajectory-model";
import { ChatMarkdown } from "@/shared/ui/chat/chat-markdown";
import { ChatMessage } from "@/shared/ui/chat/chat-message";
import { PiTrajectoryLedger } from "@/shared/ui/pi-trajectory-ledger";
import {
  PiTrajectoryInspector,
  type TrajectoryInspectorTab,
} from "@/shared/ui/pi-trajectory-inspector";
import { SessionSurfaceBar } from "@/shared/ui/session-dock/surface-bar";
import { ArrowLeft, Bot, RefreshCw, Stop } from "@/shared/ui/icons";

type Props = {
  piSessionId: string | null;
  records: SubagentRecord[];
  available: boolean;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  selectedAgentId: string | null;
  onSelectedAgentChange: (id: string | null) => void;
  onParentNavigate: (record: SubagentRecord) => void;
  runtimeGeneration?: number;
};

function elapsed(record: SubagentRecord, now: number) {
  const seconds = Math.max(
    0,
    Math.floor(
      ((record.completedAt ??
        (isSubagentActive(record) ? now : record.startedAt)) -
        record.startedAt) /
        1000,
    ),
  );
  if (!record.completedAt && !isSubagentActive(record))
    return "Duration unavailable";
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : `${seconds}s`;
}

function usage(record: SubagentRecord) {
  if (!record.usage) return "Usage unavailable";
  const total =
    record.usage.input +
    record.usage.output +
    record.usage.cacheRead +
    record.usage.cacheWrite;
  const cost =
    record.usage.costUsd > 0 && record.usage.costUsd < 0.0001
      ? "<$0.0001"
      : `$${record.usage.costUsd.toFixed(4)}`;
  return `${new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(total)} tokens · ${cost}`;
}

function stateClass(record: SubagentRecord) {
  return record.status === "error"
    ? "text-danger"
    : record.status === "interrupted" || record.status === "stopping"
      ? "text-warning"
      : record.status === "completed"
        ? "text-success"
        : "text-muted";
}

export function SessionSubagentsPanel({
  piSessionId,
  records,
  available,
  loading,
  error,
  onRefresh,
  selectedAgentId,
  onSelectedAgentChange,
  onParentNavigate,
  runtimeGeneration = 0,
}: Props) {
  const detail = useSubagentSnapshot(
    piSessionId,
    selectedAgentId,
    runtimeGeneration,
  );
  const [tab, setTab] = useState<"conversation" | "trace">("conversation");
  const [stepId, setStepId] = useState<string>();
  const [inspectorTab, setInspectorTab] =
    useState<TrajectoryInspectorTab>("Summary");
  const controlGeneration = useRef(0);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<"stop" | "steer" | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const activeCount = records.filter(isSubagentActive).length;
  const record =
    records.find((item) => item.id === selectedAgentId) ?? detail.data?.record;
  const currentDetail =
    detail.data?.record.id === selectedAgentId ? detail.data : null;
  useEffect(() => {
    if (!activeCount) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeCount]);
  useEffect(() => {
    controlGeneration.current += 1;
    setStepId(undefined);
    setMessage("");
    setControlError(null);
    setPending(null);
  }, [piSessionId, selectedAgentId]);
  const model = useMemo(() => {
    let next = createSessionRuntimeModel();
    for (const envelope of currentDetail?.events ?? []) {
      if (
        envelope.payload.origin !== "sdk" &&
        envelope.payload.origin !== "rpc"
      )
        continue;
      next = applyAgentRuntimeEvent(next, {
        seq: envelope.seq,
        timestamp: envelope.ts,
        event: envelope.payload as unknown as AgentRuntimeEvent,
      });
    }
    return next;
  }, [currentDetail?.events]);
  const turns = useMemo(() => subagentTrajectoryTurns(model), [model]);
  const runs = useMemo(() => buildTrajectoryRuns(turns), [turns]);
  const selectedTurn = turns.find((turn) =>
    turn.steps.some((step) => step.id === stepId),
  );
  const selectedStep = selectedTurn?.steps.find((step) => step.id === stepId);
  const messages = [...model.messages.values()].filter((entry) =>
    entry.parts.some((part) => part.partType === "text" && part.body),
  );
  const control = async (action: "stop" | "steer") => {
    if (!piSessionId || !record || pending) return;
    const generation = controlGeneration.current;
    setPending(action);
    setControlError(null);
    try {
      if (action === "stop") await subagentsClient.stop(piSessionId, record.id);
      else {
        await subagentsClient.steer(piSessionId, record.id, message.trim());
        if (generation === controlGeneration.current) setMessage("");
      }
    } catch (failure) {
      if (generation === controlGeneration.current)
        setControlError(
          failure instanceof Error ? failure.message : String(failure),
        );
    } finally {
      if (generation === controlGeneration.current) setPending(null);
    }
  };
  return (
    <VStack
      gap={0}
      className="h-full min-h-0 min-w-0"
      data-testid="session-subagents-panel"
    >
      <SessionSurfaceBar
        actions={
          <IconButton
            label="Refresh subagents"
            icon={<RefreshCw className="size-4" />}
            size="sm"
            variant="ghost"
            isDisabled={loading || detail.loading}
            onClick={() => {
              onRefresh();
              detail.refresh();
            }}
          />
        }
      >
        {selectedAgentId ? (
          <IconButton
            label="All subagents"
            icon={<ArrowLeft className="size-4" />}
            size="sm"
            variant="ghost"
            onClick={() => onSelectedAgentChange(null)}
          />
        ) : null}
        <p className="truncate text-sm font-medium">
          {selectedAgentId && record ? record.type : "Subagents"}
        </p>
        {activeCount > 0 ? (
          <Token size="sm" label={`${activeCount} active`} />
        ) : null}
      </SessionSurfaceBar>
      {error ? (
        <p role="alert" className="px-4 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {!selectedAgentId ? (
        <VStack gap={0} className="min-h-0 flex-1 overflow-y-auto">
          {loading && !records.length ? (
            <p role="status" className="px-4 py-6 text-sm text-muted">
              Loading subagents…
            </p>
          ) : records.length ? (
            <List
              density="compact"
              header={<p className="sr-only">Subagent execution tree</p>}
            >
              {subagentTree(records).map(({ record: item, depth }) => (
                <ListItem
                  key={item.id}
                  label={item.type}
                  onClick={() => onSelectedAgentChange(item.id)}
                  startContent={<Bot className="size-4 text-muted" />}
                  endContent={
                    <Token
                      size="sm"
                      label={item.status}
                      className={stateClass(item)}
                    />
                  }
                  style={{
                    paddingInlineStart: `calc(var(--spacing-4) + ${depth} * var(--spacing-4))`,
                  }}
                  description={
                    <VStack gap={1}>
                      <p className="line-clamp-2 text-sm text-muted">
                        {item.description}
                      </p>
                      <p className="text-xs text-muted">
                        {item.currentTool ? `${item.currentTool} · ` : ""}
                        {elapsed(item, now)} · {usage(item)}
                      </p>
                      {item.workflowId ? (
                        <p className="text-xs text-muted">
                          Workflow {item.workflowId}
                        </p>
                      ) : null}
                    </VStack>
                  }
                />
              ))}
            </List>
          ) : !error ? (
            <HStack
              className="min-h-0 flex-1 px-6"
              hAlign="center"
              vAlign="center"
            >
              <EmptyState
                isCompact
                icon={<Bot className="size-6" />}
                title={available ? "No subagents yet" : "Subagents unavailable"}
                description={
                  available
                    ? "Delegated work will appear here. Closing this panel keeps it running."
                    : "Enable a supported subagent extension in this session to observe delegated work."
                }
              />
            </HStack>
          ) : null}
        </VStack>
      ) : (
        <VStack gap={0} className="min-h-0 flex-1">
          {record ? (
            <VStack
              gap={2}
              className="shrink-0 border-b border-separator px-4 py-3"
            >
              <HStack gap={2} vAlign="center" hAlign="between">
                <Button
                  label={
                    record.parentAgentId ? "Parent agent" : "Parent session"
                  }
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    record.parentAgentId
                      ? onSelectedAgentChange(record.parentAgentId)
                      : onParentNavigate(record)
                  }
                />
                <HStack gap={2} vAlign="center">
                  <Token
                    size="sm"
                    label={record.status}
                    className={stateClass(record)}
                  />
                  {record.capabilities.stop && isSubagentActive(record) ? (
                    <IconButton
                      label="Stop subagent"
                      icon={<Stop className="size-4" />}
                      size="sm"
                      variant="ghost"
                      isDisabled={
                        pending !== null || record.status === "stopping"
                      }
                      onClick={() => void control("stop")}
                    />
                  ) : null}
                </HStack>
              </HStack>
              <p className="text-sm text-foreground">{record.description}</p>
              <p className="text-xs text-muted">
                {record.model
                  ? `${record.model.provider} / ${record.model.id}`
                  : "Model unavailable"}
                {record.thinkingLevel ? ` · ${record.thinkingLevel}` : ""}
              </p>
              <p className="text-xs text-muted">
                {record.currentTool ? `${record.currentTool} · ` : ""}
                {record.toolUses} tools · {elapsed(record, now)} ·{" "}
                {usage(record)}
              </p>
              {record.status === "interrupted" ? (
                <p className="text-sm text-warning">
                  The runtime ended before this subagent finished. Recorded
                  history is preserved.
                </p>
              ) : null}
              {record.error ? (
                <p role="alert" className="text-sm text-danger">
                  {record.error}
                </p>
              ) : null}
            </VStack>
          ) : null}
          {controlError || detail.error ? (
            <p role="alert" className="px-4 py-2 text-sm text-danger">
              {controlError ?? detail.error}
            </p>
          ) : null}
          <HStack
            gap={1}
            className="shrink-0 px-3 py-2"
            aria-label="Subagent view"
          >
            <Button
              label="Conversation"
              size="sm"
              variant={tab === "conversation" ? "secondary" : "ghost"}
              aria-pressed={tab === "conversation"}
              onClick={() => setTab("conversation")}
            />
            <Button
              label="Trace"
              size="sm"
              variant={tab === "trace" ? "secondary" : "ghost"}
              aria-pressed={tab === "trace"}
              onClick={() => setTab("trace")}
            />
          </HStack>
          {detail.loading && !currentDetail ? (
            <p role="status" className="px-4 py-3 text-sm text-muted">
              Loading subagent history…
            </p>
          ) : tab === "conversation" ? (
            <VStack
              gap={4}
              className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
              data-testid="subagent-conversation"
            >
              {messages.map((entry) =>
                entry.role === "user" ? (
                  <ChatMessage.User key={entry.messageId}>
                    <ChatMessage.Bubble>
                      <ChatMessage.Content>
                        {entry.parts
                          .filter((part) => part.partType === "text")
                          .map((part) => part.body)
                          .join("\n")}
                      </ChatMessage.Content>
                    </ChatMessage.Bubble>
                  </ChatMessage.User>
                ) : (
                  <ChatMessage.Assistant key={entry.messageId}>
                    <ChatMessage.Body>
                      <ChatMessage.Content>
                        <ChatMarkdown>
                          {entry.parts
                            .filter((part) => part.partType === "text")
                            .map((part) => part.body)
                            .join("\n")}
                        </ChatMarkdown>
                      </ChatMessage.Content>
                    </ChatMessage.Body>
                  </ChatMessage.Assistant>
                ),
              )}
              {!messages.length ? (
                <EmptyState
                  isCompact
                  title="No conversation recorded"
                  description={
                    record && isSubagentActive(record)
                      ? "Waiting for the subagent. Open Trace to inspect tool activity."
                      : "Conversation content is unavailable for this execution."
                  }
                />
              ) : null}
              {record?.result && !messages.length ? (
                <ChatMarkdown>{record.result}</ChatMarkdown>
              ) : null}
            </VStack>
          ) : (
            <VStack
              gap={0}
              className="min-h-0 flex-1 overflow-y-auto"
              data-testid="subagent-trace"
            >
              {turns.length ? (
                <PiTrajectoryLedger
                  runs={runs}
                  selectedStepId={stepId}
                  onSelectedStepChange={setStepId}
                />
              ) : (
                <EmptyState
                  isCompact
                  title="No trace recorded"
                  description="Recorded model and tool events will appear here."
                />
              )}
              {selectedStep?.isRunning && selectedStep.output !== undefined ? (
                <p role="status" className="px-4 py-2 text-xs text-muted">
                  Partial output · tool is still running.
                </p>
              ) : null}
              {selectedStep && selectedTurn ? (
                <PiTrajectoryInspector
                  step={selectedStep}
                  turn={selectedTurn}
                  tab={inspectorTab}
                  onTabChange={setInspectorTab}
                  onClose={() => setStepId(undefined)}
                  schema={
                    selectedStep.name
                      ? currentDetail?.toolSchemas.schemas[selectedStep.name]
                      : undefined
                  }
                />
              ) : null}
            </VStack>
          )}
          {record?.capabilities.steer && isSubagentActive(record) ? (
            <VStack
              gap={2}
              className="shrink-0 border-t border-separator px-4 py-3"
            >
              <TextArea
                label="Message to subagent"
                value={message}
                onChange={setMessage}
                rows={2}
                size="sm"
                isDisabled={pending !== null || record.status === "stopping"}
              />
              <Button
                label="Send to subagent"
                size="sm"
                isDisabled={
                  !message.trim() ||
                  pending !== null ||
                  record.status === "stopping"
                }
                onClick={() => void control("steer")}
              />
            </VStack>
          ) : null}
        </VStack>
      )}
    </VStack>
  );
}
