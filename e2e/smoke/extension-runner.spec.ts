import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { launchPace } from "../fixtures/electron-app";

const plugin = process.env.PACE_TEST_SUBAGENTS_DIR;

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(filename));
    else if (entry.isFile()) result.push(filename);
  }
  return result.sort();
}

async function fingerprint(directory: string) {
  const hash = createHash("sha256");
  for (const filename of await files(directory)) {
    hash.update(filename.slice(directory.length));
    hash.update(await readFile(filename));
  }
  return hash.digest("hex");
}

for (const authMode of ["api-key", "codex-oauth"] as const) {
  test(`the original async subagent completes through the host and system Node with ${authMode}`, async ({}, testInfo) => {
    test.skip(!plugin, "Set PACE_TEST_SUBAGENTS_DIR to an installed pi-subagents package with its dependencies");
    const before = await fingerprint(plugin!);
    const provider = authMode === "codex-oauth" ? "openai-codex" : "pace-test";
    const api = authMode === "codex-oauth" ? "openai-codex-responses" : "openai-completions";
    const model = `${provider}/probe`;
    const access = `fixture.${Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
    })).toString("base64url")}.fixture`;
    let requests = 0;
    const authenticatedRequests: boolean[] = [];
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* Drain the request before sending the deterministic fixture response. */ }
      const first = ++requests === 1;
      const args = JSON.stringify({ agent: "probe", task: "Return BACKGROUND_OK without using tools or changing files.", async: true, model });
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (authMode === "codex-oauth") {
        authenticatedRequests.push(request.headers.authorization === `Bearer ${access}`
          && request.headers["chatgpt-account-id"] === "fixture-account");
        const item = first
          ? { type: "function_call", id: "fc_probe", call_id: "background-probe", name: "subagent", arguments: args, status: "completed" }
          : { type: "message", id: `msg_${requests}`, role: "assistant", content: [{ type: "output_text", text: "BACKGROUND_OK", annotations: [] }], status: "completed" };
        for (const event of [
          { type: "response.created", response: { id: `resp_${requests}` } },
          { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", content: [] } },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id: `resp_${requests}`, status: "completed", output: [item],
            usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } },
        ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
        return;
      }
      const delta = first ? { role: "assistant", tool_calls: [{ index: 0, id: "background-probe", type: "function", function: {
        name: "subagent", arguments: args,
      } }] } : { role: "assistant", content: "BACKGROUND_OK" };
      const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "probe" };
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture server address");
    const app = await launchPace({ seedProject: true, emptyPath: true,
      environment: { PACE_NODE_PATH: process.execPath },
      agentFiles: {
        "settings.json": JSON.stringify({ defaultProvider: provider, defaultModel: "probe", defaultThinkingLevel: "off", transport: "sse", extensions: [join(plugin!, "index.ts")] }),
        ...(authMode === "codex-oauth" ? { "auth.json": JSON.stringify({ "openai-codex": {
          type: "oauth", access, refresh: "fixture-refresh", expires: Date.now() + 3_600_000, accountId: "fixture-account",
        } }) } : {}),
        "models.json": JSON.stringify({ providers: { [provider]: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`, api,
          ...(authMode === "api-key" ? { apiKey: "local-test-placeholder" } : {}),
          models: [{ id: "probe", name: "Probe", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        } } }),
        "agents/probe.md": `---\nname: probe\ndescription: Runtime compatibility test\nmodel: ${model}\ntools: read\n---\nReturn BACKGROUND_OK without tools.\n`,
      },
    });
    try {
      const created = await app.window.evaluate(cwd => window.pace!.invoke<{ piSessionId: string }>("create_session", {
        sessionId: "background-probe", projectId: cwd, cwd,
      }), app.project!.path);
      await app.window.evaluate(piSessionId => window.pace!.invoke("send_prompt", { piSessionId, prompt: "Start the background probe." }), created.piSessionId);
      const root = dirname(app.project!.path);
      const completed = async () => {
        const paths = await files(root);
        const statuses = await Promise.all(paths.filter(path => path.endsWith("/status.json")).map(async path => {
          try { return JSON.parse(await readFile(path, "utf8")); } catch { return {}; }
        }));
        return statuses.find(status => status.state === "complete" && status.processTerminal?.state === "observed");
      };
      await expect.poll(completed, { timeout: 30_000 }).toBeTruthy();
      const status = await completed();
      expect(status.processTerminal.instances[0].exitCode).toBe(0);
      expect(status.totalTokens.total).toBeGreaterThan(0);
      if (authMode === "codex-oauth") {
        expect(authenticatedRequests.length).toBeGreaterThanOrEqual(2);
        expect(authenticatedRequests.every(Boolean)).toBe(true);
      }
      await expect.poll(async () => {
        const sessions = (await files(join(root, "agent"))).filter(path => path.endsWith(".jsonl"));
        return (await Promise.all(sessions.map(path => readFile(path, "utf8")))).some(content => content.includes('"customType":"subagent-notify"') && content.includes("BACKGROUND_OK"));
      }).toBe(true);
      expect(await fingerprint(plugin!)).toBe(before);
      await testInfo.attach("background-result", { body: JSON.stringify({ requests, pluginUnchanged: true, status }), contentType: "application/json" });
    } finally {
      await app.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
