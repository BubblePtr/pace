// Composer model selector (issue #99, "Flat" direction). One flat searchable
// model list; hovering or clicking a row opens a per-model options flyout
// (vertical Reasoning levels + Fast Mode switch). Fast siblings are separate
// catalog entries merged into one family row here. Hover intent uses a
// safe-triangle (menu-aim): while the pointer travels toward the open flyout
// it is never stolen by rows on the way. Decision record:
// .scratch/model-selector/PRD.md

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Button } from "@astryxdesign/core/Button";
import { List, ListItem } from "@astryxdesign/core/List";
import { Popover } from "@astryxdesign/core/Popover";
import { Switch } from "@astryxdesign/core/Switch";
import { TextInput } from "@astryxdesign/core/TextInput";
import type {
  RuntimeModelCapability,
  RuntimeModelControls,
  RuntimeModelSelection,
  RuntimeThinkingLevel,
} from "@pace/core";
import { ProviderMark } from "@/entities/provider/provider-icon";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Flash,
  ImageIcon,
} from "@/shared/ui/icons";
import {
  baseModelOf,
  fastSiblingOf,
  formatContextWindow,
  isFastModel,
  isInsideTriangle,
  isModelVisible,
  matchesModelQuery,
  nearestThinkingLevel,
  visibleModelsOf,
  type ModelRef,
  type Point,
} from "./model-selector-logic";

const thinkingLevelLabels: Record<RuntimeThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

/*
 * Flyout hover-intent tuning. Close is deferred by a grace period; switching
 * to another row while a flyout is open goes through the safe-triangle test
 * (apex = pointer position ~POINTER_TRAIL_MS ago, base = the flyout's near
 * edge ± TRIANGLE_PAD_PX). Traveling toward the flyout defers the switch,
 * re-evaluated every SWITCH_RECHECK_MS; leaving the triangle or parking
 * commits immediately.
 */
const FLYOUT_CLOSE_GRACE_MS = 300;
/** Matches .pigui-model-flyout exit in styles.css. */
const FLYOUT_EXIT_MS = 120;
const POINTER_TRAIL_MS = 200;
const SWITCH_RECHECK_MS = 100;
const PARKED_DISTANCE_PX = 3;
const TRIANGLE_PAD_PX = 8;
const VIEWPORT_MARGIN_PX = 12;

function modelKey(model: RuntimeModelCapability) {
  return `${model.provider}\u0000${model.modelId}`;
}

