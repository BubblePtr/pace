import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ command }) => {
  if (command !== "serve")
    throw new Error("Static mock is development-only. Use bun run dev:mock.");
  return {
    root: resolve(__dirname, "apps/desktop"),
    plugins: [
      react(),
      tailwindcss(),
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
