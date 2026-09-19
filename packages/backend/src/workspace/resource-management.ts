import { copyFile, cp, mkdir, lstat, readdir, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
  AddLocalResourceInput,
  AddLocalResourceResult,
  CheckPackageUpdatesResult,
  PackageActionResult,
  PackageProgressEvent,
  PackageSourceInput,
  RemovePackageResult,
  SetResourceEnabledInput,
  UpdatePackageInput,
} from "@pace/core";
import { packageManagerHost, pathPrefixedWithCommandDir, resolvePackageManagerCommand } from "./package-manager-command";

function assertSettingsHealthy(settings: SettingsManager) {
  const errors = settings.drainErrors();
  if (errors.length) {
    throw new Error(errors.map(({ scope, path, error }) => `${path ?? scope}: ${error.message}`).join("\n"));
  }
}

const pendingActions = new Map<string, Promise<unknown>>();

async function withPackages<T>(dir: string, action: (manager: DefaultPackageManager, settings: SettingsManager) => Promise<T>) {
  const agentDir = resolve(dir);
  // SDK locks protect each write, but packages is a whole-array snapshot. Serialize
  // Pace actions so a second request reads the first request's completed write.
  const previous = pendingActions.get(agentDir);
  const operation = (previous ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
    assertSettingsHealthy(settings);
    if (!settings.getNpmCommand()?.length) {
      const resolved = resolvePackageManagerCommand({
        env: process.env,
        homeDir: packageManagerHost.homeDir(),
        isExecutable: path => packageManagerHost.isExecutable(path),
      });
      if (resolved) {
        // Override the in-memory getter only — setNpmCommand would persist to settings.json.
        settings.getNpmCommand = () => resolved;
        // So `#!/usr/bin/env node` next to npm can resolve under Finder PATH.
        process.env.PATH = pathPrefixedWithCommandDir(process.env.PATH, resolved[0]);
      }
    }
    const manager = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager: settings });
    const progress: PackageProgressEvent[] = [];
    manager.setProgressCallback(event => progress.push({ ...event }));
    try {
      const result = await action(manager, settings);
      return { ...result, progress };
    } catch (error) {
      if (error instanceof Error && /spawn (npm|pnpm|bun) ENOENT/.test(error.message)) {
        throw Object.assign(
          new Error(`No package manager found. Pace looked for npm, pnpm and bun on PATH and in common install locations. Install one or set "npmCommand" in ${join(agentDir, "settings.json")}.`),
          { cause: error },
        );
      }
      throw error;
    } finally {
      // SDK setters enqueue locked writes; completion must mean the CLI can read them.
      await settings.flush();
      assertSettingsHealthy(settings);
    }
  });
  pendingActions.set(agentDir, operation);
  try {
    return await operation;
  } finally {
    if (pendingActions.get(agentDir) === operation) pendingActions.delete(agentDir);
  }
}

