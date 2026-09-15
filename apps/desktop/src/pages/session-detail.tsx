import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@/shared/runtime";
import {
  buildTrajectoryRuns,
  buildTrajectoryTurns,
  emptyTrajectoryFilter,
  isTrajectoryFilterActive,
  trajectoryStepMatches,
  type TrajectoryFilter,
  type TrajectoryStep,
} from "@/entities/session/trajectory-model";
import { PiTrajectoryLedger } from "@/shared/ui/pi-trajectory-ledger";
import {
  PiTrajectoryInspector,
  type TrajectoryInspectorTab,
  type TrajectoryToolSchema,
} from "@/shared/ui/pi-trajectory-inspector";
import {
  PiTrajectoryStrip,
  stripSegmentsFromTurns,
  type SegmentRange,
  type StripSegment,
  type StripWidthMode,
} from "@/shared/ui/pi-trajectory-strip";
import type { RuntimeToolSchemas, SessionDetail, SessionTurn, SubagentLookup } from "@pace/core";
import { indexSubagentRecords, lookupSubagentByOwnerToolCallId } from "@pace/core";
import { tintinwebSubagentShim } from "@pace/backend/subagent";
import { listSessions } from "@/entities/session/sessions";

export type {
  SessionContentPart,
  TokenUsage,
  CostBreakdown,
  SessionTurn,
  SessionDetail,
} from "@pace/core";

const filterableKinds = ["tool", "think", "text", "image", "config"];

