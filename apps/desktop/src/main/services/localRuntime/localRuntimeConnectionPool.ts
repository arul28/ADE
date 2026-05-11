import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { app } from "electron";
import { isAdeMcpNamedPipePath } from "../../../shared/adeMcpIpc";
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
  LocalRuntimeStatus,
  SyncDeviceRecord,
  SyncDeviceRuntimeState,
  SyncGetStatusArgs,
  SyncPeerDeviceType,
  SyncRoleSnapshot,
} from "../../../shared/types";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { RuntimeRpcClient, type RuntimeRpcTransport } from "../remoteRuntime/runtimeRpcClient";
import { coerceProjects } from "../remoteRuntime/remoteBootstrap";
import type { Logger } from "../logging/logger";
import { getRuntimeServiceStatus, type ServiceManagerStatusResult } from "../../../../../ade-cli/src/serviceManager";

type LocalRuntimeConnection = {
  client: RuntimeRpcClient;
  child: ChildProcess | null;
  socketPath: string;
};

type RuntimeEventNotification = {
  subscriptionId: string;
  projectId: string;
  event: RemoteRuntimeBufferedEvent;
};

type RuntimeServiceManagerOutput = {
  ok: boolean | null;
  path: string | null;
  message: string | null;
};

type LocalRuntimeConnectionPoolOptions = {
  disableSync?: boolean;
  queryServiceStatus?: () => ServiceManagerStatusResult;
};

type LocalRuntimeNodePathOptions = {
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  existingNodePath?: string;
};

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
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const entries: string[] = [];

  if (resourcesPath) {
    if (platform === "darwin") {
      const archAsar = arch === "arm64" ? "app-arm64.asar" : "app-x64.asar";
      entries.push(
        path.join(resourcesPath, `${archAsar}.unpacked`, "node_modules"),
        path.join(resourcesPath, "app.asar.unpacked", "node_modules"),
        path.join(resourcesPath, archAsar, "node_modules"),
        path.join(resourcesPath, "app.asar", "node_modules"),
      );
    } else {
      entries.push(
        path.join(resourcesPath, "app.asar.unpacked", "node_modules"),
        path.join(resourcesPath, "app.asar", "node_modules"),
      );
    }
  }

  const existingNodePath = options.existingNodePath ?? process.env.NODE_PATH;
  if (existingNodePath?.trim()) entries.push(existingNodePath);
  return entries.length ? entries.join(path.delimiter) : undefined;
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

