import fs from "node:fs/promises";
import path from "node:path";
import { defineConfig } from "tsup";
import { assertPublicPostHogToken } from "../../scripts/posthog/publicPostHogToken";

const posthogProjectToken = process.env.ADE_POSTHOG_PROJECT_TOKEN?.trim() ?? "";
const devMainReadyMarker = process.env.ADE_DEV_MAIN_READY_MARKER?.trim() ?? "";
assertPublicPostHogToken(posthogProjectToken, "ADE_POSTHOG_PROJECT_TOKEN");

export default defineConfig({
  entry: {
    "main/main": "src/main/main.ts",
    "main/cursorSdkWorker": "src/main/services/chat/cursorSdkWorker.ts",
    "main/droidSdkWorker": "src/main/services/chat/droidSdkWorker.ts",
    "main/piSdkWorker": "src/main/services/chat/piSdkWorker.ts",
    "main/ptyHostWorker": "src/main/services/pty/ptyHostWorker.ts",
    "main/usageLedgerWorker": "src/main/services/usage/usageLedgerWorkerEntry.ts",
    "main/packagedRuntimeSmoke": "src/main/packagedRuntimeSmoke.ts",
    "preload/preload": "src/preload/preload.ts"
  },
  format: ["cjs"],
  platform: "node",
  target: "node18",
  // Electron provides the "electron" module at runtime; bundling the npm package breaks it.
  // node-pty is native and must be resolved at runtime for Electron.
  external: ["electron", "node-pty", "@cursor/sdk", "@factory/droid-sdk"],
  // @opencode-ai/sdk is ESM-only (no "require" export); force-inline it so
  // the CJS bundle doesn't emit a bare require() that Node/Electron can't resolve.
  noExternal: ["@opencode-ai/sdk", /^@opencode-ai\/sdk\/v2(?:\/.*)?$/],
  outDir: "dist",
  sourcemap: process.env.ADE_BUILD_SOURCEMAPS === "1",
  // Preserve Vite's dist/renderer output during main/preload watch rebuilds in dev.
  clean: ["dist/main", "dist/preload"],
  // The dev launcher must not infer build completion from main.cjs appearing:
  // tsup creates that file before every entry has finished. Signal only after
  // the complete build succeeds so Electron never starts against a partial
  // bundle, and use the same signal for safe watch-mode restarts.
  onSuccess: devMainReadyMarker
    ? async () => {
        await fs.mkdir(path.dirname(devMainReadyMarker), { recursive: true });
        await fs.writeFile(
          devMainReadyMarker,
          `${process.pid}:${Date.now()}:${Math.random()}\n`,
          "utf8",
        );
      }
    : undefined,
  // Inline build-time env variables so they're available in the packaged app.
  define: {
    "process.env.ADE_LINEAR_CLIENT_ID": JSON.stringify(process.env.ADE_LINEAR_CLIENT_ID ?? ""),
    __ADE_POSTHOG_PROJECT_TOKEN__: JSON.stringify(posthogProjectToken),
    __ADE_POSTHOG_HOST__: JSON.stringify(process.env.ADE_POSTHOG_HOST?.trim() ?? ""),
  },
});
