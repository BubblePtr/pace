import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuntimeGatewaySnapshot } from "../../packages/core/src/runtime-gateway";
import { launchPace } from "../fixtures/electron-app";

test("cold history stays process-free until the first send, including after backend restart", async ({}, testInfo) => {
  const requests: unknown[] = [];
  let finishReply!: () => void;
  const replyMayFinish = new Promise<void>(resolve => { finishReply = resolve; });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "reply", object: "chat.completion.chunk", created: 1, model: "probe" };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "First execution " }, finish_reason: null }] })}\n\n`);
    await replyMayFinish;
    for (const delta of [
      { choices: [{ index: 0, delta: { content: "completed" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
    ]) response.write(`data: ${JSON.stringify({ ...base, ...delta })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture server address");
  const piSessionId = "e2e-pi-session";
  const runId = `${piSessionId}:run-1`;
  const messageId = `${runId}:turn-1:message-1`;
  const history = [
    { kind: "message", role: "user", body: "Historical question", messageId: `pi-sdk:${piSessionId}:user:0` },
    { type: "run", phase: "start", trigger: "prompt", runId, surface: "hidden" },
    { type: "message", phase: "start", runId, turnId: `${runId}:turn-1`, messageId, role: "assistant", surface: "chat" },
    { type: "message", phase: "end", runId, turnId: `${runId}:turn-1`, messageId, role: "assistant", parts: [{ partId: `${messageId}:tool`, partType: "tool_call", toolCallId: "old-tool", name: "bash", body: '{"command":"pwd"}', done: true }], surface: "chat" },
    { type: "tool", phase: "start", runId, turnId: `${runId}:turn-1`, messageId, toolCallId: "old-tool", name: "bash", args: { command: "pwd" }, surface: "trace" },
    { type: "tool", phase: "end", runId, turnId: `${runId}:turn-1`, messageId, toolCallId: "old-tool", name: "bash", result: { content: [{ type: "text", text: "/saved/project" }] }, surface: "trace" },
    { type: "message", phase: "end", runId, turnId: `${runId}:turn-1`, messageId: `${runId}:turn-2:message-2`, role: "assistant", parts: [{ partId: `${runId}:turn-2:message-2:text`, partType: "text", body: "Saved answer from history", done: true }], surface: "chat" },
    { type: "run", phase: "end", trigger: "prompt", outcome: "completed", runId, surface: "hidden" },
  ].map((payload, index) => ({ id: `history-${index}`, seq: index + 1, sessionId: "e2e-session", piSessionId,
    type: payload.type ?? "message_update", ts: `2026-09-14T00:00:0${index}.000Z`,
    payload: "type" in payload ? { ...payload, origin: "sdk" } : payload }));
  const application = await launchPace({ seedModelControls: true,
    environment: process.env.PACE_HISTORY_RENDERER_URL ? { ELECTRON_RENDERER_URL: process.env.PACE_HISTORY_RENDERER_URL } : {},
    agentFiles: {
      "settings.json": JSON.stringify({ defaultProvider: "pace-test", defaultModel: "probe", defaultThinkingLevel: "off", extensions: ["./history-observer.ts"] }),
      "models.json": JSON.stringify({ providers: { "pace-test": { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-test-placeholder",
        models: [{ id: "probe", name: "Probe", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }),
      "history-observer.ts": `import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
export default function(pi) {
  const log = type => appendFileSync(join(getAgentDir(), "starts.jsonl"), JSON.stringify({ type, pid: process.pid, at: Date.now() }) + "\\n");
  log("module_loaded");
  pi.on("session_start", () => log("session_start"));
  pi.on("input", () => log("input"));
}`,
      "../data/sessions/e2e-pi-session.jsonl": history.map(event => JSON.stringify(event)).join("\n") + "\n",
    },
  });
  const { window, projection } = application;
  const root = dirname(application.project!.path);
  const starts = async () => readFile(join(root, "agent/starts.jsonl"), "utf8").then(text => text.trim().split("\n").map(line => JSON.parse(line) as { type: string; pid: number; at: number }), () => []);
  const timings: string[] = [];
  const snapshot = async () => {
    const startedAt = performance.now();
    const state = await window.evaluate(id => window.pace!.invoke<RuntimeGatewaySnapshot>("get_runtime_snapshot", { piSessionId: id }), piSessionId);
    timings.push(`history_read (${state.executionState}, IPC included): ${(performance.now() - startedAt).toFixed(1)}ms`);
    return state;
  };
  try {
    await application.writeProjection({ ...projection!, initialPrompt: "Historical question", modelSelection: { provider: "pace-test", modelId: "probe", thinkingLevel: "off" } });
    for (const suffix of ["second", "third"]) {
      await application.writeProjection({ ...projection!, sessionId: `cold-${suffix}`, piSessionId: `pi-${suffix}`,
        initialPrompt: `Saved ${suffix} question`, sessionFile: join(root, `missing-${suffix}.jsonl`) });
    }
    // Fixture edits happen outside the store; restart to discard its read cache.
    await window.evaluate(() => window.pace!.invoke("__e2e_kill_backend").catch(() => undefined));
    await expect.poll(async () => snapshot().then(state => state.executionState, () => "restarting")).toBe("cold");
    await window.reload();
    for (const suffix of ["second", "third"]) {
      await window.getByRole("button", { name: new RegExp(`^Saved ${suffix} question`) }).click();
      await expect(window.getByLabel("Live Chat messages")).toContainText(`Saved ${suffix} question`);
      await expect(window.getByTestId("session-history-status")).toHaveCount(0);
      expect(await starts()).toEqual([]);
    }
    await appendFile(projection!.sessionFile!, JSON.stringify({ type: "message", id: "old-user", parentId: null,
      timestamp: "2026-09-14T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Historical question" }], timestamp: 1789344000000 } }) + "\n");
    await window.getByTestId("session-row-with-actions").getByText("Historical question", { exact: true }).click();
    await expect(window.getByLabel("Live Chat messages")).toContainText("Saved answer from history");
    await expect(window.getByLabel("Live Chat messages")).toContainText("Ran");
    expect((await snapshot()).executionState).toBe("cold");
    expect(await starts()).toEqual([]);
    expect(requests).toEqual([]);
    await window.screenshot({ path: testInfo.outputPath("cold-history.png") });

    await window.evaluate(() => window.pace!.invoke("__e2e_kill_backend").catch(() => undefined));
    await expect.poll(async () => snapshot().then(state => state.executionState, () => "restarting")).toBe("cold");
    await expect(window.getByLabel("Live Chat messages")).toContainText("Saved answer from history");
    expect(await starts()).toEqual([]);

    await window.getByPlaceholder("What do you want to know?").fill("Continue once");
    const firstSubmitAt = Date.now();
    await window.getByRole("button", { name: "Send", exact: true }).click();
    await expect(window.getByLabel("Live Chat messages")).toContainText("First execution");
    const startedEvents = await starts();
    await window.getByRole("button", { name: /^Saved second question/ }).click();
    await expect(window.getByLabel("Live Chat messages")).toContainText("Saved second question");
    await window.getByTestId("session-row-with-actions").getByText("Historical question", { exact: true }).click();
    await expect(window.getByLabel("Live Chat messages")).toContainText("Saved answer from history");
    expect(await starts()).toEqual(startedEvents);
    finishReply();
    await expect(window.getByLabel("Live Chat messages")).toContainText("First execution completed");
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain("Historical question");
    const events = await starts();
    const firstInput = events.find(event => event.type === "input")!;
    timings.push(`first_execution_prepare (click to Pi input hook): ${firstInput.at - firstSubmitAt}ms`);
    expect(events.filter(event => event.type === "session_start")).toHaveLength(1);
    expect(events.filter(event => event.type === "input")).toHaveLength(1);
    const ready = await snapshot();
    expect(ready.executionState).toBe("ready");
    expect(ready.events.some(event => event.seq > history.length)).toBe(true);
    await window.reload();
    await expect(window.getByLabel("Live Chat messages")).toContainText("First execution completed");
    expect(await starts()).toEqual(events);
    await window.screenshot({ path: testInfo.outputPath("first-execution.png") });
    await testInfo.attach("session-timing", { body: timings.join("\n"), contentType: "text/plain" });
    console.log(timings.join("\n"));
  } finally {
    finishReply();
    await application.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
