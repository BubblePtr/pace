import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const run = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeSource = resolve(process.env.PACE_TEST_RUNTIME_DIR ?? join(repo, "apps/desktop/out/main/runtime"));

test("an independent SDK derives subscription auth from stored credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "pace-extension-oauth-"));
  try {
    await cp(runtimeSource, root, { recursive: true });
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await writeFile(join(agentDir, "auth.json"), JSON.stringify({
      "openai-codex": { type: "oauth", access: "fixture-access", refresh: "fixture-refresh",
        expires: Date.now() + 3_600_000, accountId: "fixture-account" },
    }));
    await writeFile(join(root, "probe.mjs"), `
      import assert from 'node:assert/strict';
      import { ModelRuntime } from '@earendil-works/pi-coding-agent';
      globalThis.fetch = () => { throw new Error('OAuth fixture must not use the network'); };
      const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
      const result = await runtime.getAuth('openai-codex');
      assert.equal(result?.auth.apiKey, 'fixture-access');
      console.log('SDK_OAUTH_OK');
    `);
    const { stdout } = await run(process.execPath, [join(root, "probe.mjs")], {
      cwd: root,
      env: { HOME: root, PATH: "", PI_CODING_AGENT_DIR: agentDir,
        PI_PACKAGE_DIR: join(root, "node_modules/@earendil-works/pi-coding-agent") },
      timeout: 30_000,
    });
    assert.match(stdout, /SDK_OAUTH_OK/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the standalone provider entry loads every built-in OAuth flow", async () => {
  const root = await mkdtemp(join(tmpdir(), "pace-provider-oauth-"));
  try {
    await cp(runtimeSource, root, { recursive: true });
    await writeFile(join(root, "probe.mjs"), `
      import assert from 'node:assert/strict';
      import { builtinProviders, radiusProvider } from '@earendil-works/pi-ai/providers/all';
      globalThis.fetch = () => { throw new Error('OAuth fixture must not use the network'); };
      const credential = { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3_600_000 };
      const providers = [...builtinProviders(), radiusProvider({ gateway: 'https://radius.example.test' })]
        .filter(provider => provider.auth.oauth);
      assert.ok(providers.some(provider => provider.id === 'openai-codex'));
      for (const provider of providers) {
        const auth = await provider.auth.oauth.toAuth(credential);
        assert.equal(auth.apiKey ?? auth.headers?.Authorization?.replace(/^Bearer /, ''), credential.access, provider.id);
      }
      console.log('PROVIDER_OAUTH_OK', providers.length);
    `);
    const { stdout } = await run(process.execPath, [join(root, "probe.mjs")], {
      cwd: root, env: { HOME: root, PATH: "" }, timeout: 30_000,
    });
    assert.match(stdout, /PROVIDER_OAUTH_OK/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an independent Node process can use the shipped SDK and its peer exports", async () => {
  const root = await mkdtemp(join(tmpdir(), "pace-extension-sdk-"));
  try {
    await cp(join(repo, "apps/desktop/out/main/runtime"), root, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(root, "probe.mjs"), `
      import assert from 'node:assert/strict';
      import * as sdk from '@earendil-works/pi-coding-agent';
      import { Agent } from '@earendil-works/pi-agent-core';
      import * as nodeCore from '@earendil-works/pi-agent-core/node';
      import * as ai from '@earendil-works/pi-ai/compat';
      import * as oauth from '@earendil-works/pi-ai/oauth';
      import * as providers from '@earendil-works/pi-ai/providers/all';
      import * as tui from '@earendil-works/pi-tui';
      import { Type } from 'typebox';
      import { Compile } from 'typebox/compile';
      import { Value } from 'typebox/value';
      const schema = Type.Object({ task: Type.String() });
      assert.equal(Compile(schema).Check({ task: 'probe' }), true);
      assert.equal(Value.Check(schema, { task: 42 }), false);
      const loader = new sdk.DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true });
      await loader.reload();
      const { session } = await sdk.createAgentSession({ cwd: process.cwd(), resourceLoader: loader });
      assert.ok(session.agent instanceof Agent, 'the public SDK must share peer identity');
      assert.ok(session.agent.state.tools.some(tool => tool.name === 'read'));
      await session.dispose();
      console.log('SDK_CHILD_OK');
    `);
    const { stdout } = await run(process.execPath, [join(root, "probe.mjs")], {
      cwd: root,
      env: { HOME: root, PATH: "", PI_CODING_AGENT_DIR: join(root, "agent"),
        PI_PACKAGE_DIR: join(root, "node_modules/@earendil-works/pi-coding-agent") },
      timeout: 30_000,
    });
    assert.match(stdout, /SDK_CHILD_OK/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the release declares an exact Pi engine combination", async () => {
  const { dependencies } = JSON.parse(await readFile(join(repo, "packages/backend/package.json"), "utf8"));
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
    assert.match(dependencies[name], /^\d+\.\d+\.\d+$/, `${name} must be pinned before release`);
    const installed = JSON.parse(await readFile(join(repo, "packages/backend/node_modules", name, "package.json"), "utf8"));
    assert.equal(installed.version, dependencies[name]);
  }
});

test("the shipped backend works without global pi or repository node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "pigui-bundled-runtime-"));
  try {
    const appDir = join(root, "app");
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await cp(join(repo, "apps/desktop/out/main"), join(appDir, "out/main"), { recursive: true });
    await cp(join(repo, "apps/desktop/package.json"), join(appDir, "package.json"));
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(cwd);
    await writeFile(join(agentDir, "auth.json"), JSON.stringify({
      openai: { type: "api_key", key: "bundled-runtime-test-placeholder" },
    }));
    await writeFile(join(agentDir, "extensions/working.ts"), `
      import { Type } from "typebox";
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      export default function(pi) {
        pi.registerTool({ name: "bundle_probe", label: "Probe", description: "Bundled extension probe",
          parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "ok" }] }) });
        pi.on("session_start", async (_event, ctx) => { writeFileSync(join(ctx.cwd, "started.txt"), "ready"); });
        pi.registerCommand("bundle-probe", { description: "Probe command", handler: async (_args, ctx) => {
          writeFileSync(join(ctx.cwd, "command.txt"), "ready");
        } });
      }
    `);
    await writeFile(join(agentDir, "extensions/broken.ts"), `export default function() { throw new Error("EXTENSION_LOAD_PROBE"); }`);
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", `
      import { pathToFileURL } from "node:url";
      const pending = new Map();
      const events = [];
      let receive;
      let connected;
      const ready = new Promise(resolve => { connected = resolve; });
      process.parentPort = { on(_name, connect) {
        connect({ data: { type: "connect" }, ports: [{
          on(_event, handler) { receive = handler; connected(); }, start() {},
          postMessage(message) {
            if (message.type === "event") events.push(message.event);
            else { pending.get(message.id)?.(message); pending.delete(message.id); }
          },
        }] });
      } };
      await import(pathToFileURL(process.env.PROBE_BACKEND));
      await ready;
      let sequence = 0;
      const request = (method, params) => new Promise(resolve => {
        const id = String(++sequence); pending.set(id, resolve); receive({ data: { id, method, params } });
      });
      const preflight = await request("run_environment_preflight");
      const created = await request("create_session", { sessionId: "probe", projectId: "probe", cwd: process.env.PROBE_CWD });
      const piSessionId = created.result?.piSessionId;
      const tools = piSessionId ? await request("resolve_tool_schemas", { piSessionId, names: ["bundle_probe"] }) : null;
      const prompted = piSessionId ? await request("send_prompt", { piSessionId, prompt: "/bundle-probe" }) : null;
      const snapshot = piSessionId ? await request("get_runtime_snapshot", { piSessionId }) : null;
      console.log("PROBE_RESULT " + JSON.stringify({ preflight, created, tools, prompted, snapshot, events }));
    `], {
      cwd,
      env: {
        ...process.env,
        PATH: "",
        HOME: root,
        PI_CODING_AGENT_DIR: agentDir,
        PACE_DATA_DIR: join(root, "data"),
        PROBE_BACKEND: join(appDir, "out/main/runtime/node_modules/@earendil-works/pi-coding-agent/pace-backend.js"),
        PI_PACKAGE_DIR: join(appDir, "out/main/runtime/node_modules/@earendil-works/pi-coding-agent"),
        PACE_NODE_PATH: join(root, "missing-node"),
        PROBE_CWD: cwd,
      },
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const result = JSON.parse(stdout.split("\n").find(line => line.startsWith("PROBE_RESULT ")).slice(13));
    assert.equal(result.created.error, undefined);
    assert.ok(result.created.result.events.some(event => event.payload.code === "extension_load_error"), "startup errors must be in the first snapshot");
    assert.ok(result.tools?.result?.schemas?.bundle_probe, "the extension must resolve bundled peer modules");
    assert.equal(await readFile(join(cwd, "started.txt"), "utf8"), "ready", "session_start must run");
    assert.equal(await readFile(join(cwd, "command.txt"), "utf8"), "ready", "native commands must run");
    assert.ok(result.snapshot?.result?.events?.some(event => JSON.stringify(event.payload).includes("EXTENSION_LOAD_PROBE")), "load errors must survive gateway replay");
    assert.equal(result.preflight.result?.canContinue, true, "a global CLI must not be required");
    const runtimeCheck = result.preflight.result.checks.find(check => check.id === "pi_runtime");
    const appPackage = JSON.parse(await readFile(join(appDir, "package.json"), "utf8"));
    const piPackage = JSON.parse(await readFile(join(repo, "packages/backend/node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
    assert.equal(runtimeCheck.detail, `Pace ${appPackage.version} · Pi ${piPackage.version} · SDK`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
