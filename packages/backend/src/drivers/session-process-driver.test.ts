import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiRuntimeDriver, RuntimeGatewayDriverEvent } from "../gateway/runtime-gateway";
import { createSessionProcessDriver } from "./session-process-driver";

describe("Session process isolation", () => {
  let root: string;
  let driver: PiRuntimeDriver;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "pace-session-process-")));
    await Promise.all(["a", "b"].map(name => mkdir(join(root, name))));
    driver = createSessionProcessDriver({
      entryPath: join(process.cwd(), "packages/backend/src/drivers/fixtures/session-process.mjs"),
      agentDir: root,
      shutdownTimeoutMs: 500,
    });
  });
  afterEach(async () => {
    await driver.dispose?.();
    await rm(root, { recursive: true, force: true });
  });

  it("gives each root Session its own cwd and module state, including roots in the same project", async () => {
    const create = (sessionId: string, project: string) => driver.createSession({
      sessionId, projectId: project, cwd: join(root, project),
    });
    const [a, b, sibling] = await Promise.all([create("a", "a"), create("b", "b"), create("sibling", "a")]);
    expect(new Set([a.runtimeId, b.runtimeId, sibling.runtimeId]).size).toBe(3);
    expect([a.cwd, b.cwd, sibling.cwd]).toEqual([join(root, "a"), join(root, "b"), join(root, "a")]);
    expect([a.sessionName, b.sessionName, sibling.sessionName]).toEqual(["1", "1", "1"]);
    expect(process.cwd()).not.toBe(a.cwd);
  });

  it("reattaches without reloading extensions and releases only the requested root", async () => {
    const a = await driver.createSession({ sessionId: "a", projectId: "a", cwd: join(root, "a") });
    const b = await driver.createSession({ sessionId: "b", projectId: "b", cwd: join(root, "b") });
    const resumed = await driver.resumeSession({ ...a, sessionFile: "unused-while-alive" });
    expect(resumed.runtimeId).toBe(a.runtimeId);
    expect(resumed.sessionName).toBe("1");
    const pending = driver.sendPrompt({ piSessionId: a.piSessionId, prompt: "hold" }).catch(error => error);
    await driver.disposeSession!(a.piSessionId);
    expect(await pending).toBeInstanceOf(Error);
    expect(await readFile(join(a.cwd, `closed-${a.runtimeId}`), "utf8")).toBe("closed");
    expect((await driver.getSnapshot(b.piSessionId)).runtimeId).toBe(b.runtimeId);
  });

  it("reports a crash, settles pending commands and permits explicit recovery without restarting siblings", async () => {
    const events: RuntimeGatewayDriverEvent[] = [];
    driver.onEvent(event => events.push(event));
    const a = await driver.createSession({ sessionId: "a", projectId: "a", cwd: join(root, "a") });
    const b = await driver.createSession({ sessionId: "b", projectId: "b", cwd: join(root, "b") });
    await expect(driver.sendPrompt({ piSessionId: a.piSessionId, prompt: "crash" })).rejects.toThrow("exited");
    expect(events.some(event => event.piSessionId === a.piSessionId && event.type === "error")).toBe(true);
    expect((await driver.getSnapshot(a.piSessionId)).status).toBe("failed");
    const resumed = await driver.resumeSession({ ...a, sessionFile: "fixture.jsonl" });
    expect(resumed.runtimeId).not.toBe(a.runtimeId);
    expect((await driver.getSnapshot(b.piSessionId)).runtimeId).toBe(b.runtimeId);
  });

  it("shares one process for concurrent resumes and rejects a conflicting owner", async () => {
    const input = { sessionId: "a", projectId: "a", cwd: join(root, "a"), piSessionId: "pi-a", sessionFile: "fixture.jsonl" };
    const [a, b, conflict] = await Promise.all([
      driver.resumeSession(input), driver.resumeSession(input),
      driver.resumeSession({ ...input, sessionId: "other" }).then(() => null, error => error),
    ]);
    expect(a.runtimeId).toBe(b.runtimeId);
    expect(conflict).toBeInstanceOf(Error);
    expect(conflict.message).toContain("different Pace session");
  });

  it("bounds an uncooperative shutdown and reports forced termination", async () => {
    const events: RuntimeGatewayDriverEvent[] = [];
    driver.onEvent(event => events.push(event));
    const a = await driver.createSession({ sessionId: "a", projectId: "a", cwd: join(root, "a") });
    await driver.sendPrompt({ piSessionId: a.piSessionId, prompt: "hang-shutdown" });
    await driver.disposeSession!(a.piSessionId);
    expect(() => process.kill(Number(a.runtimeId), 0)).toThrow();
    expect(events.some(event => event.type === "error" && String(event.payload.body).includes("timed out"))).toBe(true);
  });

  it("returns the failed Session snapshot when the process exits during a snapshot query", async () => {
    const a = await driver.createSession({ sessionId: "a", projectId: "a", cwd: join(root, "a") });
    await driver.sendPrompt({ piSessionId: a.piSessionId, prompt: "hold-snapshot" });
    const pending = driver.getSnapshot(a.piSessionId).catch(error => error);
    await expect(driver.sendPrompt({ piSessionId: a.piSessionId, prompt: "crash" })).rejects.toThrow("exited");
    expect(await pending).toMatchObject({ piSessionId: a.piSessionId, status: "failed" });
  });
});
