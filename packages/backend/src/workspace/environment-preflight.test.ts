import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createEnvironmentPreflightReader } from "./environment-preflight";

async function tempRoots() {
  const root = await mkdtemp(join(tmpdir(), "pigui-preflight-"));
  const agentDir = join(root, "agent");
  const dataDir = join(root, "data");
  await mkdir(agentDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  return { root, agentDir, dataDir };
}

describe("environment preflight", () => {
  it("uses the bundled SDK without requiring or reporting a global pi CLI", async () => {
    const { agentDir, dataDir } = await tempRoots();
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "test-key" } }),
      "utf8",
    );

    const whichCommand = vi.fn(async (command: string) =>
      command === "git" ? "/bin/git" : null,
    );
    const reader = createEnvironmentPreflightReader({
      agentDir,
      dataDir,
      whichCommand,
      runVersion: async () => "git version 2.45.0",
    });

    const report = await reader.run();
    expect(report.requiredPassed).toBe(true);
    expect(report.canContinue).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([
      "pi_runtime",
      "data_directory",
      "model_auth",
      "git",
    ]);
    expect(report.checks.find((check) => check.id === "git")?.status).toBe("pass");
    expect(whichCommand).not.toHaveBeenCalledWith("pi", expect.anything());
    expect(report.checks.find((check) => check.id === "pi_runtime")).toMatchObject({
      status: "pass",
      detail: expect.stringMatching(/Pi 0\.84\.3.*SDK/),
    });
  });

  it("reports a broken bundled engine even when a global CLI exists", async () => {
    const { agentDir, dataDir } = await tempRoots();
    const reader = createEnvironmentPreflightReader({
      agentDir,
      dataDir,
      whichCommand: async (command) => command === "pi" ? "/bin/pi" : null,
      inspectRuntime: async () => {
        throw new Error("Bundled SDK module could not load");
      },
    });

    const report = await reader.run();
    expect(report.requiredPassed).toBe(false);
    expect(report.canContinue).toBe(false);
    expect(report.checks.find((check) => check.id === "pi_runtime")?.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "pi_runtime")?.detail).toContain("Bundled SDK module could not load");
    expect(JSON.stringify(report.checks[0].remediation)).not.toContain("Install Pi");
    expect(report.checks.find((check) => check.id === "model_auth")?.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "git")?.status).toBe("skip");
  });

  it("treats forced E2E git-missing as optional skip without blocking continue", async () => {
    const { agentDir, dataDir } = await tempRoots();
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "test-key" } }),
      "utf8",
    );

    const reader = createEnvironmentPreflightReader({
      agentDir,
      dataDir,
      env: {
        ...process.env,
        PACE_E2E: "1",
        PACE_E2E_FORCE_GIT_MISSING: "1",
      },
      whichCommand: async (command) => (command === "pi" ? "/bin/pi" : "/usr/bin/git"),
      runVersion: async () => "ok",
    });

    const report = await reader.run();
    expect(report.canContinue).toBe(true);
    expect(report.checks.find((check) => check.id === "git")).toMatchObject({
      severity: "optional",
      status: "skip",
    });
  });

  it("refuses complete while required checks fail and persists on success", async () => {
    const { agentDir, dataDir } = await tempRoots();
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "test-key" } }),
      "utf8",
    );

    const failing = createEnvironmentPreflightReader({
      agentDir,
      dataDir,
      inspectRuntime: async () => { throw new Error("Bundled engine unavailable"); },
      whichCommand: async (command) => (command === "git" ? "/usr/bin/git" : null),
      runVersion: async () => "git version 2.45.0",
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    await expect(failing.complete()).rejects.toThrow(/required checks/i);

    const ready = createEnvironmentPreflightReader({
      agentDir,
      dataDir,
      whichCommand: async (command) =>
        command === "pi" || command === "git" ? `/usr/bin/${command}` : null,
      runVersion: async () => "ok",
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    const status = await ready.complete();
    expect(status.completedAt).toBe("2026-07-25T12:00:00.000Z");
    await expect(ready.getStatus()).resolves.toEqual(
      expect.objectContaining({ completedAt: "2026-07-25T12:00:00.000Z" }),
    );
  });
});
