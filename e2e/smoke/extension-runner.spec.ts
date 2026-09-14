import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { launchPace } from "../fixtures/electron-app";

const plugin = process.env.PACE_TEST_TINTIN_SUBAGENTS_DIR;

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


const observer = `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
export default function(pi) {
  let sessionId;
  const log = (type, data) => appendFileSync(join(getAgentDir(), "trial-events.jsonl"), JSON.stringify({type, sessionId, pid:process.pid, processCwd:process.cwd(), data})+"\\n");
  pi.on("session_start", (event, ctx) => { sessionId=ctx.sessionManager.getSessionId(); log("session_start", {cwd:ctx.cwd, hasUI:ctx.hasUI}); });
  pi.on("session_shutdown", () => log("session_shutdown", {}));
  pi.on("agent_end", () => log("agent_end", {}));
  pi.on("tool_result", (event) => log("tool_result", {name:event.toolName, content:event.content, details:event.details, isError:event.isError}));
  for(const type of ["subagents:started", "subagents:completed", "subagents:failed"]) pi.events.on(type, data => log(type,data));
  pi.registerTool(defineTool({name:"trial_stop",label:"Trial stop",description:"Test probe for the plugin public stop RPC",parameters:Type.Object({id:Type.String()}),
    async execute(_id, params) {
      const requestId="trial-"+Date.now();
      const reply=await new Promise(resolve=>{const off=pi.events.on("subagents:rpc:stop:reply:"+requestId,data=>{off();resolve(data)});pi.events.emit("subagents:rpc:stop",{requestId,agentId:params.id});});
      return {content:[{type:"text",text:JSON.stringify(reply)}],details:reply};
    }
  }));
}
`;

