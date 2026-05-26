#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRuntimeCliForDevClient,
  ensureRuntime,
  resolveDevSocketPath,
  resolveProjectRoot,
} from "../../../scripts/dev-shared.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const desktopRoot = path.resolve(path.dirname(scriptPath), "..");
const bridgeScript = path.join(desktopRoot, "scripts", "browser-runtime-bridge.mjs");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function parseArgs(argv) {
  return {
    skipRuntimeBuild: argv.includes("--skip-runtime-build"),
  };
}

function spawnLogged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: desktopRoot,
    stdio: "inherit",
    env: options.env ?? process.env,
    ...options,
  });
  return child;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = resolveProjectRoot();
  const socketPath = resolveDevSocketPath();

  process.stdout.write(`[ade] vite live project root: ${projectRoot}\n`);
  process.stdout.write(`[ade] vite live runtime socket: ${socketPath}\n`);

  await buildRuntimeCliForDevClient(options.skipRuntimeBuild, socketPath);
  await ensureRuntime(socketPath, projectRoot);

  const bridgeEnv = {
    ...process.env,
    ADE_PROJECT_ROOT: projectRoot,
  };
  const bridge = spawnLogged(process.execPath, [bridgeScript], { env: bridgeEnv });

  const viteEnv = {
    ...process.env,
    ADE_PROJECT_ROOT: projectRoot,
  };
  const vite = spawnLogged(
    npmCommand,
    ["run", "dev:vite"],
    { env: viteEnv },
  );

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!bridge.killed) bridge.kill(signal);
    if (!vite.killed) vite.kill(signal);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  bridge.on("exit", (code, signal) => {
    if (shuttingDown) return;
    process.stderr.write(
      `[ade] browser runtime bridge exited (${signal ?? code ?? "unknown"})\n`,
    );
    shutdown("SIGTERM");
  });

  vite.on("exit", (code) => {
    shutdown("SIGTERM");
    process.exit(typeof code === "number" ? code : 0);
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
