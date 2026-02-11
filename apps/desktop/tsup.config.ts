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
  external: ["electron", "sql.js"],
  outDir: "dist",
  sourcemap: true,
  clean: true
});