for (const authMode of ["api-key", "codex-oauth"] as const) {
  test(`original Tintinweb owns children inside isolated root Sessions: ${authMode}`, async ({}, testInfo) => {
    test.skip(!plugin, "Set PACE_TEST_TINTIN_SUBAGENTS_DIR to @tintinweb/pi-subagents with its dependencies");
    const before = await fingerprint(plugin!);
    test.setTimeout(60_000);
    const provider = authMode === "codex-oauth" ? "openai-codex" : "pace-test";
    const api = authMode === "codex-oauth" ? "openai-codex-responses" : "openai-completions";
    const model = `${provider}/probe`;
    const access = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
    const requests: any[] = [];
    const holds = new Map<string, { response: ServerResponse; release: () => void; closed: boolean; released: boolean }>();
    let serial = 0;
    const emit = (response: ServerResponse, text: string, tool?: { name: string; args: any }) => {
      const id = `fixture-${++serial}`;
      if (!response.headersSent) response.writeHead(200, { "content-type": "text/event-stream" });
      if (authMode === "codex-oauth") {
        const item = tool
          ? { type: "function_call", id: `fc_${id}`, call_id: id, name: tool.name, arguments: JSON.stringify(tool.args), status: "completed" }
          : { type: "message", id: `msg_${id}`, role: "assistant", content: [{ type: "output_text", text, annotations: [] }], status: "completed" };
        for (const event of [
          { type: "response.created", response: { id } },
          { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", content: [] } },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } },
        ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      } else {
        const base = { id, object: "chat.completion.chunk", created: 1, model: "probe" };
        const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { role: "assistant", content: text };
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\n`);
        response.end("data: [DONE]\n\n");
      }
    };
    const contentText = (value: any): string => typeof value === "string" ? value : Array.isArray(value) ? value.map(part => part.text ?? "").join("\n") : "";
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const body = JSON.parse((request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw).toString());
      const messages = body.messages ?? body.input;
      const userTexts = messages.filter((message: any) => message.role === "user").map((message: any) => contentText(message.content));
      const childPrompt = userTexts.find((text: string) => text.startsWith("CHILD_HOLD:"));
      const last = messages.at(-1);
      const lastText = contentText(last?.content);
      const isToolResult = last?.role === "tool" || last?.type === "function_call_output";
      requests.push({ index: requests.length, childPrompt, lastType: last?.role ?? last?.type, lastText, body, authenticated: authMode !== "codex-oauth" || request.headers.authorization === `Bearer ${access}` });
      if (childPrompt) {
        const label = childPrompt.split(":")[1].trim();
        if (isToolResult) { emit(response, `CHILD_OK:${label}`); return; }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
        const hold = { response, closed: false, released: false, release: () => { hold.released = true; emit(response, "", { name: "read", args: { path: "trial-probe.txt" } }); } };
        response.on("close", () => { hold.closed = true; });
        holds.set(label, hold);
        return;
      }
      if (!isToolResult && lastText.startsWith("SPAWN:")) {
        const [, label, type = "probe"] = lastText.split(":");
        emit(response, "", { name: "Agent", args: { subagent_type: type, prompt: `CHILD_HOLD:${label}`, description: `Trial ${label}`, run_in_background: label !== "foreground", model, thinking: "off" } });
      } else if (!isToolResult && lastText.startsWith("STOP:")) {
        emit(response, "", { name: "trial_stop", args: { id: lastText.slice(5) } });
      } else {
        emit(response, isToolResult ? "PARENT_CONTINUED" : "PARENT_NEXT_TURN");
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    const app = await launchPace({ seedProject: true, emptyPath: true,
      agentFiles: {
        "settings.json": JSON.stringify({ defaultProvider: provider, defaultModel: "probe", defaultThinkingLevel: "off", transport: "sse", extensions: [join(plugin!, "src/index.ts"), "./trial-observer.ts"] }),
        "trial-observer.ts": observer,
        "subagents.json": JSON.stringify({ fallbackSubagent: "none", rememberAgents: false }),
        ...(authMode === "codex-oauth" ? { "auth.json": JSON.stringify({ "openai-codex": { type: "oauth", access, refresh: "fixture-refresh", expires: Date.now() + 3_600_000, accountId: "fixture-account" } }) } : {}),
        "models.json": JSON.stringify({ providers: { [provider]: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api, ...(authMode === "api-key" ? { apiKey: "local-test-placeholder" } : {}), models: [{ id: "probe", name: "Probe", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }),
      },
    });
    const root = dirname(app.project!.path);
    const events = async (): Promise<any[]> => {
      try { return (await readFile(join(root, "agent", "trial-events.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
    };
    const invoke = (method: string, params: any) => app.window.evaluate(({ method, params }) => window.pace!.invoke<any>(method, params), { method, params });
    const result: any = { authMode, requests: 0, executable: process.env.PACE_E2E_EXECUTABLE };
    try {
      await mkdir(join(app.project!.path, ".pi/agents"), { recursive: true });
      await writeFile(join(app.project!.path, ".pi/agents/probe.md"), `---\nname: probe\ndescription: Project-only agent\nmodel: ${model}\ntools: read\n---\nFollow the task.\n`);
      await writeFile(join(app.project!.path, "trial-probe.txt"), "READ_FROM_CORRECT_PROJECT");
      const created = await invoke("create_session", { sessionId: `tintin-${authMode}`, projectId: app.project!.path, cwd: app.project!.path });
      result.created = created;
      const piSessionId = created.piSessionId;
      const send = (prompt: string) => invoke("send_prompt", { piSessionId, prompt });
      const idle = () => expect.poll(async () => (await invoke("get_runtime_snapshot", { piSessionId })).status).not.toBe("running");
      await send("SPAWN:completion");
      await expect.poll(() => holds.has("completion")).toBe(true);
      await idle();
      result.parentContinuesBeforeChild = !holds.get("completion")!.released && requests.some(request => request.lastType === "tool" || request.lastType === "function_call_output");
      await send("NEXT_PARENT_TURN");
      await idle();
      result.parentAcceptsNextTurn = requests.some(request => request.lastText === "NEXT_PARENT_TURN") && !holds.get("completion")!.closed;
      holds.get("completion")!.release();
      await expect.poll(async () => (await events()).some(event => event.type === "subagents:completed")).toBe(true);
      await expect.poll(() => requests.some(request => JSON.stringify(request.body).includes("subagent-notification") || request.lastText.includes("CHILD_OK:completion"))).toBe(true);
      await idle();
      result.completionNotification = true;
      result.childRead = requests.some(request => request.childPrompt && JSON.stringify(request.body).includes("READ_FROM_CORRECT_PROJECT"));
      await send("SPAWN:foreground");
      await expect.poll(() => holds.has("foreground")).toBe(true);
      expect((await invoke("get_runtime_snapshot", { piSessionId })).status).toBe("running");
      holds.get("foreground")!.release();
      await expect.poll(async () => (await events()).some(event => event.type === "tool_result" && event.data.name === "Agent" && JSON.stringify(event.data).includes("CHILD_OK:foreground"))).toBe(true);
      await idle();
      await send("SPAWN:cancel");
      await expect.poll(() => holds.has("cancel")).toBe(true);
      await idle();
      const started = (await events()).filter(event => event.type === "subagents:started").at(-1);
      await send(`STOP:${started.data.id}`);
      await expect.poll(() => holds.get("cancel")!.closed).toBe(true);
      await idle();
      result.pluginStopCancelsRequest = true;
      result.events = await events();
      result.allAuthValid = requests.every(request => request.authenticated);
      result.requests = requests.length;
      expect(new Set(result.events.filter((event: any) => event.type === "session_start").map((event: any) => event.pid)).size).toBe(1);
      expect(new Set(result.events.filter((event: any) => event.type === "session_start").map((event: any) => event.sessionId)).size).toBeGreaterThan(1);
      expect(await fingerprint(plugin!)).toBe(before);
      expect(result.parentAcceptsNextTurn).toBe(true);
      expect(result.parentContinuesBeforeChild).toBe(true);
      expect(result.childRead).toBe(true);
      expect(result.allAuthValid).toBe(true);

      const secondCwd = join(root, "second-project");
      await mkdir(join(secondCwd, ".pi/agents"), { recursive: true });
      await writeFile(join(secondCwd, ".pi/agents/probe-b.md"), `---\nname: probe-b\ndescription: Second project only\nmodel: ${model}\ntools: read\n---\nFollow the task.\n`);
      await writeFile(join(secondCwd, "trial-probe.txt"), "READ_FROM_SECOND_PROJECT");
      const originalPid = result.events.find((event: any) => event.sessionId === piSessionId && event.type === "session_start").pid;
      process.kill(originalPid, "SIGKILL");
      await expect.poll(async () => (await invoke("get_runtime_snapshot", { piSessionId })).status).toBe("failed");
      // Even if the caller's cwd drifted, Pi's saved cwd must be established
      // before the resumed root reloads project extensions and agents.
      const resumed = await invoke("resume_session", { ...created, cwd: secondCwd });
      expect(await realpath(resumed.cwd)).toBe(await realpath(app.project!.path));
      const second = await invoke("create_session", { sessionId: "second", projectId: secondCwd, cwd: secondCwd });
      await invoke("send_prompt", { piSessionId: second.piSessionId, prompt: "SPAWN:survivor:probe-b" });
      await expect.poll(() => holds.has("survivor")).toBe(true);
      await send("SPAWN:deleted");
      await expect.poll(() => holds.has("deleted")).toBe(true);
      await idle();
      const starts = (await events()).filter(event => event.type === "session_start");
      const a = starts.filter(event => event.sessionId === piSessionId).at(-1);
      const b = starts.find(event => event.sessionId === second.piSessionId);
      expect(a.processCwd).toBe(await realpath(app.project!.path));
      expect(b.processCwd).toBe(await realpath(secondCwd));
      expect(a.pid).not.toBe(b.pid);
      await invoke("delete_session", { sessionId: `tintin-${authMode}` });
      await expect.poll(() => holds.get("deleted")!.closed).toBe(true);
      expect(holds.get("survivor")!.closed).toBe(false);
      expect((await events()).some(event => event.sessionId === piSessionId && event.type === "session_shutdown")).toBe(true);
      holds.get("survivor")!.release();
      await expect.poll(() => requests.some(request => request.childPrompt && JSON.stringify(request.body).includes("READ_FROM_SECOND_PROJECT"))).toBe(true);
      await expect.poll(async () => (await invoke("get_runtime_snapshot", { piSessionId: second.piSessionId })).status).not.toBe("running");
      await invoke("send_prompt", { piSessionId: second.piSessionId, prompt: "SPAWN:quit:probe-b" });
      await expect.poll(() => holds.has("quit")).toBe(true);
      const closed = app.app.waitForEvent("close");
      await app.app.evaluate(({ app }) => app.quit());
      await closed;
      await expect.poll(() => holds.get("quit")!.closed).toBe(true);
      expect((await events()).some(event => event.sessionId === second.piSessionId && event.type === "session_shutdown")).toBe(true);
      expect(await fingerprint(plugin!)).toBe(before);
    } finally {
      result.events = await events();
      result.requestLog = requests;
      await testInfo.attach("trial-result", { body: JSON.stringify(result), contentType: "application/json" });
      await app.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
