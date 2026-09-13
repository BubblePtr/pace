import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { RuntimeGatewayEventEnvelope, RuntimeGatewaySnapshot, SubagentSnapshot, SubagentsSnapshot } from "@pace/core";
import { launchPace } from "./electron-app";

const plugin = process.env.PACE_TEST_TINTIN_DIR;
const provider = "pace-observation-test";
const model = `${provider}/probe`;

type Message = { role?: string; content?: string | Array<{ text?: string }> };
type Gate = { closed: boolean; release(): void };
type RequestBody = { messages: Message[]; tools?: Array<{ function?: { name?: string } }> };
type RequestLog = { label?: string; planner: boolean; body: RequestBody; lastText: string; responded: boolean };
export type ObservationEventWindow = Window & { observationEvents?: RuntimeGatewayEventEnvelope[] };

function textContent(message: Message | undefined): string {
  return typeof message?.content === "string" ? message.content
    : message?.content?.map(part => part.text ?? "").join("\n") ?? "";
}

async function invoke<T>(page: Page, method: string, params?: unknown): Promise<T> {
  return page.evaluate(({ method, params }) => window.pace!.invoke<T>(method, params), { method, params });
}

async function projectAgents(cwd: string, identity: string) {
  const agents = join(cwd, ".pi", "agents");
  await mkdir(agents, { recursive: true });
  await writeFile(join(cwd, "observation-probe.txt"), `READ_FROM_${identity}`);
  await writeFile(join(agents, "observation-worker.md"), `---\nname: observation-worker\ndescription: Read project files\nmodel: ${model}\ntools: read\nisolated: true\n---\nPROJECT_IDENTITY_${identity}\nFollow the task.\n`);
  await writeFile(join(agents, "observation-coordinator.md"), `---\nname: observation-coordinator\ndescription: Coordinate nested read\nmodel: ${model}\ntools: read\nallowed_subagents: observation-worker\n---\nPROJECT_IDENTITY_${identity}\nDelegate the task to observation-worker.\n`);
}

