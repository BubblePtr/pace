// Trajectory Cockpit read model. Hierarchy per CONTEXT.md: Run (Active Run,
// bounded by user inputs) > Turn (one assistant message = one model call +
// its tools) > Step (one ledger row). Pure mapping from @pace/core session
// turns — no rendering concerns here.
import type { SessionContentPart, SessionTurn } from "@pace/core";
import { toolTargetFromArgs } from "@/shared/ui/chat/chat-tool";

export type TrajectoryRole = "user" | "assistant" | "toolResult" | "annotation" | "unknown";

export type TrajectoryStep = {
  id: string;
  turnIndex: number;
  stepIndex: number;
  kind: string; // tool | think | text | image | config | <raw partType passthrough>
  name?: string;
  target?: string;
  argsText?: string;
  output?: string;
  text?: string;
  imageUrl?: string;
  imageAlt?: string;
  isError?: boolean;
  isRunning?: boolean;
  durationMs?: number;
  /** Native toolCallId on a tool step; used to join SubagentRecords. */
  toolCallId?: string;
};

export type TrajectoryTurn = {
  index: number;
  /** Active-Run ordinal: a run starts at each user input message. */
  runIndex: number;
  role: TrajectoryRole;
  label: string;
  timestamp?: string;
  /** assistant only: measured model-call latency, already validated upstream. */
  modelDurationMs?: number;
  model?: string;
  costUsd?: number;
  totalTokens?: number;
  hasError: boolean;
  toolCount: number;
  steps: TrajectoryStep[];
};

/** One Active Run: the user input plus every message until the next input. */
export type TrajectoryRun = {
  index: number;
  turns: TrajectoryTurn[];
  timestamp?: string;
  costUsd: number;
  totalTokens: number;
  hasError: boolean;
};

const roleLabels: Record<TrajectoryRole, string> = {
  user: "User",
  assistant: "Assistant",
  toolResult: "Tool result",
  annotation: "Annotation",
  unknown: "Message",
};

function payloadRecord(part: SessionContentPart): Record<string, unknown> | undefined {
  return part.payload && typeof part.payload === "object"
    ? (part.payload as Record<string, unknown>)
    : undefined;
}

function payloadString(part: SessionContentPart, key: string) {
  const value = payloadRecord(part)?.[key];
  return typeof value === "string" ? value : undefined;
}

