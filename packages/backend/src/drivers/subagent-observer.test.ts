import { describe, expect, it, vi } from "vitest";
import { createRuntimeGatewaySequencer, shouldJournalRuntimeEvent, type RuntimeGatewayEventEnvelope } from "@pace/core";
import { createSubagentObserver, type SubagentHostEvent, type SubagentHostProvider, type SubagentHostRecord } from "./subagent-observer";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const journaled: RuntimeGatewayEventEnvelope[] = [];
  const published: RuntimeGatewayEventEnvelope[] = [];
  const next = createRuntimeGatewaySequencer();
  const options = {
    journal: {
      append(event: RuntimeGatewayEventEnvelope) { journaled.push(event); },
      async read(id: string) { return journaled.filter(event => event.piSessionId === id); },
    },
    publish(event: Parameters<typeof next>[0]) {
      const envelope = next(event);
      published.push(envelope);
      if (shouldJournalRuntimeEvent(envelope.payload)) journaled.push(envelope);
      return envelope;
    },
  };
  return { observer: createSubagentObserver(options), options, published, journaled };
}

function provider(rootSessionId = "root-pi") {
  const listeners = new Set<(event: SubagentHostEvent) => void>();
  const records: SubagentHostRecord[] = [];
  const api: SubagentHostProvider = {
    snapshot: () => records,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    stop: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const record: SubagentHostRecord = { id: "worker", rootSessionId, type: "explore", description: "Inspect source", status: "running", startedAt: 10, toolUses: 0 };
  return { api, record, emit(event: SubagentHostEvent) { for (const listener of listeners) listener(event); } };
}

describe("subagent host observation", () => {
  it("captures a child's first tool execution and keeps live snapshots separate from the parent", async () => {
    const { observer, published } = fixture();
    const host = provider();
    observer.attach({ sessionId: "root-app", piSessionId: "root-pi" }, host.api);
    let receive!: (event: unknown) => void;
    const record = { ...host.record, sessionId: "child-pi" };
    host.emit({ type: "session", record, session: { sessionId: "child-pi", messages: [], subscribe(listener) { receive = listener; return () => {}; } } });
    receive({ type: "agent_start" });
    receive({ type: "turn_start" });
    receive({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "README.md" } });
    receive({ type: "tool_execution_update", toolCallId: "read-1", toolName: "read", partialResult: { content: [{ type: "text", text: "partial" }] } });
    const detail = await observer.getAgent("root-pi", "worker");
    expect(detail.events).toEqual(expect.arrayContaining([expect.objectContaining({ piSessionId: "child-pi", payload: expect.objectContaining({ type: "tool", phase: "start", args: { path: "README.md" }, subagentId: "worker" }) })]));
    expect(detail.events.some(event => event.payload.phase === "update")).toBe(true);
    expect(published.filter(event => event.piSessionId === "root-pi").every(event => event.type === "subagent_record")).toBe(true);
    expect((await observer.list("root-pi")).records[0]?.piSessionId).toBe("child-pi");
  });

  it("observes follow-up runs until the plugin releases the child session", async () => {
    const { observer } = fixture();
    const host = provider();
    observer.attach({ sessionId: "root-app", piSessionId: "root-pi" }, host.api);
    let receive!: (event: unknown) => void;
    const unsubscribe = vi.fn();
    const session = { sessionId: "child", messages: [] as unknown[], subscribe(listener: (event: unknown) => void) { receive = listener; return unsubscribe; } };
    const record = { ...host.record, sessionId: "child" };
    host.emit({ type: "session", record, session });
    receive({ type: "agent_start" });
    receive({ type: "agent_end", messages: [] });
    expect(unsubscribe).not.toHaveBeenCalled();
    session.messages.push({ role: "user", content: "first" });
    receive({ type: "agent_start" });
    receive({ type: "turn_start" });
    receive({ type: "tool_execution_start", toolCallId: "resumed-read", toolName: "read", args: { path: "second.txt" } });
    const events = (await observer.getAgent("root-pi", "worker")).events;
    expect(events.filter(event => event.payload.type === "run" && event.payload.phase === "start")).toHaveLength(2);
    expect(events.some(event => event.payload.toolCallId === "resumed-read")).toBe(true);
    host.emit({ type: "released", record: { ...record, status: "completed" } });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await observer.dispose();
  });

  it("keeps a reopened session observed when the old agent's release arrives late", async () => {
    const { observer } = fixture();
    const host = provider();
    observer.attach({ sessionId: "root-app", piSessionId: "root-pi" }, host.api);
    const oldUnsubscribe = vi.fn(), newUnsubscribe = vi.fn();
    let currentReceive: ((event: unknown) => void) | undefined;
    const old = { ...host.record, sessionId: "persisted-child" };
    const reopened = { ...old, id: "new-agent" };
    host.emit({ type: "session", record: old, session: { sessionId: "persisted-child", messages: [], subscribe: () => oldUnsubscribe } });
    host.emit({ type: "session", record: reopened, session: { sessionId: "persisted-child", messages: [{ role: "user" }], subscribe(listener) { currentReceive = listener; return newUnsubscribe; } } });
    expect(oldUnsubscribe).toHaveBeenCalledOnce();
    host.emit({ type: "released", record: old });
    expect(newUnsubscribe).not.toHaveBeenCalled();
    expect(currentReceive).toBeTypeOf("function");
    currentReceive!({ type: "agent_start" });
    currentReceive!({ type: "turn_start" });
    currentReceive!({ type: "tool_execution_start", toolCallId: "reopened-read", toolName: "read", args: {} });
    expect((await observer.getAgent("root-pi", "new-agent")).events.some(event => event.payload.toolCallId === "reopened-read")).toBe(true);
    await observer.dispose();
  });

  it("replays completed children and marks unfinished records interrupted after a host restart", async () => {
    const { observer, options } = fixture();
    const host = provider();
    observer.attach({ sessionId: "root-app", piSessionId: "root-pi" }, host.api);
    host.emit({ type: "record", record: host.record });
    host.emit({ type: "record", record: { ...host.record, id: "done", status: "completed", result: "Found it" } });
    const restarted = createSubagentObserver(options);
    const list = await restarted.list("root-pi");
    expect(list.available).toBe(false);
    expect(list.records.find(record => record.id === "worker")).toMatchObject({ status: "interrupted", capabilities: { stop: false, steer: false } });
    expect(list.records.find(record => record.id === "done")).toMatchObject({ status: "completed", result: "Found it" });
  });

  it("awaits cancellation and routes a colliding agent id only to its owning root", async () => {
    const { observer } = fixture();
    const a = provider("a"), b = provider("b");
    const stop = deferred();
    a.api.stop = vi.fn(() => stop.promise);
    observer.attach({ sessionId: "app-a", piSessionId: "a" }, a.api);
    observer.attach({ sessionId: "app-b", piSessionId: "b" }, b.api);
    a.emit({ type: "record", record: a.record });
    b.emit({ type: "record", record: b.record });
    let settled = false;
    const stopping = observer.stop("a", "worker").then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(a.api.stop).toHaveBeenCalledWith("worker");
    expect(b.api.stop).not.toHaveBeenCalled();
    stop.resolve();
    await stopping;
    expect(settled).toBe(true);
    await expect(observer.stop("b", "absent")).rejects.toThrow("not found");
  });
});
