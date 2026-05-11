import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const external = [
  "@agentclientprotocol/sdk",
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
const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version?: string };
const version = process.env.ADE_CLI_VERSION?.trim() || packageJson.version || "0.0.0";

export default defineConfig([
  {
    entry: {
      cli: "src/cli.ts",
      bootstrap: "src/bootstrap.ts",
      adeRpcServer: "src/adeRpcServer.ts"
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
    noExternal: ["@opencode-ai/sdk"],
    outExtension: () => ({
      js: ".cjs"
    }),
    external,
    esbuildOptions(options) {
      options.define = {
        ...(options.define ?? {}),
        __ADE_VERSION__: JSON.stringify(version),
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
    noExternal: ["ink", "ink-text-input", "react", "react/jsx-runtime", "@opencode-ai/sdk"],
    banner: {
      js: "import { createRequire as __adeCreateRequire } from 'node:module'; const require = __adeCreateRequire(import.meta.url);",
    },
    outExtension: () => ({
      js: ".mjs"
    }),
    external,
    esbuildOptions(options) {
      options.define = {
        ...(options.define ?? {}),
        __ADE_VERSION__: JSON.stringify(version),
      };
      options.alias = {
        ...(options.alias ?? {}),
        sqlite: "node:sqlite",
        "react-devtools-core": path.join(packageRoot, "src", "tuiClient", "reactDevtoolsStub.ts"),
      };
    },
  },
]);
