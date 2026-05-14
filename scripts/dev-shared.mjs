import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
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

export function resolvePrimaryProjectRoot(candidateRoot = repoRoot) {
  const resolved = path.resolve(candidateRoot);
  const parts = resolved.split(path.sep);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i] !== ".ade" || parts[i + 1] !== "worktrees" || !parts[i + 2]) continue;
    const rootParts = parts.slice(0, i);
    const projectRoot = rootParts.length === 0 ? path.sep : rootParts.join(path.sep);
    return path.resolve(projectRoot);
  }
  return resolved;
}

export function resolveProjectRoot(rawProjectRoot = null) {
  const explicit = rawProjectRoot?.trim() || process.env.ADE_PROJECT_ROOT?.trim();
  if (explicit) return path.resolve(explicit);
  return resolvePrimaryProjectRoot(repoRoot);
}

export function resolveWorkspaceRoot(rawWorkspaceRoot = null) {
  return path.resolve(rawWorkspaceRoot?.trim() || process.env.ADE_WORKSPACE_ROOT?.trim() || repoRoot);
}

export function cliPath() {
  return path.join(repoRoot, "apps", "ade-cli", "dist", "cli.cjs");
}

export function resolveDevAppVersion() {
  const override = process.env.ADE_CLI_VERSION?.trim();
  if (override) return override;
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "apps", "desktop", "package.json"), "utf8"),
    );
    const version = typeof packageJson.version === "string" ? packageJson.version.trim() : "";
    if (version) return version;
  } catch {
    // Fall through to the placeholder used by source-only CLI builds.
  }
  return "0.0.0";
}

export function computeRuntimeBuildHash() {
  try {
    return createHash("sha256").update(fs.readFileSync(cliPath())).digest("hex");
  } catch {
    return null;
  }
}

function runtimeBuildEnv() {
  const buildHash = computeRuntimeBuildHash();
  return buildHash ? { ADE_RUNTIME_BUILD_HASH: buildHash } : {};
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
  await run(npmCommand, ["--prefix", "apps/ade-cli", "run", "build"], {
    ADE_CLI_VERSION: resolveDevAppVersion(),
  });
}

export async function buildRuntimeCliForDevClient(skipRuntimeBuild, socketPath) {
  if (skipRuntimeBuild) return;
  if (fs.existsSync(cliPath()) && await canConnectToSocket(socketPath)) {
    process.stdout.write("[ade] dev runtime is already listening; skipping runtime CLI rebuild\n");
    return;
  }
  await buildRuntimeCli(false);
}

function createSocket(socketPath) {
  if (socketPath.startsWith("tcp://")) {
    const parsed = new URL(socketPath);
    return net.createConnection({ host: parsed.hostname, port: Number(parsed.port) });
  }
  return net.createConnection(socketPath);
}

function readRuntimeInfo(value) {
  const runtimeInfo =
    value && typeof value === "object" && !Array.isArray(value)
      ? value.runtimeInfo
      : null;
  if (!runtimeInfo || typeof runtimeInfo !== "object" || Array.isArray(runtimeInfo)) {
    return { version: null, buildHash: null };
  }
  const version = typeof runtimeInfo.version === "string" && runtimeInfo.version.trim()
    ? runtimeInfo.version.trim()
    : null;
  const buildHash = typeof runtimeInfo.buildHash === "string" && runtimeInfo.buildHash.trim()
    ? runtimeInfo.buildHash.trim()
    : null;
  return { version, buildHash };
}

