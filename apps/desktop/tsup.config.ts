import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "main/main": "src/main/main.ts",
    "preload/preload": "src/preload/preload.ts"
  },
  format: ["cjs"],
  platform: "node",
  target: "node18",
  // Electron provides the "electron" module at runtime; bundling the npm package breaks it.
  // sql.js loads a wasm file from disk; keep it external so it can resolve its assets.
  // node-pty is native and must be resolved at runtime for Electron.
  external: ["electron", "sql.js", "node-pty"],
  outDir: "dist",
  sourcemap: true,
  clean: true
});
