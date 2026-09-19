import { mkdirSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CheckPackageUpdatesResult, PackageActionResult, RemovePackageResult } from "@pace/core";
import { createBackendService } from "../service";
import { packageManagerHost } from "./package-manager-command";
import { addLocalResource, removeLocalResource, checkPackageUpdates, installPackage, removePackage, setResourceEnabled, updatePackage } from "./resource-management";

const roots: string[] = [];
async function fixture(settings: object = { packages: ["./kit"] }) {
  const agentDir = await mkdtemp(join(tmpdir(), "pace-resources-"));
  roots.push(agentDir);
  const put = async (path: string, content: string) => {
    await mkdir(join(agentDir, path, ".."), { recursive: true });
    await writeFile(join(agentDir, path), content);
  };
  await put("settings.json", JSON.stringify(settings));
  await put("kit/package.json", JSON.stringify({ pi: { extensions: ["extensions/*.ts"] } }));
  await put("kit/extensions/one.ts", 'throw new Error("must not execute");');
  await put("kit/extensions/two.ts", 'throw new Error("must not execute");');
  const cli = () => SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
  const resolve = () => new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager: cli() }).resolve(async () => "skip");
  const read = async () => JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  const toggle = (enabled: boolean) => setResourceEnabled(agentDir, {
    packageSource: "./kit", kind: "extension", path: join(agentDir, "kit/extensions/one.ts"), enabled,
  });
  return { agentDir, put, cli, resolve, read, toggle };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("resource management SDK contract", () => {
  it("disables and re-enables one package resource without changing its sibling", async () => {
    const f = await fixture();
    await f.toggle(false);
    expect((await f.resolve()).extensions.map(r => [r.path, r.enabled])).toEqual([
      [join(f.agentDir, "kit/extensions/one.ts"), false],
      [join(f.agentDir, "kit/extensions/two.ts"), true],
    ]);
    await f.toggle(true);
    expect((await f.resolve()).extensions.every(r => r.enabled)).toBe(true);
  });
  it("overrides a broad exclusion for one resource and preserves CLI filters and fields", async () => {
    const f = await fixture({ packages: [{ source: "./kit", extensions: ["!extensions/**", "+extensions/two.ts"], prompts: [] }], custom: { keep: true } });
    await f.toggle(true);
    expect((await f.resolve()).extensions.every(r => r.enabled)).toBe(true);
    expect((await f.read()).packages[0]).toMatchObject({ extensions: expect.arrayContaining(["!extensions/**", "+extensions/two.ts"]), prompts: [] });
    const cli = f.cli();
    cli.setDefaultModel("cli-model");
    cli.setPackages([...cli.getGlobalSettings().packages!, { source: "./other", skills: [] }]);
    await cli.flush();
    await f.toggle(false);
    expect((await f.resolve()).extensions.map(r => r.enabled)).toEqual([false, true]);
    expect(f.cli().getGlobalSettings()).toMatchObject({ defaultModel: "cli-model", custom: { keep: true }, packages: expect.arrayContaining([{ source: "./other", skills: [] }]) });
  });

  it("enables only the requested resource when the CLI disabled the entire kind", async () => {
    const f = await fixture({ packages: [{ source: "./kit", extensions: [] }] });
    await f.toggle(true);
    expect((await f.resolve()).extensions.map(r => r.enabled)).toEqual([true, false]);
    await f.toggle(false);
    expect((await f.resolve()).extensions.map(r => r.enabled)).toEqual([false, false]);
  });

  it("preserves manifest exclusions when creating the first package filter", async () => {
    const f = await fixture();
    await f.put("kit/package.json", JSON.stringify({ pi: { extensions: ["extensions/*.ts", "!extensions/two.ts"] } }));
    await f.toggle(false);
    expect((await f.resolve()).extensions.map(r => [r.path, r.enabled])).toEqual([[join(f.agentDir, "kit/extensions/one.ts"), false]]);
    await f.toggle(true);
    expect((await f.resolve()).extensions.map(r => [r.path, r.enabled])).toEqual([[join(f.agentDir, "kit/extensions/one.ts"), true]]);
  });

  it("enables a Skill excluded by its directory without affecting another Skill", async () => {
    const f = await fixture({ packages: [{ source: "./kit", skills: ["!skills/**", "-skills/review"] }] });
    await f.put("kit/package.json", JSON.stringify({ pi: { skills: ["skills"] } }));
    await f.put("kit/skills/review/SKILL.md", "---\nname: review\ndescription: review\n---\nReview");
    await f.put("kit/skills/plan/SKILL.md", "---\nname: plan\ndescription: plan\n---\nPlan");
    await setResourceEnabled(f.agentDir, { packageSource: "./kit", kind: "skill", path: join(f.agentDir, "kit/skills/review/SKILL.md"), enabled: true });
    expect((await f.resolve()).skills.filter(r => r.metadata.source === "./kit").map(r => [r.path, r.enabled])).toEqual([
      [join(f.agentDir, "kit/skills/plan/SKILL.md"), false],
      [join(f.agentDir, "kit/skills/review/SKILL.md"), true],
    ]);
  });

  it("rejects Theme and drop-in toggles explicitly without changing settings", async () => {
    const f = await fixture();
    await f.put("extensions/drop.ts", "export default function() {}");
    const before = await f.read();
    await expect(setResourceEnabled(f.agentDir, { kind: "extension", path: join(f.agentDir, "extensions/drop.ts"), enabled: false })).rejects.toThrow(/drop-in/i);
    await expect(setResourceEnabled(f.agentDir, { packageSource: "./kit", kind: "theme", path: "anything", enabled: false })).rejects.toThrow(/theme/i);
    expect(await f.read()).toEqual(before);
  });

  it("installs, checks, updates and removes a real git package without network access", async () => {
    const f = await fixture({ packages: [], custom: "keep" });
    const backend = createBackendService({ agentDir: f.agentDir, dataDir: join(f.agentDir, "pace") });
    const call = async <T>(method: string, params?: unknown): Promise<T> => {
      const response = await backend.handleRequest({ id: "git-package", method, params });
      expect(response.error).toBeUndefined();
      return response.result as T;
    };
    const remote = join(f.agentDir, "remote");
    await f.put("remote/extensions/git-tool.ts", "// version one");
    const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: remote });
    await git("init", "-b", "main");
    await git("add", ".");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial");
    const source = "git:https://pace.invalid/team/kit";
    await f.put("gitconfig", `[url "file://${remote}"]\n  insteadOf = https://pace.invalid/team/kit\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(f.agentDir, "gitconfig"));
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    const installed = await call<PackageActionResult>("install_package", { source });
    expect(installed.progress).toEqual(expect.arrayContaining([expect.objectContaining({ action: "install", type: "complete", source })]));
    expect(f.cli().getGlobalSettings().packages).toContain(source);
    const installedResource = (await f.resolve()).extensions.find(r => r.metadata.source === source)!;
    expect(await readFile(installedResource.path, "utf8")).toBe("// version one");
    expect((await call<CheckPackageUpdatesResult>("check_package_updates")).updates).toEqual([]);
    await f.put("remote/extensions/git-tool.ts", "// version two");
    await git("add", ".");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "next");
    expect((await call<CheckPackageUpdatesResult>("check_package_updates")).updates).toEqual([expect.objectContaining({ source, scope: "user" })]);
    await call<PackageActionResult>("update_package", { source });
    expect(await readFile(installedResource.path, "utf8")).toBe("// version two");
    await call<PackageActionResult>("update_package");
    expect((await call<RemovePackageResult>("remove_package", { source })).removed).toBe(true);
    expect(f.cli().getGlobalSettings()).toMatchObject({ packages: [], custom: "keep" });
    await expect(readFile(installedResource.path)).rejects.toThrow();
  });

  it("rejects local installation but lets the CLI's local package be unregistered without deleting it", async () => {
    const f = await fixture();
    await expect(installPackage(f.agentDir, { source: "./kit" })).rejects.toThrow(/Add local resource/);
    await expect(removePackage(f.agentDir, { source: "./kit" })).resolves.toMatchObject({ removed: true });
    expect(await readFile(join(f.agentDir, "kit/extensions/one.ts"), "utf8")).toContain("must not execute");
  });

  it("exposes writes, inventory refresh and validation errors through RPC", async () => {
    const f = await fixture();
    const backend = createBackendService({ agentDir: f.agentDir, dataDir: join(f.agentDir, "pace") });
    const call = (method: string, params?: unknown) => backend.handleRequest({ id: "resource-test", method, params });
    expect(await call("install_package", { source: "./kit" })).toMatchObject({ error: expect.stringContaining("Add local resource") });
    expect(await call("set_resource_enabled", { packageSource: "./kit", kind: "extension", path: join(f.agentDir, "kit/extensions/one.ts"), enabled: false })).toMatchObject({ result: { progress: [] } });
    expect(await call("get_config_inventory")).toMatchObject({ result: { extensions: expect.arrayContaining([expect.objectContaining({ path: join(f.agentDir, "kit/extensions/one.ts"), enabled: false })]) } });
    expect(await call("update_package")).toMatchObject({ result: { progress: [] } });
    expect(await call("check_package_updates")).toMatchObject({ result: { updates: [] } });
    expect(await call("set_resource_enabled", { packageSource: "./kit", kind: "extension", path: "anything", enabled: "false" })).toMatchObject({ error: expect.stringContaining("boolean") });
    expect(await call("update_package", { source: 12 })).toMatchObject({ error: expect.stringContaining("source") });
    expect(await call("remove_package", { source: "./kit" })).toMatchObject({ result: { removed: true } });
  });

  it("reports unreadable settings through RPC and leaves the file intact", async () => {
    const f = await fixture();
    await f.put("settings.json", "{ invalid json");
    const backend = createBackendService({ agentDir: f.agentDir, dataDir: join(f.agentDir, "pace") });
    const response = await backend.handleRequest({ id: "bad-settings", method: "remove_package", params: { source: "./kit" } });
    expect(response.error).toContain("settings.json");
    expect(await readFile(join(f.agentDir, "settings.json"), "utf8")).toBe("{ invalid json");
  });

  it("keeps simultaneous resource changes instead of overwriting the packages array", async () => {
    const f = await fixture();
    await Promise.all([
      f.toggle(false),
      setResourceEnabled(f.agentDir, { packageSource: "./kit", kind: "extension", path: join(f.agentDir, "kit/extensions/two.ts"), enabled: false }),
    ]);
    expect((await f.resolve()).extensions.map(r => r.enabled)).toEqual([false, false]);
  });

  it("reports a real SDK queued write failure rather than returning success", async () => {
    const f = await fixture();
    const create = SettingsManager.create.bind(SettingsManager);
    vi.spyOn(SettingsManager, "create").mockImplementationOnce((...args) => {
      const settings = create(...args);
      // Replace the file after the SDK reads it to force a write-time I/O failure.
      rmSync(join(f.agentDir, "settings.json"));
      mkdirSync(join(f.agentDir, "settings.json"));
      return settings;
    });
    await expect(removePackage(f.agentDir, { source: "./kit" })).rejects.toThrow(/settings.json/);
  });

  it("keeps project settings out of updates and resource writes", async () => {
    const f = await fixture();
    await f.put(".pi/settings.json", JSON.stringify({ packages: ["npm:must-not-access-network"], custom: true }));
    await updatePackage(f.agentDir);
    expect((await checkPackageUpdates(f.agentDir)).updates).toEqual([]);
    await f.toggle(false);
    expect(JSON.parse(await readFile(join(f.agentDir, ".pi/settings.json"), "utf8"))).toEqual({ packages: ["npm:must-not-access-network"], custom: true });
  });

  it("rejects local file and bare-directory toggles because Pi ignores their filters", async () => {
    const f = await fixture({ packages: ["./single.ts", "./bare"] });
    await f.put("single.ts", "export default function() {}");
    await f.put("bare/index.ts", "export default function() {}");
    for (const source of ["./single.ts", "./bare"]) {
      const path = join(f.agentDir, source);
      const cli = f.cli();
      cli.setPackages([source]);
      await cli.flush();
      expect((await f.resolve()).extensions.find(r => r.path === path)?.enabled).toBe(true);
      const before = await f.read();
      await expect(setResourceEnabled(f.agentDir, { packageSource: source, kind: "extension", path, enabled: false })).rejects.toThrow(/Pi.*ignores.*Filter/);
      expect(await f.read()).toEqual(before);
      cli.setPackages([{ source, extensions: [`+${path}`, `-${path}`] }]);
      await cli.flush();
      // Pi ignores file filters and drops bare-directory entries instead of exposing a toggle.
      expect((await f.resolve()).extensions.find(r => r.path === path)?.enabled).toBe(source === "./single.ts" ? true : undefined);
    }
  });

});


describe("local resources", () => {
  it("copies a local extension without changing its source and asks before replacing", async () => {
    const f = await fixture();
    await f.put("source/foo.ts", "original");
    const path = join(f.agentDir, "source/foo.ts");
    const target = join(f.agentDir, "extensions/foo.ts");
    const backend = createBackendService({ agentDir: f.agentDir, dataDir: join(f.agentDir, "pace") });
    const added = await backend.handleRequest({ id: "add-local", method: "add_local_resource", params: { path } });
    expect(added.error).toBeUndefined();
    expect(added.result).toMatchObject({ path: target, kind: "extension", conflict: false });
    const inventory = await backend.handleRequest({ id: "inventory", method: "get_config_inventory" });
    expect(inventory.result).toMatchObject({ extensions: expect.arrayContaining([expect.objectContaining({ path: target, origin: "drop-in" })]) });
    await f.put("source/foo.ts", "updated");
    expect(await addLocalResource(f.agentDir, { path })).toMatchObject({ conflict: true });
    expect(await readFile(target, "utf8")).toBe("original");
    await addLocalResource(f.agentDir, { path, overwrite: true });
    expect(await readFile(target, "utf8")).toBe("updated");
    await removeLocalResource(f.agentDir, { path: target });
    await expect(readFile(target)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("updated");
  });
});


describe("local resource boundaries", () => {
  it("routes supported files and skill directories and rejects unrelated input", async () => {
    const f = await fixture();
    for (const [name, kind, folder] of [["foo.js", "extension", "extensions"], ["plan.md", "prompt", "prompts"], ["night.json", "theme", "themes"]]) {
      await f.put(`source/${name}`, "content");
      expect(await addLocalResource(f.agentDir, { path: join(f.agentDir, "source", name) })).toMatchObject({ kind, path: join(f.agentDir, folder, name) });
    }
    await f.put("source/review/SKILL.md", "skill");
    await f.put("source/review/assets/helper.txt", "helper");
    await addLocalResource(f.agentDir, { path: join(f.agentDir, "source/review") });
    expect(await readFile(join(f.agentDir, "skills/review/assets/helper.txt"), "utf8")).toBe("helper");
    await expect(addLocalResource(f.agentDir, { path: join(f.agentDir, "source/review/assets") })).rejects.toThrow();
    await expect(addLocalResource(f.agentDir, { path: join(f.agentDir, "source/review/assets/helper.txt") })).rejects.toThrow();
    await removeLocalResource(f.agentDir, { path: join(f.agentDir, "skills/review/SKILL.md") });
    await expect(readFile(join(f.agentDir, "skills/review/assets/helper.txt"))).rejects.toThrow();
  });
  it("never deletes outside drop-in roots or follows linked roots or input", async () => {
    const f = await fixture();
    await f.put("source/foo.ts", "keep");
    await expect(removeLocalResource(f.agentDir, { path: join(f.agentDir, "source/foo.ts") })).rejects.toThrow();
    await symlink(join(f.agentDir, "source"), join(f.agentDir, "extensions"));
    await expect(addLocalResource(f.agentDir, { path: join(f.agentDir, "source/foo.ts") })).rejects.toThrow();
    await expect(removeLocalResource(f.agentDir, { path: join(f.agentDir, "extensions/foo.ts") })).rejects.toThrow();
    expect(await readFile(join(f.agentDir, "source/foo.ts"), "utf8")).toBe("keep");
  });
});


async function isolatedPackageManagerHome() {
  const home = await mkdtemp(join(tmpdir(), "pace-pkg-home-"));
  roots.push(home);
  const pathDir = join(home, "empty-path");
  await mkdir(pathDir);
  vi.stubEnv("PATH", pathDir);
  vi.stubEnv("HOME", home);
  vi.spyOn(packageManagerHost, "homeDir").mockReturnValue(home);
  const probe = packageManagerHost.isExecutable;
  vi.spyOn(packageManagerHost, "isExecutable").mockImplementation(path => {
    if (path.startsWith("/opt/homebrew/") || path.startsWith("/usr/local/")) return false;
    return probe(path);
  });
  return home;
}

describe("package manager resolution", () => {
  it("hands a resolved package manager to the SDK without persisting npmCommand", async () => {
    const home = await isolatedPackageManagerHome();
    const recordPath = join(home, "bun-argv.txt");
    const bunPath = join(home, ".bun/bin/bun");
    await mkdir(join(home, ".bun/bin"), { recursive: true });
    await writeFile(
      bunPath,
      `#!/bin/sh\n{\n  printf '%s\\n' "$0" "$@"\n  printf 'PATH=%s\\n' "$PATH"\n} > ${JSON.stringify(recordPath)}\n`,
    );
    await chmod(bunPath, 0o755);
    const f = await fixture({ packages: ["npm:some-pkg"] });
    await f.put("npm/node_modules/some-pkg/package.json", JSON.stringify({ name: "some-pkg", version: "1.0.0" }));
    await removePackage(f.agentDir, { source: "npm:some-pkg" });
    const recorded = await readFile(recordPath, "utf8");
    expect(recorded).toMatch(/uninstall/);
    expect(recorded.split("\n").find(line => line.startsWith("PATH="))?.slice(5).split(delimiter)[0])
      .toBe(dirname(bunPath));
    expect(await f.read()).not.toHaveProperty("npmCommand");
  });

  it("rewrites a missing package manager spawn as an actionable error", async () => {
    await isolatedPackageManagerHome();
    const f = await fixture({ packages: ["npm:some-pkg"] });
    await f.put("npm/node_modules/some-pkg/package.json", JSON.stringify({ name: "some-pkg", version: "1.0.0" }));
    await expect(removePackage(f.agentDir, { source: "npm:some-pkg" })).rejects.toThrow(/No package manager found/);
  });
});
