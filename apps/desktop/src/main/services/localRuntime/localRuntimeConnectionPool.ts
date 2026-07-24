import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { isAdeRuntimeNamedPipePath } from "../../../shared/adeRuntimeIpc";
import {
  isRuntimeProtocolCompatible,
  parseRuntimeLastWedge,
  parseRuntimePublishHealth,
} from "../../../shared/adeRuntimeProtocol";
import type {
  RemoteRuntimeActionRequest,
  RemoteRuntimeActionResult,
  RemoteRuntimeBufferedEvent,
  RemoteRuntimeEventCategory,
  RemoteRuntimeProjectRecord,
  RemoteRuntimeStreamEventsRequest,
  RemoteRuntimeStreamEventsResult,
} from "../../../shared/types/remoteRuntime";
import type {
  AdeActionRegistryEntry,
  LocalRuntimeStatus,
  RuntimeActivitySummary,
  SyncCloudRelayStatus,
  SyncDeviceRecord,
  SyncDeviceRuntimeState,
  SyncGetStatusArgs,
  SyncPeerDeviceType,
  SyncRoleSnapshot,
} from "../../../shared/types";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import {
  SYSTEM_PROJECT_REGISTRATION,
  type ProjectRegistrationIntent,
  type ProjectRegistrationSource,
} from "../../../../../ade-cli/src/services/projects/projectRegistry";
import { RuntimeRpcClient, type RuntimeRpcTransport } from "../remoteRuntime/runtimeRpcClient";
import { coerceProjects } from "../remoteRuntime/remoteBootstrap";
import type { Logger } from "../logging/logger";
import { getRuntimeServiceStatus, type ServiceManagerStatusResult } from "../../../../../ade-cli/src/serviceManager";
import { buildPackagedRuntimeNodePath, type PackagedRuntimeNodePathOptions } from "../runtime/packagedNodePath";
import { readLastFailure } from "../runtime/lastFailureStore";
import type { AdeRecoveryErrorCode } from "../../../shared/types/recovery";
import { LOCAL_RELEASE_BUILD_OUTPUT_RUNTIME_MESSAGE } from "../../../shared/runtimeErrors";
import type { RuntimeHealthSnapshot } from "../../../shared/types/storage";
import {
  LOCAL_RUNTIME_ACTION_REGISTRY_TIMEOUT_MS,
  LOCAL_RUNTIME_EVENT_POLL_TIMEOUT_MS,
  LOCAL_RUNTIME_PROJECT_TIMEOUT_MS,
  LOCAL_RUNTIME_SYNC_TIMEOUT_MS,
  localRuntimeActionTimeoutMs,
} from "./localRuntimeTimeoutPolicy";

const SLOW_ACTION_THRESHOLD_MS = 500;
const RUNTIME_HEALTH_WINDOW_MS = 24 * 60 * 60_000;
// Ring-cap the in-memory slow-action window so a sustained slow-call storm can
// never grow this array without bound (the very failure mode we are surfacing).
const RUNTIME_HEALTH_MAX_SAMPLES = 5_000;

type LocalRuntimeConnection = {
  client: RuntimeRpcClient;
  child: ChildProcess | null;
  socketPath: string;
};

type SlowActionSample = { at: number; totalMs: number };

type RuntimeEventNotification = {
  subscriptionId: string;
  projectId: string;
  event: RemoteRuntimeBufferedEvent;
  eventEpoch: string | null;
};

type RuntimeServiceManagerOutput = {
  ok: boolean | null;
  path: string | null;
  message: string | null;
};

type LocalRuntimeConnectionPoolOptions = {
  disableSync?: boolean;
  preferServiceRepair?: boolean;
  desktopBridgeAuthToken?: string | null;
  queryServiceStatus?: () => ServiceManagerStatusResult;
  onRuntimeStatusChange?: (status: LocalRuntimeStatus) => void;
  /**
   * Invoked when the pool enters or leaves isolated (no-sync fallback) mode.
   * "isolated" fires once per degradation, "primary" once per recovery.
   */
  onRuntimeModeChange?: (mode: "primary" | "isolated") => void;
};

type LocalRuntimeNodePathOptions = PackagedRuntimeNodePathOptions;

const LOCAL_RUNTIME_SERVICE_UNINSTALL_TIMEOUT_MS = 20_000;
const LOCAL_RUNTIME_STATUS_REFRESH_TIMEOUT_MS = 2_000;
const PLACEHOLDER_RUNTIME_VERSION = "0.0.0";
const LOCAL_RUNTIME_OUTPUT_LINE_MAX_CHARS = 4_000;
const LOCAL_RUNTIME_OUTPUT_BUFFER_MAX_CHARS = 16_000;
const COALESCED_LOCAL_RUNTIME_ACTIONS = new Set([
  "chat.listSessions",
  // Exact duplicate destructive requests share one in-flight result. This is
  // not a retry: mutations still have maxAttempts=1, and different arguments
  // or sequential invocations remain independent.
  "lane.archive",
  "lane.delete",
  "lane.unarchive",
  "layout.get",
  "project_config.get",
  "pty.resize",
  "session.list",
  "tiling_tree.get",
]);

function normalizeComparableSocketPath(socketPath: string): string {
  return socketPath.startsWith("tcp://") || isAdeRuntimeNamedPipePath(socketPath)
    ? socketPath
    : path.resolve(socketPath);
}

function defaultChannelRuntimeSocketPaths(): Set<string> {
  return new Set([".ade", ".ade-alpha", ".ade-beta"].map((homeName) =>
    path.join(os.homedir(), homeName, "sock", "ade.sock")
  ).map(normalizeComparableSocketPath));
}

function isPrimaryMachineRuntimeSocketPath(
  socketPath: string,
  layoutSocketPath: string,
): boolean {
  const normalizedSocketPath = normalizeComparableSocketPath(socketPath);
  if (normalizedSocketPath === normalizeComparableSocketPath(layoutSocketPath)) {
    return true;
  }
  return defaultChannelRuntimeSocketPaths().has(normalizedSocketPath);
}

function primaryRuntimeSpawnBlockedMessage(socketPath: string): string {
  return (
    `ADE runtime is unavailable at ${socketPath}; refusing to spawn an app-owned brain ` +
    "on a primary channel socket. Start or repair the ADE background service instead."
  );
}

function codedRecoveryError(message: string, code: AdeRecoveryErrorCode): Error & { code: AdeRecoveryErrorCode } {
  return Object.assign(new Error(message), { code });
}

function probeSocketHasOwner(socketPath: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (owned: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(owned);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function stableActionValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stableActionValue);
  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((next, key) => {
      const item = record[key];
      if (item !== undefined) next[key] = stableActionValue(item);
      return next;
    }, {});
}

function coalescedLocalRuntimeActionKey(
  rootPath: string,
  request: RemoteRuntimeActionRequest,
): string | null {
  const actionKey = `${request.domain}.${request.action}`;
  if (!COALESCED_LOCAL_RUNTIME_ACTIONS.has(actionKey)) return null;
  return JSON.stringify({
    rootPath: path.resolve(rootPath),
    domain: request.domain,
    action: request.action,
    arg: stableActionValue(request.arg),
    args: stableActionValue(request.args),
    argsList: stableActionValue(request.argsList),
  });
}

function isSameProjectRegistrationIntent(
  left: ProjectRegistrationIntent,
  right: ProjectRegistrationIntent,
): boolean {
  return left.catalogVisibility === right.catalogVisibility
    && left.registrationSource === right.registrationSource;
}

function cachedProjectSatisfiesRegistration(
  project: RemoteRuntimeProjectRecord,
  registration: ProjectRegistrationIntent,
): boolean {
  // The default runtime-auto registration is only an internal lookup: callers
  // need a projectId so they can route an action. Any cached registration for
  // the same normalized root already satisfies that requirement. In
  // particular, do not overwrite a foreground recent/desktop registration
  // with system/runtime-auto on every action — that metadata ping-pong forced a
  // fresh projects.add in front of PTY writes after project switches.
  if (
    isSameProjectRegistrationIntent(registration, SYSTEM_PROJECT_REGISTRATION)
  ) {
    return true;
  }

  return project.catalogVisibility === registration.catalogVisibility
    && project.registrationSource === registration.registrationSource;
}

export function buildLocalRuntimeServeArgs(
  cliPath: string,
  socketPath: string,
  options: { disableSync?: boolean } = {},
): string[] {
  const args = [cliPath, "serve", "--socket", socketPath];
  if (options.disableSync) args.push("--no-sync");
  return args;
}

export function buildLocalRuntimeNodePath(options: LocalRuntimeNodePathOptions = {}): string | undefined {
  return buildPackagedRuntimeNodePath({
    ...options,
    resourcesPath: options.resourcesPath ?? process.resourcesPath,
  });
}

export function buildLocalRuntimeNodeEnv(
  appVersion: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  nodePathOptions: Omit<LocalRuntimeNodePathOptions, "existingNodePath"> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ADE_DEFAULT_ROLE: "cto",
    ELECTRON_RUN_AS_NODE: "1",
    ADE_CLI_VERSION: appVersion,
  };
  const nodePath = buildLocalRuntimeNodePath({ ...nodePathOptions, existingNodePath: baseEnv.NODE_PATH });
  if (nodePath) env.NODE_PATH = nodePath;
  return env;
}

type RuntimeOutputStreamName = "stdout" | "stderr";

export function createLocalRuntimeOutputLogger(args: {
  logger: Logger;
  socketPath: string;
  pid: number | null;
  stream: RuntimeOutputStreamName;
}): { push: (chunk: Buffer | string) => void; flush: () => void } {
  let pending = "";
  const event = args.stream === "stderr" ? "local_runtime.stderr" : "local_runtime.stdout";
  const log = args.stream === "stderr" ? args.logger.warn.bind(args.logger) : args.logger.info.bind(args.logger);

  const emitLine = (rawLine: string, partial: boolean) => {
    if (!rawLine) return;
    const truncated = rawLine.length > LOCAL_RUNTIME_OUTPUT_LINE_MAX_CHARS;
    log(event, {
      socketPath: args.socketPath,
      pid: args.pid,
      line: truncated ? rawLine.slice(0, LOCAL_RUNTIME_OUTPUT_LINE_MAX_CHARS) : rawLine,
      ...(truncated ? { truncated: true, originalChars: rawLine.length } : {}),
      ...(partial ? { partial: true } : {}),
    });
  };

  const flushCompleteLines = () => {
    while (true) {
      const newlineIndex = pending.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = pending.slice(0, newlineIndex);
      pending = pending.slice(newlineIndex + 1);
      emitLine(line, false);
    }
    if (pending.length > LOCAL_RUNTIME_OUTPUT_BUFFER_MAX_CHARS) {
      emitLine(pending, true);
      pending = "";
    }
  };

  return {
    push(chunk) {
      pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      pending = pending.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      flushCompleteLines();
    },
    flush() {
      emitLine(pending, true);
      pending = "";
    },
  };
}

