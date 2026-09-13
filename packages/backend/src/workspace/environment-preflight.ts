import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  EnvironmentPreflightCheck,
  EnvironmentPreflightReport,
  EnvironmentPreflightStatus,
} from "@pace/core";
import { inspectPiRuntime, type PiRuntimeInfo } from "../drivers/pi-runtime-info";

const execFileAsync = promisify(execFile);

export type EnvironmentPreflightReaderOptions = {
  agentDir: string;
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  whichCommand?: (command: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
  runVersion?: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
  inspectRuntime?: () => Promise<PiRuntimeInfo>;
};

export type EnvironmentPreflightReader = {
  run(): Promise<EnvironmentPreflightReport>;
  getStatus(): Promise<EnvironmentPreflightStatus>;
  complete(report?: EnvironmentPreflightReport): Promise<EnvironmentPreflightStatus>;
};

function statusPath(dataDir: string) {
  return join(dataDir, "preflight-status.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function defaultWhich(command: string, env: NodeJS.ProcessEnv) {
  const pathValue = env.PATH ?? "";
  const extensions =
    process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];

  for (const directory of pathValue.split(delimiter)) {
    if (!directory) {
      continue;
    }

    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // try next
      }
    }
  }

  return null;
}

async function defaultRunVersion(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    env,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  return `${stdout}${stderr}`.trim();
}

