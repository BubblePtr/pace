import { realpathSync } from "node:fs";
import type { ConfigInventory, ResourceInfo } from "@pace/core";
import type { SessionEventJournal } from "../persistence/session-event-journal";
import type { SessionProjectionStore } from "../persistence/session-projection-store";

/**
 * Resolve symlinks/casing so a resource path and a journaled error path
 * refer to the same file even when one side is a symlink or differs only in
 * case (common on case-insensitive macOS/Windows filesystems). A path that no
 * longer exists (e.g. a removed resource) can't be resolved; fall back to the
 * raw path so lookups still work for stable, existing paths.
 */
function normalizePath(path: string, cache: Map<string, string>): string {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  let normalized: string;
  try {
    normalized = realpathSync(path);
  } catch {
    normalized = path;
  }
  cache.set(path, normalized);
  return normalized;
}

export async function addResourceDiagnostics(
  inventory: ConfigInventory,
  store: SessionProjectionStore,
  journal: SessionEventJournal,
): Promise<ConfigInventory> {
  const latest = (await store.list()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!latest) return inventory;
  const errors = (await journal.read(latest.piSessionId))
    .filter(event => event.payload.type === "error" &&
      (event.payload.code === "extension_load_error" || event.payload.code === "extension_error") &&
      typeof event.payload.body === "string")
    .sort((a, b) => b.ts.localeCompare(a.ts));
  const pathCache = new Map<string, string>();
  const diagnose = (resource: ResourceInfo): ResourceInfo => {
    if (resource.kind !== "extension") return resource;
    const resourcePath = normalizePath(resource.path, pathCache);
    const error = errors.find(event => {
      const body = event.payload.body as string;
      // ADR-0031 journals "path: detail"; require a path boundary, never a substring in a stack trace.
      const path = normalizePath(body.slice(0, body.indexOf(": ")), pathCache);
      return path === resourcePath || path.startsWith(`${resourcePath}/`);
    });
    return { ...resource, lastError: error ? {
      sessionId: latest.sessionId, timestamp: error.ts, message: error.payload.body as string,
    } : undefined };
  };
  return {
    ...inventory,
    extensions: inventory.extensions.map(diagnose),
    packages: inventory.packages.map(pkg => ({ ...pkg, resources: pkg.resources.map(diagnose) })),
  };
}