function formatValue(value: unknown) {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function firstLine(value: string, max = 140) {
  const line =
    value
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(Boolean) ?? "";
  const compact = line.replace(/\s+/g, " ");
  return compact.length > max ? `${compact.slice(0, max - 1).trimEnd()}…` : compact;
}

export function buildTrajectoryTurns(turns: SessionTurn[]): TrajectoryTurn[] {
  let runIndex = -1;

  return turns.map((turn, turnIndex) => {
    const role: TrajectoryRole = turn.kind === "annotation" ? "annotation" : (turn.role ?? "unknown");
    if (role === "user") {
      runIndex += 1;
    }
    const assignedRunIndex = Math.max(runIndex, 0);

    const steps: TrajectoryStep[] = [];
    const openTools: Array<TrajectoryStep & { callId?: string }> = [];
    let stepIndex = 0;

    for (const part of turn.parts) {
      const id = `t${turnIndex}-s${stepIndex}`;

      if (part.partType === "toolCall") {
        const payload = payloadRecord(part);
        const argsValue = payload?.arguments ?? payload?.input;
        const argsText = argsValue === undefined ? undefined : formatValue(argsValue);
        const step: TrajectoryStep & { callId?: string } = {
          id,
          turnIndex,
          stepIndex,
          kind: "tool",
          name: part.name ?? payloadString(part, "name"),
          target: toolTargetFromArgs(argsText),
          argsText,
          isRunning: true,
          callId: payloadString(part, "id"),
          ...(payloadString(part, "id") ? { toolCallId: payloadString(part, "id") } : {}),
        };
        openTools.push(step);
        steps.push(step);
        stepIndex += 1;
        continue;
      }

      if (part.partType === "toolResult") {
        const callId = payloadString(part, "toolCallId");
        const match =
          openTools.find((tool) => tool.isRunning && callId && tool.callId === callId) ??
          openTools.find((tool) => tool.isRunning);
        const step =
          match ??
          (() => {
            const orphan: TrajectoryStep = {
              id,
              turnIndex,
              stepIndex,
              kind: "tool",
              name: part.name,
              ...(callId ? { toolCallId: callId } : {}),
            };
            steps.push(orphan);
            stepIndex += 1;
            return orphan;
          })();
        step.isRunning = false;
        step.output = part.text ?? formatValue(part.payload);
        step.isError = part.isError;
        step.durationMs = part.durationMs;
        continue;
      }

      if (part.partType === "image") {
        const url =
          payloadString(part, "url") ??
          (payloadString(part, "data") && payloadString(part, "mimeType")
            ? `data:${payloadString(part, "mimeType")};base64,${payloadString(part, "data")}`
            : undefined);
        steps.push({
          id,
          turnIndex,
          stepIndex,
          kind: "image",
          imageUrl: url,
          imageAlt: payloadString(part, "alt") ?? payloadString(part, "name"),
          target: payloadString(part, "alt") ?? url,
        });
        stepIndex += 1;
        continue;
      }

      if (turn.kind === "annotation") {
        steps.push({
          id,
          turnIndex,
          stepIndex,
          kind: "config",
          name: turn.model,
          text: part.payload == null ? undefined : formatValue(part.payload),
          target: turn.title,
        });
        stepIndex += 1;
        continue;
      }

      const text = part.text ?? formatValue(part.payload);
      steps.push({
        id,
        turnIndex,
        stepIndex,
        kind: part.partType === "thinking" ? "think" : part.partType,
        name: part.name,
        text,
        target: text ? firstLine(text) : undefined,
      });
      stepIndex += 1;
    }

    return {
      index: turnIndex,
      runIndex: assignedRunIndex,
      role,
      label: turn.kind === "annotation" ? (turn.title ?? "Annotation") : roleLabels[role],
      timestamp: turn.timestamp,
      modelDurationMs: turn.modelDurationMs,
      model: turn.model,
      costUsd: turn.cost?.totalUsd,
      totalTokens: turn.usage?.totalTokens,
      hasError: steps.some((step) => step.isError),
      toolCount: steps.filter((step) => step.kind === "tool").length,
      steps,
    };
  });
}

export function buildTrajectoryRuns(turns: TrajectoryTurn[]): TrajectoryRun[] {
  const runs: TrajectoryRun[] = [];
  for (const turn of turns) {
    let run = runs[runs.length - 1];
    if (!run || run.index !== turn.runIndex) {
      run = {
        index: turn.runIndex,
        turns: [],
        timestamp: turn.timestamp,
        costUsd: 0,
        totalTokens: 0,
        hasError: false,
      };
      runs.push(run);
    }
    run.turns.push(turn);
    run.costUsd += turn.costUsd ?? 0;
    run.totalTokens += turn.totalTokens ?? 0;
    run.hasError = run.hasError || turn.hasError;
  }
  return runs;
}

/** Trajectory filter: query/kind/errors are true filters (rows drop out). */
export type TrajectoryFilter = {
  query: string;
  kinds: ReadonlySet<string>;
  errorsOnly: boolean;
};

export const emptyTrajectoryFilter: TrajectoryFilter = {
  query: "",
  kinds: new Set<string>(),
  errorsOnly: false,
};

export function isTrajectoryFilterActive(filter: TrajectoryFilter) {
  return filter.query.trim() !== "" || filter.kinds.size > 0 || filter.errorsOnly;
}

export function trajectoryStepMatches(step: TrajectoryStep, filter: TrajectoryFilter) {
  if (filter.errorsOnly && !step.isError) {
    return false;
  }
  if (filter.kinds.size > 0 && !filter.kinds.has(step.kind)) {
    return false;
  }
  const query = filter.query.trim().toLowerCase();
  if (query !== "") {
    const haystack = [step.name, step.target, step.text, step.kind]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    if (!haystack.includes(query)) {
      return false;
    }
  }
  return true;
}
