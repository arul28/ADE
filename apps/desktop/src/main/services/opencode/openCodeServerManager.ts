import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Config as OpenCodeConfig } from "@opencode-ai/sdk";
import type { Logger } from "../logging/logger";
import { stableStringify } from "../shared/utils";
import { resolveOpenCodeBinaryPath } from "./openCodeBinaryManager";

export type OpenCodeServerLeaseKind = "shared" | "dedicated";
export type OpenCodeServerOwnerKind = "inventory" | "oneshot" | "chat" | "coordinator";
export type OpenCodeServerShutdownReason =
  | "handle_close"
  | "idle_ttl"
  | "paused_run"
  | "ended_session"
  | "model_switch"
  | "project_close"
  | "budget_eviction"
  | "shutdown"
  | "config_changed"
  | "error";

type OpenCodeServerInstance = {
  url: string;
  close(): void;
};

type OpenCodeServerLaunchArgs = {
  port: number;
  config: OpenCodeConfig;
};

type OpenCodeIsolationPaths = {
  root: string;
  configHome: string;
  dataHome: string;
  stateHome: string;
  cacheHome: string;
  runtimeDir: string;
};

type OpenCodeServeLaunchSpec = {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  useShell: boolean;
  xdgPaths: OpenCodeIsolationPaths;
};

type OpenCodeServerLauncher = (args: OpenCodeServerLaunchArgs) => Promise<OpenCodeServerInstance>;
type ElectronLikeModule = {
  app?: {
    getPath(name: string): string;
  };
};

type OpenCodeServerEntry = {
  id: string;
  key: string;
  leaseKind: OpenCodeServerLeaseKind;
  ownerKind: OpenCodeServerOwnerKind;
  ownerId: string | null;
  configFingerprint: string;
  server: OpenCodeServerInstance;
  idleTtlMs: number | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  refCount: number;
  busy: boolean;
  onEvict: ((reason: OpenCodeServerShutdownReason) => void) | null;
  startedAt: number;
  lastUsedAt: number;
};

export type OpenCodeServerLease = {
  url: string;
  release(reason?: OpenCodeServerShutdownReason): void;
  close(reason?: OpenCodeServerShutdownReason): void;
  touch(): void;
  setBusy(busy: boolean): void;
  setEvictionHandler(handler: ((reason: OpenCodeServerShutdownReason) => void) | null): void;
};

export type OpenCodeRuntimeDiagnosticsEntry = {
  id: string;
  key: string;
  leaseKind: OpenCodeServerLeaseKind;
  ownerKind: OpenCodeServerOwnerKind;
  ownerId: string | null;
  configFingerprint: string;
  url: string;
  busy: boolean;
  refCount: number;
  startedAt: number;
  lastUsedAt: number;
};

const PORT_RETRY_ATTEMPTS = 3;
const DEFAULT_SHARED_IDLE_TTL_MS = 60_000;
const MAX_DEDICATED_OPENCODE_SERVERS = 6;
const OPEN_CODE_SERVER_START_TIMEOUT_MS = 15_000;
const ADE_OPENCODE_XDG_LAYOUT_VERSION = 1;

const sharedEntries = new Map<string, OpenCodeServerEntry>();
const dedicatedEntries = new Map<string, OpenCodeServerEntry>();
const inFlightEntries = new Map<string, Promise<OpenCodeServerEntry>>();
const acquireQueues = new Map<string, Array<() => void>>();
let openCodeServerLauncher: OpenCodeServerLauncher = defaultOpenCodeServerLauncher;

function serializeConfigFingerprint(config: OpenCodeConfig): string {
  return createHash("sha256").update(stableStringify(config)).digest("hex");
}

async function withAcquireLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = acquireQueues.get(lockKey);
  if (queue) {
    queue.push(release);
    await gate;
  } else {
    acquireQueues.set(lockKey, [release]);
    release();
  }

  try {
    return await fn();
  } finally {
    const currentQueue = acquireQueues.get(lockKey);
    if (currentQueue) {
      currentQueue.shift();
      const next = currentQueue[0];
      if (next) {
        next();
      } else {
        acquireQueues.delete(lockKey);
      }
    }
  }
}

async function findAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate an OpenCode port.")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function isPortConflict(error: unknown): boolean {
  if (error && typeof error === "object") {
    if ("code" in error && error.code === "EADDRINUSE") return true;
    if (error instanceof Error) {
      return error.message.includes("EADDRINUSE") || error.message.includes("address already in use");
    }
  }
  return false;
}

