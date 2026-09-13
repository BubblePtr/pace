import { existsSync, readFileSync, realpathSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

// These are the public peer imports supported by the pinned Pi extension runtime.
const peerExports: Record<string, string[]> = {
  "@earendil-works/pi-coding-agent": ["."],
  "@earendil-works/pi-agent-core": [".", "./node"],
  "@earendil-works/pi-ai": [".", "./compat", "./oauth", "./providers/all"],
  "@earendil-works/pi-tui": ["."],
  typebox: [".", "./compile", "./value"],
};

export const piBackendEntry = "runtime/node_modules/@earendil-works/pi-coding-agent/pace-backend";

function importTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const conditions = value as Record<string, unknown>;
    for (const condition of ["import", "node", "default"]) {
      const target = importTarget(conditions[condition]);
      if (target) return target;
    }
  }
}

export function piRuntimeBundle(piRoot: string, backendEntry: string): { input: Record<string, string>; plugin: Plugin } {
  const requireFromPi = createRequire(join(piRoot, "package.json"));
  const input: Record<string, string> = {};
  const manifests: Array<{ directory: string; source: string; content: object }> = [];
  const oauthBootstrap = "\0pace-pi-oauth-bootstrap";
  const virtualModules = new Map<string, string>();

  function initializedEntry(entry: string, original: string): string {
    const id = `\0pace-pi-entry:${entry}`;
    virtualModules.set(id, `import ${JSON.stringify(oauthBootstrap)};\nexport * from ${JSON.stringify(original)};`);
    return id;
  }

  input[piBackendEntry] = initializedEntry(piBackendEntry, backendEntry);

  for (const [name, subpaths] of Object.entries(peerExports)) {
    const source = name === "@earendil-works/pi-coding-agent" ? piRoot
      : requireFromPi.resolve.paths(name)?.map((directory) => join(directory, name))
        .find((directory) => existsSync(join(directory, "package.json")));
    if (!source) throw new Error(`Missing Pi runtime peer: ${name}`);
    const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    if (name === "@earendil-works/pi-ai") {
      // Resolve the public bundling API so Pi owns its private OAuth file layout.
      const oauthTarget = importTarget(pkg.exports?.["./bun-oauth"]);
      if (!oauthTarget) throw new Error("Missing Pi runtime export: @earendil-works/pi-ai/bun-oauth");
      virtualModules.set(oauthBootstrap, `
        import { registerBunOAuthFlows } from ${JSON.stringify(realpathSync(join(source, oauthTarget)))};
        registerBunOAuthFlows();
      `);
    }
    const directory = `runtime/node_modules/${name}`;
    const exports: Record<string, string> = {};
    for (const subpath of subpaths) {
      const wildcard = Object.keys(pkg.exports ?? {}).find((key) => key.endsWith("*") && subpath.startsWith(key.slice(0, -1)));
      const entry = pkg.exports?.[subpath] ?? (wildcard ? pkg.exports[wildcard] : subpath === "." ? pkg.main : undefined);
      const target = importTarget(entry);
      if (!target) throw new Error(`Missing Pi runtime export: ${name} ${subpath}`);
      const filename = subpath === "." ? "index" : subpath.slice(2);
      const original = realpathSync(join(source,
        wildcard ? target.replace("*", subpath.slice(wildcard.length - 1)) : target));
      const outputEntry = `${directory}/${filename}`;
      if (name === "@earendil-works/pi-coding-agent" || name === "@earendil-works/pi-ai") {
        // Independent consumers do not run Pace's backend. Initialize once per module graph.
        input[outputEntry] = initializedEntry(outputEntry, original);
      } else {
        input[outputEntry] = original;
      }
      exports[subpath] = `./${filename}.js`;
    }
    manifests.push({ directory, source, content: {
      name: pkg.name, version: pkg.version, type: "module", main: "./index.js", exports,
      license: pkg.license, ...(pkg.piConfig ? { piConfig: pkg.piConfig } : {}),
    } });
  }

  return { input, plugin: {
    name: "pace-pi-runtime-packages",
    resolveId(id) {
      if (virtualModules.has(id)) return id;
    },
    load(id) {
      return virtualModules.get(id);
    },
    async writeBundle(options) {
      if (!options.dir) throw new Error("Pi runtime output directory is required");
      for (const pkg of manifests) {
        const directory = join(options.dir, pkg.directory);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "package.json"), JSON.stringify(pkg.content, null, 2));
        if (existsSync(join(pkg.source, "LICENSE"))) await copyFile(join(pkg.source, "LICENSE"), join(directory, "LICENSE"));
      }
      await writeFile(join(options.dir, "runtime/package.json"), JSON.stringify({ name: "@pace/pi-runtime", private: true, type: "module" }));
      for (const theme of ["dark.json", "light.json"]) {
        const relative = `dist/modes/interactive/theme/${theme}`;
        const target = join(options.dir, "runtime/node_modules/@earendil-works/pi-coding-agent", relative);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(piRoot, relative), target);
      }
    },
  } };
}
