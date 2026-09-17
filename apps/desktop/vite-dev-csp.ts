import type { Plugin } from "vite";

/**
 * index.html ships a strict, production CSP (no eval, no inline scripts).
 * The Vite dev server needs more: its HMR client and @vitejs/plugin-react's
 * Fast Refresh preamble are an inline `<script type="module">`, and source
 * transforms rely on `eval`. Relax script-src only in dev, only here, so the
 * packaged app's index.html — and every production build of it — stay
 * untouched.
 *
 * Shared by every Vite config that serves apps/desktop/index.html in dev
 * mode: electron.vite.config.ts (bun run dev) and vite.mock.config.ts
 * (bun run dev:mock).
 */
export function relaxCspForDevServer(): Plugin {
  let isDev = false;
  return {
    name: "pigui-relax-csp-for-dev-server",
    configResolved(config) {
      isDev = config.command === "serve";
    },
    transformIndexHtml(html) {
      if (!isDev) return html;
      return html.replace(
        /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/,
        (_match, prefix: string, content: string, suffix: string) =>
          `${prefix}${content.replace(
            "script-src 'self' 'wasm-unsafe-eval'",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
          )}${suffix}`,
      );
    },
  };
}
