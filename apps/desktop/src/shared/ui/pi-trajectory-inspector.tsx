import type { ComponentProps } from "react";
import { formatToolDuration } from "@/shared/ui/chat/chat-tool";
import type { RuntimeToolSchema } from "@pace/core";
import type { TrajectoryStep, TrajectoryTurn } from "@/entities/session/trajectory-model";
import { TrajectoryStepBadge, trajectoryStepStatus, trajectoryStepType } from "@/shared/ui/pi-trajectory-ledger";

/**
 * The Inspector (Trajectory Cockpit detail pane): Summary / Payload / Result /
 * Schema / Timing tabs for the Playhead step. Large payloads mount only
 * here, never in the Ledger. Schema shows the tool's declared definition —
 * resolved by the Runtime Gateway by tool name, not stored in the trajectory —
 * and degrades to an unavailable notice when the tool is no longer
 * registered or its definition drifted.
 */
export const trajectoryInspectorTabs = ["Summary", "Payload", "Result", "Schema", "Timing"] as const;
export type TrajectoryInspectorTab = (typeof trajectoryInspectorTabs)[number];

export type TrajectoryToolSchema = RuntimeToolSchema;

function formatCost(value?: number) {
  if (value === undefined) {
    return undefined;
  }
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(value);
}

function formatTokens(value?: number) {
  if (value === undefined) {
    return undefined;
  }
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatTime(value?: string) {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(date);
}

function Field({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-3 py-1">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-xs text-foreground">{children ?? "—"}</dd>
    </div>
  );
}

function CodeBlock({ value }: { value?: string }) {
  if (value === undefined || value === "") {
    return <p className="py-6 text-center text-xs text-muted">Nothing recorded for this step.</p>;
  }
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-surface-muted px-3 py-2 font-mono text-xs leading-5 text-foreground">
      {value}
    </pre>
  );
}

type PiTrajectoryInspectorOwnProps = {
  step: TrajectoryStep;
  turn: TrajectoryTurn;
  tab: TrajectoryInspectorTab;
  onTabChange: (tab: TrajectoryInspectorTab) => void;
  onClose: () => void;
  /** Tool definition resolved by name (a Runtime Gateway capability). */
  schema?: TrajectoryToolSchema;
  /**
   * Trajectory-only deep-link for an Agent step whose SubagentRecord has a
   * childSessionId. Missing JSONL → disabled, not an error.
   */
  childSession?: { id: string; isAvailable: boolean };
  onOpenChildSession?: () => void;
};

export type PiTrajectoryInspectorProps = Omit<
  ComponentProps<"div">,
  keyof PiTrajectoryInspectorOwnProps | "children"
> &
  PiTrajectoryInspectorOwnProps;

export function PiTrajectoryInspector({
  step,
  turn,
  tab,
  onTabChange,
  onClose,
  schema,
  childSession,
  onOpenChildSession,
  className,
  ...rest
}: PiTrajectoryInspectorProps) {
  const status = trajectoryStepStatus(step);

  return (
    <div
      className={`flex h-full min-h-0 flex-col ${className ?? ""}`.trim()}
      data-slot="trajectory-inspector"
      {...rest}
    >
      <header className="shrink-0 border-b border-border px-4 pb-0 pt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate font-mono text-xs text-muted">
            Run {turn.runIndex + 1} · Step {step.stepIndex + 1}
          </p>
          <button
            aria-label="Close inspector"
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
            type="button"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <h2 className="mt-1 flex min-w-0 items-baseline gap-2">
          <span className="truncate font-mono text-sm font-semibold text-foreground">
            {step.name ?? step.kind}
          </span>
          <span aria-hidden="true" className={`text-xs ${status.className}`}>
            {status.glyph}
          </span>
        </h2>
        <div aria-label="Step detail" className="mt-2 flex gap-1" role="tablist">
          {trajectoryInspectorTabs.map((name) => (
            <button
              aria-selected={tab === name}
              className={`cursor-pointer rounded-t px-2.5 pb-2 pt-1 text-xs transition-colors ${
                tab === name
                  ? "font-semibold text-foreground shadow-[inset_0_-2px_0_var(--primary)]"
                  : "text-muted hover:text-foreground"
              }`}
              key={name}
              role="tab"
              type="button"
              onClick={() => onTabChange(name)}
            >
              {name}
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {tab === "Summary" ? (
          <dl>
            <Field label="Kind">{step.kind}</Field>
            <Field label="Status">{status.label}</Field>
            <Field label="Target">
              <span className="break-all font-mono">{step.target}</span>
            </Field>
            <Field label="Type">
              <TrajectoryStepBadge type={trajectoryStepType(step, turn.role)} />
            </Field>
            <Field label="Model">{turn.model}</Field>
            <Field label="Turn cost">{formatCost(turn.costUsd)}</Field>
            <Field label="Turn tokens">{formatTokens(turn.totalTokens)}</Field>
            {step.imageUrl ? (
              <div className="mt-3">
                <img
                  alt={step.imageAlt ?? "Session image"}
                  className="max-h-56 max-w-full rounded-md object-contain outline outline-1 -outline-offset-1 outline-black/10"
                  src={step.imageUrl}
                />
              </div>
            ) : null}
            {childSession ? (
              <div className="mt-3 border-t border-border pt-3">
                <button
                  className={`text-xs ${
                    childSession.isAvailable
                      ? "cursor-pointer text-foreground underline-offset-2 hover:underline"
                      : "cursor-not-allowed text-muted"
                  }`}
                  data-testid="open-child-session"
                  disabled={!childSession.isAvailable}
                  title={
                    childSession.isAvailable
                      ? `Open ${childSession.id}`
                      : "Child session JSONL is not in the session index"
                  }
                  type="button"
                  onClick={childSession.isAvailable ? onOpenChildSession : undefined}
                >
                  Open child session
                </button>
              </div>
            ) : null}
          </dl>
        ) : null}
        {tab === "Payload" ? <CodeBlock value={step.argsText ?? step.text} /> : null}
        {tab === "Result" ? <CodeBlock value={step.output ?? step.text} /> : null}
        {tab === "Schema" ? (
          step.kind !== "tool" ? (
            <p className="py-6 text-center text-xs text-muted">This is not a tool step.</p>
          ) : schema ? (
            <div>
              <p className="font-mono text-sm font-semibold text-foreground">{step.name}</p>
              <p className="mt-1 text-xs leading-5 text-muted">{schema.description}</p>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-muted">
                Parameters
              </p>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-surface-muted px-3 py-2 font-mono text-xs leading-5 text-foreground">
                {JSON.stringify(schema.parameters, null, 2)}
              </pre>
            </div>
          ) : (
            <p className="py-6 text-center text-xs leading-5 text-muted">
              This tool's current definition is unavailable.
              <br />
              It may have been uninstalled, or it may have changed.
            </p>
          )
        ) : null}
        {tab === "Timing" ? (
          <dl>
            <Field label="Started">{formatTime(turn.timestamp)}</Field>
            <Field label="Duration">{formatToolDuration(step.durationMs) ?? "Not available"}</Field>
            <Field label="State">{status.label}</Field>
          </dl>
        ) : null}
      </div>
    </div>
  );
}
