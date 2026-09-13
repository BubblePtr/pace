import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuntimeGatewaySnapshot, SubagentSnapshot } from "@pace/core";
import { createSubagentObservationFixture as fixture, type ObservationEventWindow as EventWindow } from "../fixtures/subagent-observation";

const activeStatuses = new Set(["queued", "running", "stopping"]);

function expectReadTrace(snapshot: SubagentSnapshot, identity: string) {
  const start = snapshot.events.find(event => event.payload.type === "tool" && event.payload.name === "read" && event.payload.phase === "start");
  const end = snapshot.events.find(event => event.payload.type === "tool" && event.payload.name === "read" && event.payload.phase === "end");
  expect(start?.payload.args).toEqual({ path: "observation-probe.txt" });
  expect(end?.payload.toolCallId).toBe(start?.payload.toolCallId);
  expect(JSON.stringify(end?.payload.result)).toContain(`READ_FROM_${identity}`);
  expect(snapshot.toolSchemas.schemas.read).toBeTruthy();
  expect(snapshot.events.every(event => event.piSessionId === snapshot.record.piSessionId && event.payload.subagentId === snapshot.record.id && event.payload.rootPiSessionId === snapshot.record.rootPiSessionId)).toBe(true);
  expect(new Set(snapshot.events.map(event => event.id)).size).toBe(snapshot.events.length);
}

test("parallel children expose their real trace while the parent continues, and stopping one preserves its sibling", async () => {
  const run = await fixture();
  try {
    const root = await run.create("parallel-observation");
    const first = await run.spawn(root, "first");
    const second = await run.spawn(root, "second");
    await run.send(root, "NEXT_PARENT_TURN");
    await run.idle(root);
    expect(run.requests.some(request => request.lastText === "NEXT_PARENT_TURN")).toBe(true);
    expect((await run.list(root)).records.filter(record => record.status === "running")).toHaveLength(2);
    (await run.gate("first:before-read")).release();
    await run.gate("first:after-read");
    const trace = await run.detail(root, first.id);
    expectReadTrace(trace, "ALPHA");
    expect(trace.record.piSessionId).not.toBe(root);
    expect(trace.record.toolCallId).toBeTruthy();
    const rootTrace = await run.call<RuntimeGatewaySnapshot>("get_runtime_snapshot", { piSessionId: root });
    expect(rootTrace.events.some(event => event.payload.type === "tool" && event.payload.name === "Agent" && event.payload.toolCallId === trace.record.toolCallId)).toBe(true);
    await run.call("stop_subagent", { piSessionId: root, agentId: first.id });
    await expect.poll(async () => (await run.gate("first:after-read")).closed).toBe(true);
    expect(activeStatuses.has((await run.detail(root, first.id)).record.status)).toBe(false);
    expect((await run.gate("second:before-read")).closed).toBe(false);
    expect((await run.detail(root, second.id)).record.status).toBe("running");
    (await run.gate("second:before-read")).release();
    (await run.gate("second:after-read")).release();
    await expect.poll(async () => (await run.detail(root, second.id)).record.status).toBe("completed");
    expectReadTrace(await run.detail(root, second.id), "ALPHA");
    const streamed = await run.page.evaluate(() => (window as EventWindow).observationEvents ?? []);
    expect(streamed.some(event => event.piSessionId === root && event.type === "subagent_record")).toBe(true);
    expect(streamed.some(event => event.piSessionId === trace.record.piSessionId && event.payload.type === "tool" && event.payload.phase === "end")).toBe(true);
  } finally { await run.close(); }
});

test("same-named project agents keep their configuration, cwd, and observations separate", async () => {
  const run = await fixture();
  try {
    const alpha = await run.create("project-alpha");
    const betaPath = join(dirname(run.app.project!.path), "project-beta");
    const beta = await run.create("project-beta", betaPath, "BETA");
    const [alphaAgent, betaAgent] = await Promise.all([run.spawn(alpha, "alpha"), run.spawn(beta, "beta")]);
    for (const [root, agent, label, identity] of [[alpha, alphaAgent, "alpha", "ALPHA"], [beta, betaAgent, "beta", "BETA"]] as const) {
      (await run.gate(`${label}:before-read`)).release();
      await run.gate(`${label}:after-read`);
      expectReadTrace(await run.detail(root, agent.id), identity);
      const prompt = JSON.stringify(run.requests.find(request => request.label === label)?.body);
      expect(prompt).toContain(`PROJECT_IDENTITY_${identity}`);
      expect(prompt).not.toContain(`PROJECT_IDENTITY_${identity === "ALPHA" ? "BETA" : "ALPHA"}`);
      expect((await run.list(root)).records).toHaveLength(1);
    }
    await expect(run.detail(alpha, betaAgent.id)).rejects.toThrow();
    await expect(run.call("stop_subagent", { piSessionId: alpha, agentId: betaAgent.id })).rejects.toThrow();
    expect((await run.gate("beta:after-read")).closed).toBe(false);
  } finally { await run.close(); }
});

