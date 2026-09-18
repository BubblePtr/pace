import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: {
      "@pace/core": resolve(__dirname, "packages/core/src/index.ts"),
      "@pace/backend": resolve(__dirname, "packages/backend/src/index.ts"),
      "@": resolve(__dirname, "apps/desktop/src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "e2e/**", "**/out/**", "**/.claude/worktrees/**"],
    pool: "forks",
    // @lobehub/icons ships extensionless directory imports that Node's ESM
    // resolver rejects; let Vite resolve them so pages using brand icons stay
    // unit-testable.
    server: { deps: { inline: [/@lobehub\//] } },
    setupFiles: ["./apps/desktop/src/test/setup.ts"],
  },
});
