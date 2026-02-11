import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
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
