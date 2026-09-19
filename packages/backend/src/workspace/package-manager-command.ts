import { accessSync, constants, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter as pathDelimiter, dirname, join, resolve } from "node:path";

const CANDIDATES = ["npm", "pnpm", "bun"] as const;

function pathIsExecutable(commandPath: string): boolean {
  try {
    accessSync(commandPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Test seam: object methods can be spied; ESM exports of node:os / node:fs cannot. */
export const packageManagerHost = {
  homeDir: () => homedir(),
  isExecutable: pathIsExecutable,
};

function executableNames(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  if (platform !== "win32") return [command];
  return (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean).map(extension => `${command}${extension}`);
}

function parseNodeVersion(name: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(name);
  if (!match) return;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function highestNvmBinDir(homeDir: string) {
  const root = join(homeDir, ".nvm", "versions", "node");
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return;
  }
  let bestName: string | undefined;
  let bestVersion: [number, number, number] | undefined;
  for (const name of names) {
    const version = parseNodeVersion(name);
    if (!version) continue;
    if (
      !bestVersion ||
      version[0] > bestVersion[0] ||
      (version[0] === bestVersion[0] && version[1] > bestVersion[1]) ||
      (version[0] === bestVersion[0] && version[1] === bestVersion[1] && version[2] > bestVersion[2])
    ) {
      bestName = name;
      bestVersion = version;
    }
  }
  return bestName ? join(root, bestName, "bin") : undefined;
}

function fallbackDirs(homeDir: string) {
  const nvmBin = highestNvmBinDir(homeDir);
  return [
    join(homeDir, ".bun", "bin"),
    join(homeDir, "Library", "pnpm"),
    join(homeDir, ".local", "share", "pnpm"),
    join(homeDir, ".volta", "bin"),
    ...(nvmBin ? [nvmBin] : []),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

export function pathPrefixedWithCommandDir(
  pathValue: string | undefined,
  commandPath: string,
  delimiter = pathDelimiter,
): string {
  const dir = dirname(commandPath);
  const entries = (pathValue ?? "").split(delimiter);
  if (entries.includes(dir)) return pathValue ?? "";
  return [dir, ...entries.filter(Boolean)].join(delimiter);
}

export function resolvePackageManagerCommand(input: {
  configured?: string[];
  env: NodeJS.ProcessEnv;
  homeDir: string;
  platform?: NodeJS.Platform;
  isExecutable?: (path: string) => boolean;
}): string[] | null {
  if (input.configured && input.configured.length > 0) return input.configured;
  const platform = input.platform ?? process.platform;
  const isExecutable = input.isExecutable ?? pathIsExecutable;
  const delimiter = platform === "win32" ? ";" : ":";
  const dirs = [
    ...(input.env.PATH ?? input.env.Path ?? "").split(delimiter).filter(Boolean),
    ...fallbackDirs(input.homeDir),
  ];
  for (const candidate of CANDIDATES) {
    for (const dir of dirs) {
      for (const name of executableNames(candidate, input.env, platform)) {
        const commandPath = resolve(dir, name);
        if (isExecutable(commandPath)) return [commandPath];
      }
    }
  }
  return null;
}