function stopChildProcess(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === "win32" && proc.pid) {
    const out = spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
    if (!out.error && out.status === 0) return;
  }
  proc.kill();
}

function resolveAdeManagedOpenCodeRoot(): string {
  const override = process.env.ADE_OPENCODE_XDG_ROOT?.trim();
  if (override) return path.resolve(override);
  try {
    const electron = require("electron") as ElectronLikeModule;
    const userDataPath = electron.app?.getPath?.("userData");
    if (typeof userDataPath === "string" && userDataPath.trim().length > 0) {
      return path.resolve(userDataPath, "opencode-runtime");
    }
  } catch {
    // Ignore when running outside Electron, such as unit tests.
  }
  const homeDir = os.homedir().trim();
  if (homeDir.length > 0) {
    return path.resolve(homeDir, ".ade", "opencode-runtime");
  }
  return path.resolve(os.tmpdir(), "ade-opencode-runtime");
}

function resolveOpenCodeIsolationPaths(): OpenCodeIsolationPaths {
  const root = path.join(
    resolveAdeManagedOpenCodeRoot(),
    `xdg-v${ADE_OPENCODE_XDG_LAYOUT_VERSION}`,
  );
  return {
    root,
    configHome: path.join(root, "config"),
    dataHome: path.join(root, "data"),
    stateHome: path.join(root, "state"),
    cacheHome: path.join(root, "cache"),
    runtimeDir: path.join(root, "runtime"),
  };
}

function ensureOpenCodeIsolationDirs(paths: OpenCodeIsolationPaths): void {
  for (const dir of [
    paths.root,
    paths.configHome,
    paths.dataHome,
    paths.stateHome,
    paths.cacheHome,
    paths.runtimeDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function buildIsolatedOpenCodeEnv(
  config: OpenCodeConfig,
  paths: OpenCodeIsolationPaths,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("OPENCODE_")) continue;
    env[key] = value;
  }
  return {
    ...env,
    XDG_CONFIG_HOME: paths.configHome,
    XDG_DATA_HOME: paths.dataHome,
    XDG_STATE_HOME: paths.stateHome,
    XDG_CACHE_HOME: paths.cacheHome,
    XDG_RUNTIME_DIR: paths.runtimeDir,
    OPENCODE_CONFIG_DIR: path.join(paths.configHome, "opencode"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config ?? {}),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  };
}

function buildOpenCodeServeLaunchSpec(args: OpenCodeServerLaunchArgs): OpenCodeServeLaunchSpec {
  const executable = resolveOpenCodeBinaryPath();
  if (!executable) {
    throw new Error("OpenCode executable is not available.");
  }
  const xdgPaths = resolveOpenCodeIsolationPaths();
  ensureOpenCodeIsolationDirs(xdgPaths);
  return {
    executable,
    args: [
      "serve",
      "--hostname=127.0.0.1",
      `--port=${args.port}`,
    ],
    env: buildIsolatedOpenCodeEnv(args.config, xdgPaths),
    useShell: process.platform === "win32" && /\.(cmd|bat)$/i.test(executable),
    xdgPaths,
  };
}

async function defaultOpenCodeServerLauncher(
  args: OpenCodeServerLaunchArgs,
): Promise<OpenCodeServerInstance> {
  const launchSpec = buildOpenCodeServeLaunchSpec(args);
  const proc = spawn(launchSpec.executable, launchSpec.args, {
    env: launchSpec.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: launchSpec.useShell,
  });

  let output = "";
  let resolved = false;

  return await new Promise<OpenCodeServerInstance>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeoutId);
      proc.stdout?.off("data", onStdout);
      proc.stderr?.off("data", onStderr);
      proc.off("exit", onExit);
      proc.off("error", onError);
    };

    const fail = (error: Error): void => {
      cleanup();
      stopChildProcess(proc);
      reject(error);
    };

    const timeoutId = setTimeout(() => {
      fail(new Error(`Timeout waiting for server to start after ${OPEN_CODE_SERVER_START_TIMEOUT_MS}ms`));
    }, OPEN_CODE_SERVER_START_TIMEOUT_MS);

    const onStdout = (chunk: Buffer): void => {
      if (resolved) return;
      output += chunk.toString();
      const lines = output.split("\n");
      for (const line of lines) {
        if (!line.startsWith("opencode server listening")) continue;
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match) {
          fail(new Error(`Failed to parse server url from output: ${line}`));
          return;
        }
        resolved = true;
        cleanup();
        resolve({
          url: match[1],
          close() {
            cleanup();
            stopChildProcess(proc);
          },
        });
        return;
      }
    };

    const onStderr = (chunk: Buffer): void => {
      output += chunk.toString();
    };

    const onExit = (code: number | null): void => {
      if (resolved) return;
      cleanup();
      let message = `Server exited with code ${code}`;
      if (output.trim()) {
        message += `\nServer output: ${output}`;
      }
      reject(new Error(message));
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", onStderr);
    proc.on("exit", onExit);
    proc.on("error", onError);
  });
}

