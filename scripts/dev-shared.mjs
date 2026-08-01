import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sharedPath = fileURLToPath(import.meta.url);

export const repoRoot = path.resolve(path.dirname(sharedPath), "..");

export function resolveDefaultDevSocketPath(
  platform = process.platform,
  env = process.env,
) {
  if (platform !== "win32") return "/tmp/ade-runtime-dev.sock";
  const userIdentity = [
    env.USERDOMAIN?.trim(),
    env.USERNAME?.trim() || os.userInfo().username.trim(),
  ].filter(Boolean).join("\\").toLowerCase();
  const userHash = createHash("sha256")
    .update(userIdentity || "unknown-user")
    .digest("hex")
    .slice(0, 12);
  return `\\\\.\\pipe\\ade-runtime-dev-${userHash}`;
}

export const defaultDevSocketPath = resolveDefaultDevSocketPath();
const validDefaultRoles = new Set(["cto", "orchestrator", "agent", "external", "evaluator"]);

export function resolveDevRuntimeStartupTimeoutMs(
  platform = process.platform,
) {
  // A freshly rebuilt CLI can spend more than ten seconds in Windows Defender
  // inspection before Node reaches server.listen(). Do not kill a healthy
  // runtime during that first-start window.
  return platform === "win32" ? 30_000 : 10_000;
}

function normalizeDefaultRole(value, fallback = null) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return validDefaultRoles.has(candidate) ? candidate : fallback;
}

export function resolveDevSocketPath(rawSocketPath = null) {
  const candidate = rawSocketPath?.trim()
    || process.env.ADE_DEV_RUNTIME_SOCKET_PATH?.trim()
    || defaultDevSocketPath;
  const isWindowsNamedPipe = /^\\\\[.?]\\pipe\\/i.test(candidate);
  return candidate.startsWith("tcp://") || isWindowsNamedPipe
    ? candidate
    : path.resolve(candidate);
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

function newestMtimeMs(rootPath) {
  let newest = 0;
  const stack = [rootPath];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    let stat;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const name = path.basename(current);
      if (name === "node_modules" || name === "dist" || name === ".git") continue;
      for (const child of fs.readdirSync(current)) {
        stack.push(path.join(current, child));
      }
      continue;
    }
    if (stat.isFile()) newest = Math.max(newest, stat.mtimeMs);
  }
  return newest;
}

function oldestMtimeMs(paths) {
  let oldest = Number.POSITIVE_INFINITY;
  for (const candidate of paths) {
    try {
      oldest = Math.min(oldest, fs.statSync(candidate).mtimeMs);
    } catch {
      return 0;
    }
  }
  return Number.isFinite(oldest) ? oldest : 0;
}

export function isRuntimeCliBuildFresh() {
  const packageRoot = path.join(repoRoot, "apps", "ade-cli");
  const desktopRoot = path.join(repoRoot, "apps", "desktop");
  const distMtime = oldestMtimeMs([
    cliPath(),
    path.join(packageRoot, "dist", "bootstrap.cjs"),
    path.join(packageRoot, "dist", "adeRpcServer.cjs"),
    path.join(packageRoot, "dist", "tuiClient", "cli.mjs"),
  ]);
  if (distMtime <= 0) return false;
  const sourceMtime = Math.max(
    newestMtimeMs(path.join(packageRoot, "src")),
    newestMtimeMs(path.join(packageRoot, "scripts")),
    newestMtimeMs(path.join(desktopRoot, "src", "main")),
    newestMtimeMs(path.join(desktopRoot, "src", "shared")),
    ...[
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "tsup.config.ts",
    ].map((file) => newestMtimeMs(path.join(packageRoot, file))),
    ...[
      "package.json",
      "package-lock.json",
      "tsconfig.json",
    ].map((file) => newestMtimeMs(path.join(desktopRoot, file))),
  );
  return distMtime >= sourceMtime;
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

function quoteWindowsCmdArg(value) {
  let quoted = "\"";
  let backslashes = 0;
  for (const char of String(value).replace(/%/g, "%%")) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === "\"") {
      quoted += "\\".repeat(backslashes * 2);
      quoted += "\"\"";
    } else {
      quoted += "\\".repeat(backslashes);
      quoted += char;
    }
    backslashes = 0;
  }
  quoted += "\\".repeat(backslashes * 2);
  quoted += "\"";
  return quoted;
}