function resolveCliScriptPath(): string {
  const override = process.env.ADE_CLI_JS?.trim();
  if (override) return path.resolve(override);

  const candidates = [
    path.join(process.resourcesPath ?? "", "ade-cli", "cli.cjs"),
    path.join(app.getAppPath(), "..", "ade-cli", "dist", "cli.cjs"),
    path.resolve(process.cwd(), "..", "ade-cli", "dist", "cli.cjs"),
  ];
  return candidates.find((candidate) => {
    try {
      return Boolean(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) ?? path.resolve(process.cwd(), "..", "ade-cli", "dist", "cli.cjs");
}

export function isLocalChannelBuildOutputPath(targetPath: string): boolean {
  const normalized = path.resolve(targetPath);
  const parts = normalized.split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length - 2; index += 1) {
    if (
      parts[index] === "apps" &&
      parts[index + 1] === "desktop" &&
      /^release-[^/\\]+$/.test(parts[index + 2] ?? "")
    ) {
      return true;
    }
  }
  return false;
}

export function shouldAutoInstallRuntimeServiceFromPath(targetPath: string): boolean {
  if (process.env.ADE_ALLOW_LOCAL_RELEASE_SERVICE_INSTALL === "1") return true;
  return !isLocalChannelBuildOutputPath(targetPath);
}

export function localReleaseBuildOutputRuntimeBlock(targetPath: string): { cliPath: string; message: string } | null {
  const cliPath = path.resolve(targetPath);
  if (shouldAutoInstallRuntimeServiceFromPath(cliPath)) return null;
  return {
    cliPath,
    message: LOCAL_RELEASE_BUILD_OUTPUT_RUNTIME_MESSAGE,
  };
}

function openSocketTransport(socketPath: string, timeoutMs = 3_000): Promise<RuntimeRpcTransport> {
  return new Promise((resolve, reject) => {
    const socket = isAdeRuntimeNamedPipePath(socketPath)
      ? net.createConnection(socketPath)
      : net.createConnection({ path: socketPath });
    let settled = false;
    let connected = false;
    let closed = false;
    let lastError: Error | null = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`Timed out connecting to ADE service socket: ${socketPath}`));
    }, timeoutMs);
    const closeCallbacks = new Set<() => void>();
    const errorCallbacks = new Set<(error: Error) => void>();
    const fail = (error: Error) => {
      if (!connected) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
        return;
      }
      lastError = error;
      for (const callback of [...errorCallbacks]) {
        try {
          callback(error);
        } catch {
          // Disconnect observers must not turn a socket reset into a process crash.
        }
      }
    };
    socket.on("error", fail);
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      connected = true;
      clearTimeout(timer);
      socket.on("close", () => {
        closed = true;
        for (const callback of [...closeCallbacks]) {
          try {
            callback();
          } catch {
            // Disconnect observers must not turn a socket close into a process crash.
          }
        }
      });
      resolve({
        onData(callback) {
          socket.on("data", (chunk) => {
            try {
              callback(Buffer.from(chunk));
            } catch {
              socket.destroy();
            }
          });
        },
        onClose(callback) {
          closeCallbacks.add(callback);
          if (closed) queueMicrotask(callback);
        },
        onError(callback) {
          errorCallbacks.add(callback);
          const error = lastError;
          if (error) queueMicrotask(() => callback(error));
        },
        write(data) {
          socket.write(data);
        },
        close() {
          socket.end();
        },
      });
    });
  });
}

export function readLocalRuntimeInfo(value: unknown): {
  version: string | null;
  buildHash: string | null;
  defaultRole: string | null;
  pid: number | null;
  syncPort: number | null;
  publishHealth: LocalRuntimeStatus["publishHealth"];
  lastWedge: LocalRuntimeStatus["lastWedge"];
  minCompatibleProtocol: number | null;
  protocolVersion: number | null;
} {
  const empty = {
    version: null,
    buildHash: null,
    defaultRole: null,
    pid: null,
    syncPort: null,
    publishHealth: null,
    lastWedge: null,
    minCompatibleProtocol: null,
    protocolVersion: null,
  } satisfies ReturnType<typeof readLocalRuntimeInfo>;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return empty;
  }
  const runtimeInfo = (value as { runtimeInfo?: unknown }).runtimeInfo;
  if (!runtimeInfo || typeof runtimeInfo !== "object" || Array.isArray(runtimeInfo)) {
    return empty;
  }
  const info = runtimeInfo as Record<string, unknown>;
  const version = info.version;
  const buildHash = info.buildHash;
  const defaultRole = info.defaultRole;
  const pid = info.pid;
  const syncPort = info.syncPort;
  const parsedPublishHealth = parseRuntimePublishHealth(info.publishHealth);
  const minCompatibleProtocol = info.minCompatibleProtocol;
  const protocolVersion = info.protocolVersion;
  return {
    version: typeof version === "string" && version.trim() ? version.trim() : null,
    buildHash: typeof buildHash === "string" && buildHash.trim() ? buildHash.trim() : null,
    defaultRole: typeof defaultRole === "string" && defaultRole.trim() ? defaultRole.trim() : null,
    pid: typeof pid === "number" && Number.isFinite(pid) && pid > 0 ? Math.floor(pid) : null,
    syncPort:
      typeof syncPort === "number"
      && Number.isInteger(syncPort)
      && syncPort > 0
      && syncPort <= 65_535
        ? syncPort
        : null,
    publishHealth:
      parsedPublishHealth
        ? {
            state: parsedPublishHealth.state,
            failingSinceMs: parsedPublishHealth.failingSinceMs,
            lastLegDurations: parsedPublishHealth.lastLegDurations,
          }
        : null,
    lastWedge: parseRuntimeLastWedge(info.lastWedge),
    minCompatibleProtocol:
      typeof minCompatibleProtocol === "number"
      && Number.isInteger(minCompatibleProtocol)
      && minCompatibleProtocol > 0
        ? minCompatibleProtocol
        : null,
    protocolVersion:
      typeof protocolVersion === "number"
      && Number.isInteger(protocolVersion)
      && protocolVersion > 0
        ? protocolVersion
        : null,
  };
}

export function computeLocalRuntimeBuildHash(cliPath = resolveCliScriptPath()): string | null {
  try {
    const content = fs.readFileSync(cliPath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

function isCompatibleRuntimeVersion(args: {
  runtimeVersion: string | null;
  appVersion: string;
  runtimeBuildHash: string | null;
  expectedBuildHash: string | null;
}): boolean {
  if (!args.runtimeVersion) return true;
  if (args.runtimeVersion === args.appVersion) return true;
  return (
    args.runtimeVersion === PLACEHOLDER_RUNTIME_VERSION &&
    args.expectedBuildHash != null &&
    args.runtimeBuildHash === args.expectedBuildHash
  );
}

export function compareRuntimeVersionStrings(left: string | null, right: string | null): number | null {
  if (!left?.trim() || !right?.trim()) return null;
  const parse = (value: string): { core: number[]; prerelease: string[] } | null => {
    const withoutBuild = value.trim().replace(/^v/i, "").split("+")[0] ?? "";
    const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/.exec(withoutBuild);
    if (!match) return null;
    return {
      core: match[1].split(".").map((part) => Number.parseInt(part, 10)),
      prerelease: match[2] ? match[2].split(".") : [],
    };
  };
  const comparePrereleaseIdentifier = (a: string, b: string): number => {
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) - Number(b);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a.localeCompare(b);
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) return null;
  const length = Math.max(leftParts.core.length, rightParts.core.length, 3);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts.core[index] ?? 0;
    const b = rightParts.core[index] ?? 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  if (leftParts.prerelease.length === 0 && rightParts.prerelease.length > 0) return 1;
  if (leftParts.prerelease.length > 0 && rightParts.prerelease.length === 0) return -1;
  const prereleaseLength = Math.max(leftParts.prerelease.length, rightParts.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const a = leftParts.prerelease[index];
    const b = rightParts.prerelease[index];
    if (a == null && b == null) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    const comparison = comparePrereleaseIdentifier(a, b);
    if (comparison > 0) return 1;
    if (comparison < 0) return -1;
  }
  return 0;
}

type LocalRuntimeVersionSkewState = LocalRuntimeStatus["versionSkew"]["state"];

class LocalRuntimeCompatibilityError extends Error {
  readonly pid: number | null;
  readonly runtimeVersion: string | null;
  readonly runtimeBuildHash: string | null;
  readonly runtimeDefaultRole: string | null;
  readonly skewState: LocalRuntimeVersionSkewState;
  constructor(
    message: string,
    runtimeInfo: {
      pid?: number | null;
      version?: string | null;
      buildHash?: string | null;
      defaultRole?: string | null;
    } = {},
    skewState: LocalRuntimeVersionSkewState = "unknown",
  ) {
    super(message);
    this.name = "LocalRuntimeCompatibilityError";
    this.pid = runtimeInfo.pid ?? null;
    this.runtimeVersion = runtimeInfo.version ?? null;
    this.runtimeBuildHash = runtimeInfo.buildHash ?? null;
    this.runtimeDefaultRole = runtimeInfo.defaultRole ?? null;
    this.skewState = skewState;
  }
}

function closeRuntimeClient(client: RuntimeRpcClient): void {
  try {
    client.close();
  } catch {}
}

// The RPC client surfaces a dropped/closed daemon socket with these sentinel
// messages (see RuntimeRpcClient.failConnection). A drop happens whenever the
// daemon restarts or is recycled — e.g. when a desktop rebuild changes the
// expected build hash and the running daemon is deemed incompatible.
export function isLocalRuntimeConnectionDropped(error: Error): boolean {
  return /Remote ADE service connection (closed|failed)/i.test(error.message);
}

// Conservative mirror of the preload's isReadOnlyRuntimeAction. Only these
// actions are safe to transparently retry after a connection drop, because a
// retry of a mutating action could re-run it against the reconnected daemon.
const RETRYABLE_READ_ACTION_PREFIXES = [
  "diagnosticsGet",
  "get",
  "list",
  "oauthGet",
  "oauthList",
  "portList",
  "proxyGet",
  "read",
  "search",
] as const;

const RETRYABLE_READ_ACTIONS = new Set<string>([
  "chat.codexFuzzyFileSearch",
  "chat.fileSearch",
  "chat.modelCatalog",
  "file.listTreeChildren",
  "file.quickOpen",
  "file.readFileRange",
  "file.refreshGitDecorations",
  "terminal.activeForChat",
  "terminal.preview",
]);

export function isRetryableReadAction(domain: string, action: string): boolean {
  if (RETRYABLE_READ_ACTIONS.has(`${domain}.${action}`)) return true;
  return RETRYABLE_READ_ACTION_PREFIXES.some(
    (prefix) =>
      action === prefix ||
      (action.startsWith(prefix) && /^[A-Z]/.test(action.slice(prefix.length))),
  );
}

function signalRuntimeChildProcess(child: ChildProcess | null, signal: NodeJS.Signals): void {
  if (!child?.pid) return;
  try {
    child.kill(signal);
  } catch {}
}

async function unlinkSocketIfNotListening(socketPath: string): Promise<void> {
  if (isAdeRuntimeNamedPipePath(socketPath)) return;
  try {
    const transport = await openSocketTransport(socketPath, 150);
    transport.close();
    return;
  } catch {}
  try {
    fs.unlinkSync(socketPath);
  } catch {}
}

function disposeOwnedRuntimeChild(
  child: ChildProcess | null,
  socketPath: string,
  options: { unlinkSocket?: boolean } = {},
): void {
  if (!child?.pid) return;
  let settled = false;
  let cleanupTimer: NodeJS.Timeout | null = null;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    if (cleanupTimer) {
      clearTimeout(cleanupTimer);
      cleanupTimer = null;
    }
    if (options.unlinkSocket) {
      void unlinkSocketIfNotListening(socketPath);
    }
  };
  child.once("exit", cleanup);
  signalRuntimeChildProcess(child, "SIGTERM");
  cleanupTimer = setTimeout(() => {
    signalRuntimeChildProcess(child, "SIGKILL");
    const unlinkTimer = setTimeout(cleanup, 250);
    unlinkTimer.unref?.();
  }, 2_000);
  cleanupTimer.unref?.();
}

async function waitForSocket(socketPath: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  let lastError: Error | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const transport = await openSocketTransport(socketPath, 500);
      transport.close();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError ?? new Error(`ADE service socket did not become available: ${socketPath}`);
}

export function parseRuntimeServiceManagerOutput(output: string): RuntimeServiceManagerOutput | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  return {
    ok: typeof record.ok === "boolean" ? record.ok : null,
    path: typeof record.path === "string" && record.path.trim() ? record.path.trim() : null,
    message: typeof record.message === "string" && record.message.trim() ? record.message.trim() : null,
  };
}

