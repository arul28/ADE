import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const external = [
  "@anthropic-ai/claude-agent-sdk",
  "@cursor/sdk",
  "@wize-logic/nodejs-rfb",
  "chokidar",
  "node-pty",
  "node:sqlite",
  "sql.js",
  "sqlite3",
  "zod",
];
const tuiNoExternal = [
  "ink",
  "ink-text-input",
  "react",
  "react/jsx-runtime",
  "@opencode-ai/sdk",
  "@xterm/headless",
  "marked",
  "string-width",
  "ws",
  "yaml",
  /^highlight\.js(?:\/.*)?$/,
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
      droidSdkWorker: "../desktop/src/main/services/chat/droidSdkWorker.ts"
    },
    format: ["cjs"],
    platform: "node",
    target: "node22",
    outDir: "dist",
    sourcemap: true,
    clean: true,
    // @opencode-ai/sdk is ESM-only (no "require" export); force-inline it so
    // the CJS runtime bundle does not emit a bare require() that packaged
    // Electron-as-node cannot resolve.
    noExternal: ["@factory/droid-sdk", "@opencode-ai/sdk", "yaml"],
    outExtension: () => ({
      js: ".cjs"
    }),
    external,
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
        "react-devtools-core": path.join(packageRoot, "src", "tuiClient", "reactDevtoolsStub.ts"),
      };
    },
  },
  {
    entry: {
      "tuiClient/cli": "src/tuiClient/cli.tsx"
    },
    format: ["esm"],
    platform: "node",
    target: "node22",
    outDir: "dist",
    sourcemap: true,
    clean: false,
    splitting: false,
    noExternal: tuiNoExternal,
    banner: {
      js: [
        "import { createRequire as __adeCreateRequire } from 'node:module';",
        "import { fileURLToPath as __adeFileURLToPath } from 'node:url';",
        "import { dirname as __adeDirname } from 'node:path';",
        "const require = __adeCreateRequire(import.meta.url);",
        "const __filename = __adeFileURLToPath(import.meta.url);",
        "const __dirname = __adeDirname(__filename);",
      ].join("\n"),
    },
    outExtension: () => ({
      js: ".mjs"
    }),
    external,
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
        "react-devtools-core": path.join(packageRoot, "src", "tuiClient", "reactDevtoolsStub.ts"),
      };
    },
  },
]);