function formatTokens(value: number) {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatCost(value: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function getSessionDetail(sessionId: string) {
  return invoke<SessionDetail>("get_session_detail", { id: sessionId });
}

function getToolSchemas(piSessionId: string, names: string[]) {
  return invoke<RuntimeToolSchemas>("resolve_tool_schemas", {
    piSessionId,
    names,
  });
}

function toolNamesFromSession(session?: SessionDetail) {
  const names = new Set<string>();

  for (const turn of session?.turns ?? []) {
    for (const part of turn.parts) {
      if (part.partType === "toolCall" && part.name) {
        names.add(part.name);
      }
    }
  }

  return [...names].sort();
}

function stepIdsInSegmentRange(segments: StripSegment[], range: SegmentRange) {
  const ids: string[] = [];
  for (let index = range[0]; index <= range[1]; index += 1) {
    ids.push(...(segments[index]?.stepIds ?? []));
  }
  return ids;
}

function playheadInFocusedSteps(stepIds: string[], visibleIds: Set<string>, preferred?: string) {
  if (preferred && stepIds.includes(preferred) && visibleIds.has(preferred)) {
    return preferred;
  }
  return stepIds.find((id) => visibleIds.has(id)) ?? preferred ?? stepIds[0];
}

function focusChipLabel(segments: StripSegment[], range: SegmentRange) {
  const start = segments[range[0]];
  if (!start) {
    return "focus ✕";
  }
  if (range[0] === range[1]) {
    return `focus #${start.runIndex + 1} ${start.lane} ✕`;
  }
  return `focus ${range[1] - range[0] + 1} segments ✕`;
}

function FilterChip({
  label,
  isActive,
  onToggle,
}: {
  label: string;
  isActive: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      aria-pressed={isActive}
      className={`cursor-pointer rounded-full border px-2 py-0.5 font-mono text-[11px] transition-colors ${
        isActive
          ? "border-transparent bg-foreground text-background"
          : "border-border text-muted hover:bg-surface-hover hover:text-foreground"
      }`}
      type="button"
      onClick={onToggle}
    >
      {label}
    </button>
  );
}

/**
 * The Trajectory Cockpit: Strip (overview band) + filter bar + Ledger (left,
 * virtualized by Active Run) + Inspector (right, resizable). Interaction
 * semantics: Strip brush = focus (dims, never filters); the filter bar =
 * true filter (rows drop out); the Playhead (selected step, ↑/↓) walks the
 * visible steps inside the focused segment range.
 */
export function SessionDetailView({
  session,
  sessionId,
  isLoading = false,
  isError = false,
  toolSchemas,
  subagentsByOwnerToolCallId,
  indexedSessionIds,
  onOpenChildSession,
}: {
  session?: SessionDetail;
  sessionId: string;
  isLoading?: boolean;
  isError?: boolean;
  toolSchemas?: Record<string, TrajectoryToolSchema>;
  subagentsByOwnerToolCallId?: SubagentLookup;
  indexedSessionIds?: ReadonlySet<string>;
  onOpenChildSession?: (sessionId: string) => void;
}) {
  const turns = useMemo(() => buildTrajectoryTurns(session?.turns ?? []), [session?.turns]);
  const runs = useMemo(() => buildTrajectoryRuns(turns), [turns]);
  const segments = useMemo(() => stripSegmentsFromTurns(turns), [turns]);

  const [filter, setFilter] = useState<TrajectoryFilter>(emptyTrajectoryFilter);
  // Video-editing semantics: the brushed segment range focuses (dims the
  // rest); it does not filter rows out. Kept separate from the true filters.
  const [focusRange, setFocusRange] = useState<SegmentRange | undefined>(undefined);
  const [stripWidthMode, setStripWidthMode] = useState<StripWidthMode>("steps");
  const [selectedStepId, setSelectedStepId] = useState<string | undefined>(undefined);
  const [tab, setTab] = useState<TrajectoryInspectorTab>("Summary");
  const [inspectorWidth, setInspectorWidth] = useState(384);
  const [isInspectorCollapsed, setIsInspectorCollapsed] = useState(false);

  const scrollBodyRef = useRef<HTMLDivElement>(null);
  const stepRefs = useRef(new Map<string, HTMLButtonElement>());
  const turnRefs = useRef(new Map<number, HTMLDivElement>());
  const resizeState = useRef<{ startX: number; startWidth: number } | undefined>(undefined);
  // Pin the jump target in the virtual window. scrollToIndex clamps to 0 when
  // the scroller has no layout yet (jsdom, first paint), so scrollIntoView
  // would otherwise have nothing to find.
  const pendingRevealIndex = useRef<number | null>(null);
  const [, setRevealGeneration] = useState(0);

  const allSteps = useMemo(() => turns.flatMap((turn) => turn.steps), [turns]);
  const visibleSteps = useMemo(
    () => allSteps.filter((step) => trajectoryStepMatches(step, filter)),
    [allSteps, filter],
  );
  const visibleIds = useMemo(() => new Set(visibleSteps.map((step) => step.id)), [visibleSteps]);
  const stepFilter = useMemo(
    () => (step: TrajectoryStep) => visibleIds.has(step.id),
    [visibleIds],
  );
  // The Playhead walks the steps inside the focused segment range.
  const focusedStepIds = useMemo(() => {
    if (!focusRange) {
      return undefined;
    }
    const ids = new Set<string>();
    for (let index = focusRange[0]; index <= focusRange[1]; index += 1) {
      for (const stepId of segments[index]?.stepIds ?? []) {
        ids.add(stepId);
      }
    }
    return ids.size > 0 ? ids : undefined;
  }, [focusRange, segments]);
  const walkableSteps = useMemo(
    () =>
      focusedStepIds
        ? visibleSteps.filter((step) => focusedStepIds.has(step.id))
        : visibleSteps,
    [visibleSteps, focusedStepIds],
  );

  const visibleRuns = useMemo(
    () => runs.filter((run) => run.turns.some((turn) => turn.steps.some(stepFilter))),
    [runs, stepFilter],
  );

  const selectedStep = allSteps.find((step) => step.id === selectedStepId);
  const selectedTurn = selectedStep ? turns[selectedStep.turnIndex] : undefined;
  const selectedSubagent = lookupSubagentByOwnerToolCallId(
    subagentsByOwnerToolCallId,
    selectedStep?.toolCallId,
  );
  const childSession =
    selectedStep?.name === "Agent" && selectedSubagent?.childSessionId
      ? {
          id: selectedSubagent.childSessionId,
          isAvailable: indexedSessionIds?.has(selectedSubagent.childSessionId) ?? false,
        }
      : undefined;

  function isRunDimmed(runIndex: number) {
    if (!focusRange) {
      return false;
    }
    for (let index = focusRange[0]; index <= focusRange[1]; index += 1) {
      if (segments[index]?.runIndex === runIndex) {
        return false;
      }
    }
    return true;
  }

  // Inspector resize: pointer-drag on the divider, double-click collapses.
  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    resizeState.current = { startX: event.clientX, startWidth: inspectorWidth };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events (tests, automation) have no active pointer.
    }
  }

  function moveResize(event: React.PointerEvent<HTMLDivElement>) {
    const state = resizeState.current;
    if (!state) {
      return;
    }
    const delta = state.startX - event.clientX;
    setInspectorWidth(Math.min(640, Math.max(280, state.startWidth + delta)));
    if (isInspectorCollapsed) {
      setIsInspectorCollapsed(false);
    }
  }

  function endResize() {
    resizeState.current = undefined;
  }

  const rowVirtualizer = useVirtualizer({
    count: visibleRuns.length,
    getScrollElement: () => scrollBodyRef.current,
    estimateSize: () => 160,
    measureElement: (element) => element.getBoundingClientRect().height || 160,
    overscan: 4,
    getItemKey: (index) => visibleRuns[index].index,
    initialOffset: 0,
    initialRect: { width: 0, height: 720 },
    observeElementRect: (instance, callback) => {
      const element = instance.scrollElement;
      if (!element) {
        callback({ width: 0, height: 720 });
        return () => {};
      }

      const observer = new ResizeObserver(() => {
        const rect = element.getBoundingClientRect();
        callback({
          width: rect.width || 0,
          height: rect.height || 720,
        });
      });
      observer.observe(element);
      return () => observer.disconnect();
    },
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      const pinned = pendingRevealIndex.current;
      if (pinned !== null && pinned >= 0 && pinned < range.count && !indexes.includes(pinned)) {
        indexes.push(pinned);
        indexes.sort((a, b) => a - b);
      }
      return indexes;
    },
  });

  const revealLedgerTarget = useCallback(
    (input: { runIndex: number; stepId?: string; turnIndex?: number }) => {
      const virtualIndex = visibleRuns.findIndex((run) => run.index === input.runIndex);
      if (virtualIndex >= 0) {
        pendingRevealIndex.current = virtualIndex;
        setRevealGeneration((generation) => generation + 1);
        rowVirtualizer.scrollToIndex(virtualIndex, { align: "start" });
      }
      requestAnimationFrame(() => {
        if (input.stepId) {
          stepRefs.current.get(input.stepId)?.scrollIntoView?.({ block: "nearest" });
          return;
        }
        if (input.turnIndex !== undefined) {
          turnRefs.current.get(input.turnIndex)?.scrollIntoView?.({ block: "start" });
        }
      });
    },
    [rowVirtualizer, visibleRuns],
  );

  // ArrowUp/ArrowDown walk the visible steps, respecting filter and focus.
  // Empty/loading views have no walkable steps — leave page scroll alone.
  useEffect(() => {
    if (walkableSteps.length === 0) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)
      ) {
        return;
      }
      const index = walkableSteps.findIndex((step) => step.id === selectedStepId);
      const nextIndex =
        index === -1
          ? 0
          : Math.min(
              Math.max(index + (event.key === "ArrowDown" ? 1 : -1), 0),
              walkableSteps.length - 1,
            );
      const next = walkableSteps[nextIndex];
      if (!next) {
        return;
      }
      event.preventDefault();
      revealLedgerTarget({
        runIndex: turns[next.turnIndex].runIndex,
        stepId: next.id,
      });
      setSelectedStepId(next.id);
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [revealLedgerTarget, selectedStepId, turns, walkableSteps]);

  if (isLoading || isError || !session || session.turns.length === 0) {
    return (
      <article
        className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
        data-testid="session-detail-view"
      >
        <EmptyState
          className="px-4 py-12"
          isCompact
          title={
            isLoading
              ? "Loading session..."
              : isError
                ? "Could not read this session."
                : "No timeline entries found."
          }
        />
      </article>
    );
  }

  return (
    <article
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-testid="session-detail-view"
    >
      <header className="shrink-0 border-b border-separator px-5 pt-3">
        <div className="flex items-baseline justify-between gap-4">
          <p className="min-w-0 truncate font-mono text-xs text-muted" title={sessionId}>{sessionId}</p>
          <p className="shrink-0 text-xs tabular-nums text-muted" data-slot="trajectory-tally">
            {formatCost(session.totalCostUsd)} · {formatTokens(session.totalTokens)} tokens ·{" "}
            {runs.length} runs
          </p>
        </div>
        {/* Full-bleed strip band: edge-to-edge, bounded by full-width rules. */}
        <div className="-mx-5 mt-3 border-t border-border bg-surface-muted/25 px-5 py-2">
          <PiTrajectoryStrip
            selectedStepId={selectedStepId}
            selectedRange={focusRange}
            turns={turns}
            widthMode={stripWidthMode}
            onBrush={(range) => {
              setFocusRange(range);
              if (!range) {
                return;
              }
              const segment = segments[range[0]];
              const target = playheadInFocusedSteps(stepIdsInSegmentRange(segments, range), visibleIds);
              if (segment) {
                revealLedgerTarget({
                  runIndex: segment.runIndex,
                  stepId: target,
                  turnIndex: segment.turnIndex,
                });
              }
              if (target) {
                setSelectedStepId(target);
              }
            }}
            onSelect={(turnIndex, stepId) => {
              const segment = segments.find(
                (entry) =>
                  entry.turnIndex === turnIndex && (stepId === undefined || entry.stepIds.includes(stepId)),
              );
              const target = playheadInFocusedSteps(segment?.stepIds ?? [], visibleIds, stepId);
              revealLedgerTarget({
                runIndex: turns[turnIndex].runIndex,
                stepId: target,
                turnIndex,
              });
              if (target) {
                setSelectedStepId(target);
              }
            }}
            onWidthModeChange={setStripWidthMode}
          />
        </div>
      </header>

      <div
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-2"
        data-slot="trajectory-filter-bar"
      >
        <input
          className="h-6 w-48 rounded border border-border bg-surface px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted focus-visible:border-primary"
          placeholder="Filter steps…"
          type="search"
          value={filter.query}
          onChange={(event) => setFilter((current) => ({ ...current, query: event.target.value }))}
        />
        <span aria-hidden="true" className="h-4 w-px bg-border" />
        {filterableKinds.map((kind) => (
          <FilterChip
            isActive={filter.kinds.has(kind)}
            key={kind}
            label={kind}
            onToggle={() =>
              setFilter((current) => {
                const kinds = new Set(current.kinds);
                if (kinds.has(kind)) {
                  kinds.delete(kind);
                } else {
                  kinds.add(kind);
                }
                return { ...current, kinds };
              })
            }
          />
        ))}
        <span aria-hidden="true" className="h-4 w-px bg-border" />
        <FilterChip
          isActive={filter.errorsOnly}
          label="errors"
          onToggle={() =>
            setFilter((current) => ({ ...current, errorsOnly: !current.errorsOnly }))
          }
        />
        {focusRange ? (
          <FilterChip
            isActive
            label={focusChipLabel(segments, focusRange)}
            onToggle={() => setFocusRange(undefined)}
          />
        ) : null}
        {isTrajectoryFilterActive(filter) || focusRange ? (
          <button
            className="cursor-pointer font-mono text-[11px] text-muted underline-offset-2 transition-colors hover:text-foreground hover:underline"
            type="button"
            onClick={() => {
              setFilter(emptyTrajectoryFilter);
              setFocusRange(undefined);
            }}
          >
            clear
          </button>
        ) : null}
        <span className="ml-auto font-mono text-[11px] tabular-nums text-muted">
          {visibleSteps.length} / {allSteps.length} steps
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto pb-24"
          data-testid="session-detail-scroll-body"
          ref={scrollBodyRef}
        >
          {visibleSteps.length === 0 ? (
            <p className="px-4 py-10 text-center font-mono text-xs text-muted">
              No steps match the current filters.
            </p>
          ) : (
            <PiTrajectoryLedger
              isStepDimmed={
                focusedStepIds ? (step) => !focusedStepIds.has(step.id) : undefined
              }
              registerStepRef={(stepId, element) => {
                if (element) {
                  stepRefs.current.set(stepId, element);
                } else {
                  stepRefs.current.delete(stepId);
                }
              }}
              registerTurnRef={(turnIndex, element) => {
                if (element) {
                  turnRefs.current.set(turnIndex, element);
                } else {
                  turnRefs.current.delete(turnIndex);
                }
              }}
              selectedStepId={selectedStepId}
              stepFilter={stepFilter}
              onSelectedStepChange={setSelectedStepId}
            >
              <ol
                className="relative"
                data-testid="timeline-viewport"
                style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const run = visibleRuns[virtualRow.index];
                  // Layout offsets keep sticky Run headers in the scroller's coordinate space.
                  return (
                    <li
                      className="absolute left-0 w-full"
                      data-index={virtualRow.index}
                      key={virtualRow.key}
                      ref={rowVirtualizer.measureElement}
                      style={{ top: virtualRow.start }}
                    >
                      <PiTrajectoryLedger.Run
                        isDimmed={isRunDimmed(run.index)}
                        run={run}
                      />
                    </li>
                  );
                })}
              </ol>
            </PiTrajectoryLedger>
          )}
        </div>

        <div
          aria-label="Resize inspector"
          className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary"
          data-slot="trajectory-inspector-handle"
          role="separator"
          title="Drag to resize · double-click to collapse"
          onDoubleClick={() => setIsInspectorCollapsed((value) => !value)}
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
        />

        {isInspectorCollapsed ? null : (
          <aside className="shrink-0 bg-surface" style={{ width: inspectorWidth }}>
            {selectedStep && selectedTurn ? (
              <PiTrajectoryInspector
                childSession={childSession}
                schema={selectedStep.name ? toolSchemas?.[selectedStep.name] : undefined}
                step={selectedStep}
                tab={tab}
                turn={selectedTurn}
                onClose={() => setSelectedStepId(undefined)}
                onOpenChildSession={
                  childSession
                    ? () => onOpenChildSession?.(childSession.id)
                    : undefined
                }
                onTabChange={setTab}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6">
                <p className="text-center text-xs leading-5 text-muted">
                  Select a step to inspect it.
                  <br />
                  Use ↑ / ↓ to walk the trajectory.
                </p>
              </div>
            )}
          </aside>
        )}
      </div>
    </article>
  );
}