export function resolveDevSpawnInvocation(
  command,
  args,
  env = process.env,
  platform = process.platform,
) {
  const extension = platform === "win32"
    ? path.win32.extname(command).toLowerCase()
    : "";
  if (platform !== "win32" || (extension !== ".cmd" && extension !== ".bat")) {
    return { command, args, windowsVerbatimArguments: false };
  }
  return {
    command: env.ComSpec?.trim() || "cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      `"${[command, ...args].map(quoteWindowsCmdArg).join(" ")}"`,
    ],
    windowsVerbatimArguments: true,
  };
}

export function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };
    const invocation = resolveDevSpawnInvocation(command, args, env);
    const child = spawn(invocation.command, invocation.args, {
      cwd: repoRoot,
      env,
      stdio: "inherit",
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
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

export function resolveNpmInvocation(
  args,
  options = {},
) {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const pathExists = options.pathExists ?? fs.existsSync;
  if (platform !== "win32") {
    return { command: "npm", args };
  }

  const candidates = [
    env.npm_execpath?.trim(),
    path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(execPath), "node_modules", "corepack", "dist", "npm.js"),
  ].filter(Boolean);
  const npmCliPath = candidates.find((candidate) => pathExists(candidate));
  if (!npmCliPath) {
    throw new Error(
      `Unable to resolve npm's JavaScript entry point beside ${execPath}. Reinstall Node.js/npm or set npm_execpath.`,
    );
  }
  return {
    command: execPath,
    args: [npmCliPath, ...args],
  };
}

export function runNpm(args, extraEnv = {}) {
  const invocation = resolveNpmInvocation(args, {
    env: { ...process.env, ...extraEnv },
  });
  return run(invocation.command, invocation.args, extraEnv);
}

export async function buildRuntimeCli(skipRuntimeBuild = false) {
  if (skipRuntimeBuild) return;
  process.stdout.write("[ade] building runtime CLI\n");
  await runNpm(["--prefix", "apps/ade-cli", "run", "build"], {
    ADE_CLI_VERSION: resolveDevAppVersion(),
  });
}

export async function buildRuntimeCliForDevClient(skipRuntimeBuild, socketPath) {
  if (skipRuntimeBuild) return;
  if (isRuntimeCliBuildFresh() && await canConnectToSocket(socketPath)) {
    process.stdout.write("[ade] dev runtime is already listening and CLI build is fresh; skipping runtime CLI rebuild\n");
    return;
  }
  await buildRuntimeCli(false);
}

export async function assertRuntimeFresh(socketPath, projectRoot = null) {
  const info = await getRuntimeInfo(socketPath);
  const mismatch = runtimeMismatchReason(info, { projectRoot });
  if (!mismatch) return;
  throw new Error(
    `The dev runtime at ${socketPath} is stale (${mismatch}). Restart it with npm run dev:runtime or use auto mode so ADE can restart it.`,
  );
}

function createSocket(socketPath) {
  if (socketPath.startsWith("tcp://")) {
    const parsed = new URL(socketPath);
    return net.createConnection({ host: parsed.hostname, port: Number(parsed.port) });
  }
  return net.createConnection(socketPath);
}

function isTcpSocketPath(socketPath) {
  return socketPath.startsWith("tcp://");
}

function canAutoStartRuntime(socketPath) {
  if (!isTcpSocketPath(socketPath)) return true;
  try {
    const parsed = new URL(socketPath);
    const host = parsed.hostname.toLowerCase();
    return host === "localhost"
      || host === "127.0.0.1"
      || host === "::1"
      || host === "[::1]"
      || host === "0.0.0.0";
  } catch {
    return false;
  }
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
  const defaultRole = typeof runtimeInfo.defaultRole === "string" && runtimeInfo.defaultRole.trim()
    ? runtimeInfo.defaultRole.trim()
    : null;
  const projectRoot = typeof runtimeInfo.projectRoot === "string" && runtimeInfo.projectRoot.trim()
    ? path.resolve(runtimeInfo.projectRoot.trim())
    : null;
  return { version, buildHash, defaultRole, projectRoot };
}

export function jsonRpcRequestSequence(socketPath, requests, options = {}) {
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

export function jsonRpcRequest(socketPath, method, params, options = {}) {
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

function runtimeMismatchReason(info, expected = {}) {
  const expectedVersion = resolveDevAppVersion();
  const expectedBuildHash = computeRuntimeBuildHash();
  const expectedDefaultRole = normalizeDefaultRole(process.env.ADE_DEFAULT_ROLE, "cto");
  const expectedProjectRoot = expected.projectRoot ? path.resolve(expected.projectRoot) : null;
  if (info.version && info.version !== expectedVersion) {
    return `version ${info.version} != ${expectedVersion}`;
  }
  if (expectedBuildHash && info.buildHash !== expectedBuildHash) {
    return info.buildHash
      ? "build hash changed"
      : "build hash missing";
  }
  if (info.defaultRole !== expectedDefaultRole) {
    return `default role ${info.defaultRole ?? "missing"} != ${expectedDefaultRole}`;
  }
  if (expectedProjectRoot && info.projectRoot !== expectedProjectRoot) {
    return `project root ${info.projectRoot ?? "missing"} != ${expectedProjectRoot}`;
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

export async function shutdownRuntime(socketPath) {
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

export async function ensureRuntime(socketPath, projectRoot = null) {
  try {
    const info = await getRuntimeInfo(socketPath);
    const mismatch = runtimeMismatchReason(info, { projectRoot });
    if (!mismatch) return false;
    if (!canAutoStartRuntime(socketPath)) {
      throw new Error(`ADE dev runtime at ${socketPath} is stale (${mismatch}), and only local TCP or Unix-socket runtimes can be auto-started.`);
    }
    process.stdout.write(`[ade] restarting stale dev runtime at ${socketPath} (${mismatch})\n`);
    await shutdownRuntime(socketPath);
  } catch (error) {
    if (await canConnectToSocket(socketPath)) {
      throw error;
    }
  }
  if (!canAutoStartRuntime(socketPath)) {
    throw new Error(`Cannot auto-start ADE dev runtime on remote TCP socket ${socketPath}. Start it with npm run dev:runtime, or use a local TCP/Unix socket for auto mode.`);
  }
  process.stdout.write(`[ade] starting dev runtime at ${socketPath}\n`);
  const child = spawn(process.execPath, [cliPath(), "serve", "--socket", socketPath], {
    cwd: repoRoot,
    env: detachedDevRuntimeEnv(socketPath, projectRoot),
    detached: true,
    stdio: "ignore",
    windowsHide: process.platform === "win32",
  });
  const runtimeExitedBeforeReady = new Promise((_, reject) => {
    child.once("error", (error) => {
      reject(new Error(
        `ADE dev runtime failed to start at ${socketPath}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    });
    child.once("exit", (code, signal) => {
      reject(new Error(
        `ADE dev runtime exited before opening ${socketPath} (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
      ));
    });
  });
  child.unref();
  try {
    await Promise.race([
      waitForSocket(socketPath, resolveDevRuntimeStartupTimeoutMs()),
      runtimeExitedBeforeReady,
    ]);
  } catch (error) {
    // The child is detached and unref'd, so a launcher that gives up here used
    // to walk away and leave an immortal brain behind — one per failed dev
    // start, each still signed in and still dialing the relay. Reap what we
    // spawned before surfacing the failure.
    await terminateSpawnedRuntime(child);
    throw error;
  }
  return true;
}

async function terminateSpawnedRuntime(child) {
  const pid = child?.pid;
  if (!pid) return;
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  };
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!alive()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

export function devRuntimeEnv(socketPath, projectRoot) {
  return {
    ADE_CLI_VERSION: resolveDevAppVersion(),
    ADE_DEFAULT_ROLE: normalizeDefaultRole(process.env.ADE_DEFAULT_ROLE, "cto"),
    ADE_DEV_RUNTIME_SOCKET_PATH: socketPath,
    ADE_RUNTIME_SOCKET_PATH: socketPath,
    ADE_RPC_SOCKET_PATH: socketPath,
    ...(projectRoot ? { ADE_PROJECT_ROOT: projectRoot } : {}),
    ...runtimeBuildEnv(),
  };
}

export function detachedDevRuntimeEnv(
  socketPath,
  projectRoot,
  parentEnv = process.env,
) {
  const env = {
    ...parentEnv,
    ...devRuntimeEnv(socketPath, projectRoot),
  };
  // A shared dev runtime outlives the terminal or Electron process that
  // launched it. ADE-hosted shells can carry these lifecycle controls from a
  // different runtime; inheriting them makes this detached server disappear
  // as soon as that unrelated parent exits or its idle timer fires.
  delete env.ADE_RUNTIME_PARENT_PID;
  delete env.ADE_RUNTIME_IDLE_EXIT_MS;
  return env;
}
