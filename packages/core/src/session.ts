// Session data contracts — the ubiquitous language shared across the process
// seam: the utilityProcess parser produces these; the renderer consumes them.

import type { SubagentRecord } from "./subagent";

export type MessageRole = "user" | "assistant" | "toolResult" | "unknown";

export type SessionContentPart = {
  partType: string;
  text?: string;
  name?: string;
  // toolResult only: success/failure straight from the JSONL record, and
  // execution time derived from event timestamps (Pi ships no duration field).
  isError?: boolean;
  durationMs?: number;
  payload: unknown;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};

export type CostBreakdown = {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  totalUsd: number;
};

export type SessionTurn = {
  kind: "message" | "annotation";
  role?: MessageRole;
  timestamp?: string;
  // assistant only: how long the model call took, derived from the pair of
  // stamps Pi writes around it (stream open inside the message, message end on
  // the record). Absent for older sessions and for any pair that does not yield
  // a plausible span — consumers estimate instead. Same units as
  // SessionContentPart.durationMs, and likewise already validated here so no
  // consumer re-derives it.
  modelDurationMs?: number;
  title?: string;
  model?: string;
  usage?: TokenUsage;
  cost?: CostBreakdown;
  parts: SessionContentPart[];
};

export type SessionDetail = {
  id: string;
  timestamp: string;
  project: string;
  totalCostUsd: number;
  totalTokens: number;
  primaryModel?: string;
  turnCount: number;
  durationSeconds?: number;
  turns: SessionTurn[];
  /** Cold-reconstructed plugin children; absent on parse-only fixtures. */
  subagents?: SubagentRecord[];
};

export type ModelUsage = {
  model: string;
  costUsd: number;
  tokens: number;
};

export type NamedCount = {
  name: string;
  count: number;
};

export type Title =
  | { kind: "command"; name: string; args: string }
  | { kind: "skill"; name: string }
  | { kind: "text"; sentence: string }
  | { kind: "raw"; text: string };

// Whether the Pi session behind a summary also exists as a Pace Session:
// "active" and "archived" are both projected here (archiving only hides a
// Session, it never drops its Trajectory), "external" means the session was
// started outside Pace — the Pi CLI, say. Derived per request from the
// projection store, so it is never cached alongside the parsed summary.
export type SessionPresence = "active" | "archived" | "external";

export type SessionSummary = {
  id: string;
  timestamp: string;
  project: string;
  title: Title;
  totalCostUsd: number;
  totalTokens: number;
  primaryModel?: string;
  modelBreakdown: ModelUsage[];
  toolCounts: NamedCount[];
  skillCounts: NamedCount[];
  presence: SessionPresence;
};