function jsonRpcRequestSequence(socketPath, requests, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2000;
  const allowCloseBeforeResponse = options.allowCloseBeforeResponse === true;
  return new Promise((resolve, reject) => {
    const socket = createSocket(socketPath);
    let buffer = "";
    let connected = false;
    let settled = false;
    let nextId = 1;
    let requestIndex = 0;
    let activeRequest = null;
    let lastResult = null;
    const timer = setTimeout(() => {
      const label = activeRequest?.method ?? requests[requestIndex]?.method ?? "request";
      finish(new Error(`Timed out waiting for ADE dev runtime ${label} response at ${socketPath}.`));
    }, timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const sendNext = () => {
      const request = requests[requestIndex];
      if (!request) {
        finish(null, lastResult);
        return;
      }
      const id = nextId;
      nextId += 1;
      activeRequest = { id, method: request.method };
      const payload = {
        jsonrpc: "2.0",
        id,
        method: request.method,
        ...(request.params !== undefined ? { params: request.params } : {}),
      };
      socket.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (error) finish(error);
      });
    };
    socket.once("connect", () => {
      connected = true;
      sendNext();
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) return;
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (!line) continue;
        let response;
        try {
          response = JSON.parse(line);
        } catch {
          finish(new Error(`ADE dev runtime returned invalid JSON-RPC response: ${line}`));
          return;
        }
        if (!response || typeof response !== "object" || response.id !== activeRequest?.id) continue;
        if (response.error) {
          const message =
            response.error && typeof response.error === "object" && typeof response.error.message === "string"
              ? response.error.message
              : `ADE dev runtime rejected ${activeRequest.method}.`;
          finish(new Error(message));
          return;
        }
        lastResult = response.result;
        requestIndex += 1;
        activeRequest = null;
        sendNext();
      }
    });
    socket.once("close", () => {
      if (allowCloseBeforeResponse && connected) {
        finish(null, lastResult);
        return;
      }
      const label = activeRequest?.method ?? requests[requestIndex]?.method ?? "request";
      finish(new Error(`ADE dev runtime socket closed before ${label} completed.`));
    });
    socket.once("error", (error) => finish(error));
  });
}

function jsonRpcRequest(socketPath, method, params, options = {}) {
  return jsonRpcRequestSequence(socketPath, [{ method, params }], options);
}

function launcherInitializeParams(clientName) {
  return {
    protocolVersion: "2025-06-18",
    clientInfo: { name: clientName, version: resolveDevAppVersion() },
    identity: {
      role: "external",
      callerId: `${clientName}:${process.pid}`,
      computerUsePolicy: {
        mode: "auto",
        allowLocalFallback: false,
        retainArtifacts: true,
      },
    },
  };
}

async function getRuntimeInfo(socketPath) {
  const result = await jsonRpcRequest(
    socketPath,
    "ade/initialize",
    launcherInitializeParams("ade-dev-launcher"),
  );
  return readRuntimeInfo(result);
}

function runtimeMismatchReason(info) {
  const expectedVersion = resolveDevAppVersion();
  const expectedBuildHash = computeRuntimeBuildHash();
  if (info.version && info.version !== expectedVersion) {
    return `version ${info.version} != ${expectedVersion}`;
  }
  if (expectedBuildHash && info.buildHash !== expectedBuildHash) {
    return info.buildHash
      ? "build hash changed"
      : "build hash missing";
  }
  return null;
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

async function waitForSocketToClose(socketPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await canConnectToSocket(socketPath, 150))) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for stale ADE dev runtime at ${socketPath} to stop.`);
}

async function shutdownRuntime(socketPath) {
  await jsonRpcRequestSequence(
    socketPath,
    [
      {
        method: "ade/initialize",
        params: launcherInitializeParams("ade-dev-launcher-shutdown"),
      },
      { method: "shutdown", params: {} },
    ],
    {
      timeoutMs: 3000,
      allowCloseBeforeResponse: true,
    },
  );
  await waitForSocketToClose(socketPath);
}

export async function ensureRuntime(socketPath) {
  try {
    const info = await getRuntimeInfo(socketPath);
    const mismatch = runtimeMismatchReason(info);
    if (!mismatch) return false;
    process.stdout.write(`[ade] restarting stale dev runtime at ${socketPath} (${mismatch})\n`);
    await shutdownRuntime(socketPath);
  } catch (error) {
    if (await canConnectToSocket(socketPath)) {
      throw error;
    }
  }
  if (socketPath.startsWith("tcp://")) {
    throw new Error(`Cannot auto-start ADE dev runtime on TCP socket ${socketPath}.`);
  }
  process.stdout.write(`[ade] starting dev runtime at ${socketPath}\n`);
  const child = spawn(process.execPath, [cliPath(), "serve", "--socket", socketPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ADE_CLI_VERSION: resolveDevAppVersion(),
      ADE_DEV_RUNTIME_SOCKET_PATH: socketPath,
      ADE_RUNTIME_SOCKET_PATH: socketPath,
      ADE_RPC_SOCKET_PATH: socketPath,
      ...runtimeBuildEnv(),
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
    ADE_CLI_VERSION: resolveDevAppVersion(),
    ADE_DEV_RUNTIME_SOCKET_PATH: socketPath,
    ADE_RUNTIME_SOCKET_PATH: socketPath,
    ADE_RPC_SOCKET_PATH: socketPath,
    ...(projectRoot ? { ADE_PROJECT_ROOT: projectRoot } : {}),
    ...runtimeBuildEnv(),
  };
}