async function createOpencodeServerWithRetry(
  config: OpenCodeConfig,
): Promise<OpenCodeServerInstance> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PORT_RETRY_ATTEMPTS; attempt += 1) {
    const port = await findAvailablePort();
    try {
      return await openCodeServerLauncher({ port, config });
    } catch (error) {
      lastError = error;
      if (!isPortConflict(error)) throw error;
    }
  }
  throw lastError;
}

function logRuntimeEvent(
  logger: Logger | null | undefined,
  event: string,
  entry: OpenCodeServerEntry,
  extra: Record<string, unknown> = {},
): void {
  logger?.info(event, {
    leaseKind: entry.leaseKind,
    ownerKind: entry.ownerKind,
    ownerId: entry.ownerId,
    configFingerprint: entry.configFingerprint,
    url: entry.server.url,
    ...extra,
  });
}

function clearIdleTimer(entry: OpenCodeServerEntry): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
}

function removeEntry(entry: OpenCodeServerEntry): void {
  clearIdleTimer(entry);
  if (entry.leaseKind === "shared") {
    sharedEntries.delete(entry.key);
    return;
  }
  dedicatedEntries.delete(entry.key);
}

function shutdownEntry(
  entry: OpenCodeServerEntry,
  reason: OpenCodeServerShutdownReason,
  logger?: Logger | null,
): void {
  removeEntry(entry);
  try {
    entry.server.close();
  } catch {
    // ignore shutdown failures
  }
  logRuntimeEvent(logger, "opencode.server_shutdown", entry, { reason });
}

function scheduleSharedIdleTimer(
  entry: OpenCodeServerEntry,
  logger?: Logger | null,
): void {
  clearIdleTimer(entry);
  if (!entry.idleTtlMs || entry.refCount > 0) return;
  entry.idleTimer = setTimeout(() => {
    const current = sharedEntries.get(entry.key);
    if (!current || current.id !== entry.id || current.refCount > 0) return;
    shutdownEntry(current, "idle_ttl", logger);
  }, entry.idleTtlMs);
  if (entry.idleTimer.unref) entry.idleTimer.unref();
}

function buildLease(entry: OpenCodeServerEntry, logger?: Logger | null): OpenCodeServerLease {
  let released = false;
  const touch = (): void => {
    entry.lastUsedAt = Date.now();
  };
  const release = (reason: OpenCodeServerShutdownReason = "handle_close"): void => {
    if (released) return;
    released = true;
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastUsedAt = Date.now();
    logRuntimeEvent(logger, "opencode.server_released", entry, { reason, refCount: entry.refCount });
    if (entry.leaseKind === "shared") {
      if (entry.refCount === 0 && reason === "error") {
        shutdownEntry(entry, reason, logger);
        return;
      }
      scheduleSharedIdleTimer(entry, logger);
      return;
    }
    if (entry.refCount === 0) {
      shutdownEntry(entry, reason, logger);
    }
  };
  touch();
  return {
    url: entry.server.url,
    release,
    close(reason = "handle_close") {
      release(reason);
    },
    touch,
    setBusy(busy: boolean) {
      entry.busy = busy;
      entry.lastUsedAt = Date.now();
    },
    setEvictionHandler(handler) {
      entry.onEvict = handler;
    },
  };
}

function pickDedicatedEvictionCandidate(excludeKey?: string): OpenCodeServerEntry | null {
  let oldest: OpenCodeServerEntry | null = null;
  for (const entry of dedicatedEntries.values()) {
    if (entry.key === excludeKey) continue;
    if (entry.busy || entry.refCount > 0) continue;
    if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) {
      oldest = entry;
    }
  }
  return oldest;
}