export async function setResourceEnabled(dir: string, input: SetResourceEnabledInput): Promise<PackageActionResult> {
  if (input.kind === "theme") throw new Error("Theme resources only affect the Pi terminal and cannot be toggled");
  const packageSource = input.packageSource;
  if (!packageSource || packageSource === "auto") throw new Error("Drop-in and top-level resources have no package filter; remove the resource file instead");
  if (!["extension", "skill", "prompt"].includes(input.kind)) throw new Error("Unknown resource kind");
  if (typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean");
  return withPackages(dir, async (manager, settings) => {
    const key = { extension: "extensions", skill: "skills", prompt: "prompts", theme: "themes" } as const;
    const resources = await manager.resolve(async () => "skip");
    const resource = resources[key[input.kind]].find(entry =>
      entry.path === input.path && entry.metadata.source === packageSource &&
      entry.metadata.scope === "user" && entry.metadata.origin === "package");
    if (!resource) throw new Error("Resource was not found in the configured package");
    if (resource.path === manager.getInstalledPath(packageSource, "user")) {
      throw new Error("Pi ignores Resource Filter toggles for local file or bare-directory packages. Remove the registration or move the resource into a convention directory.");
    }
    const packages = settings.getGlobalSettings().packages ?? [];
    const index = packages.findIndex(pkg => (typeof pkg === "string" ? pkg : pkg.source) === packageSource);
    if (index < 0 || !resource.metadata.baseDir) throw new Error("Resource has no configured user package");
    const current = packages[index];
    const pkg = typeof current === "string" ? { source: current } : { ...current };
    const field = key[input.kind];
    const baseDir = resource.metadata.baseDir;
    const path = relative(baseDir, resource.path);
    const existing = pkg[field];
    // An empty native filter disables the whole kind; retain that baseline.
    const baseline = existing?.length === 0 && pkg.autoload !== false ? ["!**/*"] : existing ?? [];
    const patterns = baseline.filter(pattern => {
      if (!pattern.startsWith("+") && !pattern.startsWith("-")) return true;
      const target = resolve(baseDir, pattern.slice(1));
      return target !== resource.path && !(input.kind === "skill" && basename(resource.path) === "SKILL.md" && target === dirname(resource.path));
    });
    // Exact overrides survive broad exclusions and treat glob characters in filenames literally.
    patterns.push(`${input.enabled ? "+" : "-"}${path}`);
    pkg[field] = patterns;
    packages[index] = pkg;
    settings.setPackages(packages);
    return {};
  });
}

export async function installPackage(dir: string, input: PackageSourceInput): Promise<PackageActionResult> {
  if (!/^(npm:|git:|https:\/\/)/.test(input.source)) {
    throw new Error("Install accepts npm:, git:, or https:// sources. Use Add local resource for local files.");
  }
  return withPackages(dir, async manager => {
    await manager.installAndPersist(input.source);
    return {};
  });
}

export async function removePackage(dir: string, input: PackageSourceInput): Promise<RemovePackageResult> {
  return withPackages(dir, async manager => ({ removed: await manager.removeAndPersist(input.source) }));
}

export async function updatePackage(dir: string, input: UpdatePackageInput = {}): Promise<PackageActionResult> {
  return withPackages(dir, async manager => {
    await manager.update(input.source);
    return {};
  });
}

export async function checkPackageUpdates(dir: string): Promise<CheckPackageUpdatesResult> {
  return withPackages(dir, async manager => ({ updates: await manager.checkForAvailableUpdates() }));
}

const localFolders = { extension: "extensions", skill: "skills", prompt: "prompts", theme: "themes" } as const;

async function localKind(path: string): Promise<keyof typeof localFolders> {
  const stat = await lstat(path);
  if (stat.isDirectory()) {
    if ((await lstat(resolve(path, "SKILL.md"))).isFile()) return "skill";
  } else if (stat.isFile()) {
    switch (extname(path)) {
      case ".ts": case ".js": return "extension";
      case ".md": return "prompt";
      case ".json": return "theme";
    }
  }
  throw new Error("Choose a .ts, .js, .md, .json file or a directory containing SKILL.md");
}

async function assertNoLinks(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error("Linked resources are not supported");
  if (stat.isDirectory()) for (const entry of await readdir(path)) await assertNoLinks(resolve(path, entry));
}

async function localRoot(dir: string, folder: string) {
  const root = resolve(dir, folder);
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== resolve(await realpath(dir), folder)) {
    throw new Error("Linked resource directories are not supported");
  }
  return root;
}

export async function addLocalResource(dir: string, input: AddLocalResourceInput): Promise<AddLocalResourceResult> {
  const source = resolve(input.path);
  const kind = await localKind(source);
  await assertNoLinks(source);
  const root = await localRoot(dir, localFolders[kind]);
  const target = resolve(root, basename(source));
  if (source === target || (kind === "skill" && relative(source, target).split(/[\\/]/)[0] !== "..")) throw new Error("Resource is already in its destination");
  const result = { path: target, kind, conflict: false };
  try {
    if (kind === "skill") {
      // Reserve the directory before copying so two imports cannot silently merge.
      await mkdir(target);
    } else {
      await copyFile(source, target, constants.COPYFILE_EXCL);
      return result;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!input.overwrite) return { ...result, conflict: true };
    await assertNoLinks(target);
    await rm(target, { recursive: true });
  }
  if (kind === "skill") {
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source)) await cp(resolve(source, entry), resolve(target, entry), { recursive: true, force: false, errorOnExist: true });
  } else await copyFile(source, target, constants.COPYFILE_EXCL);
  return result;
}

export async function removeLocalResource(dir: string, input: { path: string }) {
  const path = resolve(input.path);
  const parts = relative(resolve(dir), path).split(/[\\/]/);
  const folder = parts[0];
  if (!Object.values(localFolders).includes(folder as typeof localFolders[keyof typeof localFolders]) || parts.includes("..")) throw new Error("Only drop-in resource files can be removed");
  const root = await localRoot(dir, folder);
  const target = folder === "skills" && parts.length === 3 && parts[2] === "SKILL.md" ? dirname(path) : path;
  if (dirname(target) !== root) throw new Error("Only direct drop-in resources can be removed");
  await assertNoLinks(target);
  if (localFolders[await localKind(target)] !== folder) throw new Error("Resource kind does not match its directory");
  await rm(target, { recursive: true });
  return { progress: [] };
}