test("nested agents appear in the execution tree and stopping their owner drains the subtree", async () => {
  const run = await fixture();
  try {
    const root = await run.create("nested-observation");
    const owner = await run.spawn(root, "owner", "coordinator");
    const sibling = await run.spawn(root, "sibling");
    const nested = await run.find(root, "owner-nested");
    expect(nested.parentAgentId).toBe(owner.id);
    expect(nested.rootPiSessionId).toBe(root);
    (await run.gate("owner-nested:before-read")).release();
    await run.gate("owner-nested:after-read");
    expectReadTrace(await run.detail(root, nested.id), "ALPHA");
    await run.call("stop_subagent", { piSessionId: root, agentId: owner.id });
    await expect.poll(async () => (await run.gate("owner-nested:after-read")).closed).toBe(true);
    for (const id of [owner.id, nested.id]) expect(activeStatuses.has((await run.detail(root, id)).record.status)).toBe(false);
    expect((await run.detail(root, sibling.id)).record.status).toBe("running");
    expect((await run.gate("sibling:before-read")).closed).toBe(false);
  } finally { await run.close(); }
});

test("stopping a mentioned agent cancels its observable planner before any worker starts", async () => {
  const run = await fixture();
  try {
    const root = await run.create("mention-stop-observation");
    const prompting = run.send(root, "@observation-worker CHILD:mention-stop");
    const plannerRequest = await run.gate("mention-stop:planner");
    await expect.poll(async () => (await run.list(root)).records.some(record => record.type === "mention-planner")).toBe(true);
    const planner = (await run.list(root)).records.find(record => record.type === "mention-planner")!;
    const trace = await run.detail(root, planner.id);
    expect(trace.record.status).toBe("running");
    expect(trace.events.some(event => event.payload.type === "message" && event.payload.role === "user" && JSON.stringify(event.payload.parts).includes("CHILD:mention-stop"))).toBe(true);
    await run.call("stop_run", { piSessionId: root });
    await expect.poll(() => plannerRequest.closed).toBe(true);
    await prompting;
    await run.idle(root);
    const records = (await run.list(root)).records;
    expect(records.some(record => activeStatuses.has(record.status))).toBe(false);
    expect(records.filter(record => record.type === "observation-worker")).toHaveLength(0);
    expect(run.requests.filter(request => request.label === "mention-stop" && !request.planner)).toHaveLength(0);
  } finally { await run.close(); }
});

test("a mentioned agent exposes one planner delegation and the worker's complete read trace", async () => {
  const run = await fixture();
  try {
    const root = await run.create("mention-complete-observation");
    const prompting = run.send(root, "@observation-worker CHILD:mention-complete");
    (await run.gate("mention-complete:planner")).release();
    await run.gate("mention-complete:before-read");
    await prompting;
    const worker = await run.find(root, "mention-complete");
    const planner = (await run.list(root)).records.find(record => record.type === "mention-planner")!;
    expect(planner).toBeTruthy();
    await expect.poll(async () => (await run.detail(root, planner.id)).record.status).toBe("completed");
    const delegation = await run.detail(root, planner.id);
    await test.info().attach("mention-planner-trace", { body: JSON.stringify({ delegation, requests: run.requests }), contentType: "application/json" });
    for (const phase of ["start", "end"]) {
      expect(delegation.events.filter(event => event.payload.type === "tool" && event.payload.name === "Agent" && event.payload.phase === phase)).toHaveLength(1);
    }
    (await run.gate("mention-complete:before-read")).release();
    (await run.gate("mention-complete:after-read")).release();
    await expect.poll(async () => (await run.detail(root, worker.id)).record.status).toBe("completed");
    const trace = await run.detail(root, worker.id);
    expectReadTrace(trace, "ALPHA");
    expect(trace.events.filter(event => event.payload.type === "message" && event.payload.role === "user" && event.payload.phase === "end" && JSON.stringify(event.payload.parts).includes("CHILD:mention-complete"))).toHaveLength(1);
    expect(trace.events.filter(event => event.payload.type === "tool" && event.payload.name === "read" && event.payload.phase === "end")).toHaveLength(1);
    expect((await run.list(root)).records.filter(record => record.type === "observation-worker")).toHaveLength(1);
  } finally { await run.close(); }
});

