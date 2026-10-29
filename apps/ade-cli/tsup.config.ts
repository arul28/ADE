import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { asciiBundleSource } from "../../scripts/build/asciiBundleSource";

const external = [
  "@anthropic-ai/claude-agent-sdk",
  "@cursor/sdk",
  "chokidar",
  "node-pty",
  "node:sqlite",
  "sqlite3",
  "zod",
];
const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const cliNodeModules = path.join(packageRoot, "node_modules");
const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version?: string };
const version = process.env.ADE_CLI_VERSION?.trim() || packageJson.version || "0.0.0";
const posthogProjectToken = process.env.ADE_POSTHOG_PROJECT_TOKEN?.trim() ?? "";
if (posthogProjectToken && !/^phc_[A-Za-z0-9_-]{8,}$/.test(posthogProjectToken)) {
  throw new Error("ADE_POSTHOG_PROJECT_TOKEN must be a public phc_ project token; personal API keys must never be bundled.");
}

export default defineConfig([
  {
    entry: {
      cli: "src/cli.ts",
      bootstrap: "src/bootstrap.ts",
      adeRpcServer: "src/adeRpcServer.ts",
      ptyHostWorker: "../desktop/src/main/services/pty/ptyHostWorker.ts",
      cursorSdkWorker: "../desktop/src/main/services/chat/cursorSdkWorker.ts",
      droidSdkWorker: "../desktop/src/main/services/chat/droidSdkWorker.ts",
      copilotSdkWorker: "../desktop/src/main/services/chat/copilotSdkWorker.ts",
      piSdkWorker: "../desktop/src/main/services/chat/piSdkWorker.ts",
      usageLedgerWorker: "../desktop/src/main/services/usage/usageLedgerWorkerEntry.ts"
    },
    format: ["cjs"],
    platform: "node",
    target: "node22",
    outDir: "dist",
    sourcemap: true,
    clean: true,
    // @opencode/client is ESM-only (no "require" export); force-inline it so
    // the CJS runtime bundle does not emit a bare require() that packaged
    // Electron-as-node cannot resolve. @muse-code/sdk is ESM-only (zero deps)
    // and inlined for the same reason.
    // string-width: cli.ts reaches it at module scope through
    // lib/displayWidth (table formatters); the packaged CLI resolves
    // externals through NODE_PATH into apps/desktop's production tree, which
    // does not ship it (v1.2.75 release smoke). verify-built-cli.mjs guards
    // this class.
    // @sentry/*: inlined so the brain loads one file instead of a few hundred
    // small ones, which costs most of a second on Windows (Defender scans each).
    noExternal: [
      "@factory/droid-sdk",
      "@github/copilot-sdk",
      /^@opencode\/client(?:\/.*)?$/,
      /^@muse-code\/sdk(?:\/.*)?$/,
      "yaml",
      "string-width",
      /^@sentry\//,
    ],
    outExtension: () => ({
      js: ".cjs"
    }),
    external,
    plugins: [asciiBundleSource()],
    esbuildOptions(options) {
      options.nodePaths = Array.from(new Set([cliNodeModules, ...(options.nodePaths ?? [])]));
      options.define = {
        ...(options.define ?? {}),
        __ADE_VERSION__: JSON.stringify(version),
        __ADE_POSTHOG_PROJECT_TOKEN__: JSON.stringify(posthogProjectToken),
        __ADE_POSTHOG_HOST__: JSON.stringify(process.env.ADE_POSTHOG_HOST?.trim() ?? ""),
      };
      options.alias = {
        ...(options.alias ?? {}),
        sqlite: "node:sqlite",
        electron: path.join(packageRoot, "src", "electronUnavailableStub.cjs"),
      };
    },
  },
]);
