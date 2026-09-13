import { describe, expect, it, vi } from "vitest";
import type { BackendRpcEvent } from "@pace/backend";
import type {
  RuntimeGatewayEventEnvelope,
  SubagentRecord,
  SubagentSnapshot,
  SubagentsSnapshot,
} from "@pace/core";
import { createSubagentsClient } from "./subagents-client";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const record: SubagentRecord = {
  id: "a",
  rootSessionId: "root-app",
  rootPiSessionId: "root",
  piSessionId: "child",
  type: "explore",
  description: "Inspect runtime",
  status: "running",
  startedAt: 1000,
  toolUses: 0,
  capabilities: { stop: true, steer: true },
};
function event(
  seq: number,
  payload: Record<string, unknown>,
): RuntimeGatewayEventEnvelope {
  return {
    id: `e${seq}`,
    seq,
    ts: "2026-09-13T12:00:00Z",
    sessionId: "child-app",
    piSessionId: "child",
    type: String(payload.type),
    payload: { rootPiSessionId: "root", subagentId: "a", ...payload },
  };
}
function setup(response: Promise<unknown>) {
  let listener: ((event: BackendRpcEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const invoke = vi.fn(async () => response);
  const client = createSubagentsClient({
    invoke: invoke as <T>() => Promise<T>,
    onBackendEvent: (next) => {
      listener = next;
      return unsubscribe;
    },
  });
  return {
    client,
    invoke,
    unsubscribe,
    emit: (value: RuntimeGatewayEventEnvelope) =>
      listener?.({ type: "event", event: value }),
  };
}

describe("subagent observations", () => {
  it("subscribes before the initial read and preserves a completion received during it", async () => {
    const request = deferred<SubagentsSnapshot>();
    const { client, emit } = setup(request.promise);
    const changed = vi.fn();
    client.observeRecords("root", changed);
    emit({
      ...event(9, {
        type: "subagent_record",
        record: { ...record, status: "completed" },
      }),
      piSessionId: "root",
    });
    emit({
      ...event(8, { type: "subagent_record", record }),
      piSessionId: "root",
    });
    emit({
      ...event(10, {
        type: "subagent_record",
        record: { ...record, id: "foreign" },
      }),
      piSessionId: "other-root",
    });
    request.resolve({ available: true, records: [record] });
    await vi.waitFor(() =>
      expect(changed.mock.lastCall?.[0].loading).toBe(false),
    );
    expect(changed.mock.lastCall?.[0].data.records).toEqual([
      { ...record, status: "completed" },
    ]);
  });

  it("merges live trace with the snapshot once and ignores sibling traces", async () => {
    const request = deferred<SubagentSnapshot>();
    const { client, emit } = setup(request.promise);
    const changed = vi.fn();
    client.observeSession("root", "a", changed);
    const first = event(1, {
      type: "run",
      phase: "start",
      runId: "run",
      trigger: "prompt",
    });
    const second = event(2, {
      type: "message",
      phase: "end",
      role: "assistant",
      messageId: "m",
      parts: [],
    });
    emit(second);
    emit({
      ...event(3, { type: "message" }),
      payload: { rootPiSessionId: "root", subagentId: "sibling" },
    });
    request.resolve({
      record,
      events: [first, second],
      toolSchemas: { schemas: {} },
    });
    await vi.waitFor(() =>
      expect(changed.mock.lastCall?.[0].loading).toBe(false),
    );
    expect(changed.mock.lastCall?.[0].data.events).toEqual([first, second]);
    emit(first);
    expect(changed.mock.lastCall?.[0].data.events).toEqual([first, second]);
  });

  it("unsubscribes on view disposal and ignores a late snapshot without stopping work", async () => {
    const request = deferred<SubagentSnapshot>();
    const { client, unsubscribe, invoke } = setup(request.promise);
    const changed = vi.fn();
    const observation = client.observeSession("root", "a", changed);
    observation.dispose();
    changed.mockClear();
    request.resolve({ record, events: [], toolSchemas: { schemas: {} } });
    await Promise.resolve();
    await Promise.resolve();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("receives schemas for tools that start after the detail snapshot", async () => {
    const { client, emit } = setup(
      Promise.resolve({ record, events: [], toolSchemas: { schemas: {} } }),
    );
    const changed = vi.fn();
    client.observeSession("root", "a", changed);
    await vi.waitFor(() =>
      expect(changed.mock.lastCall?.[0].loading).toBe(false),
    );
    const schema = {
      description: "Read a project file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    };
    emit(
      event(1, {
        type: "tool",
        phase: "start",
        name: "read",
        toolCallId: "call",
        toolSchema: schema,
      }),
    );
    expect(changed.mock.lastCall?.[0].data.toolSchemas.schemas.read).toEqual(
      schema,
    );
  });
});
