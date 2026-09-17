// Agent Runtime Event Model — the product-layer event contract carried as the
// Runtime Gateway envelope payload. Boundaries come from agent-core lifecycle,
// never from renderer guesses. See docs/adr/0020-agent-runtime-event-model.md.

import type { RuntimeContextUsage, RuntimeGatewaySummary } from "./runtime-gateway";
import type { SubagentEventPhase, SubagentRecord } from "./subagent";

export type AgentRunPhase = "start" | "update" | "end";

// Lifecycle (`phase`) and content encoding (`bodyMode`) are deliberately
// separate axes; the legacy `partial | delta | final` tri-state is retired.
export type AgentBodyMode = "delta" | "snapshot";

export type AgentSurface = "chat" | "trace" | "status" | "composer" | "hidden";

export type AgentEventOrigin = "sdk" | "rpc";

export type AgentRunTrigger = "prompt" | "steer" | "follow_up" | "unknown";

export type AgentRunOutcome = "completed" | "aborted" | "failed";

export type AgentMessagePartType = "text" | "thinking" | "tool_call" | "image";

export type AgentStatusCode =
  | "retrying"
  | "retry_succeeded"
  | "retry_failed"
  | "compacting"
  | "compaction_done"
  // A compaction that never reported its own end because the Active Run
  // stopped first (abort, failure). Distinct from `compaction_done` so the
  // trace never claims a completion that did not happen.
  | "compaction_aborted"
  | "runtime_unavailable"
  | "first_token_timeout"
  | "model_changed"
  | "thinking_level_changed";

export type AgentMessagePartSnapshot = {
  partId: string;
  partType: AgentMessagePartType;
  body: string;
  toolCallId?: string;
};

export type AgentRuntimeEvent =
  // Message lifecycle. Carries no streaming body; `end` carries the final
  // parts snapshot as the authoritative message content. `abandoned` marks a
  // partial message closed by retry — consumers must never be left holding
  // dangling streaming state, but abandoned content is not a final answer.
  | {
      type: "message";
      runId: string;
      turnId: string;
      messageId: string;
      role: "user" | "assistant";
      phase: "start" | "end";
      parts?: readonly AgentMessagePartSnapshot[];
      abandoned?: boolean;
      surface: "chat";
      origin: AgentEventOrigin;
    }
  // Part-level streaming updates — the hot path. `update` events carry only
  // the delta fragment; `start`/`end` carry snapshots.
  | {
      type: "message_part";
      runId: string;
      turnId: string;
      messageId: string;
      partId: string;
      partType: AgentMessagePartType;
      phase: AgentRunPhase;
      bodyMode: AgentBodyMode;
      body: string;
      toolCallId?: string;
      // Tool name on a tool_call part, known from the opening boundary — the
      // native toolCallId only arrives with part(end) and the execution
      // lifecycle only with tool(start), so without this the live trace has
      // nothing to name for as long as the arguments stream (ADR-0030 §4).
      // Absent on every other part type and on bridges that cannot supply it.
      toolName?: string;
      surface: "chat" | "trace";
      origin: AgentEventOrigin;
    }
  // Tool execution lifecycle, joined to the message's tool_call part by
  // toolCallId. Validated args from execution overwrite message-stream args.
  | {
      type: "tool";
      runId: string;
      turnId: string;
      toolCallId: string;
      phase: AgentRunPhase;
      name: string;
      args?: unknown;
      result?: unknown;
      isError?: boolean;
      surface: "trace";
      origin: AgentEventOrigin;
    }
  // Active Run / Turn boundaries. Hidden: they drive the projection state
  // machine and are never rendered as bubbles. Session completion is decided
  // by run(end).outcome, not by status events.
  | {
      type: "run";
      runId: string;
      phase: "start" | "end";
      trigger: AgentRunTrigger;
      outcome?: AgentRunOutcome;
      surface: "hidden";
      origin: AgentEventOrigin;
    }
  | {
      type: "turn";
      runId: string;
      turnId: string;
      phase: "start" | "end";
      surface: "hidden";
      origin: AgentEventOrigin;
    }
  | {
      type: "status";
      runId?: string;
      code: AgentStatusCode;
      body?: string;
      surface: "status" | "composer" | "trace" | "hidden";
      origin: AgentEventOrigin;
    }
  | {
      type: "error";
      runId?: string;
      turnId?: string;
      code: string;
      body: string;
      // Pi can report an extension failure while keeping the session usable.
      fatal?: boolean;
      surface: "chat";
      origin: AgentEventOrigin;
    }
  | {
      type: "usage";
      runId: string;
      summary: Partial<RuntimeGatewaySummary>;
      surface: "hidden";
      origin: AgentEventOrigin;
    }
  // Context-window occupancy after a lifecycle boundary that can have changed
  // it (turn end, compaction end). Hidden like `usage`: it feeds the session
  // projection the composer indicator reads, never a timeline entry.
  | {
      type: "context_usage";
      runId?: string;
      usage: RuntimeContextUsage;
      surface: "hidden";
      origin: AgentEventOrigin;
    }
  | {
      type: "queue";
      steering: string[];
      followUp: string[];
      surface: "hidden";
      origin: AgentEventOrigin;
    }
  | {
      type: "queued-message-consumed";
      queuedMessageId: string;
      consumedAt: string;
      surface: "hidden";
      origin: AgentEventOrigin;
    }
  // Plugin-owned child conversation. Hidden: never a chat bubble or Trajectory
  // row. Consumers join it to the parent Agent Tool Call by ownerToolCallId.
  | {
      type: "subagent";
      phase: SubagentEventPhase;
      record: SubagentRecord;
      surface: "hidden";
      origin: AgentEventOrigin;
      runId?: string;
      turnId?: string;
    };

// Surface routing — the single source of truth. Page components must not
// re-derive placement; policy changes happen here only.

export function surfaceForMessagePart(partType: AgentMessagePartType): "chat" | "trace" {
  return partType === "text" || partType === "image" ? "chat" : "trace";
}

// Session Event Journal boundary filter — the single source of truth for
// what new journals contain. Message deltas and cumulative tool partialResult
// snapshots are covered by end events; persisting each update bloats replay.
export function shouldJournalRuntimeEvent(payload: Record<string, unknown>): boolean {
  return !(
    (payload.type === "message_part" || payload.type === "tool") &&
    payload.phase === "update"
  );
}

export const AGENT_STATUS_SURFACES: Record<
  AgentStatusCode,
  "status" | "composer" | "trace" | "hidden"
> = {
  retrying: "trace",
  retry_succeeded: "trace",
  retry_failed: "trace",
  compacting: "trace",
  compaction_done: "trace",
  compaction_aborted: "trace",
  runtime_unavailable: "composer",
  first_token_timeout: "composer",
  model_changed: "status",
  thinking_level_changed: "status",
};
