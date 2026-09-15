import { describe, expect, it } from "vitest";
import {
  applySubagentRecord,
  emptySubagentLookup,
  indexSubagentRecords,
  isSettledSubagentState,
  lookupSubagentByControlId,
  lookupSubagentByOwnerToolCallId,
  subagentAdvertisesControl,
  subagentPhaseForTransition,
  type SubagentRecord,
} from "./subagent";

function record(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    childSessionId: "child-1",
    parentSessionId: "parent-1",
    ownerToolCallId: "call-1",
    state: "started",
    source: "tintinweb",
    createdAt: "2026-09-15T10:00:00.000Z",
    updatedAt: "2026-09-15T10:00:00.000Z",
    ...overrides,
  };
}

describe("subagent state machine", () => {
  it("treats completed, failed, and stopped as settled", () => {
    expect(isSettledSubagentState("created")).toBe(false);
    expect(isSettledSubagentState("started")).toBe(false);
    expect(isSettledSubagentState("completed")).toBe(true);
    expect(isSettledSubagentState("failed")).toBe(true);
    expect(isSettledSubagentState("stopped")).toBe(true);
  });

  it("emits start for the first created/started record, end when settling, update otherwise", () => {
    expect(subagentPhaseForTransition(undefined, "created")).toBe("start");
    expect(subagentPhaseForTransition(undefined, "started")).toBe("start");
    expect(subagentPhaseForTransition(undefined, "failed")).toBe("end");
    expect(subagentPhaseForTransition("created", "started")).toBe("update");
    expect(subagentPhaseForTransition("started", "completed")).toBe("end");
    expect(subagentPhaseForTransition("started", "failed")).toBe("end");
    expect(subagentPhaseForTransition("started", "stopped")).toBe("end");
  });

  it("resumes a settled child back to started as an update, not a new start", () => {
    expect(subagentPhaseForTransition("completed", "started")).toBe("update");
    expect(subagentPhaseForTransition("failed", "started")).toBe("update");
    expect(subagentPhaseForTransition("stopped", "started")).toBe("update");
  });
});

describe("subagent lookup", () => {
  it("indexes by ownerToolCallId and ignores records without one", () => {
    const lookup = indexSubagentRecords([
      record(),
      record({ ownerToolCallId: "", sourceAgentId: "rpc-only" }),
    ]);
    expect(lookup.size).toBe(1);
    expect(lookupSubagentByOwnerToolCallId(lookup, "call-1")?.childSessionId).toBe("child-1");
    expect(lookupSubagentByOwnerToolCallId(lookup, "missing")).toBeUndefined();
    expect(lookupSubagentByOwnerToolCallId(emptySubagentLookup(), "call-1")).toBeUndefined();
  });

  it("points both the spawn and resume tool call ids at the latest record", () => {
    const lookup = new Map<string, SubagentRecord>();
    applySubagentRecord(lookup, record({ state: "completed", sourceAgentId: "agent-1" }));
    applySubagentRecord(
      lookup,
      record({
        ownerToolCallId: "call-resume",
        sourceAgentId: "agent-1",
        state: "started",
        updatedAt: "2026-09-15T11:00:00.000Z",
      }),
    );
    expect(lookup.get("call-1")?.state).toBe("started");
    expect(lookup.get("call-resume")?.state).toBe("started");
    expect(lookup.get("call-1")?.ownerToolCallId).toBe("call-resume");
  });

  it("resolves control ids by sourceAgentId first, then childSessionId", () => {
    const records = [
      record({ sourceAgentId: "ag-1", childSessionId: "child-1" }),
      record({
        ownerToolCallId: "call-2",
        sourceAgentId: "ag-2",
        childSessionId: "child-2",
      }),
    ];
    expect(lookupSubagentByControlId(records, { sourceAgentId: "ag-2" })?.ownerToolCallId).toBe(
      "call-2",
    );
    expect(lookupSubagentByControlId(records, { childSessionId: "child-1" })?.sourceAgentId).toBe(
      "ag-1",
    );
    expect(
      lookupSubagentByControlId(records, { sourceAgentId: "ag-2", childSessionId: "child-1" })
        ?.sourceAgentId,
    ).toBe("ag-2");
    expect(lookupSubagentByControlId(records, {})).toBeUndefined();
  });

  it("treats missing capability flags as unadvertised", () => {
    expect(subagentAdvertisesControl(record(), "send")).toBe(false);
    expect(subagentAdvertisesControl(record({ capabilities: { send: true } }), "send")).toBe(true);
    expect(subagentAdvertisesControl(record({ capabilities: { send: true } }), "stop")).toBe(false);
    expect(subagentAdvertisesControl(undefined, "stop")).toBe(false);
  });
});
