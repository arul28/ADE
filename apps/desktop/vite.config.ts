import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "src/renderer",
  base: "./",
  // Keep cache location stable regardless of renderer root semantics.
  cacheDir: path.resolve(__dirname, "node_modules/.vite"),
  plugins: [react()],
  optimizeDeps: {
    // Disable dep optimizer in dev to avoid 504 "Outdated Optimize Dep" crashes.
    disabled: "dev",
    // Keep problematic UI libraries out of esbuild dep-pre-bundling in dev.
    // This avoids intermittent optimizeDeps failures and bad pre-bundles at runtime.
    exclude: [
      "@radix-ui/react-tabs",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "motion",
      "motion/react",
      "motion-dom",
      "motion-utils"
    ]
  },
  server: {
    fs: {
      // Keep Vite's default workspace/node_modules access and additionally allow src/.
      // Monaco's ESM runtime pulls CSS/assets from node_modules at dev-time.
      allow: [path.resolve(__dirname), path.resolve(__dirname, "src")]
    }
  },
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true
  }
});
