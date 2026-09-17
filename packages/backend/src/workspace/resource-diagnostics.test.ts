import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import type { ConfigInventory } from "@pace/core";
import { createFileSessionEventJournal } from "../persistence/session-event-journal";
import { createFileSessionProjectionStore } from "../persistence/session-projection-store";
import { addResourceDiagnostics } from "./resource-diagnostics";

it("associates only the latest session's extension errors with exact resource paths and directory children", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pace-diagnostics-"));
  try {
    const store = createFileSessionProjectionStore({ dataDir: dir });
    for (const [id, updatedAt] of [["old", "2026-09-08T00:00:00Z"], ["new", "2026-09-09T00:00:00Z"]]) {
      await store.save({ sessionId: id, piSessionId: id, runtimeId: id, projectId: "p", cwd: "/", status: "idle", updatedAt });
    }
    await mkdir(join(dir, "sessions"));
    const event = (body: string, ts: string, code = "extension_load_error") => ({ type: "error", ts, payload: { type: "error", code, body } });
    await writeFile(join(dir, "sessions/new.jsonl"), [
      event("/kit/tool.ts: first failure", "2026-09-09T01:00:00Z"),
      event("/kit/tool.ts: handler failed", "2026-09-09T02:00:00Z", "extension_error"),
      event("/extensions/drop/index.ts: drop failed", "2026-09-09T03:00:00Z"),
      event("/kit/tool.ts.bak: wrong file", "2026-09-09T04:00:00Z"),
      event("/kit/tool.ts: model failed", "2026-09-09T05:00:00Z", "model_error"),
    ].map(e => JSON.stringify(e)).join("\n"));
    await writeFile(join(dir, "sessions/old.jsonl"), JSON.stringify(event("/kit/clean.ts: stale failure", "2026-09-08T00:00:00Z")));
    const extensions: ConfigInventory["extensions"] = ["/kit/tool.ts", "/kit/clean.ts", "/extensions/drop"].map(path => ({ kind: "extension", name: path, path, enabled: true, scope: "user", origin: "drop-in" }));
    const inventory: ConfigInventory = { packages: [{ source: "npm:kit", scope: "user", filtered: false, resources: extensions.slice(0, 2) }], extensions, skills: [], themes: [], promptTemplates: [] };
    const result = await addResourceDiagnostics(inventory, store, createFileSessionEventJournal({ dataDir: dir }));
    expect(result.packages[0].resources[0].lastError).toEqual({ sessionId: "new", timestamp: "2026-09-09T02:00:00Z", message: "/kit/tool.ts: handler failed" });
    expect(result.extensions[1].lastError).toBeUndefined();
    expect(result.extensions[2].lastError?.message).toBe("/extensions/drop/index.ts: drop failed");
    await store.save({ sessionId: "clean", piSessionId: "clean", runtimeId: "clean", projectId: "p", cwd: "/", status: "idle", updatedAt: "2026-09-10T00:00:00Z" });
    const clean = await addResourceDiagnostics(inventory, store, createFileSessionEventJournal({ dataDir: dir }));
    expect(clean.extensions.every(resource => !resource.lastError)).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("matches a resource path against a journaled error path through a symlink", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pace-diagnostics-symlink-"));
  try {
    const store = createFileSessionProjectionStore({ dataDir: dir });
    await store.save({ sessionId: "new", piSessionId: "new", runtimeId: "new", projectId: "p", cwd: "/", status: "idle", updatedAt: "2026-09-09T00:00:00Z" });
    await mkdir(join(dir, "sessions"));
    // Pi may log the symlink-resolved real path even though the resource is
    // registered by its symlinked path (e.g. a package linked via `npm link`).
    const realDir = join(dir, "real");
    await mkdir(realDir);
    await writeFile(join(realDir, "tool.ts"), "");
    const linkPath = join(dir, "linked-tool.ts");
    await symlink(join(realDir, "tool.ts"), linkPath);
    const event = { type: "error", ts: "2026-09-09T01:00:00Z", payload: { type: "error", code: "extension_load_error", body: `${join(realDir, "tool.ts")}: symlink target failed` } };
    await writeFile(join(dir, "sessions/new.jsonl"), JSON.stringify(event));
    const extensions: ConfigInventory["extensions"] = [{ kind: "extension", name: "linked-tool", path: linkPath, enabled: true, scope: "user", origin: "drop-in" }];
    const inventory: ConfigInventory = { packages: [], extensions, skills: [], themes: [], promptTemplates: [] };
    const result = await addResourceDiagnostics(inventory, store, createFileSessionEventJournal({ dataDir: dir }));
    expect(result.extensions[0].lastError?.message).toBe(`${join(realDir, "tool.ts")}: symlink target failed`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