function enforceDedicatedBudget(
  logger?: Logger | null,
  excludeKey?: string,
): void {
  if (dedicatedEntries.size < MAX_DEDICATED_OPENCODE_SERVERS) return;
  const candidate = pickDedicatedEvictionCandidate(excludeKey);
  if (!candidate) {
    throw new Error(
      `OpenCode runtime limit reached (${MAX_DEDICATED_OPENCODE_SERVERS} dedicated servers). Close or wait for an idle chat/mission runtime before starting another OpenCode session.`,
    );
  }
  candidate.onEvict?.("budget_eviction");
  const stillPresent = dedicatedEntries.get(candidate.key);
  if (stillPresent) {
    if (stillPresent.refCount > 0 || stillPresent.busy) {
      throw new Error(
        `OpenCode runtime limit reached (${MAX_DEDICATED_OPENCODE_SERVERS} dedicated servers). The selected eviction candidate is still leased and cannot be reclaimed safely.`,
      );
    }
    shutdownEntry(stillPresent, "budget_eviction", logger);
  }
}

async function createEntry(args: {
  key: string;
  leaseKind: OpenCodeServerLeaseKind;
  ownerKind: OpenCodeServerOwnerKind;
  ownerId?: string | null;
  config: OpenCodeConfig;
  configFingerprint: string;
  idleTtlMs?: number | null;
  logger?: Logger | null;
}): Promise<OpenCodeServerEntry> {
  const inflightKey = `${args.leaseKind}:${args.key}:${args.configFingerprint}`;
  const existingPromise = inFlightEntries.get(inflightKey);
  if (existingPromise) return await existingPromise;

  const createPromise = (async () => {
    const server = await createOpencodeServerWithRetry(args.config);
    const entry: OpenCodeServerEntry = {
      id: randomUUID(),
      key: args.key,
      leaseKind: args.leaseKind,
      ownerKind: args.ownerKind,
      ownerId: args.ownerId?.trim() || null,
      configFingerprint: args.configFingerprint,
      server,
      idleTtlMs: args.leaseKind === "shared" ? args.idleTtlMs ?? DEFAULT_SHARED_IDLE_TTL_MS : null,
      idleTimer: null,
      refCount: 0,
      busy: false,
      onEvict: null,
      startedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    logRuntimeEvent(args.logger, "opencode.server_started", entry);
    return entry;
  })().finally(() => {
    inFlightEntries.delete(inflightKey);
  });

  inFlightEntries.set(inflightKey, createPromise);
  return await createPromise;
}

export async function acquireSharedOpenCodeServer(args: {
  config: OpenCodeConfig;
  key?: string;
  ownerKind?: OpenCodeServerOwnerKind;
  ownerId?: string | null;
  idleTtlMs?: number | null;
  logger?: Logger | null;
}): Promise<OpenCodeServerLease> {
  const configFingerprint = serializeConfigFingerprint(args.config);
  const key = args.key?.trim() || configFingerprint;
  return await withAcquireLock(`shared:${key}`, async () => {
    while (true) {
      const existing = sharedEntries.get(key);
      if (existing && existing.configFingerprint === configFingerprint) {
        clearIdleTimer(existing);
        existing.refCount += 1;
        existing.lastUsedAt = Date.now();
        logRuntimeEvent(args.logger, "opencode.server_reused", existing, { refCount: existing.refCount });
        return buildLease(existing, args.logger);
      }
      if (existing && existing.refCount > 0) {
        logRuntimeEvent(args.logger, "opencode.server_config_mismatch_rejected", existing, {
          requestedConfigFingerprint: configFingerprint,
          refCount: existing.refCount,
        });
        throw new Error(
          `Shared OpenCode server for key "${key}" is still in use (refCount=${existing.refCount}) with a different config. Cannot acquire a lease with the requested configuration.`
        );
      }
      if (existing) {
        shutdownEntry(existing, "config_changed", args.logger);
      }
      const entry = await createEntry({
        key,
        leaseKind: "shared",
        ownerKind: args.ownerKind ?? "oneshot",
        ownerId: args.ownerId,
        config: args.config,
        configFingerprint,
        idleTtlMs: args.idleTtlMs,
        logger: args.logger,
      });
      if (entry.configFingerprint !== configFingerprint) {
        shutdownEntry(entry, "config_changed", args.logger);
        continue;
      }
      entry.refCount = 1;
      sharedEntries.set(key, entry);
      return buildLease(entry, args.logger);
    }
  });
}

export async function acquireDedicatedOpenCodeServer(args: {
  ownerKey: string;
  config: OpenCodeConfig;
  ownerKind: OpenCodeServerOwnerKind;
  ownerId?: string | null;
  logger?: Logger | null;
}): Promise<OpenCodeServerLease> {
  const ownerKey = args.ownerKey.trim();
  if (!ownerKey.length) {
    throw new Error("ownerKey is required for dedicated OpenCode servers.");
  }
  const configFingerprint = serializeConfigFingerprint(args.config);
  return await withAcquireLock(`dedicated:${ownerKey}`, async () => {
    while (true) {
      const existing = dedicatedEntries.get(ownerKey);
      if (existing && existing.configFingerprint === configFingerprint) {
        existing.refCount += 1;
        existing.lastUsedAt = Date.now();
        logRuntimeEvent(args.logger, "opencode.server_reused", existing, { refCount: existing.refCount });
        return buildLease(existing, args.logger);
      }
      if (existing && existing.refCount > 0) {
        logRuntimeEvent(args.logger, "opencode.server_config_mismatch_rejected", existing, {
          requestedConfigFingerprint: configFingerprint,
          refCount: existing.refCount,
        });
        throw new Error(
          `Dedicated OpenCode server for "${ownerKey}" is still in use (refCount=${existing.refCount}) with a different config. Cannot acquire a lease with the requested configuration.`
        );
      }
      if (existing) {
        shutdownEntry(existing, "config_changed", args.logger);
      }
      enforceDedicatedBudget(args.logger, ownerKey);
      const entry = await createEntry({
        key: ownerKey,
        leaseKind: "dedicated",
        ownerKind: args.ownerKind,
        ownerId: args.ownerId,
        config: args.config,
        configFingerprint,
        logger: args.logger,
      });
      if (entry.configFingerprint !== configFingerprint) {
        shutdownEntry(entry, "config_changed", args.logger);
        continue;
      }
      entry.refCount = 1;
      dedicatedEntries.set(ownerKey, entry);
      return buildLease(entry, args.logger);
    }
  });
}

export function shutdownOpenCodeServers(filter: {
  leaseKind?: OpenCodeServerLeaseKind;
  ownerKind?: OpenCodeServerOwnerKind;
  ownerId?: string | null;
} = {}): void {
  const matches = (entry: OpenCodeServerEntry): boolean => {
    if (filter.leaseKind && entry.leaseKind !== filter.leaseKind) return false;
    if (filter.ownerKind && entry.ownerKind !== filter.ownerKind) return false;
    if (filter.ownerId !== undefined && entry.ownerId !== (filter.ownerId?.trim() || null)) return false;
    return true;
  };
  for (const entry of [...sharedEntries.values(), ...dedicatedEntries.values()]) {
    if (!matches(entry)) continue;
    shutdownEntry(entry, "shutdown");
  }
}

export function getOpenCodeRuntimeDiagnostics(): {
  sharedCount: number;
  dedicatedCount: number;
  entries: OpenCodeRuntimeDiagnosticsEntry[];
} {
  const entries = [...sharedEntries.values(), ...dedicatedEntries.values()].map((entry) => ({
    id: entry.id,
    key: entry.key,
    leaseKind: entry.leaseKind,
    ownerKind: entry.ownerKind,
    ownerId: entry.ownerId,
    configFingerprint: entry.configFingerprint,
    url: entry.server.url,
    busy: entry.busy,
    refCount: entry.refCount,
    startedAt: entry.startedAt,
    lastUsedAt: entry.lastUsedAt,
  }));
  return {
    sharedCount: sharedEntries.size,
    dedicatedCount: dedicatedEntries.size,
    entries,
  };
}

export function __resetOpenCodeServerManagerForTests(): void {
  shutdownOpenCodeServers();
  inFlightEntries.clear();
  acquireQueues.clear();
  openCodeServerLauncher = defaultOpenCodeServerLauncher;
}

export function __setOpenCodeServerLauncherForTests(
  launcher: OpenCodeServerLauncher | null,
): void {
  openCodeServerLauncher = launcher ?? defaultOpenCodeServerLauncher;
}

export function __buildOpenCodeServeLaunchSpecForTests(args: {
  config: OpenCodeConfig;
  port?: number;
}): OpenCodeServeLaunchSpec {
  return buildOpenCodeServeLaunchSpec({
    port: args.port ?? 4096,
    config: args.config,
  });
}
