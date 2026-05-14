#!/usr/bin/env node

import fs from "node:fs";
import {
  buildRuntimeCliForDevClient,
  canConnectToSocket,
  devRuntimeEnv,
  npmCommand,
  resolveDevSocketPath,
  resolveProjectRoot,
  run,
} from "./dev-shared.mjs";

function usage() {
  return [
    "Usage: npm run dev:desktop -- [options]",
    "",
    "Uses the shared dev runtime, building it first when it is not already running.",
    "Default mode is --auto: desktop is allowed to auto-create the dev runtime.",
    "",
    "Options:",
    "  --auto                     Use dev socket and let desktop create runtime if missing. Default.",
    "  --attach                   Require an existing dev runtime before launching desktop.",
    "  --project-root <path>      Project to auto-open. Defaults to the primary checkout for ADE worktrees.",
    "  --socket <path>            Dev runtime socket. Defaults to /tmp/ade-runtime-dev.sock.",
    "  --clean                    Use desktop dev:clean instead of dev.",
    "  --skip-runtime-build       Launch without rebuilding apps/ade-cli.",
    "  -h, --help                 Show this help.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    mode: "auto",
    projectRoot: null,
    socketPath: null,
    clean: false,
    skipRuntimeBuild: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--auto") {
      options.mode = "auto";
      continue;
    }
    if (arg === "--attach") {
      options.mode = "attach";
      continue;
    }
    if (arg === "--clean") {
      options.clean = true;
      continue;
    }
    if (arg === "--skip-runtime-build") {
      options.skipRuntimeBuild = true;
      continue;
    }
    if (arg === "--project-root") {
      options.projectRoot = argv[++i] ?? null;
      if (!options.projectRoot) throw new Error("--project-root requires a path.");
      continue;
    }
    if (arg.startsWith("--project-root=")) {
      options.projectRoot = arg.slice("--project-root=".length);
      continue;
    }
    if (arg === "--socket") {
      options.socketPath = argv[++i] ?? null;
      if (!options.socketPath) throw new Error("--socket requires a path.");
      continue;
    }
    if (arg.startsWith("--socket=")) {
      options.socketPath = arg.slice("--socket=".length);
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return {
    ...options,
    projectRoot: resolveProjectRoot(options.projectRoot),
    socketPath: resolveDevSocketPath(options.socketPath),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(`${options.projectRoot}/.ade`)) {
    process.stderr.write(`[ade] warning: ${options.projectRoot} does not contain .ade; desktop may open the project picker.\n`);
  }
  process.stdout.write(`[ade] desktop mode: ${options.mode}\n`);
  process.stdout.write(`[ade] project root: ${options.projectRoot}\n`);
  process.stdout.write(`[ade] runtime socket: ${options.socketPath}\n`);
  if (options.mode === "attach" && !(await canConnectToSocket(options.socketPath))) {
    throw new Error(`No dev runtime is listening at ${options.socketPath}. Start it with npm run dev:runtime.`);
  }
  await buildRuntimeCliForDevClient(options.skipRuntimeBuild, options.socketPath);
  const desktopScript = options.clean ? "dev:clean" : "dev";
  await run(
    npmCommand,
    ["--prefix", "apps/desktop", "run", desktopScript],
    devRuntimeEnv(options.socketPath, options.projectRoot),
  );
}

main().catch((error) => {
  process.stderr.write(`[ade] dev desktop failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