function openSocketTransport(socketPath: string, timeoutMs = 3_000): Promise<RuntimeRpcTransport> {
  return new Promise((resolve, reject) => {
    const socket = isAdeMcpNamedPipePath(socketPath)
      ? net.createConnection(socketPath)
      : net.createConnection({ path: socketPath });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`Timed out connecting to ADE service socket: ${socketPath}`));
    }, timeoutMs);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("error", fail);
      const closeCallbacks = new Set<() => void>();
      const errorCallbacks = new Set<(error: Error) => void>();
      socket.on("error", (error) => {
        for (const callback of [...errorCallbacks]) {
          callback(error);
        }
      });
      socket.on("close", () => {
        for (const callback of [...closeCallbacks]) {
          callback();
        }
      });
      resolve({
        onData(callback) {
          socket.on("data", (chunk) => callback(Buffer.from(chunk)));
        },
        onClose(callback) {
          closeCallbacks.add(callback);
        },
        onError(callback) {
          errorCallbacks.add(callback);
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

function readRuntimeInfo(value: unknown): { version: string | null; buildHash: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: null, buildHash: null };
  }
  const runtimeInfo = (value as { runtimeInfo?: unknown }).runtimeInfo;
  if (!runtimeInfo || typeof runtimeInfo !== "object" || Array.isArray(runtimeInfo)) {
    return { version: null, buildHash: null };
  }
  const version = (runtimeInfo as { version?: unknown }).version;
  const buildHash = (runtimeInfo as { buildHash?: unknown }).buildHash;
  return {
    version: typeof version === "string" && version.trim() ? version.trim() : null,
    buildHash: typeof buildHash === "string" && buildHash.trim() ? buildHash.trim() : null,
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

async function shutdownRuntimeClient(client: RuntimeRpcClient): Promise<void> {
  try {
    await client.call("shutdown", {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("socket closed")) throw error;
  } finally {
    try { client.close(); } catch {}
  }
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
  private connection: Promise<LocalRuntimeConnection> | null = null;
  private activeClient: RuntimeRpcClient | null = null;
  private readonly projectsByRoot = new Map<string, RemoteRuntimeProjectRecord>();
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
  private serviceHealthCheckedAtMs = 0;

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
    return {
      connectionState: this.activeClient
        ? "connected"
        : this.connection
          ? "connecting"
          : "idle",
      serviceInstall: { ...this.serviceInstallStatus },
      serviceHealth: { ...this.serviceHealthStatus },
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

  async installServiceBestEffort(): Promise<void> {
    const cliPath = resolveCliScriptPath();
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
        env: buildLocalRuntimeNodeEnv(this.appVersion),
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

  async ensureProject(rootPath: string): Promise<RemoteRuntimeProjectRecord> {
    const normalizedRoot = path.resolve(rootPath);
    const cached = this.projectsByRoot.get(normalizedRoot);
    if (cached) return cached;
    const entry = await this.connect();
    const project = await entry.client.call("projects.add", { rootPath: normalizedRoot });
    const record = coerceProjects([project])[0];
    if (!record) throw new Error("Local ADE service did not return a project record.");
    this.projectsByRoot.set(normalizedRoot, record);
    return record;
  }

  async projects(): Promise<RemoteRuntimeProjectRecord[]> {
    const entry = await this.connect();
    return coerceProjects(await entry.client.call("projects.list", {}));
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

  async callActionForRoot(
    rootPath: string,
    request: RemoteRuntimeActionRequest,
  ): Promise<RemoteRuntimeActionResult> {
    const project = await this.ensureProject(rootPath);
    const entry = await this.connect();
    const value = await entry.client.call("ade/actions/call", {
      projectId: project.projectId,
      name: "run_ade_action",
      arguments: {
        domain: request.domain,
        action: request.action,
        ...(request.args ? { args: request.args } : {}),
        ...(Object.prototype.hasOwnProperty.call(request, "arg") ? { arg: request.arg } : {}),
        ...(request.argsList ? { argsList: request.argsList } : {}),
      },
    });

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

  async streamEventsForRoot(
    rootPath: string,
    request: RemoteRuntimeStreamEventsRequest = {},
  ): Promise<RemoteRuntimeStreamEventsResult> {
    const project = await this.ensureProject(rootPath);
    const entry = await this.connect();
    const value = await entry.client.call("ade/actions/call", {
      projectId: project.projectId,
      name: "stream_events",
      arguments: {
        cursor: clampCursor(request.cursor),
        limit: clampLimit(request.limit),
        ...(isRemoteRuntimeEventCategory(request.category) ? { category: request.category } : {}),
      },
    });

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (record.ok === false) {
        const error = record.error && typeof record.error === "object" && !Array.isArray(record.error)
          ? record.error as Record<string, unknown>
          : {};
        throw new Error(typeof error.message === "string" ? error.message : "Local ADE service event stream failed.");
      }

      return {
        events: Array.isArray(record.events)
          ? record.events.map(normalizeBufferedEvent).filter((event): event is RemoteRuntimeBufferedEvent => event != null)
          : [],
        nextCursor: typeof record.nextCursor === "number" && Number.isFinite(record.nextCursor)
          ? Math.max(0, Math.floor(record.nextCursor))
          : clampCursor(request.cursor),
        hasMore: record.hasMore === true,
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
    onEvent: (event: RemoteRuntimeBufferedEvent) => void,
    onEnded?: () => void,
  ): Promise<() => void> {
    const project = await this.ensureProject(rootPath);
    const entry = await this.connect();
    return await subscribeToRuntimeEvents(entry.client, project.projectId, request, onEvent, onEnded);
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
    }) as T;
  }

  dispose(): void {
    const pending = this.connection;
    this.connection = null;
    this.activeClient = null;
    this.projectsByRoot.clear();
    void pending?.then((entry) => {
      try { entry.client.close(); } catch {}
    }).catch(() => {});
  }

  private async connect(): Promise<LocalRuntimeConnection> {
    if (this.connection) return this.connection;
    this.connection = this.createConnection().catch((error) => {
      this.connection = null;
      throw error;
    });
    return this.connection;
  }

  private async createConnection(): Promise<LocalRuntimeConnection> {
    const layout = resolveMachineAdeLayout();
    const socketPath = process.env.ADE_RUNTIME_SOCKET_PATH?.trim() || layout.socketPath;
    const existing = await this.tryConnect(socketPath);
    if (existing) return { client: existing, child: null, socketPath };

    const child = this.spawnRuntime(socketPath);
    await waitForSocket(socketPath);
    const client = await this.connectClient(socketPath);
    return { client, child, socketPath };
  }

  private async tryConnect(socketPath: string): Promise<RuntimeRpcClient | null> {
    try {
      return await this.connectClient(socketPath);
    } catch (error) {
      this.logger.debug("local_runtime.connect_existing_failed", {
        socketPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async connectClient(socketPath: string): Promise<RuntimeRpcClient> {
    const transport = await openSocketTransport(socketPath);
    const client = new RuntimeRpcClient(transport);
    const initializeResult = await client.initialize("ade-desktop-local", this.appVersion);
    const runtimeInfo = readRuntimeInfo(initializeResult);
    if (runtimeInfo.version && runtimeInfo.version !== this.appVersion) {
      this.logger.info("local_runtime.version_mismatch_restart", {
        socketPath,
        runtimeVersion: runtimeInfo.version,
        appVersion: this.appVersion,
      });
      await shutdownRuntimeClient(client);
      throw new Error(`ADE service version ${runtimeInfo.version} does not match desktop version ${this.appVersion}.`);
    }
    const expectedBuildHash = computeLocalRuntimeBuildHash();
    if (expectedBuildHash && runtimeInfo.buildHash !== expectedBuildHash) {
      this.logger.info("local_runtime.build_mismatch_restart", {
        socketPath,
        runtimeBuildHash: runtimeInfo.buildHash,
        expectedBuildHash,
      });
      await shutdownRuntimeClient(client);
      throw new Error("ADE service build does not match the packaged desktop runtime.");
    }
    this.activeClient = client;
    client.onDisconnect((error) => {
      if (this.activeClient !== client) return;
      this.logger.warn("local_runtime.disconnected", {
        socketPath,
        error: error.message,
      });
      this.connection = null;
      this.activeClient = null;
      this.projectsByRoot.clear();
    });
    return client;
  }

  private spawnRuntime(socketPath: string): ChildProcess {
    const cliPath = resolveCliScriptPath();
    const args = buildLocalRuntimeServeArgs(cliPath, socketPath, this.options);
    this.logger.info("local_runtime.spawn", { cliPath, socketPath, disableSync: this.options.disableSync === true });
    const env = buildLocalRuntimeNodeEnv(this.appVersion);
    const buildHash = computeLocalRuntimeBuildHash(cliPath);
    if (buildHash) env.ADE_RUNTIME_BUILD_HASH = buildHash;
    const child = spawn(process.execPath, args, {
      env,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    child.once("exit", (code, signal) => {
      this.logger.warn("local_runtime.exited", { code, signal });
      this.connection = null;
    });
    child.once("error", (error) => {
      this.logger.warn("local_runtime.spawn_failed", { error: error.message });
      this.connection = null;
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
  return value === "orchestrator" || value === "dag_mutation" || value === "runtime" || value === "mission";
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

async function subscribeToRuntimeEvents(
  client: RuntimeRpcClient,
  projectId: string,
  request: RemoteRuntimeStreamEventsRequest,
  onEvent: (event: RemoteRuntimeBufferedEvent) => void,
  onEnded?: () => void,
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
      onEvent(notification.event);
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
    });
    subscriptionId = readSubscriptionId(value);
    for (const notification of pendingNotifications) {
      if (closed) break;
      if (notification.subscriptionId === subscriptionId) {
        onEvent(notification.event);
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
  if (subscriptionId == null || !projectId || !event) return null;
  return { subscriptionId, projectId, event };
}