export function SessionDetailPage() {
  const { sessionId } = useParams({ from: "/sessions/$sessionId" });
  const navigate = useNavigate();
  const detail = useQuery({
    queryKey: ["session-detail", sessionId],
    queryFn: () => getSessionDetail(sessionId),
  });
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: listSessions });
  const toolNames = useMemo(() => toolNamesFromSession(detail.data), [detail.data]);
  const schemas = useQuery({
    queryKey: ["tool-schemas", sessionId, toolNames],
    // Analyze /sessions/:id is the Pi JSONL session id — the same identity
    // the Gateway uses as piSessionId for a live runtime.
    queryFn: () => getToolSchemas(sessionId, toolNames),
    enabled: toolNames.length > 0,
  });
  const subagentsByOwnerToolCallId = useMemo(() => {
    if (!detail.data) {
      return undefined;
    }
    return indexSubagentRecords(
      tintinwebSubagentShim.fromSession?.(detail.data, sessions.data ?? []) ?? [],
    );
  }, [detail.data, sessions.data]);
  const indexedSessionIds = useMemo(
    () => new Set((sessions.data ?? []).map((session) => session.id)),
    [sessions.data],
  );

  return (
    <SessionDetailView
      session={detail.data}
      sessionId={sessionId}
      isLoading={detail.isLoading}
      isError={detail.isError}
      toolSchemas={schemas.data?.schemas}
      subagentsByOwnerToolCallId={subagentsByOwnerToolCallId}
      indexedSessionIds={indexedSessionIds}
      onOpenChildSession={(childSessionId) => {
        void navigate({ to: "/sessions/$sessionId", params: { sessionId: childSessionId } });
      }}
    />
  );
}

// Kept for callers that imported the timeline directly; the Cockpit view is
// now the only timeline rendering.
export type { SessionTurn as SessionTimelineTurn };
