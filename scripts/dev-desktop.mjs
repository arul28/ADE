#!/usr/bin/env node

import fs from "node:fs";
import {
  buildRuntimeCliForDevClient,
  assertDevAdeHome,
  printDevIsolationReport,
  assertRuntimeFresh,
  canConnectToSocket,
  devRuntimeEnv,
  ensureRuntime,
  resolveDevSocketPath,
  resolveProjectRoot,
  runNpm,
  repoRoot,
  shutdownRuntime,
} from "./dev-shared.mjs";
import { prepareLaneUserData, pruneStaleDevUserData } from "./dev-user-data.mjs";

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
    remoteDebuggingPort: null,
    forwardedDebugFlags: [],
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
    // App Control hands a custom launcher its debug flags on the command line
    // when the caller uses the `{ADE_APP_CONTROL_DEBUG_FLAGS}` placeholder, and
    // exports the same set in the environment. Consume them here and pass the
    // CDP port to the desktop dev script through the env var it already reads
    // (`ADE_ELECTRON_REMOTE_DEBUGGING_PORT`); rejecting them made
    // `ade app-control launch --command "npm run dev:desktop -- ... {ADE_APP_CONTROL_DEBUG_FLAGS}"`
    // fail with "Unknown option: --remote-debugging-port=…".
    if (arg.startsWith("--remote-debugging-port=")) {
      const port = Number.parseInt(arg.slice("--remote-debugging-port=".length), 10);
      if (Number.isFinite(port) && port > 0) options.remoteDebuggingPort = port;
      continue;
    }
    if (arg === "--remote-debugging-port") {
      const port = Number.parseInt(argv[++i] ?? "", 10);
      if (Number.isFinite(port) && port > 0) options.remoteDebuggingPort = port;
      continue;
    }
    if (arg.startsWith("--remote-debugging-address=")) continue;
    if (arg === "--remote-debugging-address") {
      i += 1;
      continue;
    }
    // Any Chromium `--disable-*` flag App Control adds is forwarded to Electron
    // (the current set is the occlusion/backgrounding pair). Accepting the
    // family, not two literals, keeps a new render flag from breaking the
    // launcher the same way the port flag did.
    if (arg.startsWith("--disable-")) {
      options.forwardedDebugFlags.push(arg);
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

/**
 * Give a lane worktree's dev app a user-data folder of its own.
 *
 * Electron keeps its single-instance lock in the user-data folder. When every
 * dev app shared `ade-desktop-dev`, a second lane's app lost the lock and never
 * opened a window. An explicit ADE_DESKTOP_USER_DATA_PATH still wins; the
 * primary checkout keeps the shared folder. Stale lane folders (worktree gone,
 * or unused for 30 days) are removed here, so they do not pile up.
 */
function laneUserDataEnv() {
  if (process.env.ADE_DESKTOP_USER_DATA_PATH?.trim()) {
    process.stdout.write(`[ade] user data : ${process.env.ADE_DESKTOP_USER_DATA_PATH} (ADE_DESKTOP_USER_DATA_PATH)\n`);
    return {};
  }
  let folder = null;
  try {
    folder = prepareLaneUserData(repoRoot);
    for (const entry of pruneStaleDevUserData({ keep: folder })) {
      process.stdout.write(`[ade] removed stale dev user data ${entry.folder} (${entry.reason})\n`);
    }
  } catch (error) {
    process.stderr.write(
      `[ade] warning: lane user data not prepared, using the shared folder: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return {};
  }
  if (!folder) return {};
  process.stdout.write(`[ade] user data : ${folder} (this lane's; npm run dev:clean-data lists them all)\n`);
  return { ADE_DESKTOP_USER_DATA_PATH: folder };
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
  let runtimeStartedByLauncher = false;
  let runtimeStopPromise = null;
  const stopOwnedRuntime = () => {
    if (!runtimeStartedByLauncher) return Promise.resolve();
    if (runtimeStopPromise) return runtimeStopPromise;
    runtimeStopPromise = shutdownRuntime(options.socketPath)
      .catch((error) => {
        process.stderr.write(
          `[ade] failed to stop owned dev runtime: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      });
    return runtimeStopPromise;
  };
  let signalCount = 0;
  const handleSignal = () => {
    // Ctrl+C is also delivered to the npm/Electron child. Keep this launcher
    // alive just long enough to stop the detached runtime it created. A second
    // signal means the user wants out now: the brain watches this process
    // (exitWithLauncher), so exiting does not leak it.
    signalCount += 1;
    if (signalCount > 1) process.exit(130);
    void stopOwnedRuntime();
  };
  // App Control stops an app with SIGINT, then SIGTERM, then closes its
  // terminal (SIGHUP). Each must reach the handler, or the launcher dies before
  // it stops its brain.
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  process.on("SIGHUP", handleSignal);
  // Before anything starts: a dev app on somebody else's state root boots
  // cleanly and then shows a different database.
  assertDevAdeHome();

  try {
    if (options.mode === "attach") {
      await assertRuntimeFresh(options.socketPath, options.projectRoot);
    } else {
      runtimeStartedByLauncher = await ensureRuntime(options.socketPath, options.projectRoot, { exitWithLauncher: true });
    }
    printDevIsolationReport(options.socketPath, options.projectRoot, {
      ownsRuntime: runtimeStartedByLauncher,
    });
    const desktopScript = options.clean ? "dev:clean" : "dev";
    // The desktop dev script reads its Electron CDP port from the environment
    // (ADE_APP_CONTROL_CDP_PORT / ADE_ELECTRON_REMOTE_DEBUGGING_PORT). An
    // explicit `--remote-debugging-port` from an App Control launch wins over
    // the inherited App Control port; the render flags ride along so an
    // occluded window keeps painting.
    const appControlDebugEnv = {};
    if (options.remoteDebuggingPort) {
      appControlDebugEnv.ADE_ELECTRON_REMOTE_DEBUGGING_PORT = String(options.remoteDebuggingPort);
    }
    if (options.forwardedDebugFlags.length) {
      appControlDebugEnv.ADE_APP_CONTROL_DEBUG_FLAGS = options.forwardedDebugFlags.join(" ");
    }
    await runNpm(
      ["--prefix", "apps/desktop", "run", desktopScript],
      { ...devRuntimeEnv(options.socketPath, options.projectRoot), ...laneUserDataEnv(), ...appControlDebugEnv },
    );
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    process.off("SIGHUP", handleSignal);
    await stopOwnedRuntime();
  }
}

main().catch((error) => {
  process.stderr.write(`[ade] dev desktop failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
