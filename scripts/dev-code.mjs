#!/usr/bin/env node

import {
  buildRuntimeCliForDevClient,
  canConnectToSocket,
  cliPath,
  devRuntimeEnv,
  ensureRuntime,
  resolveDevSocketPath,
  resolveProjectRoot,
  resolveWorkspaceRoot,
  run,
} from "./dev-shared.mjs";

function usage() {
  return [
    "Usage: npm run dev:code -- [options] [-- ade-code-args...]",
    "",
    "Uses the shared dev runtime, building it first when it is not already running.",
    "Default mode is --auto: start the dev runtime if it is missing.",
    "",
    "Options:",
    "  --auto                     Start dev runtime if missing. Default.",
    "  --attach                   Require an existing dev runtime.",
    "  --project-root <path>      ADE project data root. Defaults to the primary checkout for ADE worktrees.",
    "  --workspace-root <path>    Source checkout/workspace root. Defaults to this checkout.",
    "  --socket <path>            Dev runtime socket. Defaults to /tmp/ade-runtime-dev.sock.",
    "  --skip-runtime-build       Launch without rebuilding apps/ade-cli.",
    "  -h, --help                 Show this help.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    mode: "auto",
    projectRoot: null,
    workspaceRoot: null,
    socketPath: null,
    skipRuntimeBuild: false,
    rest: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      options.rest = argv.slice(i + 1);
      break;
    }
    if (arg === "--auto") {
      options.mode = "auto";
      continue;
    }
    if (arg === "--attach") {
      options.mode = "attach";
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
      const value = arg.slice("--project-root=".length).trim();
      if (!value) throw new Error("--project-root requires a path.");
      options.projectRoot = value;
      continue;
    }
    if (arg === "--workspace-root") {
      options.workspaceRoot = argv[++i] ?? null;
      if (!options.workspaceRoot) throw new Error("--workspace-root requires a path.");
      continue;
    }
    if (arg.startsWith("--workspace-root=")) {
      const value = arg.slice("--workspace-root=".length).trim();
      if (!value) throw new Error("--workspace-root requires a path.");
      options.workspaceRoot = value;
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
    workspaceRoot: resolveWorkspaceRoot(options.workspaceRoot),
    socketPath: resolveDevSocketPath(options.socketPath),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  process.stdout.write(`[ade] code mode: ${options.mode}\n`);
  process.stdout.write(`[ade] project root: ${options.projectRoot}\n`);
  process.stdout.write(`[ade] workspace root: ${options.workspaceRoot}\n`);
  process.stdout.write(`[ade] runtime socket: ${options.socketPath}\n`);
  if (options.mode === "attach") {
    if (!(await canConnectToSocket(options.socketPath))) {
      throw new Error(`No dev runtime is listening at ${options.socketPath}. Start it with npm run dev:runtime.`);
    }
    await buildRuntimeCliForDevClient(options.skipRuntimeBuild, options.socketPath);
  } else {
    await buildRuntimeCliForDevClient(options.skipRuntimeBuild, options.socketPath);
    await ensureRuntime(options.socketPath);
  }
  await run(
    process.execPath,
    [
      cliPath(),
      "code",
      "--project-root",
      options.projectRoot,
      "--workspace-root",
      options.workspaceRoot,
      "--socket",
      options.socketPath,
      "--require-socket",
      ...options.rest,
    ],
    devRuntimeEnv(options.socketPath, options.projectRoot),
  );
}

main().catch((error) => {
  process.stderr.write(`[ade] dev code failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
