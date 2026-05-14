#!/usr/bin/env node

import {
  buildRuntimeCliForDevClient,
  ensureRuntime,
  resolveDevSocketPath,
  resolveProjectRoot,
} from "./dev-shared.mjs";

function usage() {
  return [
    "Usage: npm run dev:all -- [options]",
    "",
    "Starts the shared dev runtime, building it first when it is not already running.",
    "Then run npm run dev:desktop:attach and npm run dev:code:attach in separate terminals.",
    "",
    "Options:",
    "  --project-root <path>      Project root. Defaults to this checkout.",
    "  --socket <path>            Dev runtime socket. Defaults to /tmp/ade-runtime-dev.sock.",
    "  --skip-runtime-build       Launch without rebuilding apps/ade-cli.",
    "  -h, --help                 Show this help.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    projectRoot: null,
    socketPath: null,
    skipRuntimeBuild: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
    if (arg === "--skip-runtime-build") {
      options.skipRuntimeBuild = true;
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
  process.stdout.write(`[ade] project root: ${options.projectRoot}\n`);
  process.stdout.write(`[ade] runtime socket: ${options.socketPath}\n`);
  await buildRuntimeCliForDevClient(options.skipRuntimeBuild, options.socketPath);
  await ensureRuntime(options.socketPath);
  process.stdout.write("[ade] dev runtime is ready.\n");
  process.stdout.write("[ade] terminal 1: npm run dev:desktop:attach\n");
  process.stdout.write("[ade] terminal 2: npm run dev:code:attach\n");
}

main().catch((error) => {
  process.stderr.write(`[ade] dev all failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
