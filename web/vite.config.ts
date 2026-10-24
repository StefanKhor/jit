import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(root, "../static");

export default defineConfig({
  root,
  plugins: [
    react(),
    viteSingleFile(),
    {
      name: "jit-dashboard-name",
      closeBundle() {
        const from = path.join(outDir, "index.html");
        const to = path.join(outDir, "dashboard.html");
        if (existsSync(from)) renameSync(from, to);
      },
    },
  ],
  build: {
    outDir,
    emptyOutDir: true,
    target: "es2022",
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": process.env.JIT_DEV_SERVER || "http://127.0.0.1:3000",
    },
  },
});