for (const action of ["stop", "stop-idle", "delete"] as const) {
  test(`${action} of the main session drains child requests`, async () => {
    const run = await fixture();
    try {
      const sessionId = `root-${action}`;
      const root = await run.create(sessionId);
      const child = await run.spawn(root, "active-child");
      if (action !== "delete") {
        if (action === "stop") {
          await run.send(root, "HOLD_PARENT");
          await run.gate("parent");
        }
        await run.call("stop_run", { piSessionId: root });
        if (action === "stop") await expect.poll(async () => (await run.gate("parent")).closed).toBe(true);
      } else await run.call("delete_session", { sessionId });
      await expect.poll(async () => (await run.gate("active-child:before-read")).closed).toBe(true);
      if (action !== "delete") expect(activeStatuses.has((await run.detail(root, child.id)).record.status)).toBe(false);
    } finally { await run.close(); }
  });
}

test("a backend crash preserves child trace and marks unfinished execution as interrupted", async () => {
  const run = await fixture();
  try {
    const root = await run.create("crash-observation");
    const child = await run.spawn(root, "crash-child");
    (await run.gate("crash-child:before-read")).release();
    await run.gate("crash-child:after-read");
    expectReadTrace(await run.detail(root, child.id), "ALPHA");
    await run.call("__e2e_kill_backend");
    await expect.poll(async () => (await run.gate("crash-child:after-read")).closed).toBe(true);
    await expect.poll(async () => {
      try { return (await run.list(root)).records.find(record => record.id === child.id)?.status; }
      catch { return "reconnecting"; }
    }, { timeout: 15_000 }).toBe("interrupted");
    const history = await run.detail(root, child.id);
    expectReadTrace(history, "ALPHA");
    expect(history.record.capabilities.stop).toBe(false);
    expect(history.record.capabilities.steer).toBe(false);
  } finally { await run.close(); }
});

test("normal application quit emits session shutdown and closes its active child request", async () => {
  const run = await fixture({ observeShutdown: true });
  try {
    const root = await run.create("quit-observation");
    await run.spawn(root, "quit-child");
    const childRequest = await run.gate("quit-child:before-read");
    expect(childRequest.closed).toBe(false);
    await run.app.app.close();
    await expect.poll(() => childRequest.closed).toBe(true);
    const marker = join(dirname(run.app.project!.path), "agent", "shutdown.jsonl");
    const shutdown = (await readFile(marker, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { sessionId: string });
    expect(shutdown.filter(event => event.sessionId === root)).toHaveLength(1);
  } finally { await run.close(); }
});

for (const reportUsage of [true, false]) {
  test(`child model usage is counted once with plugin reportUsage=${reportUsage}`, async () => {
    const run = await fixture({ reportUsage });
    try {
      const root = await run.create(`usage-${reportUsage}`);
      const child = await run.spawn(root, "usage-child");
      (await run.gate("usage-child:before-read")).release();
      (await run.gate("usage-child:after-read")).release();
      await expect.poll(async () => (await run.detail(root, child.id)).record.status).toBe("completed");
      await expect.poll(() => run.requests.some(request => !request.label && request.responded && JSON.stringify(request.body).includes("CHILD_DONE:usage-child"))).toBe(true);
      await run.idle(root);
      const trace = await run.detail(root, child.id);
      expect(trace.record.usage).toMatchObject({ input: 34, output: 10, cacheRead: 0, cacheWrite: 0 });
      expect(trace.record.usage!.costUsd).toBeCloseTo(0.000054, 10);
      const childUsage = trace.events.filter(event => event.payload.type === "usage")
        .map(event => event.payload.summary as { totalTokens: number; totalCostUsd: number });
      expect(childUsage.reduce((sum, usage) => sum + usage.totalTokens, 0)).toBe(44);
      expect(childUsage.reduce((sum, usage) => sum + usage.totalCostUsd, 0)).toBeCloseTo(0.000054, 10);
      const parent = await run.call<RuntimeGatewaySnapshot>("get_runtime_snapshot", { piSessionId: root });
      const parentCalls = run.requests.filter(request => !request.label && request.responded).length;
      expect(parent.summary?.totalTokens).toBe(parentCalls * 22);
      expect(parent.summary?.totalCostUsd).toBeCloseTo(parentCalls * 0.000027, 10);
    } finally { await run.close(); }
  });
}
