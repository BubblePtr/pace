import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pathPrefixedWithCommandDir, resolvePackageManagerCommand } from "./package-manager-command";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function resolveFor(
  files: Iterable<string>,
  input: Partial<Parameters<typeof resolvePackageManagerCommand>[0]> = {},
) {
  const existing = new Set(files);
  return resolvePackageManagerCommand({
    env: { PATH: "" },
    homeDir: "/home/me",
    platform: "darwin",
    isExecutable: path => existing.has(path),
    ...input,
  });
}

describe("resolvePackageManagerCommand", () => {
  it("returns the configured command unchanged", () => {
    const configured = ["mise", "exec", "node@20", "--", "npm"];
    expect(resolveFor([], { configured })).toEqual(configured);
    expect(resolveFor(["/home/me/.bun/bin/bun"], { configured: ["/opt/bin/npm"] })).toEqual(["/opt/bin/npm"]);
  });

  it("prefers a PATH hit over the same binary in a fallback directory", () => {
    expect(resolveFor(
      ["/on-path/npm", "/opt/homebrew/bin/npm"],
      { env: { PATH: "/on-path" } },
    )).toEqual(["/on-path/npm"]);
  });

  it("falls back to well-known install directories when PATH is empty", () => {
    expect(resolveFor(["/home/me/.bun/bin/bun"])).toEqual(["/home/me/.bun/bin/bun"]);
  });

  it("prefers npm over bun when both exist", () => {
    expect(resolveFor(
      ["/on-path/npm", "/on-path/bun"],
      { env: { PATH: "/on-path" } },
    )).toEqual(["/on-path/npm"]);
    expect(resolveFor([
      "/home/me/.bun/bin/bun",
      "/opt/homebrew/bin/npm",
    ])).toEqual(["/opt/homebrew/bin/npm"]);
  });

  it("uses the highest nvm node version", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "pace-nvm-"));
    roots.push(homeDir);
    for (const version of ["v9.22.0", "v10.0.0", "v8.0.0"]) {
      mkdirSync(join(homeDir, ".nvm/versions/node", version, "bin"), { recursive: true });
    }
    expect(resolveFor([
      join(homeDir, ".nvm/versions/node/v9.22.0/bin/npm"),
      join(homeDir, ".nvm/versions/node/v10.0.0/bin/npm"),
      join(homeDir, ".nvm/versions/node/v8.0.0/bin/npm"),
    ], { homeDir })).toEqual([join(homeDir, ".nvm/versions/node/v10.0.0/bin/npm")]);
  });

  it("returns null when no package manager exists", () => {
    expect(resolveFor([])).toBeNull();
  });

  it("honors PATHEXT when resolving on win32", () => {
    expect(resolveFor(
      [join("/win/bin", "npm.CMD")],
      { env: { PATH: "/win/bin", PATHEXT: ".CMD;.EXE" }, platform: "win32" },
    )).toEqual([join("/win/bin", "npm.CMD")]);
  });
});

describe("pathPrefixedWithCommandDir", () => {
  it("prepends the command directory only when it is not already a PATH entry", () => {
    expect(pathPrefixedWithCommandDir("/opt/homebrew/bin:/usr/bin", "/opt/homebrew/bin/npm", ":"))
      .toBe("/opt/homebrew/bin:/usr/bin");
    expect(pathPrefixedWithCommandDir("/usr/bin:/bin", "/home/me/.bun/bin/bun", ":"))
      .toBe("/home/me/.bun/bin:/usr/bin:/bin");
  });
});
