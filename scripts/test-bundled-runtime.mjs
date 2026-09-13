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
      import assert from "node:assert/strict";
      import { Type } from "typebox";
      import { initTheme, getMarkdownTheme, resizeImage } from "@earendil-works/pi-coding-agent";
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      export default function(pi) {
        pi.registerTool({ name: "bundle_probe", label: "Probe", description: "Bundled extension probe",
          parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "ok" }] }) });
        pi.on("session_start", async (_event, ctx) => { writeFileSync(join(ctx.cwd, "started.txt"), "ready"); });
        pi.registerCommand("bundle-probe", { description: "Probe command", handler: async (_args, ctx) => {
          for (const name of ["dark", "light"]) {
            initTheme(name);
            assert.match(getMarkdownTheme().heading("theme-probe"), /theme-probe/);
          }
          const image = await resizeImage(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=", "base64"), "image/png", { maxWidth: 1, maxHeight: 1 });
          assert.equal(image?.width, 1, "the Photon WASM module must load");
          writeFileSync(join(ctx.cwd, "command.txt"), "themes-and-image-ready");
        } });
      }
    `);
    await writeFile(join(agentDir, "extensions/broken.ts"), `export default function() { throw new Error("EXTENSION_LOAD_PROBE"); }`);
    const { stdout, stderr } = await run(process.execPath, ["--input-type=module", "-e", `
      import { pathToFileURL } from "node:url";
      const pending = new Map();
      const events = [];
      let receive;
      let connected;
      const ready = new Promise(resolve => { connected = resolve; });
      process.parentPort = { on(_name, connect) {
        connect({ data: { type: "connect" }, ports: [{
          on(event, handler) { if (event === "message") { receive = handler; connected(); } }, start() {},
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
        PROBE_BACKEND: join(appDir, "out/main/backend.js"),
        PI_PACKAGE_DIR: join(appDir, "out/main/pi-assets"),
        PROBE_CWD: cwd,
      },
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const result = JSON.parse(stdout.split("\n").find(line => line.startsWith("PROBE_RESULT ")).slice(13));
    if (stderr) console.error(stderr);
    assert.equal(result.created.error, undefined);
    assert.ok(result.created.result.events.some(event => event.payload.code === "extension_load_error"), "startup errors must be in the first snapshot");
    assert.ok(result.tools?.result?.schemas?.bundle_probe, "the extension must resolve bundled peer modules");
    assert.equal(await readFile(join(cwd, "started.txt"), "utf8"), "ready", "session_start must run");
    assert.equal(result.prompted?.error, undefined, JSON.stringify(result.snapshot));
    assert.equal(await readFile(join(cwd, "command.txt"), "utf8"), "themes-and-image-ready", "native commands, built-in themes, and Photon must run");
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