function useModelFlyout() {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [presentKey, setPresentKey] = useState<string | null>(null);
  const [flyoutTop, setFlyoutTop] = useState(0);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const switchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeKeyRef = useRef<string | null>(null);
  const pointerTrailRef = useRef<{ point: Point; time: number }[]>([]);

  const clearTimer = (ref: typeof closeTimerRef) => {
    if (ref.current !== null) {
      clearTimeout(ref.current);
      ref.current = null;
    }
  };

  /**
   * Cancels only the deferred close. A pending switch stays alive: re-entering
   * the panel directly onto a row must not undo the switch that row just
   * scheduled.
   */
  const cancelPendingClose = () => {
    clearTimer(closeTimerRef);
  };

  const trackPointer = (event: React.PointerEvent) => {
    const trail = pointerTrailRef.current;
    const now = Date.now();
    trail.push({ point: { x: event.clientX, y: event.clientY }, time: now });

    while (trail.length > 1 && now - (trail[0]?.time ?? now) > POINTER_TRAIL_MS) {
      trail.shift();
    }
  };

  const commitOpen = (key: string, row: HTMLElement | null) => {
    activeKeyRef.current = key;
    setActiveKey(key);
    setPresentKey(key);

    if (row && anchorRef.current) {
      const rowRect = row.getBoundingClientRect();
      const anchorRect = anchorRef.current.getBoundingClientRect();
      setFlyoutTop(rowRect.top - anchorRect.top);
    }
  };

  const openFlyout = (
    key: string,
    row: HTMLElement | null,
    options?: { immediate?: boolean },
  ) => {
    clearTimer(closeTimerRef);
    clearTimer(switchTimerRef);

    // Clicks, a first open, and re-entering the active row commit at once.
    if (
      options?.immediate ||
      activeKeyRef.current === null ||
      activeKeyRef.current === key
    ) {
      commitOpen(key, row);
      return;
    }

    const trySwitch = () => {
      switchTimerRef.current = null;
      const flyoutElement = anchorRef.current?.querySelector(
        "[data-slot='model-selector-flyout']",
      );
      const trail = pointerTrailRef.current;
      const current = trail[trail.length - 1]?.point;
      const apex = trail[0]?.point;

      if (!flyoutElement || !current || !apex) {
        commitOpen(key, row);
        return;
      }

      const rect = flyoutElement.getBoundingClientRect();

      // Pointer already reached the flyout: the switch is moot.
      if (
        current.x >= rect.left &&
        current.x <= rect.right &&
        current.y >= rect.top &&
        current.y <= rect.bottom
      ) {
        return;
      }

      const isParked =
        Math.hypot(current.x - apex.x, current.y - apex.y) < PARKED_DISTANCE_PX;
      const topCorner = { x: rect.left, y: rect.top - TRIANGLE_PAD_PX };
      const bottomCorner = { x: rect.left, y: rect.bottom + TRIANGLE_PAD_PX };

      if (
        isParked ||
        !isInsideTriangle(current, apex, topCorner, bottomCorner)
      ) {
        commitOpen(key, row);
        return;
      }

      switchTimerRef.current = setTimeout(trySwitch, SWITCH_RECHECK_MS);
    };

    trySwitch();
  };

  const closeFlyout = () => {
    clearTimer(closeTimerRef);
    clearTimer(switchTimerRef);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      activeKeyRef.current = null;
      setActiveKey(null);
    }, FLYOUT_CLOSE_GRACE_MS);
  };

  useEffect(() => {
    if (activeKey !== null) {
      setPresentKey(activeKey);
      return;
    }

    if (presentKey === null) {
      return;
    }

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const timeout = window.setTimeout(
      () => setPresentKey(null),
      reduceMotion ? 0 : FLYOUT_EXIT_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [activeKey, presentKey]);

  return {
    activeKey,
    presentKey,
    flyoutTop,
    anchorRef,
    openFlyout,
    closeFlyout,
    cancelPendingClose,
    trackPointer,
  };
}

/** Rough flyout height, used to clamp it inside the viewport. */
function estimateFlyoutHeight(
  model: RuntimeModelCapability,
  models: RuntimeModelCapability[],
): number {
  const header = 62;
  const reasoning =
    model.thinkingLevels.length > 1 ? 26 + model.thinkingLevels.length * 32 : 0;
  const fast = fastSiblingOf(model, models) ? 49 : 0;

  return header + reasoning + fast + 10;
}

function ModelOptionsFlyout({
  model,
  models,
  selected,
  isDisabled,
  onSubmit,
}: {
  model: RuntimeModelCapability;
  models: RuntimeModelCapability[];
  selected: RuntimeModelSelection;
  isDisabled: boolean;
  onSubmit: (selection: RuntimeModelSelection) => void;
}) {
  const base = baseModelOf(model, models);
  const fastSibling = fastSiblingOf(base, models);
  const selectedModel = models.find(
    (candidate) =>
      candidate.provider === selected.provider &&
      candidate.modelId === selected.modelId,
  );
  const isCurrentFamily =
    selectedModel !== undefined &&
    baseModelOf(selectedModel, models).modelId === base.modelId &&
    base.provider === selectedModel.provider;
  const activeVariant = isCurrentFamily ? (selectedModel ?? base) : base;
  const levels = activeVariant.thinkingLevels;
  const activeLevel = levels.includes(selected.thinkingLevel)
    ? selected.thinkingLevel
    : nearestThinkingLevel(selected.thinkingLevel, levels);

  const commitReasoning = (level: RuntimeThinkingLevel) => {
    onSubmit({
      provider: activeVariant.provider,
      modelId: activeVariant.modelId,
      thinkingLevel: level,
    });
  };

  const commitFast = (fast: boolean) => {
    const target = fast && fastSibling ? fastSibling : base;
    onSubmit({
      provider: target.provider,
      modelId: target.modelId,
      thinkingLevel: nearestThinkingLevel(
        selected.thinkingLevel,
        target.thinkingLevels,
      ),
    });
  };

  return (
    <section aria-label={`${base.name} options`} className="flex flex-col">
      <div className="flex flex-col gap-0.5 border-b border-border px-2 pb-2 pt-1">
        <span className="truncate text-sm font-medium text-foreground">
          {base.name}
        </span>
        {activeVariant.contextWindow || activeVariant.maxTokens ? (
          <span className="flex items-center gap-1 text-xs text-muted tabular-nums">
            {activeVariant.contextWindow ? (
              <span>{formatContextWindow(activeVariant.contextWindow)} ctx</span>
            ) : null}
            {activeVariant.contextWindow && activeVariant.maxTokens ? (
              <span aria-hidden="true">·</span>
            ) : null}
            {activeVariant.maxTokens ? (
              <span>{formatContextWindow(activeVariant.maxTokens)} out</span>
            ) : null}
            {activeVariant.input?.includes("image") ? (
              <>
                <span aria-hidden="true">·</span>
                <ImageIcon
                  aria-label="Supports image input"
                  className="size-3.5"
                />
              </>
            ) : null}
          </span>
        ) : null}
      </div>

      {levels.length > 1 ? (
        <div className="flex flex-col gap-0.5 pb-1 pt-1.5">
          <span className="px-2 text-xs font-medium text-muted">Reasoning</span>
          <List aria-label={`${base.name} reasoning effort`} density="compact">
            {levels.map((level) => {
              const isActive = isCurrentFamily && level === activeLevel;

              return (
                <ListItem
                  endContent={
                    isActive ? (
                      <Check
                        aria-hidden="true"
                        className="size-4 shrink-0 text-foreground"
                      />
                    ) : undefined
                  }
                  isDisabled={isDisabled}
                  isSelected={isActive}
                  key={level}
                  label={thinkingLevelLabels[level]}
                  onClick={() => commitReasoning(level)}
                />
              );
            })}
          </List>
        </div>
      ) : null}

      {fastSibling ? (
        <div className="border-t border-border px-2 pb-1 pt-1.5">
          <Switch
            description="Lower latency"
            isDisabled={isDisabled}
            label="Fast Mode"
            labelIcon={() => <Flash className="size-3.5" />}
            labelPosition="start"
            labelSpacing="spread"
            size="sm"
            value={isCurrentFamily && isFastModel(activeVariant)}
            width="100%"
            onChange={commitFast}
          />
        </div>
      ) : null}
    </section>
  );
}

/**
 * Composer chip + popover for model, reasoning effort, and fast mode.
 * Contract matches the previous inline ModelThinkingControl: renders nothing
 * without a selection, disables while locked, and reports failures inline.
 */
type ModelSelectorControlOwnProps = {
  controls: RuntimeModelControls;
  isDisabled: boolean;
  /** Settings-managed allowlist; empty lists the whole catalog (issue #102). */
  visibleModels?: ModelRef[];
  onChange: (selection: RuntimeModelSelection) => Promise<void> | void;
  onManageModels?: () => void;
};

export type ModelSelectorControlProps = Omit<
  ComponentProps<typeof Button>,
  keyof ModelSelectorControlOwnProps | "children" | "label" | "onClick"
> &
  ModelSelectorControlOwnProps;

export function ModelSelectorControl({
  controls,
  isDisabled,
  visibleModels = [],
  onChange,
  onManageModels,
  className,
  ...rest
}: ModelSelectorControlProps) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const {
    activeKey,
    presentKey,
    flyoutTop,
    anchorRef,
    openFlyout,
    closeFlyout,
    cancelPendingClose,
    trackPointer,
  } = useModelFlyout();

  const selected = controls.selected;

  if (!selected) {
    return null;
  }

  const catalog = visibleModelsOf(controls.models, visibleModels, selected);
  const selectedModel = catalog.find(
    (model) =>
      model.provider === selected.provider &&
      model.modelId === selected.modelId,
  );
  const baseModels = catalog.filter((model) => {
    if (!isFastModel(model)) {
      return true;
    }

    // Keep a fast entry only when it has no base sibling to fold into.
    return fastSiblingOf(model, catalog) === undefined;
  });
  const listedModels = baseModels.filter((model) =>
    matchesModelQuery(model, query),
  );
  const flyoutModel = presentKey
    ? listedModels.find((model) => modelKey(model) === presentKey)
    : undefined;

  const anchorTop = anchorRef.current?.getBoundingClientRect().top ?? 0;
  const clampedFlyoutTop = flyoutModel
    ? Math.max(
        VIEWPORT_MARGIN_PX - anchorTop,
        Math.min(
          flyoutTop,
          window.innerHeight -
            VIEWPORT_MARGIN_PX -
            anchorTop -
            estimateFlyoutHeight(flyoutModel, catalog),
        ),
      )
    : flyoutTop;

  const isControlDisabled = isDisabled || isPending;

  const submitSelection = async (selection: RuntimeModelSelection) => {
    if (isControlDisabled) {
      return;
    }

    if (
      selection.provider === selected.provider &&
      selection.modelId === selected.modelId &&
      selection.thinkingLevel === selected.thinkingLevel
    ) {
      return;
    }

    setIsPending(true);

    try {
      await onChange(selection);
      setError(null);
    } catch (changeError) {
      setError(
        changeError instanceof Error
          ? changeError.message
          : "Model configuration failed.",
      );
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Popover
      alignment="start"
      label="Model and Thinking"
      placement="above"
      width={236}
      content={
        <div
          className="flex w-full flex-col gap-1 p-1"
          data-testid="model-thinking-popover"
          onMouseEnter={cancelPendingClose}
          onMouseLeave={closeFlyout}
          onPointerMove={trackPointer}
          // The popover is portal-mounted but React events still bubble to
          // the ChatComposer, whose click-to-focus would steal focus from the
          // search input. Keep pointer events inside the popover.
          onClick={(event: React.MouseEvent) => event.stopPropagation()}
          onMouseDown={(event: React.MouseEvent) => event.stopPropagation()}
          onPointerDown={(event: React.PointerEvent) =>
            event.stopPropagation()
          }
        >
          <TextInput
            isLabelHidden
            label="Search models"
            placeholder="Search models"
            size="sm"
            value={query}
            width="100%"
            onChange={(value: string) => setQuery(value)}
          />
          <div className="relative" ref={anchorRef}>
            {listedModels.length > 0 ? (
              <List
                aria-label="Model"
                className="max-h-72 overflow-y-auto"
                data-testid="model-thinking-model-list"
                density="compact"
              >
                {listedModels.map((model) => {
                  const isSelected =
                    selectedModel !== undefined &&
                    baseModelOf(selectedModel, catalog).modelId ===
                      model.modelId &&
                    model.provider === selectedModel.provider;

                  return (
                    <ListItem
                      endContent={
                        isSelected ? (
                          <Check
                            aria-hidden="true"
                            className="size-4 shrink-0 text-foreground"
                          />
                        ) : (
                          <ChevronRight
                            aria-hidden="true"
                            className="size-4 shrink-0 text-muted"
                          />
                        )
                      }
                      description={
                        isModelVisible(model, visibleModels)
                          ? undefined
                          : "Hidden in Settings"
                      }
                      isDisabled={isControlDisabled}
                      isSelected={modelKey(model) === activeKey}
                      key={modelKey(model)}
                      label={model.name}
                      startContent={
                        <ProviderMark
                          className="size-3.5 shrink-0"
                          providerId={model.provider}
                          reserveSlot
                        />
                      }
                      onClick={(event: React.MouseEvent) => {
                        if (!isControlDisabled && !isSelected) {
                          void submitSelection({
                            provider: model.provider,
                            modelId: model.modelId,
                            thinkingLevel: nearestThinkingLevel(
                              selected.thinkingLevel,
                              model.thinkingLevels,
                            ),
                          });
                        }

                        openFlyout(
                          modelKey(model),
                          (event.currentTarget as HTMLElement).closest("li"),
                          { immediate: true },
                        );
                      }}
                      onMouseEnter={(event: React.MouseEvent) =>
                        openFlyout(
                          modelKey(model),
                          (event.currentTarget as HTMLElement).closest("li"),
                        )
                      }
                    />
                  );
                })}
              </List>
            ) : (
              <p className="px-2 py-3 text-xs text-muted">
                No models match “{query}”.
              </p>
            )}

            {flyoutModel ? (
              <div
                aria-label={`${flyoutModel.name} options`}
                className="pigui-model-flyout w-[15rem]"
                data-open={activeKey ? "true" : undefined}
                data-slot="model-selector-flyout"
                role="group"
                style={{ left: "calc(100% + 28px)", top: clampedFlyoutTop }}
              >
                <ModelOptionsFlyout
                  isDisabled={isControlDisabled}
                  model={flyoutModel}
                  models={catalog}
                  selected={selected}
                  onSubmit={(selection) => void submitSelection(selection)}
                />
              </div>
            ) : null}
          </div>

          <div className="border-t border-border pt-1">
            <List aria-label="Model management" density="compact">
              <ListItem
                description="Choose which models appear here"
                isDisabled={!onManageModels}
                label="Add Models"
                onClick={onManageModels}
              />
            </List>
          </div>
          {isDisabled ? (
            <span className="px-2 pb-0.5 text-xs text-muted">
              Locked while running
            </span>
          ) : null}
          {error ? (
            <span className="px-2 pb-0.5 text-xs text-danger" role="status">
              {error}
            </span>
          ) : null}
        </div>
      }
    >
      <Button
        className={`min-w-0 max-w-[19rem] flex-nowrap gap-1.5 px-2 text-muted ${className ?? ""}`.trim()}
        data-testid="model-thinking-trigger"
        isDisabled={!controls.models.length}
        label="Model and Thinking"
        size="sm"
        variant="ghost"
        {...rest}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {selectedModel ? (
            <ProviderMark
              className="size-3.5 shrink-0"
              providerId={selectedModel.provider}
            />
          ) : null}
          {selectedModel && isFastModel(selectedModel) ? (
            <Flash aria-hidden="true" className="size-3.5 shrink-0" />
          ) : null}
          <span className="truncate">
            {selectedModel?.name ?? selected.modelId} ·{" "}
            {thinkingLevelLabels[selected.thinkingLevel]}
          </span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
        </span>
      </Button>
    </Popover>
  );
}