function serviceHealthState(
  status: ServiceManagerStatusResult,
): LocalRuntimeStatus["serviceHealth"]["state"] {
  if (!status.ok) return status.installed == null ? "unsupported" : "error";
  if (status.installed === false) return "not_installed";
  if (status.running === true) return "running";
  if (status.installed === true) return "installed";
  return "unknown";
}

export class LocalRuntimeConnectionPool {
  private disposed = false;
  private connection: Promise<LocalRuntimeConnection> | null = null;
  private activeConnection: LocalRuntimeConnection | null = null;
  private activeClient: RuntimeRpcClient | null = null;
  private activeRuntimePid: number | null = null;
  private activeRuntimeSyncPort: number | null = null;
  private activeRuntimePublishHealth: LocalRuntimeStatus["publishHealth"] = null;
  private activeRuntimeLastWedge: LocalRuntimeStatus["lastWedge"] = null;
  private ownedRuntimeChild: ChildProcess | null = null;
  private isolatedRecoveryTimer: NodeJS.Timeout | null = null;
  private isolatedModeActive = false;
  private lastIsolatedServiceRepairMs = 0;
  private readonly coalescedActionCalls = new Map<string, Promise<RemoteRuntimeActionResult>>();
  private readonly projectsByRoot = new Map<string, RemoteRuntimeProjectRecord>();
  private readonly projectRegistrationsByRoot = new Map<string, {
    acceptsMatchingWaiters: boolean;
    intent: ProjectRegistrationIntent;
    promise: Promise<RemoteRuntimeProjectRecord>;
  }>();
  private serviceInstallStatus: LocalRuntimeStatus["serviceInstall"] = {
    state: "not_attempted",
    attempted: false,
    path: null,
    message: "Background service installation has not run in this session.",
    exitCode: null,
    updatedAt: null,
  };
  private serviceHealthStatus: LocalRuntimeStatus["serviceHealth"] = {
    state: "unknown",
    installed: null,
    running: null,
    path: null,
    message: "Background service status has not been checked in this session.",
    checkedAt: null,
  };
  private versionSkewStatus: LocalRuntimeStatus["versionSkew"] = {
    state: "none",
    appVersion: null,
    runtimeVersion: null,
    message: null,
    updatedAt: null,
  };
  private serviceHealthCheckedAtMs = 0;
  private serviceInstallPromise: Promise<void> | null = null;
  private runtimeStatusRefreshPromise: Promise<void> | null = null;
  // Rolling 24 h aggregate of slow (>500 ms) or errored daemon action calls.
  // Feeds the machine-level runtime-health diagnostic surfaced in Settings.
  private slowActionSamples: SlowActionSample[] = [];

  constructor(
    private readonly appVersion: string,
    private readonly logger: Logger,
    private readonly options: LocalRuntimeConnectionPoolOptions = {},
  ) {}

  async ensureRunning(): Promise<void> {
    await this.connect();
  }

  getStatus(): LocalRuntimeStatus {
    this.refreshServiceHealthIfStale();
    return this.statusSnapshot();
  }

  private statusSnapshot(): LocalRuntimeStatus {
    return {
      connectionState: this.activeClient
        ? "connected"
        : this.connection
          ? "connecting"
          : "idle",
      pid: this.activeRuntimePid,
      syncPort: this.activeRuntimeSyncPort,
      publishHealth: this.activeRuntimePublishHealth
        ? {
            ...this.activeRuntimePublishHealth,
            lastLegDurations: { ...this.activeRuntimePublishHealth.lastLegDurations },
          }
        : null,
      lastWedge: this.activeRuntimeLastWedge ? { ...this.activeRuntimeLastWedge } : null,
      runtimeMode: this.isolatedModeActive ? "isolated" : "primary",
      versionSkew: { ...this.versionSkewStatus },
      serviceInstall: { ...this.serviceInstallStatus },
      serviceHealth: { ...this.serviceHealthStatus },
    };
  }

  async getFreshStatus(): Promise<LocalRuntimeStatus> {
    await this.refreshRuntimeDiagnostics();
    return this.getStatus();
  }

