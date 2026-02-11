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
      // Allow importing shared types/utilities from src/ outside the renderer root.
      allow: [path.resolve(__dirname, "src")]
    }
  },
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true
  }
});