async function readStatusFile(dataDir: string): Promise<EnvironmentPreflightStatus> {
  try {
    const raw = JSON.parse(await readFile(statusPath(dataDir), "utf8")) as unknown;
    if (!isRecord(raw)) {
      return {};
    }

    return {
      completedAt: typeof raw.completedAt === "string" ? raw.completedAt : undefined,
      lastReport: isRecord(raw.lastReport)
        ? (raw.lastReport as EnvironmentPreflightReport)
        : undefined,
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

async function writeStatusFile(dataDir: string, status: EnvironmentPreflightStatus) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(statusPath(dataDir), `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

async function checkPiRuntime(
  options: EnvironmentPreflightReaderOptions,
): Promise<EnvironmentPreflightCheck> {
  try {
    const runtime = await (options.inspectRuntime ?? inspectPiRuntime)();
    return {
      id: "pi_runtime",
      severity: "required",
      status: "pass",
      title: "Pi Runtime",
      summary: "Bundled Pi engine available",
      detail: `Pace ${runtime.appVersion} · Pi ${runtime.piVersion} · ${runtime.mode}`,
    };
  } catch (error) {
    return {
      id: "pi_runtime",
      severity: "required",
      status: "fail",
      title: "Pi Runtime",
      summary: "Bundled Pi engine unavailable",
      detail: error instanceof Error ? error.message : String(error),
      remediation: [
        "Reinstall or update Pace to restore its bundled engine",
        "Click Recheck",
      ],
    };
  }
}

async function checkDataDirectory(
  options: EnvironmentPreflightReaderOptions,
): Promise<EnvironmentPreflightCheck> {
  const dataDir = options.dataDir;
  const probe = join(dataDir, ".preflight-write-probe");

  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(probe, "ok\n", "utf8");
    await access(dataDir, constants.R_OK | constants.W_OK);

    return {
      id: "data_directory",
      severity: "required",
      status: "pass",
      title: "Data directory",
      summary: "Pace data directory is writable",
      detail: dataDir,
    };
  } catch (error) {
    return {
      id: "data_directory",
      severity: "required",
      status: "fail",
      title: "Data directory",
      summary: "Not writable",
      detail: `${dataDir}${error instanceof Error ? ` · ${error.message}` : ""}`,
      remediation: [
        "Ensure the process can create and write files in the Pace data directory",
        "Check disk permissions or free space",
        "Click Recheck",
      ],
    };
  }
}

function authEntryLooksValid(value: unknown) {
  if (!isRecord(value)) {
    return false;
  }

  for (const key of ["key", "apiKey", "api_key", "token", "accessToken", "access_token"]) {
    if (typeof value[key] === "string" && value[key].trim().length > 0) {
      return true;
    }
  }

  if (typeof value.type === "string" && value.type.trim().length > 0) {
    // Presence of a typed auth record without empty-looking fields is enough for readiness.
    return Object.values(value).some(
      (entry) => typeof entry === "string" && entry.trim().length > 0,
    );
  }

  return false;
}

async function checkModelAuth(
  options: EnvironmentPreflightReaderOptions,
): Promise<EnvironmentPreflightCheck> {
  const authPath = join(options.agentDir, "auth.json");

  try {
    const raw = JSON.parse(await readFile(authPath, "utf8")) as unknown;
    if (!isRecord(raw)) {
      return {
        id: "model_auth",
        severity: "required",
        status: "fail",
        title: "Model auth",
        summary: "No provider credentials",
        detail: `${authPath} is not a JSON object`,
        remediation: [
          "Open Provider Settings and configure at least one provider",
          "Click Recheck",
        ],
      };
    }

    const providers = Object.entries(raw).filter(([, value]) => authEntryLooksValid(value));
    if (providers.length === 0) {
      return {
        id: "model_auth",
        severity: "required",
        status: "fail",
        title: "Model auth",
        summary: "No provider credentials",
        detail: "auth.json has no usable provider entries",
        remediation: [
          "Open Provider Settings and add an API key or subscription login",
          "Click Recheck",
        ],
      };
    }

    return {
      id: "model_auth",
      severity: "required",
      status: "pass",
      title: "Model auth",
      summary: "Provider credentials present",
      detail: `${providers.length} provider(s) configured`,
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        id: "model_auth",
        severity: "required",
        status: "fail",
        title: "Model auth",
        summary: "No provider credentials",
        detail: `Missing ${authPath}`,
        remediation: [
          "Open Provider Settings and configure at least one provider",
          "Click Recheck",
        ],
      };
    }

    return {
      id: "model_auth",
      severity: "required",
      status: "fail",
      title: "Model auth",
      summary: "Could not read credentials",
      detail: error instanceof Error ? error.message : String(error),
      remediation: [
        "Open Provider Settings and re-save credentials",
        "Click Recheck",
      ],
    };
  }
}

async function checkGit(
  options: EnvironmentPreflightReaderOptions,
): Promise<EnvironmentPreflightCheck> {
  const env = options.env ?? process.env;
  // E2E-only hook: prove optional Git never blocks Continue without mutating PATH.
  if (env.PACE_E2E === "1" && env.PACE_E2E_FORCE_GIT_MISSING === "1") {
    return {
      id: "git",
      severity: "optional",
      status: "skip",
      title: "Git",
      summary: "Not installed — Changes / worktree limited",
      detail: "Forced missing for E2E (PACE_E2E_FORCE_GIT_MISSING=1).",
    };
  }

  const which = options.whichCommand ?? defaultWhich;
  const runVersion = options.runVersion ?? defaultRunVersion;
  const resolved = await which("git", env);

  if (!resolved) {
    return {
      id: "git",
      severity: "optional",
      status: "skip",
      title: "Git",
      summary: "Not installed — Changes / worktree limited",
      detail: "Git is optional. Non-Git projects still work; Session Changes needs Git.",
    };
  }

  try {
    const versionText = await runVersion(resolved, ["--version"], env);
    return {
      id: "git",
      severity: "optional",
      status: "pass",
      title: "Git",
      summary: "Git available",
      detail: versionText || resolved,
    };
  } catch (error) {
    return {
      id: "git",
      severity: "optional",
      status: "fail",
      title: "Git",
      summary: "Found on PATH but failed to run",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function summarizeChecks(checks: EnvironmentPreflightCheck[], checkedAt: string) {
  const requiredPassed = checks
    .filter((check) => check.severity === "required")
    .every((check) => check.status === "pass");
  const optionalFailed = checks.some(
    (check) => check.severity === "optional" && check.status === "fail",
  );

  return {
    checkedAt,
    checks,
    requiredPassed,
    optionalFailed,
    canContinue: requiredPassed,
  } satisfies EnvironmentPreflightReport;
}

export function createEnvironmentPreflightReader(
  options: EnvironmentPreflightReaderOptions,
): EnvironmentPreflightReader {
  const now = options.now ?? (() => new Date());

  return {
    async run() {
      const checkedAt = now().toISOString();
      const checks = await Promise.all([
        checkPiRuntime(options),
        checkDataDirectory(options),
        checkModelAuth(options),
        checkGit(options),
      ]);
      const report = summarizeChecks(checks, checkedAt);
      const existing = await readStatusFile(options.dataDir);
      await writeStatusFile(options.dataDir, {
        ...existing,
        lastReport: report,
      });
      return report;
    },

    async getStatus() {
      return readStatusFile(options.dataDir);
    },

    async complete(report) {
      const latest = report ?? (await this.run());
      if (!latest.canContinue) {
        throw new Error("Cannot complete preflight while required checks are failing.");
      }

      const status: EnvironmentPreflightStatus = {
        completedAt: now().toISOString(),
        lastReport: latest,
      };
      await writeStatusFile(options.dataDir, status);
      return status;
    },
  };
}

export function defaultAgentDirHint(env: NodeJS.ProcessEnv = process.env) {
  return env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}
