// Generic subagent contract — pico-v3 §8.5 semantics, community extensions
// shim onto it. Pace observes (and later steers) subagents; it does not spawn
// them. See .scratch/subagent-contract/PRD.md.

export type SubagentSource = "tintinweb" | "nicobailon" | "pico";

export type SubagentState = "created" | "started" | "completed" | "failed" | "stopped";

export type SubagentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

/** Optional. Absent means “this source does not expose that control.” */
export type SubagentCapabilities = {
  send?: boolean;
  stop?: boolean;
};

export type SubagentRecord = {
  childSessionId: string;
  parentSessionId: string;
  ownerToolCallId: string;
  state: SubagentState;
  source: SubagentSource;
  createdAt: string;
  updatedAt: string;
  usage?: SubagentUsage;
  startedAt?: string;
  endedAt?: string;
  capabilities?: SubagentCapabilities;
  sourceAgentId?: string;
  sessionFile?: string;
};

export type SubagentEventPhase = "start" | "update" | "end";

const SETTLED_STATES: ReadonlySet<SubagentState> = new Set(["completed", "failed", "stopped"]);

export function isSettledSubagentState(state: SubagentState): boolean {
  return SETTLED_STATES.has(state);
}

/** Lifecycle phase stamped on the AgentRuntimeEvent that carries this record. */
export function subagentPhaseForTransition(
  previous: SubagentState | undefined,
  next: SubagentState,
): SubagentEventPhase {
  if (previous === undefined) {
    return next === "created" || next === "started" ? "start" : "end";
  }
  if (isSettledSubagentState(next) && next !== previous) {
    return "end";
  }
  return "update";
}

export type SubagentLookup = ReadonlyMap<string, SubagentRecord>;

export function emptySubagentLookup(): SubagentLookup {
  return new Map();
}

/**
 * Index records by ownerToolCallId. Resume of a settled child may attach a new
 * tool call id; both keys keep pointing at the latest record so either Agent
 * step on Trajectory can resolve the child.
 */
export function indexSubagentRecords(records: readonly SubagentRecord[]): Map<string, SubagentRecord> {
  const lookup = new Map<string, SubagentRecord>();
  for (const record of records) {
    applySubagentRecord(lookup, record);
  }
  return lookup;
}

export function applySubagentRecord(
  lookup: Map<string, SubagentRecord>,
  record: SubagentRecord,
): Map<string, SubagentRecord> {
  if (record.sourceAgentId) {
    for (const [key, existing] of lookup) {
      if (existing.sourceAgentId === record.sourceAgentId) {
        lookup.set(key, record);
      }
    }
  }
  if (record.ownerToolCallId) {
    lookup.set(record.ownerToolCallId, record);
  }
  return lookup;
}

export function lookupSubagentByOwnerToolCallId(
  lookup: SubagentLookup | undefined,
  ownerToolCallId: string | undefined,
): SubagentRecord | undefined {
  if (!lookup || !ownerToolCallId) {
    return undefined;
  }
  return lookup.get(ownerToolCallId);
}
