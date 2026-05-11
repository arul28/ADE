import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sharedPath = fileURLToPath(import.meta.url);

export const repoRoot = path.resolve(path.dirname(sharedPath), "..");
export const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
export const defaultDevSocketPath = process.platform === "win32"
  ? path.join(os.tmpdir(), "ade-runtime-dev.sock")
  : "/tmp/ade-runtime-dev.sock";

export function resolveDevSocketPath(rawSocketPath = null) {
  const candidate = rawSocketPath?.trim()
    || process.env.ADE_DEV_RUNTIME_SOCKET_PATH?.trim()
    || defaultDevSocketPath;
  return candidate.startsWith("tcp://") ? candidate : path.resolve(candidate);
}

export function resolveProjectRoot(rawProjectRoot = null) {
  return path.resolve(rawProjectRoot?.trim() || process.env.ADE_PROJECT_ROOT?.trim() || repoRoot);
}

export function cliPath() {
  return path.join(repoRoot, "apps", "ade-cli", "dist", "cli.cjs");
}

export function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} exited with signal ${signal}.`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}.`));
        return;
      }
      resolve();
    });
  });
}

export async function buildRuntimeCli(skipRuntimeBuild = false) {
  if (skipRuntimeBuild) return;
  process.stdout.write("[ade] building runtime CLI\n");
  await run(npmCommand, ["--prefix", "apps/ade-cli", "run", "build"]);
}

function createSocket(socketPath) {
  if (socketPath.startsWith("tcp://")) {
    const parsed = new URL(socketPath);
    return net.createConnection({ host: parsed.hostname, port: Number(parsed.port) });
  }
  return net.createConnection(socketPath);
}

export function canConnectToSocket(socketPath, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = createSocket(socketPath);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function waitForSocket(socketPath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await canConnectToSocket(socketPath, 250)) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ADE dev runtime at ${socketPath}.`);
}

export async function ensureRuntime(socketPath) {
  if (await canConnectToSocket(socketPath)) return false;
  if (socketPath.startsWith("tcp://")) {
    throw new Error(`Cannot auto-start ADE dev runtime on TCP socket ${socketPath}.`);
  }
  process.stdout.write(`[ade] starting dev runtime at ${socketPath}\n`);
  const child = spawn(process.execPath, [cliPath(), "serve", "--socket", socketPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ADE_DEV_RUNTIME_SOCKET_PATH: socketPath,
      ADE_RUNTIME_SOCKET_PATH: socketPath,
      ADE_RPC_SOCKET_PATH: socketPath,
    },
    detached: true,
    stdio: "ignore",
  });
  child.once("error", () => {});
  child.unref();
  await waitForSocket(socketPath);
  return true;
}

export function devRuntimeEnv(socketPath, projectRoot) {
  return {
    ADE_DEV_RUNTIME_SOCKET_PATH: socketPath,
    ADE_RUNTIME_SOCKET_PATH: socketPath,
    ADE_RPC_SOCKET_PATH: socketPath,
    ADE_PROJECT_ROOT: projectRoot,
  };
}
