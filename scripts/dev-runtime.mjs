#!/usr/bin/env node

import {
  buildRuntimeCli,
  cliPath,
  devRuntimeEnv,
  resolveDevSocketPath,
  resolveProjectRoot,
  run,
} from "./dev-shared.mjs";

function usage() {
  return [
    "Usage: npm run dev:runtime -- [options]",
    "",
    "Builds the ADE CLI/runtime, then runs only the dev runtime in the foreground.",
    "",
    "Options:",
    "  --project-root <path>       Project root exported to the runtime. Defaults to the primary checkout for ADE worktrees.",
    "  --socket <path>             Dev runtime socket. Defaults to /tmp/ade-runtime-dev.sock.",
    "  --skip-runtime-build        Launch without rebuilding apps/ade-cli.",
    "  --no-sync                   Disable runtime sync discovery for this run.",
    "  -h, --help                  Show this help.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    projectRoot: null,
    socketPath: null,
    skipRuntimeBuild: false,
    sync: true,
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
    if (arg === "--no-sync") {
      options.sync = false;
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
  await buildRuntimeCli(options.skipRuntimeBuild);
  await run(
    process.execPath,
    [cliPath(), "serve", "--socket", options.socketPath, ...(options.sync ? [] : ["--no-sync"])],
    devRuntimeEnv(options.socketPath, options.projectRoot),
  );
}

main().catch((error) => {
  process.stderr.write(`[ade] dev runtime failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