export async function createSubagentObservationFixture(options: { observeShutdown?: boolean; reportUsage?: boolean } = {}) {
  test.skip(!plugin || !existsSync(join(plugin, "node_modules")), "Set PACE_TEST_TINTIN_DIR to the adapted Tintinweb checkout with dependencies");
  const gates = new Map<string, Gate>();
  const requests: RequestLog[] = [];
  const responseRequests = new WeakMap<ServerResponse, RequestLog>();
  const fixtureErrors: string[] = [];
  let responseSequence = 0;
  function respond(response: ServerResponse, text: string, tool?: { name: string; args: unknown }) {
    const id = `observation-${++responseSequence}`;
    if (!response.headersSent) response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id, object: "chat.completion.chunk", created: 1, model: "probe" };
    const delta = tool
      ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
      : { role: "assistant", content: text };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 } })}\n\n`);
    response.end("data: [DONE]\n\n");
    const request = responseRequests.get(response);
    if (request) request.responded = true;
  }
  function hold(key: string, response: ServerResponse, release: () => void) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    const gate = { closed: false, release };
    response.on("close", () => { gate.closed = true; });
    gates.set(key, gate);
  }
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as RequestBody;
      const userTexts = body.messages.filter(message => message.role === "user").map(textContent);
      const childPrompt = userTexts.find(text => text.startsWith("CHILD:") || text.startsWith("COORD:"));
      const last = body.messages.at(-1);
      const lastText = textContent(last);
      const label = childPrompt?.split(":")[1]?.split(/\s/)[0];
      const planner = body.tools?.length === 1 && body.tools[0]?.function?.name === "Agent";
      const logged = { label, planner, body, lastText, responded: false };
      requests.push(logged);
      responseRequests.set(response, logged);
      if (planner) {
        if (!label) throw new Error("Mention planner request has no task label");
        if (last?.role === "tool") respond(response, `PLANNER_DONE:${label}`);
        else hold(`${label}:planner`, response, () => respond(response, "", { name: "Agent", args: {
          subagent_type: "observation-worker", prompt: `CHILD:${label}`, description: label,
          run_in_background: true, model, thinking: "off",
        } }));
      } else if (childPrompt?.startsWith("COORD:")) {
        if (last?.role === "tool") respond(response, `COORDINATOR_DONE:${label}`);
        else respond(response, "", { name: "Agent", args: { subagent_type: "observation-worker", prompt: `CHILD:${label}-nested`, description: `${label}-nested`, run_in_background: false, model, thinking: "off" } });
      } else if (childPrompt) {
        if (last?.role === "tool") hold(`${label}:after-read`, response, () => respond(response, `CHILD_DONE:${label}`));
        else hold(`${label}:before-read`, response, () => respond(response, "", { name: "read", args: { path: "observation-probe.txt" } }));
      } else if (last?.role === "user" && lastText.startsWith("SPAWN:")) {
        const [, nextLabel, kind = "worker"] = lastText.split(":");
        respond(response, "", { name: "Agent", args: {
          subagent_type: `observation-${kind}`, prompt: `${kind === "coordinator" ? "COORD" : "CHILD"}:${nextLabel}`,
          description: nextLabel, run_in_background: true, model, thinking: "off",
        } });
      } else if (last?.role === "user" && lastText === "HOLD_PARENT") {
        hold("parent", response, () => respond(response, "PARENT_DONE"));
      } else respond(response, last?.role === "tool" ? "PARENT_CONTINUED" : "PARENT_NEXT_TURN");
    } catch (error) {
      fixtureErrors.push(String(error));
      response.writeHead(500).end("Fixture request failed");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture server address");
  const app = await launchPace({ seedProject: true, emptyPath: true, agentFiles: {
    "settings.json": JSON.stringify({ defaultProvider: provider, defaultModel: "probe", defaultThinkingLevel: "off", extensions: [join(plugin!, "src/index.ts"), ...(options.observeShutdown ? ["./shutdown-observer.ts"] : [])] }),
    ...(options.observeShutdown ? { "shutdown-observer.ts": `
      import { appendFileSync } from "node:fs";
      import { join } from "node:path";
      import { getAgentDir } from "@earendil-works/pi-coding-agent";
      export default function(pi) {
        pi.on("session_shutdown", (_event, ctx) => {
          appendFileSync(join(getAgentDir(), "shutdown.jsonl"), JSON.stringify({ sessionId: ctx.sessionManager.getSessionId() }) + "\\n");
        });
      }
    ` } : {}),
    "subagents.json": JSON.stringify({ fallbackSubagent: "none", rememberAgents: false, maxConcurrent: 4, maxSubagentDepth: 2, ...(options.reportUsage === undefined ? {} : { reportUsage: options.reportUsage }) }),
    "models.json": JSON.stringify({ providers: { [provider]: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fixture-key", models: [{ id: "probe", name: "Observation probe", reasoning: false, input: ["text"], contextWindow: 16000, maxTokens: 1024, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] } } }),
  } });
  const page = app.window;
  await page.evaluate(() => {
    (window as ObservationEventWindow).observationEvents = [];
    window.pace!.onBackendEvent(event => (window as ObservationEventWindow).observationEvents!.push(event.event));
  });
  const call = <T>(method: string, params?: unknown) => invoke<T>(page, method, params);
  const list = (piSessionId: string) => call<SubagentsSnapshot>("get_subagents", { piSessionId });
  const detail = (piSessionId: string, agentId: string) => call<SubagentSnapshot>("get_subagent_snapshot", { piSessionId, agentId });
  const send = (piSessionId: string, prompt: string) => call("send_prompt", { piSessionId, prompt });
  const idle = (piSessionId: string) => expect.poll(async () => (await call<RuntimeGatewaySnapshot>("get_runtime_snapshot", { piSessionId })).status).not.toBe("running");
  const gate = async (key: string) => {
    await expect.poll(() => gates.has(key), { message: `Waiting for model request ${key}` }).toBe(true);
    return gates.get(key)!;
  };
  const find = async (piSessionId: string, description: string) => {
    await expect.poll(async () => (await list(piSessionId)).records.some(record => record.description === description)).toBe(true);
    return (await list(piSessionId)).records.find(record => record.description === description)!;
  };
  return {
    app, page, requests, call, list, detail, send, idle, gate, find,
    async create(sessionId: string, cwd = app.project!.path, identity = "ALPHA") {
      await projectAgents(cwd, identity);
      const created = await call<{ piSessionId: string }>("create_session", { sessionId, projectId: cwd, cwd });
      expect((await list(created.piSessionId)).available).toBe(true);
      return created.piSessionId;
    },
    async spawn(piSessionId: string, label: string, kind = "worker") {
      await send(piSessionId, `SPAWN:${label}:${kind}`);
      await gate(`${label}${kind === "coordinator" ? "-nested" : ""}:before-read`);
      await idle(piSessionId);
      return find(piSessionId, label);
    },
    async close() {
      if (test.info().status !== test.info().expectedStatus && !page.isClosed()) {
        const events = await page.evaluate(() => (window as ObservationEventWindow).observationEvents ?? []);
        await test.info().attach("model-requests-and-runtime-events", {
          body: JSON.stringify({ requests, events, fixtureErrors }), contentType: "application/json",
        });
      }
      await app.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      expect(fixtureErrors).toEqual([]);
    },
  };
}
