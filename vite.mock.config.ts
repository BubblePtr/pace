import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { relaxCspForDevServer } from "./apps/desktop/vite-dev-csp";

export default defineConfig(({ command }) => {
  if (command !== "serve")
    throw new Error("Static mock is development-only. Use bun run dev:mock.");
  return {
    root: resolve(__dirname, "apps/desktop"),
    plugins: [
      react(),
      tailwindcss(),
      // This serves the real apps/desktop/index.html (with its strict
      // production CSP) through Vite's dev server, so it needs the same
      // dev-only relaxation electron.vite.config.ts applies for `bun run dev`
      // — otherwise React Fast Refresh's inline preamble script is blocked.
      relaxCspForDevServer(),
      {
        name: "pace-static-mock-entry",
        transformIndexHtml(html) {
          return html.replace("/src/app/main.tsx", "/src/dev/mock/main.ts");
        },
      },
    ],
    resolve: {
      alias: {
        "@": resolve(__dirname, "apps/desktop/src"),
        "@pace/core": resolve(__dirname, "packages/core/src/index.ts"),
        "@pace/backend": resolve(__dirname, "packages/backend/src/index.ts"),
        react: resolve(__dirname, "node_modules/react"),
        "react-dom": resolve(__dirname, "node_modules/react-dom"),
      },
      dedupe: ["react", "react-dom"],
    },
    server: { host: "127.0.0.1", port: 1421, strictPort: true },
  };
});
