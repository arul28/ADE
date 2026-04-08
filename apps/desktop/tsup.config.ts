import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "main/adeMcpProxy": "src/main/adeMcpProxy.ts",
    "main/main": "src/main/main.ts",
    "main/packagedRuntimeSmoke": "src/main/packagedRuntimeSmoke.ts",
    "preload/preload": "src/preload/preload.ts"
  },
  format: ["cjs"],
  platform: "node",
  target: "node18",
  // Electron provides the "electron" module at runtime; bundling the npm package breaks it.
  // sql.js loads a wasm file from disk; keep it external so it can resolve its assets.
  // node-pty is native and must be resolved at runtime for Electron.
  external: ["electron", "sql.js", "node-pty", "onnxruntime-node"],
  // @opencode-ai/sdk is ESM-only (no "require" export); force-inline it so
  // the CJS bundle doesn't emit a bare require() that Node/Electron can't resolve.
  noExternal: ["@opencode-ai/sdk"],
  outDir: "dist",
  sourcemap: true,
  clean: true,
  // Inline build-time env variables so they're available in the packaged app.
  define: {
    "process.env.ADE_LINEAR_CLIENT_ID": JSON.stringify(process.env.ADE_LINEAR_CLIENT_ID ?? ""),
  },
});