  private async refreshRuntimeDiagnostics(): Promise<void> {
    if (this.runtimeStatusRefreshPromise) {
      await this.runtimeStatusRefreshPromise;
      return;
    }
    const client = this.activeClient;
    if (!client) return;
    const refresh = (async () => {
      try {
        const value = await client.call("runtime/info", {}, {
          timeoutMs: LOCAL_RUNTIME_STATUS_REFRESH_TIMEOUT_MS,
        });
        if (this.activeClient !== client) return;
        const runtimeInfo = readLocalRuntimeInfo(value);
        if (runtimeInfo.version == null && runtimeInfo.pid == null) return;
        this.activeRuntimePid = runtimeInfo.pid;
        this.activeRuntimeSyncPort = runtimeInfo.syncPort;
        this.activeRuntimePublishHealth = runtimeInfo.publishHealth;
        this.activeRuntimeLastWedge = runtimeInfo.lastWedge;
        this.emitRuntimeStatusChange();
      } catch (error) {
        this.logger.debug("local_runtime.status_refresh_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })().finally(() => {
      if (this.runtimeStatusRefreshPromise === refresh) {
        this.runtimeStatusRefreshPromise = null;
      }
    });
    this.runtimeStatusRefreshPromise = refresh;
    await refresh;
  }

  private emitRuntimeStatusChange(): void {
    try {
      this.options.onRuntimeStatusChange?.(this.statusSnapshot());
    } catch (error) {
      this.logger.warn("local_runtime.status_listener_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getRuntimeProcessIds(): number[] {
    const pids = [
      this.activeRuntimePid,
      this.activeConnection?.child?.pid,
      this.ownedRuntimeChild?.pid,
    ].filter((pid): pid is number => (
      typeof pid === "number" && Number.isFinite(pid) && pid > 0 && pid !== process.pid
    ));
    return Array.from(new Set(pids));
  }

  private recordSlowAction(atMs: number, totalMs: number): void {
    this.slowActionSamples.push({ at: atMs, totalMs });
    // Keep the window bounded on both age and count.
    const horizon = atMs - RUNTIME_HEALTH_WINDOW_MS;
    if (this.slowActionSamples.length > RUNTIME_HEALTH_MAX_SAMPLES || this.slowActionSamples[0]!.at < horizon) {
      this.slowActionSamples = this.slowActionSamples.filter((sample) => sample.at >= horizon);
      if (this.slowActionSamples.length > RUNTIME_HEALTH_MAX_SAMPLES) {
        this.slowActionSamples = this.slowActionSamples.slice(-RUNTIME_HEALTH_MAX_SAMPLES);
      }
    }
  }

  getRuntimeHealth(nowMs: number = Date.now()): RuntimeHealthSnapshot {
    const horizon = nowMs - RUNTIME_HEALTH_WINDOW_MS;
    const recent = this.slowActionSamples.filter((sample) => sample.at >= horizon);
    // Prune while we are here so idle pools do not retain a stale window.
    this.slowActionSamples = recent;
    let p95: number | null = null;
    if (recent.length > 0) {
      const sorted = recent.map((sample) => sample.totalMs).sort((left, right) => left - right);
      // Nearest-rank p95: index ceil(0.95*n)-1, clamped into range.
      const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
      p95 = sorted[rank]!;
    }
    return {
      slowActions24h: recent.length,
      slowActionP95Ms: p95,
      sampledAt: new Date(nowMs).toISOString(),
    };
  }

  noteServiceInstallSkipped(message: string): void {
    this.serviceInstallStatus = {
      state: "skipped",
      attempted: false,
      path: null,
      message,
      exitCode: null,
      updatedAt: new Date().toISOString(),
    };
  }

  private refreshServiceHealthIfStale(maxAgeMs = 2_000): void {
    if (Date.now() - this.serviceHealthCheckedAtMs < maxAgeMs) return;
    this.serviceHealthCheckedAtMs = Date.now();
    try {
      const status = (this.options.queryServiceStatus ?? getRuntimeServiceStatus)();
      this.serviceHealthStatus = {
        state: serviceHealthState(status),
        installed: status.installed,
        running: status.running,
        path: status.path,
        message: status.message,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.serviceHealthStatus = {
        state: "error",
        installed: null,
        running: null,
        path: null,
        message: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      };
      this.logger.warn("local_runtime.service_status_failed", {
        error: this.serviceHealthStatus.message,
      });
    }
  }

  async installServiceBestEffort(options: { forceRestart?: boolean } = {}): Promise<void> {
    if (this.serviceInstallPromise) return this.serviceInstallPromise;
    const install = this.runServiceInstallBestEffort(options).finally(() => {
      if (this.serviceInstallPromise === install) this.serviceInstallPromise = null;
    });
    this.serviceInstallPromise = install;
    return install;
  }

  /**
   * Stop and remove the per-user service login item by spawning
   * `serve --uninstall-service` — the same child-process boundary the
   * installer uses; desktop never imports ade-cli service-manager code
   * directly. Throws when the uninstall reports failure so the repair flow
   * does not proceed to exclusive database work with a brain still running.
   */
  async uninstallServiceBestEffort(): Promise<void> {
    const cliPath = resolveCliScriptPath();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, "serve", "--uninstall-service"], {
        env: buildLocalRuntimeNodeEnv(this.appVersion),
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      // A hung `serve --uninstall-service` (e.g. a stuck login-item removal)
      // must not leave the repair flow waiting forever; time it out, kill the
      // child, and reject so the caller reports a repair failure instead of
      // silently proceeding to exclusive database work.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGKILL"); } catch { /* child may already be gone */ }
        const message = "ADE service login item removal timed out.";
        this.logger.warn("local_runtime.service_uninstall_failed", { cliPath, reason: "timeout", message });
        reject(new Error(message));
      }, LOCAL_RUNTIME_SERVICE_UNINSTALL_TIMEOUT_MS);
      timer.unref?.();
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.logger.warn("local_runtime.service_uninstall_failed", { error: error.message });
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const output = stdout.trim();
        const parsed = parseRuntimeServiceManagerOutput(output);
        const failed = code !== 0 || parsed?.ok === false;
        if (failed) {
          const message = parsed?.message || stderr.trim() || output || "ADE service login item removal failed.";
          this.logger.warn("local_runtime.service_uninstall_failed", { cliPath, exitCode: code, message });
          reject(new Error(message));
          return;
        }
        this.serviceInstallStatus = {
          state: "not_attempted",
          attempted: false,
          path: parsed?.path ?? cliPath,
          message: parsed?.message || output || "ADE service login item was removed.",
          exitCode: code,
          updatedAt: new Date().toISOString(),
        };
        this.logger.info("local_runtime.service_uninstall_succeeded", { cliPath, exitCode: code });
        resolve();
      });
    });
  }

  private async runServiceInstallBestEffort(options: { forceRestart?: boolean } = {}): Promise<void> {
    const cliPath = resolveCliScriptPath();
    const releaseBuildBlock = localReleaseBuildOutputRuntimeBlock(cliPath);
    if (releaseBuildBlock) {
      this.serviceInstallStatus = {
        state: "skipped",
        attempted: false,
        path: releaseBuildBlock.cliPath,
        message: releaseBuildBlock.message,
        exitCode: null,
        updatedAt: new Date().toISOString(),
      };
      this.logger.warn("local_runtime.service_install_skipped", {
        cliPath: releaseBuildBlock.cliPath,
        reason: "local_release_build_output",
        message: releaseBuildBlock.message,
      });
      return;
    }
    const socketPath = process.env.ADE_RUNTIME_SOCKET_PATH?.trim() || resolveMachineAdeLayout().socketPath;
    const runningProbe = await this.probeRuntimeCompatibility(socketPath);
    const runningCompatibilityError = runningProbe?.error ?? null;
    if (
      !runningCompatibilityError
      && runningProbe
      && runningProbe.compatibleNewer
    ) {
      this.clearVersionSkewStatus();
      this.serviceInstallStatus = {
        state: "skipped",
        attempted: false,
        path: cliPath,
        message: "Skipped ADE service install because the newer running brain is protocol-compatible.",
        exitCode: null,
        updatedAt: new Date().toISOString(),
      };
      this.logger.info("local_runtime.service_install_skipped", {
        cliPath,
        socketPath,
        reason: "compatible_newer_runtime",
        runtimeVersion: runningProbe.runtimeInfo.version,
        appVersion: this.appVersion,
        runtimePid: runningProbe.runtimeInfo.pid,
      });
      return;
    }
    if (runningCompatibilityError?.skewState === "runtime_newer") {
      this.noteCompatibilityError(runningCompatibilityError);
      this.serviceInstallStatus = {
        state: "skipped",
        attempted: false,
        path: cliPath,
        message: "Skipped ADE service install because a newer ADE brain is already running.",
        exitCode: null,
        updatedAt: new Date().toISOString(),
      };
      this.logger.warn("local_runtime.service_install_skipped", {
        cliPath,
        socketPath,
        reason: "preserve_running_runtime",
        skewState: runningCompatibilityError.skewState,
        runtimeVersion: runningCompatibilityError.runtimeVersion,
        appVersion: this.appVersion,
        runtimePid: runningCompatibilityError.pid,
      });
      return;
    }
    this.serviceInstallStatus = {
      state: "installing",
      attempted: true,
      path: cliPath,
      message: "Installing the ADE service login item.",
      exitCode: null,
      updatedAt: new Date().toISOString(),
    };
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [cliPath, "serve", "--install-service"], {
        env: {
          ...buildLocalRuntimeNodeEnv(this.appVersion),
          ...(options.forceRestart ? { ADE_FORCE_RUNTIME_SERVICE_RESTART: "1" } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", (error) => {
        this.serviceInstallStatus = {
          state: "failed",
          attempted: true,
          path: cliPath,
          message: error.message,
          exitCode: null,
          updatedAt: new Date().toISOString(),
        };
        this.logger.warn("local_runtime.service_install_failed", { error: error.message });
        resolve();
      });
      child.once("close", (code) => {
        const output = stdout.trim();
        const errorOutput = stderr.trim();
        const parsed = parseRuntimeServiceManagerOutput(output);
        const failed = code !== 0 || parsed?.ok === false;
        const statusPath = parsed ? parsed.path : cliPath;
        const payload = {
          cliPath,
          servicePath: parsed?.path ?? null,
          exitCode: code,
          stdout: output || null,
          stderr: errorOutput || null,
        };
        if (!failed) {
          this.serviceInstallStatus = {
            state: "installed",
            attempted: true,
            path: statusPath,
            message: parsed?.message || output || "ADE service login item is installed.",
            exitCode: code,
            updatedAt: new Date().toISOString(),
          };
          this.logger.info("local_runtime.service_install_succeeded", payload);
        } else {
          this.serviceInstallStatus = {
            state: "failed",
            attempted: true,
            path: statusPath,
            message: parsed?.message || errorOutput || output || "ADE service login item installation failed.",
            exitCode: code,
            updatedAt: new Date().toISOString(),
          };
          this.logger.warn("local_runtime.service_install_failed", payload);
        }
        resolve();
      });
    });
  }

  async ensureProject(
    rootPath: string,
    registration: ProjectRegistrationIntent = SYSTEM_PROJECT_REGISTRATION,
  ): Promise<RemoteRuntimeProjectRecord> {
    const normalizedRoot = path.resolve(rootPath);
    while (true) {
      this.assertNotDisposed();
      const pending = this.projectRegistrationsByRoot.get(normalizedRoot);
      if (pending) {
        if (
          pending.acceptsMatchingWaiters
          && isSameProjectRegistrationIntent(pending.intent, registration)
        ) {
          return await pending.promise;
        }
        pending.acceptsMatchingWaiters = false;
        await pending.promise.catch(() => undefined);
        continue;
      }

      const cached = this.projectsByRoot.get(normalizedRoot);
      if (cached && cachedProjectSatisfiesRegistration(cached, registration)) {
        return cached;
      }

      const registrationPromise = this.registerProject(normalizedRoot, registration);
      const nextPending = {
        acceptsMatchingWaiters: true,
        intent: { ...registration },
        promise: registrationPromise,
      };
      this.projectRegistrationsByRoot.set(normalizedRoot, nextPending);
      void registrationPromise.then(
        () => {
          if (this.projectRegistrationsByRoot.get(normalizedRoot) === nextPending) {
            this.projectRegistrationsByRoot.delete(normalizedRoot);
          }
        },
        () => {
          if (this.projectRegistrationsByRoot.get(normalizedRoot) === nextPending) {
            this.projectRegistrationsByRoot.delete(normalizedRoot);
          }
        },
      );
      return await registrationPromise;
    }
  }

  private async registerProject(
    normalizedRoot: string,
    registration: ProjectRegistrationIntent,
  ): Promise<RemoteRuntimeProjectRecord> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const entry = await this.connect();
      this.assertNotDisposed();
      if (entry.client.isClosed()) {
        const error = new Error("Remote ADE service connection closed.");
        this.logger.warn("local_runtime.ensure_project_connection_dropped", {
          rootPath: normalizedRoot,
          socketPath: entry.socketPath,
          attempt,
          willRetry: attempt < 2,
          error: error.message,
        });
        this.resetActiveConnection(entry);
        lastError = error;
        if (attempt < 2) continue;
        throw error;
      }

      try {
        const project = await entry.client.call(
          "projects.add",
          { rootPath: normalizedRoot, ...registration },
          { timeoutMs: LOCAL_RUNTIME_PROJECT_TIMEOUT_MS },
        );
        this.assertNotDisposed();
        const record = coerceProjects([project])[0];
        if (!record) throw new Error("Local ADE service did not return a project record.");
        this.projectsByRoot.set(normalizedRoot, record);
        return record;
      } catch (error) {
        const projectError = error instanceof Error ? error : new Error(String(error));
        if (!isLocalRuntimeConnectionDropped(projectError)) {
          throw projectError;
        }
        this.logger.warn("local_runtime.ensure_project_connection_dropped", {
          rootPath: normalizedRoot,
          socketPath: entry.socketPath,
          attempt,
          willRetry: attempt < 2,
          error: projectError.message,
        });
        this.resetActiveConnection(entry);
        lastError = projectError;
        if (attempt < 2) continue;
        throw projectError;
      }
    }

    // Unreachable: the loop always returns or throws on the final attempt.
    // Required here only for TypeScript's control-flow narrowing.
    throw lastError ?? new Error("Local ADE service did not return a project record.");
  }

  async setProjectCatalogVisibility(
    rootPath: string,
    catalogVisibility: "recent" | "system",
    registrationSource: ProjectRegistrationSource,
  ): Promise<RemoteRuntimeProjectRecord | null> {
    const normalizedRoot = path.resolve(rootPath);
    const entry = await this.connect();
    const value = await entry.client.call(
      "projects.setCatalogVisibility",
      { rootPath: normalizedRoot, catalogVisibility, registrationSource },
      { timeoutMs: LOCAL_RUNTIME_PROJECT_TIMEOUT_MS },
    );
    const record = coerceProjects([value])[0] ?? null;
    if (record) {
      this.projectsByRoot.set(normalizedRoot, record);
    } else {
      this.projectsByRoot.delete(normalizedRoot);
    }
    return record;
  }

  async projects(): Promise<RemoteRuntimeProjectRecord[]> {
    const entry = await this.connect();
    return coerceProjects(await entry.client.call("projects.list", {}));
  }

  async activitySummary(): Promise<RuntimeActivitySummary> {
    return await this.callSync<RuntimeActivitySummary>("runtime.activitySummary");
  }

  async syncStatusForRoot(rootPath: string, args: SyncGetStatusArgs = {}): Promise<SyncRoleSnapshot> {
    return await this.callSyncForRoot<SyncRoleSnapshot>(rootPath, "sync.getStatus", {
      includeTransferReadiness: args.includeTransferReadiness === true,
      forceTransferReadiness: args.forceTransferReadiness === true,
    });
  }

  async refreshSyncDiscoveryForRoot(rootPath: string): Promise<SyncRoleSnapshot> {
    return await this.callSyncForRoot<SyncRoleSnapshot>(rootPath, "sync.refreshDiscovery");
  }

  async syncDevicesForRoot(rootPath: string): Promise<SyncDeviceRuntimeState[]> {
    return await this.callSyncForRoot<SyncDeviceRuntimeState[]>(rootPath, "sync.listDevices");
  }

  async updateSyncLocalDeviceForRoot(
    rootPath: string,
    args: { name?: string; deviceType?: SyncPeerDeviceType },
  ): Promise<SyncDeviceRecord> {
    return await this.callSyncForRoot<SyncDeviceRecord>(rootPath, "sync.updateLocalDevice", args);
  }

  async forgetSyncDeviceForRoot(rootPath: string, deviceId: string): Promise<SyncRoleSnapshot> {
    return await this.callSyncForRoot<SyncRoleSnapshot>(rootPath, "sync.forgetDevice", { deviceId });
  }

  async syncPinForRoot(rootPath: string): Promise<{ pin: string | null }> {
    return await this.callSyncForRoot<{ pin: string | null }>(rootPath, "sync.getPin");
  }

  async setSyncPinForRoot(rootPath: string, pin: string): Promise<SyncRoleSnapshot> {
    return await this.callSyncForRoot<SyncRoleSnapshot>(rootPath, "sync.setPin", { pin });
  }

  async generateSyncPinForRoot(rootPath: string): Promise<SyncRoleSnapshot> {
    return await this.callSyncForRoot<SyncRoleSnapshot>(rootPath, "sync.generatePin");
  }

  async clearSyncPinForRoot(rootPath: string): Promise<SyncRoleSnapshot> {
    return await this.callSyncForRoot<SyncRoleSnapshot>(rootPath, "sync.clearPin");
  }

  async syncRuntimeNameForRoot(rootPath: string): Promise<{ runtimeName: string | null }> {
    return await this.callSyncForRoot<{ runtimeName: string | null }>(rootPath, "sync.getRuntimeName");
  }

  async setSyncRuntimeNameForRoot(rootPath: string, name: string): Promise<SyncRoleSnapshot> {
    return await this.callSyncForRoot<SyncRoleSnapshot>(rootPath, "sync.setRuntimeName", { name });
  }

  async clearSyncRuntimeNameForRoot(rootPath: string): Promise<SyncRoleSnapshot> {
    return await this.callSyncForRoot<SyncRoleSnapshot>(rootPath, "sync.clearRuntimeName");
  }

  async syncCloudRelayStatusForRoot(rootPath: string): Promise<SyncCloudRelayStatus> {
    return await this.callSyncForRoot<SyncCloudRelayStatus>(rootPath, "sync.getCloudRelayStatus");
  }

  async callSync<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const entry = await this.connect();
    return await entry.client.call(method, params) as T;
  }

  async callActionForRoot(
    rootPath: string,
    request: RemoteRuntimeActionRequest,
  ): Promise<RemoteRuntimeActionResult> {
    const coalescedKey = coalescedLocalRuntimeActionKey(rootPath, request);
    if (!coalescedKey) return await this.callActionForRootUncoalesced(rootPath, request);

    const existing = this.coalescedActionCalls.get(coalescedKey);
    if (existing) return await existing;

    const actionCall = this.callActionForRootUncoalesced(rootPath, request)
      .finally(() => {
        if (this.coalescedActionCalls.get(coalescedKey) === actionCall) {
          this.coalescedActionCalls.delete(coalescedKey);
        }
      });
    this.coalescedActionCalls.set(coalescedKey, actionCall);
    return await actionCall;
  }

  private async callActionForRootUncoalesced(
    rootPath: string,
    request: RemoteRuntimeActionRequest,
  ): Promise<RemoteRuntimeActionResult> {
    // A dropped daemon connection (restart / build-hash recycle) is transient:
    // the next connect() reconnects to the live daemon. Retry idempotent reads
    // once so the renderer never sees a raw "connection closed" for a refresh.
    const maxAttempts = isRetryableReadAction(request.domain, request.action) ? 2 : 1;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const tStart = Date.now();
      const project = await this.ensureProject(rootPath);
      const tProject = Date.now();
      let entry = await this.connect();
      // The cached connection may already be dead (daemon recycled since the
      // last call). Reconnecting before sending is safe for any action because
      // nothing has been written to the socket yet.
      if (entry.client.isClosed()) {
        this.resetActiveConnection(entry);
        entry = await this.connect();
      }
      const tConnect = Date.now();
      const actionCallOptions = {
        timeoutMs: localRuntimeActionTimeoutMs(request.domain, request.action),
      };
      let value: unknown = undefined;
      let callError: Error | null = null;
      try {
        value = await entry.client.call(
          "ade/actions/call",
          {
            projectId: project.projectId,
            name: "run_ade_action",
            arguments: {
              domain: request.domain,
              action: request.action,
              ...(request.args ? { args: request.args } : {}),
              ...(Object.prototype.hasOwnProperty.call(request, "arg") ? { arg: request.arg } : {}),
              ...(request.argsList ? { argsList: request.argsList } : {}),
            },
          },
          actionCallOptions,
        );
      } catch (error) {
        callError = error instanceof Error ? error : new Error(String(error));
      } finally {
        const tCall = Date.now();
        const totalMs = tCall - tStart;
        if (totalMs > SLOW_ACTION_THRESHOLD_MS || callError) {
          this.recordSlowAction(tCall, totalMs);
          this.logger.warn("local_runtime.action_slow", {
            domain: request.domain,
            action: request.action,
            totalMs,
            ensureProjectMs: tProject - tStart,
            connectMs: tConnect - tProject,
            daemonCallMs: tCall - tConnect,
            timeoutMs: actionCallOptions?.timeoutMs ?? null,
            error: callError?.message ?? null,
            attempt,
          });
        }
        if (callError && isLocalRuntimeConnectionDropped(callError)) {
          this.logger.warn("local_runtime.action_connection_dropped", {
            domain: request.domain,
            action: request.action,
            socketPath: entry.socketPath,
            totalMs,
            attempt,
            willRetry: attempt < maxAttempts,
          });
          this.resetActiveConnection(entry);
        }
      }

      if (callError) {
        if (
          isLocalRuntimeConnectionDropped(callError) &&
          attempt < maxAttempts
        ) {
          lastError = callError;
          continue;
        }
        throw callError;
      }

      if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        if (record.ok === false) {
          const error = record.error && typeof record.error === "object" && !Array.isArray(record.error)
            ? record.error as Record<string, unknown>
            : {};
          throw new Error(typeof error.message === "string" ? error.message : "Local ADE service action failed.");
        }
        return {
          domain: typeof record.domain === "string" ? record.domain : request.domain,
          action: typeof record.action === "string" ? record.action : request.action,
          result: record.result,
          statusHints: record.statusHints && typeof record.statusHints === "object" && !Array.isArray(record.statusHints)
            ? record.statusHints as Record<string, unknown>
            : {},
        };
      }

      return {
        domain: request.domain,
        action: request.action,
        result: value,
        statusHints: {},
      };
    }

    // Loop only falls through here after exhausting retries on a dropped
    // connection (it returns or throws on every other path).
    throw lastError ?? new Error("Local ADE service action failed.");
  }

  async listActionRegistryForRoot(rootPath: string): Promise<AdeActionRegistryEntry[]> {
    const project = await this.ensureProject(rootPath);
    const entry = await this.connect();
    const value = await entry.client.call("ade/actions/call", {
      projectId: project.projectId,
      name: "list_ade_actions",
      arguments: { domain: "all" },
    }, { timeoutMs: LOCAL_RUNTIME_ACTION_REGISTRY_TIMEOUT_MS });
    return normalizeAdeActionRegistry(value);
  }

  async streamEventsForRoot(
    rootPath: string,
    request: RemoteRuntimeStreamEventsRequest = {},
  ): Promise<RemoteRuntimeStreamEventsResult> {
    const project = await this.ensureProject(rootPath);
    const entry = await this.connect();
    const value = await entry.client.call(
      "ade/actions/call",
      {
        projectId: project.projectId,
        name: "stream_events",
        arguments: {
          cursor: clampCursor(request.cursor),
          limit: clampLimit(request.limit),
          ...(isRemoteRuntimeEventCategory(request.category) ? { category: request.category } : {}),
        },
      },
      { timeoutMs: LOCAL_RUNTIME_EVENT_POLL_TIMEOUT_MS },
    );

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (record.ok === false) {
        const error = record.error && typeof record.error === "object" && !Array.isArray(record.error)
          ? record.error as Record<string, unknown>
          : {};
        throw new Error(typeof error.message === "string" ? error.message : "Local ADE service event stream failed.");
      }

      const eventEpoch = typeof record.eventEpoch === "string" && record.eventEpoch.trim()
        ? record.eventEpoch.trim()
        : null;
      return {
        events: Array.isArray(record.events)
          ? record.events.map(normalizeBufferedEvent).filter((event): event is RemoteRuntimeBufferedEvent => event != null)
          : [],
        nextCursor: typeof record.nextCursor === "number" && Number.isFinite(record.nextCursor)
          ? Math.max(0, Math.floor(record.nextCursor))
          : clampCursor(request.cursor),
        hasMore: record.hasMore === true,
        ...(eventEpoch ? { eventEpoch } : {}),
        ...(record.gap === true ? { gap: true } : {}),
        ...(typeof record.oldestCursor === "number" && Number.isFinite(record.oldestCursor)
          ? { oldestCursor: Math.max(0, Math.floor(record.oldestCursor)) }
          : {}),
      };
    }

    return {
      events: [],
      nextCursor: clampCursor(request.cursor),
      hasMore: false,
    };
  }

  async subscribeEventsForRoot(
    rootPath: string,
    request: RemoteRuntimeStreamEventsRequest = {},
    onEvent: (event: RemoteRuntimeBufferedEvent, eventEpoch?: string | null) => void,
    onEnded?: () => void,
    onSubscribed?: (result: RemoteRuntimeStreamEventsResult) => void,
  ): Promise<() => void> {
    const project = await this.ensureProject(rootPath);
    const entry = await this.connect();
    return await subscribeToRuntimeEvents(entry.client, project.projectId, request, onEvent, onEnded, onSubscribed);
  }

  async callSyncForRoot<T>(
    rootPath: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const project = await this.ensureProject(rootPath);
    const entry = await this.connect();
    return await entry.client.call(method, {
      ...params,
      projectId: project.projectId,
    }, { timeoutMs: LOCAL_RUNTIME_SYNC_TIMEOUT_MS }) as T;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIsolatedRecoveryTimer();
    this.markIsolatedMode(false, { notify: false });
    const pending = this.connection;
    this.connection = null;
    this.activeConnection = null;
    this.activeClient = null;
    this.activeRuntimePid = null;
    this.activeRuntimeSyncPort = null;
    this.activeRuntimePublishHealth = null;
    this.activeRuntimeLastWedge = null;
    this.ownedRuntimeChild = null;
    this.projectsByRoot.clear();
    this.projectRegistrationsByRoot.clear();
    void pending?.then((entry) => {
      try { entry.client.close(); } catch {}
      disposeOwnedRuntimeChild(entry.child, entry.socketPath);
    }).catch(() => {});
  }

  private async connect(): Promise<LocalRuntimeConnection> {
    this.assertNotDisposed();
    if (this.connection) {
      const entry = await this.connection;
      this.assertNotDisposed();
      return entry;
    }
    const connection = this.createConnection().then((entry) => {
      if (this.connection === connection) {
        this.activeConnection = entry;
      }
      return entry;
    }).catch((error) => {
      if (this.connection === connection) {
        this.connection = null;
        this.activeConnection = null;
        this.activeClient = null;
        this.activeRuntimePid = null;
        this.activeRuntimeSyncPort = null;
        this.activeRuntimePublishHealth = null;
        this.activeRuntimeLastWedge = null;
      }
      throw error;
    });
    this.connection = connection;
    const entry = await connection;
    this.assertNotDisposed();
    return entry;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("Local runtime connection pool is disposed.");
    }
  }

  private isCurrentConnection(entry: LocalRuntimeConnection): boolean {
    return this.activeClient === entry.client || this.activeConnection?.client === entry.client;
  }

  private clearConnectionIfCurrent(entry: LocalRuntimeConnection): boolean {
    if (!this.isCurrentConnection(entry)) return false;
    this.connection = null;
    this.activeConnection = null;
    this.activeClient = null;
    this.activeRuntimePid = null;
    this.activeRuntimeSyncPort = null;
    this.activeRuntimePublishHealth = null;
    this.activeRuntimeLastWedge = null;
    this.projectsByRoot.clear();
    return true;
  }

  private noteCompatibilityError(error: LocalRuntimeCompatibilityError): void {
    this.versionSkewStatus = {
      state: error.skewState,
      appVersion: this.appVersion,
      runtimeVersion: error.runtimeVersion,
      message: error.message,
      updatedAt: new Date().toISOString(),
    };
  }

  private clearVersionSkewStatus(): void {
    this.versionSkewStatus = {
      state: "none",
      appVersion: this.appVersion,
      runtimeVersion: null,
      message: null,
      updatedAt: new Date().toISOString(),
    };
  }

  private isCompatibleNewerRuntime(
    runtimeInfo: ReturnType<typeof readLocalRuntimeInfo>,
  ): boolean {
    return compareRuntimeVersionStrings(runtimeInfo.version, this.appVersion) === 1
      && isRuntimeProtocolCompatible(runtimeInfo);
  }

  private runtimeCompatibilityError(
    socketPath: string,
    runtimeInfo: ReturnType<typeof readLocalRuntimeInfo>,
  ): LocalRuntimeCompatibilityError | null {
    const expectedBuildHash = computeLocalRuntimeBuildHash();
    let acceptedNewerRuntime = false;
    if (!isCompatibleRuntimeVersion({
      runtimeVersion: runtimeInfo.version,
      appVersion: this.appVersion,
      runtimeBuildHash: runtimeInfo.buildHash,
      expectedBuildHash,
    })) {
      this.logger.info("local_runtime.version_mismatch_detected", {
        socketPath,
        runtimeVersion: runtimeInfo.version,
        appVersion: this.appVersion,
        runtimeBuildHash: runtimeInfo.buildHash,
        expectedBuildHash,
        runtimePid: runtimeInfo.pid,
      });
      const comparison = compareRuntimeVersionStrings(runtimeInfo.version, this.appVersion);
      if (this.isCompatibleNewerRuntime(runtimeInfo)) {
        acceptedNewerRuntime = true;
        this.logger.info("local_runtime.newer_brain_accepted", {
          socketPath,
          runtimeVersion: runtimeInfo.version,
          appVersion: this.appVersion,
          runtimePid: runtimeInfo.pid,
          minCompatibleProtocol: runtimeInfo.minCompatibleProtocol,
          protocolVersion: runtimeInfo.protocolVersion,
        });
      } else {
        return new LocalRuntimeCompatibilityError(
          `ADE service version ${runtimeInfo.version} does not match desktop version ${this.appVersion}.`,
          runtimeInfo,
          comparison == null || comparison === 0
            ? "unknown"
            : comparison > 0
              ? "runtime_newer"
              : "runtime_older",
        );
      }
    }
    if (!acceptedNewerRuntime && expectedBuildHash && runtimeInfo.buildHash !== expectedBuildHash) {
      this.logger.info("local_runtime.build_mismatch_detected", {
        socketPath,
        runtimeBuildHash: runtimeInfo.buildHash,
        expectedBuildHash,
        runtimePid: runtimeInfo.pid,
      });
      return new LocalRuntimeCompatibilityError(
        "ADE service build does not match the packaged desktop runtime.",
        runtimeInfo,
        "build_mismatch",
      );
    }
    if (runtimeInfo.defaultRole !== "cto") {
      this.logger.info("local_runtime.role_mismatch_detected", {
        socketPath,
        runtimeDefaultRole: runtimeInfo.defaultRole,
        expectedDefaultRole: "cto",
        runtimePid: runtimeInfo.pid,
      });
      return new LocalRuntimeCompatibilityError(
        `ADE service default role ${runtimeInfo.defaultRole ?? "missing"} does not match desktop role cto.`,
        runtimeInfo,
        "role_mismatch",
      );
    }
    return null;
  }

  private async probeRuntimeCompatibility(socketPath: string): Promise<{
    error: LocalRuntimeCompatibilityError | null;
    runtimeInfo: ReturnType<typeof readLocalRuntimeInfo>;
    compatibleNewer: boolean;
  } | null> {
    let client: RuntimeRpcClient | null = null;
    try {
      const transport = await openSocketTransport(socketPath);
      client = new RuntimeRpcClient(transport);
      const initializeResult = await client.initialize("ade-desktop-service-install-probe", this.appVersion);
      const runtimeInfo = readLocalRuntimeInfo(initializeResult);
      return {
        error: this.runtimeCompatibilityError(socketPath, runtimeInfo),
        runtimeInfo,
        compatibleNewer: this.isCompatibleNewerRuntime(runtimeInfo),
      };
    } catch {
      return null;
    } finally {
      if (client) closeRuntimeClient(client);
    }
  }

  // Drop a stale/closed cached connection so the next connect() reconnects.
  // This does not dispose the owned child or unlink the socket: a dropped
  // connection is often a daemon that has already been replaced (e.g.
  // build-hash recycle), and a fresh daemon may have rebound the same socket —
  // tearing it down would kill the healthy replacement.
  private resetActiveConnection(entry: LocalRuntimeConnection): void {
    this.clearConnectionIfCurrent(entry);
    closeRuntimeClient(entry.client);
  }

  private async createConnection(): Promise<LocalRuntimeConnection> {
    const layout = resolveMachineAdeLayout();
    const socketPath = process.env.ADE_RUNTIME_SOCKET_PATH?.trim() || layout.socketPath;
    const existing = await this.tryConnect(socketPath);
    if (existing) return existing;

    const repaired = await this.tryRepairServiceConnection(socketPath, "missing");
    if (repaired) return repaired;

    const releaseBuildBlock = this.releaseBuildOutputRuntimeBlock();
    if (releaseBuildBlock) {
      this.logger.warn("local_runtime.release_build_runtime_blocked", {
        cliPath: releaseBuildBlock.cliPath,
        socketPath,
        reason: "missing",
        message: releaseBuildBlock.message,
      });
      throw new Error(releaseBuildBlock.message);
    }

    if (isPrimaryMachineRuntimeSocketPath(socketPath, layout.socketPath)) {
      const message = this.options.preferServiceRepair
        ? `ADE service repair did not restore the runtime endpoint at ${socketPath}; ` +
          "refusing to spawn an app-owned sync-enabled brain on the primary service socket."
        : primaryRuntimeSpawnBlockedMessage(socketPath);
      this.logger.warn(this.options.preferServiceRepair
        ? "local_runtime.service_repair_fallback_blocked"
        : "local_runtime.primary_runtime_spawn_blocked", {
        socketPath,
        message,
        serviceState: this.serviceInstallStatus.state,
        serviceMessage: this.serviceInstallStatus.message,
        preferServiceRepair: this.options.preferServiceRepair === true,
      });
      const lastFailure = readLastFailure({ kind: "machine" });
      this.refreshServiceHealthIfStale(0);
      const recordedDbCodes = new Set<AdeRecoveryErrorCode>([
        "disk_full",
        "insufficient_headroom",
        "db_integrity",
        "migration_incomplete",
        "migration_unknown_state",
      ]);
      let recoveryCode: AdeRecoveryErrorCode;
      if (lastFailure && recordedDbCodes.has(lastFailure.code)) {
        recoveryCode = lastFailure.code;
      } else if (
        this.serviceInstallStatus.state === "failed"
        || this.serviceHealthStatus.state === "not_installed"
      ) {
        recoveryCode = "brain_not_installed";
      } else {
        recoveryCode = await probeSocketHasOwner(socketPath)
          ? "socket_owned_by_other"
          : "socket_stale_no_owner";
      }
      const crashLoopDetail = lastFailure && lastFailure.count >= 3
        ? ` Secondary recovery code: brain_crash_looping (${lastFailure.count} consecutive failures since ${lastFailure.firstAt}).`
        : "";
      const reportDetail = lastFailure?.detail
        ? ` Last recorded failure: ${lastFailure.detail}`
        : "";
      throw codedRecoveryError(
        `ADE's background service could not open this project. Technical details: ${message}${crashLoopDetail}${reportDetail}`,
        recoveryCode,
      );
    }

    const child = this.spawnRuntime(socketPath);
    try {
      await waitForSocket(socketPath);
      const client = await this.connectClient(socketPath);
      return { client, child, socketPath };
    } catch (error) {
      disposeOwnedRuntimeChild(child, socketPath, { unlinkSocket: true });
      throw error;
    }
  }

  private async tryConnect(socketPath: string): Promise<LocalRuntimeConnection | null> {
    try {
      const client = await this.connectClient(socketPath);
      this.ownedRuntimeChild = null;
      return { client, child: null, socketPath };
    } catch (error) {
      if (error instanceof LocalRuntimeCompatibilityError) {
        this.noteCompatibilityError(error);
        if (error.skewState === "runtime_newer") {
          this.logger.warn("local_runtime.newer_brain_preserved", {
            socketPath,
            appVersion: this.appVersion,
            runtimeVersion: error.runtimeVersion,
            runtimePid: error.pid,
            message: error.message,
          });
          return await this.startIsolatedRuntime(socketPath, error);
        }
        const repaired = await this.tryRepairServiceConnection(socketPath, "incompatible", error);
        if (repaired) return repaired;
        const releaseBuildBlock = this.releaseBuildOutputRuntimeBlock();
        if (releaseBuildBlock) {
          this.logger.warn("local_runtime.release_build_runtime_blocked", {
            cliPath: releaseBuildBlock.cliPath,
            socketPath,
            reason: "incompatible",
            message: releaseBuildBlock.message,
            runtimePid: error.pid,
            runtimeVersion: error.runtimeVersion,
            runtimeBuildHash: error.runtimeBuildHash,
            runtimeDefaultRole: error.runtimeDefaultRole,
          });
          throw new Error(releaseBuildBlock.message);
        }
        return await this.startIsolatedRuntime(socketPath, error);
      }
      this.logger.debug("local_runtime.connect_existing_failed", {
        socketPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async tryRepairServiceConnection(
    socketPath: string,
    reason: "missing" | "incompatible",
    compatibilityError?: LocalRuntimeCompatibilityError,
  ): Promise<LocalRuntimeConnection | null> {
    if (!this.options.preferServiceRepair) return null;
    this.logger.info("local_runtime.service_repair_attempt", {
      socketPath,
      reason,
      pid: compatibilityError?.pid ?? null,
      message: compatibilityError?.message ?? null,
    });
    await this.installServiceBestEffort();
    const installStatus = this.serviceInstallStatus;
    if (installStatus.state !== "installed") {
      this.logger.warn("local_runtime.service_repair_skipped", {
        socketPath,
        reason,
        serviceState: installStatus.state,
        message: installStatus.message,
      });
      return null;
    }
    // The service was just (re)installed: the stale brain may still be dying
    // and the replacement child still binding the socket. A single connect
    // attempt lands in that churn window and strands this desktop on an
    // isolated no-sync runtime, so keep retrying — through connect failures
    // AND through compatibility errors from the not-yet-replaced old brain —
    // until the repaired service is actually reachable.
    const deadline = Date.now() + 20_000;
    let lastError: unknown = null;
    for (;;) {
      try {
        await waitForSocket(socketPath, 2_000);
        const client = await this.connectClient(socketPath);
        this.ownedRuntimeChild = null;
        return { client, child: null, socketPath };
      } catch (error) {
        lastError = error;
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
    if (lastError instanceof LocalRuntimeCompatibilityError) {
      this.logger.warn("local_runtime.service_repair_connect_failed", {
        socketPath,
        reason,
        error: lastError.message,
        runtimePid: lastError.pid,
        runtimeVersion: lastError.runtimeVersion,
        runtimeBuildHash: lastError.runtimeBuildHash,
        runtimeDefaultRole: lastError.runtimeDefaultRole,
      });
      return null;
    }
    this.logger.warn("local_runtime.service_repair_connect_failed", {
      socketPath,
      reason,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    return null;
  }

  private isolatedRuntimeSocketPath(primarySocketPath: string): string {
    const buildHash = computeLocalRuntimeBuildHash()?.slice(0, 12) ?? "runtime";
    const version = this.appVersion.replace(/[^a-zA-Z0-9_.-]+/g, "-") || "version";
    const socketKey = createHash("sha256").update(`${version}:${buildHash}`).digest("hex").slice(0, 8);
    const runtimeName = `i-${socketKey}.sock`;
    if (isAdeRuntimeNamedPipePath(primarySocketPath)) {
      return `${primarySocketPath}-${version}-${buildHash}`;
    }
    const dir = path.dirname(primarySocketPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
    return path.join(dir, runtimeName);
  }

  private async startIsolatedRuntime(
    primarySocketPath: string,
    reason: LocalRuntimeCompatibilityError,
  ): Promise<LocalRuntimeConnection> {
    const socketPath = this.isolatedRuntimeSocketPath(primarySocketPath);
    this.logger.warn("local_runtime.incompatible_preserved", {
      primarySocketPath,
      isolatedSocketPath: socketPath,
      pid: reason.pid,
      reason: reason.message,
    });
    try {
      const client = await this.connectClient(socketPath, { preserveVersionSkew: true });
      this.ownedRuntimeChild = null;
      this.scheduleIsolatedRuntimeRecovery(primarySocketPath);
      return { client, child: null, socketPath };
    } catch (error) {
      if (error instanceof LocalRuntimeCompatibilityError) {
        throw error;
      }
      this.logger.debug("local_runtime.connect_isolated_failed", {
        socketPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await unlinkSocketIfNotListening(socketPath);
    const child = this.spawnRuntime(socketPath, { ...this.options, disableSync: true });
    try {
      await waitForSocket(socketPath);
      const client = await this.connectClient(socketPath, { preserveVersionSkew: true });
      this.scheduleIsolatedRuntimeRecovery(primarySocketPath);
      return { client, child, socketPath };
    } catch (error) {
      disposeOwnedRuntimeChild(child, socketPath, { unlinkSocket: true });
      throw error;
    }
  }

  // An isolated no-sync runtime is a degraded last resort: the desktop loses
  // mobile sync and the channel brain's shared state for the whole session.
  // Keep probing the primary socket and migrate back the moment a compatible
  // brain is reachable; consumers recover through the normal disconnect path,
  // exactly as they do when a brain is recycled on a build-hash mismatch.
  private scheduleIsolatedRuntimeRecovery(primarySocketPath: string): void {
    this.markIsolatedMode(true);
    if (this.isolatedRecoveryTimer) return;
    const timer = setInterval(() => {
      void this.tryRecoverFromIsolatedRuntime(primarySocketPath);
    }, 20_000);
    timer.unref?.();
    this.isolatedRecoveryTimer = timer;
  }

  private clearIsolatedRecoveryTimer(): void {
    if (!this.isolatedRecoveryTimer) return;
    clearInterval(this.isolatedRecoveryTimer);
    this.isolatedRecoveryTimer = null;
  }

  private markIsolatedMode(active: boolean, options: { notify?: boolean } = {}): void {
    if (this.isolatedModeActive === active) return;
    this.isolatedModeActive = active;
    if (options.notify === false) return;
    try {
      this.options.onRuntimeModeChange?.(active ? "isolated" : "primary");
    } catch (error) {
      this.logger.warn("local_runtime.runtime_mode_listener_failed", {
        mode: active ? "isolated" : "primary",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.emitRuntimeStatusChange();
  }

  private async tryRecoverFromIsolatedRuntime(primarySocketPath: string): Promise<void> {
    const entry = this.activeConnection;
    if (!entry || entry.socketPath === primarySocketPath) {
      this.clearIsolatedRecoveryTimer();
      // No active isolated connection: either we reconnected to the primary
      // socket through the normal path (a real recovery worth announcing) or
      // the connection is simply gone (stay quiet).
      this.markIsolatedMode(false, { notify: entry != null });
      return;
    }
    if (!(await this.probeCompatibleRuntime(primarySocketPath))) {
      if (this.versionSkewStatus.state === "runtime_newer") {
        this.logger.info("local_runtime.isolated_recovery_waiting_for_desktop_update", {
          primarySocketPath,
          appVersion: this.versionSkewStatus.appVersion,
          runtimeVersion: this.versionSkewStatus.runtimeVersion,
        });
        return;
      }
      // The probe alone can never succeed when the service (re)install failed:
      // nothing is going to bind a compatible brain to the primary socket. Keep
      // re-attempting the install (cooled down) so a transient launchctl
      // failure does not strand this desktop in no-sync mode forever.
      await this.retryServiceInstallForIsolatedRecovery();
      return;
    }
    this.logger.info("local_runtime.isolated_recovery", {
      primarySocketPath,
      isolatedSocketPath: entry.socketPath,
    });
    // Confirm the isolated connection is still current BEFORE tearing down the
    // recovery timer. If a connection swap raced during the probe above, bail
    // with the timer intact so the next tick re-evaluates — clearing the timer
    // first would strand us in "isolated" mode with no further recovery.
    if (!this.clearConnectionIfCurrent(entry)) return;
    this.clearIsolatedRecoveryTimer();
    this.markIsolatedMode(false);
    this.clearVersionSkewStatus();
    closeRuntimeClient(entry.client);
    if (this.ownedRuntimeChild === entry.child) this.ownedRuntimeChild = null;
    disposeOwnedRuntimeChild(entry.child, entry.socketPath, { unlinkSocket: true });
  }

  private async retryServiceInstallForIsolatedRecovery(): Promise<void> {
    if (!this.options.preferServiceRepair) return;
    if (this.serviceInstallStatus.state === "skipped" || this.serviceInstallStatus.state === "installing") return;
    const now = Date.now();
    if (now - this.lastIsolatedServiceRepairMs < 60_000) return;
    this.lastIsolatedServiceRepairMs = now;
    this.logger.info("local_runtime.isolated_recovery_service_reinstall", {
      serviceState: this.serviceInstallStatus.state,
      serviceMessage: this.serviceInstallStatus.message,
    });
    await this.installServiceBestEffort();
  }

  // Compatibility check with no side effects on pool state, safe to run while
  // another connection is active.
  private async probeCompatibleRuntime(socketPath: string): Promise<boolean> {
    let client: RuntimeRpcClient | null = null;
    try {
      const transport = await openSocketTransport(socketPath);
      client = new RuntimeRpcClient(transport);
      const initializeResult = await client.initialize("ade-desktop-local-probe", this.appVersion);
      const runtimeInfo = readLocalRuntimeInfo(initializeResult);
      return this.runtimeCompatibilityError(socketPath, runtimeInfo) == null;
    } catch {
      return false;
    } finally {
      if (client) closeRuntimeClient(client);
    }
  }

  private releaseBuildOutputRuntimeBlock(): { cliPath: string; message: string } | null {
    return localReleaseBuildOutputRuntimeBlock(resolveCliScriptPath());
  }

  private async connectClient(
    socketPath: string,
    options: { preserveVersionSkew?: boolean } = {},
  ): Promise<RuntimeRpcClient> {
    const transport = await openSocketTransport(socketPath);
    const client = new RuntimeRpcClient(transport);
    let initializeResult: unknown;
    try {
      initializeResult = await client.initialize("ade-desktop-local", this.appVersion, {
        desktopBridgeAuthToken: this.options.desktopBridgeAuthToken,
      });
    } catch (error) {
      closeRuntimeClient(client);
      throw error;
    }
    const runtimeInfo = readLocalRuntimeInfo(initializeResult);
    const compatibilityError = this.runtimeCompatibilityError(socketPath, runtimeInfo);
    if (compatibilityError) {
      closeRuntimeClient(client);
      throw compatibilityError;
    }
    if (!options.preserveVersionSkew) {
      this.clearVersionSkewStatus();
    }
    this.activeClient = client;
    this.activeRuntimePid = runtimeInfo.pid;
    this.activeRuntimeSyncPort = runtimeInfo.syncPort;
    this.activeRuntimePublishHealth = runtimeInfo.publishHealth;
    this.activeRuntimeLastWedge = runtimeInfo.lastWedge;
    this.emitRuntimeStatusChange();
    client.onDisconnect((error) => {
      if (this.activeClient !== client && this.activeConnection?.client !== client) return;
      this.logger.warn("local_runtime.disconnected", {
        socketPath,
        error: error.message,
      });
      this.connection = null;
      this.activeConnection = null;
      this.activeClient = null;
      this.activeRuntimePid = null;
      this.activeRuntimeSyncPort = null;
      this.activeRuntimePublishHealth = null;
      this.activeRuntimeLastWedge = null;
      this.projectsByRoot.clear();
      this.emitRuntimeStatusChange();
    });
    return client;
  }

  private spawnRuntime(
    socketPath: string,
    options: { disableSync?: boolean } = this.options,
  ): ChildProcess {
    const cliPath = resolveCliScriptPath();
    const args = buildLocalRuntimeServeArgs(cliPath, socketPath, options);
    this.logger.info("local_runtime.spawn", { cliPath, socketPath, disableSync: options.disableSync === true });
    const env = buildLocalRuntimeNodeEnv(this.appVersion);
    env.ADE_RUNTIME_PARENT_PID = String(process.pid);
    const buildHash = computeLocalRuntimeBuildHash(cliPath);
    if (buildHash) env.ADE_RUNTIME_BUILD_HASH = buildHash;
    const child = spawn(process.execPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    this.ownedRuntimeChild = child;
    const outputBase = {
      logger: this.logger,
      socketPath,
      pid: typeof child.pid === "number" ? child.pid : null,
    };
    const stdoutLogger = createLocalRuntimeOutputLogger({ ...outputBase, stream: "stdout" });
    const stderrLogger = createLocalRuntimeOutputLogger({ ...outputBase, stream: "stderr" });
    child.stdout?.on("data", stdoutLogger.push);
    child.stderr?.on("data", stderrLogger.push);
    const flushOutput = (): void => {
      stdoutLogger.flush();
      stderrLogger.flush();
    };
    child.once("close", () => {
      flushOutput();
    });
    const clearCurrentChildState = (): void => {
      if (this.ownedRuntimeChild !== child) return;
      const client = this.activeClient;
      this.ownedRuntimeChild = null;
      this.connection = null;
      this.activeConnection = null;
      this.activeClient = null;
      this.activeRuntimePid = null;
      this.activeRuntimeSyncPort = null;
      this.activeRuntimePublishHealth = null;
      this.activeRuntimeLastWedge = null;
      this.projectsByRoot.clear();
      if (client) closeRuntimeClient(client);
    };
    child.once("exit", (code, signal) => {
      flushOutput();
      this.logger.warn("local_runtime.exited", { code, signal, pid: outputBase.pid, socketPath });
      clearCurrentChildState();
    });
    child.once("error", (error) => {
      flushOutput();
      this.logger.warn("local_runtime.spawn_failed", { error: error.message, pid: outputBase.pid, socketPath });
      clearCurrentChildState();
    });
    return child;
  }
}

function clampCursor(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function clampLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(1000, Math.floor(value)))
    : 100;
}

function isRemoteRuntimeEventCategory(value: unknown): value is RemoteRuntimeEventCategory {
  return value === "orchestrator" || value === "dag_mutation" || value === "runtime" || value === "pty";
}

function normalizeBufferedEvent(value: unknown): RemoteRuntimeBufferedEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "number" || !Number.isFinite(record.id)) return null;
  if (typeof record.timestamp !== "string") return null;
  if (!isRemoteRuntimeEventCategory(record.category)) return null;
  const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown>
    : {};
  return {
    id: Math.max(0, Math.floor(record.id)),
    timestamp: record.timestamp,
    category: record.category,
    payload,
  };
}

function normalizeAdeActionRegistry(value: unknown): AdeActionRegistryEntry[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Local ADE service did not return an action registry.");
  }
  const record = value as Record<string, unknown>;
  if (record.ok === false) {
    const error = record.error && typeof record.error === "object" && !Array.isArray(record.error)
      ? record.error as Record<string, unknown>
      : {};
    throw new Error(typeof error.message === "string" ? error.message : "Local ADE service action registry lookup failed.");
  }
  const rawActions = Array.isArray(record.actions) ? record.actions : null;
  if (!rawActions) {
    throw new Error("Local ADE service did not return an action registry.");
  }

  const grouped = new Map<string, Map<string, { name: string; description?: string }>>();
  for (const raw of rawActions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const action = raw as Record<string, unknown>;
    const domain = typeof action.domain === "string" && action.domain.trim() ? action.domain.trim() : null;
    const name = typeof action.action === "string" && action.action.trim() ? action.action.trim() : null;
    if (!domain || !name) continue;
    const description = typeof action.description === "string" && action.description.trim()
      ? action.description.trim()
      : undefined;
    let actions = grouped.get(domain);
    if (!actions) {
      actions = new Map();
      grouped.set(domain, actions);
    }
    actions.set(name, description ? { name, description } : { name });
  }

  return Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([domain, actions]) => ({
      domain,
      actions: Array.from(actions.values()).sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

async function subscribeToRuntimeEvents(
  client: RuntimeRpcClient,
  projectId: string,
  request: RemoteRuntimeStreamEventsRequest,
  onEvent: (event: RemoteRuntimeBufferedEvent, eventEpoch?: string | null) => void,
  onEnded?: () => void,
  onSubscribed?: (result: RemoteRuntimeStreamEventsResult) => void,
): Promise<() => void> {
  const pendingNotifications: RuntimeEventNotification[] = [];
  let closed = false;
  let subscriptionId: string | null = null;

  const removeNotificationListener = client.onNotification("runtime/event", (params) => {
    if (closed) return;
    const notification = normalizeRuntimeEventNotification(params);
    if (!notification || notification.projectId !== projectId) return;
    if (subscriptionId == null) {
      pendingNotifications.push(notification);
      return;
    }
    if (notification.subscriptionId === subscriptionId) {
      onEvent(notification.event, notification.eventEpoch);
    }
  });
  const removeDisconnectListener = client.onDisconnect(() => {
    if (closed) return;
    closed = true;
    removeNotificationListener();
    onEnded?.();
  });

  try {
    const value = await client.call("runtimeEvents.subscribe", {
      projectId,
      cursor: clampCursor(request.cursor),
      limit: clampLimit(request.limit),
      ...(isRemoteRuntimeEventCategory(request.category) ? { category: request.category } : {}),
      ...(typeof request.replay === "boolean" ? { replay: request.replay } : {}),
    }, { timeoutMs: LOCAL_RUNTIME_EVENT_POLL_TIMEOUT_MS });
    subscriptionId = readSubscriptionId(value);
    onSubscribed?.(normalizeRuntimeEventsSubscribeResult(value, request.cursor));
    for (const notification of pendingNotifications) {
      if (closed) break;
      if (notification.subscriptionId === subscriptionId) {
        onEvent(notification.event, notification.eventEpoch);
      }
    }
  } catch (error) {
    closed = true;
    removeNotificationListener();
    removeDisconnectListener();
    throw error;
  }

  return () => {
    if (closed) return;
    closed = true;
    removeNotificationListener();
    removeDisconnectListener();
    const id = subscriptionId;
    if (id != null) {
      void client.call("runtimeEvents.unsubscribe", { subscriptionId: id }).catch(() => {});
    }
  };
}

function normalizeRuntimeEventsSubscribeResult(
  value: unknown,
  fallbackCursor: number | undefined,
): RemoteRuntimeStreamEventsResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      events: [],
      nextCursor: clampCursor(fallbackCursor),
      hasMore: false,
    };
  }
  const record = value as Record<string, unknown>;
  const eventEpoch = typeof record.eventEpoch === "string" && record.eventEpoch.trim()
    ? record.eventEpoch.trim()
    : null;
  return {
    events: [],
    nextCursor: typeof record.nextCursor === "number" && Number.isFinite(record.nextCursor)
      ? Math.max(0, Math.floor(record.nextCursor))
      : clampCursor(fallbackCursor),
    hasMore: record.hasMore === true,
    ...(eventEpoch ? { eventEpoch } : {}),
    ...(record.gap === true ? { gap: true } : {}),
    ...(typeof record.oldestCursor === "number" && Number.isFinite(record.oldestCursor)
      ? { oldestCursor: Math.max(0, Math.floor(record.oldestCursor)) }
      : {}),
  };
}

function readSubscriptionId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ADE service event subscription did not return a subscription id.");
  }
  const id = (value as Record<string, unknown>).subscriptionId;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("ADE service event subscription did not return a subscription id.");
  }
  return id.trim();
}

function normalizeRuntimeEventNotification(value: unknown): RuntimeEventNotification | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const subscriptionId = typeof record.subscriptionId === "string" && record.subscriptionId.trim()
    ? record.subscriptionId.trim()
    : null;
  const projectId = typeof record.projectId === "string" ? record.projectId : "";
  const event = normalizeBufferedEvent(record.event);
  const eventEpoch = typeof record.eventEpoch === "string" && record.eventEpoch.trim()
    ? record.eventEpoch.trim()
    : null;
  if (subscriptionId == null || !projectId || !event) return null;
  return { subscriptionId, projectId, event, eventEpoch };
}
