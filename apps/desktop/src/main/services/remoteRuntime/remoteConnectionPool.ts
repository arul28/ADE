import { app } from "electron";
import net from "node:net";
import type { Client } from "ssh2";
import type {
  RemoteRuntimeActionRequest,
  RemoteRuntimeActionResult,
  RemoteRuntimeBufferedEvent,
  RemoteRuntimeConnectResult,
  RemoteRuntimeEventCategory,
  RemoteRuntimePortForward,
  RemoteRuntimePortForwardRequest,
  RemoteRuntimeMachineProjectCapability,
  RemoteRuntimeStreamEventsRequest,
  RemoteRuntimeStreamEventsResult,
  RemoteRuntimeProjectRecord,
  RemoteRuntimeTarget,
} from "../../../shared/types/remoteRuntime";
import type { AdeActionRegistryEntry } from "../../../shared/types/automations";
import type { RuntimeRpcClient } from "./runtimeRpcClient";
import { bootstrapRemoteRuntime, ensureRemoteProject } from "./remoteBootstrap";
import type { RemoteTargetRegistry } from "./remoteTargetRegistry";

type PoolEntry = {
  client: RuntimeRpcClient;
  ssh: Client;
  result: RemoteRuntimeConnectResult;
  dispose?: (closeClient: boolean, notify?: boolean) => void;
};

type LocalPortForwardEntry = RemoteRuntimePortForward & {
  server: net.Server;
};

function closePoolEntryResources(
  entry: PoolEntry,
  closeClient: boolean,
  forceSshDestroy = false,
): void {
  if (closeClient) {
    try {
      entry.client.close();
    } catch {}
  }
  try {
    entry.ssh.end();
  } catch {}
  if (forceSshDestroy) {
    try {
      (entry.ssh as unknown as { destroy?: () => void }).destroy?.();
    } catch {}
  }
}

type RuntimeEventNotification = {
  subscriptionId: string;
  projectId: string;
  event: RemoteRuntimeBufferedEvent;
};

type ConnectFailureBackoff = {
  error: Error;
  failureCount: number;
  retryAfterMs: number;
};

type RemoteConnectionPoolConnectOptions = {
  bypassFailureBackoff?: boolean;
};

function isRemoteRuntimeConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /remote (?:runtime|ADE service) connection (?:closed|failed)|timed out waiting for method|stream closed|channel closed|connection lost|socket closed|ECONNRESET|ECONNABORTED|EPIPE|ENOTCONN/i.test(
    message,
  );
}

const RETRYABLE_REMOTE_ACTION_RPC_TIMEOUT_MS = 25_000;
const CONNECT_FAILURE_BASE_BACKOFF_MS = 3_000;
const CONNECT_FAILURE_MAX_BACKOFF_MS = 15_000;
const LOCAL_FORWARD_HOST = "127.0.0.1";

const RETRYABLE_REMOTE_ACTION_PREFIXES = [
  "diagnosticsGet",
  "get",
  "list",
  "oauthGet",
  "oauthList",
  "portGet",
  "portList",
  "proxyGet",
  "read",
  "search",
] as const;

const RETRYABLE_REMOTE_ACTIONS = new Set([
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

/** Project-scoped sync RPCs that are safe to replay after a reconnect. */
const RETRYABLE_REMOTE_SYNC_METHODS = new Set([
  "sync.getStatus",
  "sync.refreshDiscovery",
  "sync.listDevices",
  "sync.getTransferReadiness",
  "sync.getPin",
  "sync.setActiveLanePresence",
  "modelPicker.getFavorites",
  "modelPicker.getRecents",
]);

const MACHINE_PROJECT_METHOD_CAPABILITY = new Map<string, RemoteRuntimeMachineProjectCapability>([
  ["projects.browseDirectories", "browseDirectories"],
  ["projects.getDetail", "getDetail"],
  ["projects.getWorkSummary", "getWorkSummary"],
  ["projects.getDefaultParentDir", "getDefaultParentDir"],
  ["projects.create", "create"],
  ["projects.clone", "clone"],
  ["projects.listMyGitHubRepos", "listMyGitHubRepos"],
]);

const MACHINE_PROJECT_CAPABILITY_LABEL: Record<RemoteRuntimeMachineProjectCapability, string> = {
  browseDirectories: "browsing remote directories",
  getDetail: "reading remote project details",
  getWorkSummary: "checking remote worktree state",
  getDefaultParentDir: "reading the default remote project folder",
  create: "creating remote projects",
  clone: "cloning remote projects",
  listMyGitHubRepos: "listing GitHub repositories on the remote machine",
};

function shouldRetryRemoteRuntimeAction(
  request: RemoteRuntimeActionRequest,
): boolean {
  if (RETRYABLE_REMOTE_ACTIONS.has(`${request.domain}.${request.action}`)) {
    return true;
  }
  return RETRYABLE_REMOTE_ACTION_PREFIXES.some((prefix) =>
    request.action.startsWith(prefix),
  );
}

function remoteRuntimeActionCallOptions(
  request: RemoteRuntimeActionRequest,
): { timeoutMs?: number } | undefined {
  return shouldRetryRemoteRuntimeAction(request)
    ? { timeoutMs: RETRYABLE_REMOTE_ACTION_RPC_TIMEOUT_MS }
    : undefined;
}

function normalizeForwardRemoteHost(value: string | null | undefined): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || "127.0.0.1";
}

function normalizeForwardPort(value: unknown): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Remote port must be an integer from 1 to 65535 (received ${String(value)}).`);
  }
  return port;
}

function portForwardKey(targetId: string, remoteHost: string, remotePort: number): string {
  return `${targetId}\0${remoteHost}\0${remotePort}`;
}

function snapshotPortForward(entry: LocalPortForwardEntry): RemoteRuntimePortForward {
  const {
    targetId,
    remoteHost,
    remotePort,
    localHost,
    localPort,
    localUrl,
    label,
    createdAt,
    lastUsedAt,
  } = entry;
  return {
    targetId,
    remoteHost,
    remotePort,
    localHost,
    localPort,
    localUrl,
    label,
    createdAt,
    lastUsedAt,
  };
}

function assertMachineProjectCapability(entry: PoolEntry, method: string): void {
  const capability = MACHINE_PROJECT_METHOD_CAPABILITY.get(method);
  if (!capability) return;
  if (entry.result.capabilities?.machineProjects?.[capability] === true) return;
  const version = entry.result.version ? ` ${entry.result.version}` : "";
  throw new Error(
    `Remote ADE service${version} does not support ${MACHINE_PROJECT_CAPABILITY_LABEL[capability]}. ` +
      "Update ADE on that machine, or connect with a runtime that advertises this project capability.",
  );
}

function optionalRemoteActionFallbackResult(
  request: RemoteRuntimeActionRequest,
): RemoteRuntimeActionResult | null {
  if (request.domain === "file" && request.action === "refreshGitDecorations") {
    const args = request.args && typeof request.args === "object" && !Array.isArray(request.args)
      ? request.args as Record<string, unknown>
      : {};
    const workspaceId = typeof args.workspaceId === "string" && args.workspaceId.trim()
      ? args.workspaceId.trim()
      : "primary";
    return {
      domain: "file",
      action: "refreshGitDecorations",
      result: {
        workspaceId,
        files: [],
        directories: [],
      },
      statusHints: {
        optionalActionMissing: true,
      },
    };
  }
  if (request.domain === "pr" && request.action === "listQueueStates") {
    return {
      domain: "pr",
      action: "listQueueStates",
      result: [],
      statusHints: {
        optionalActionMissing: true,
      },
    };
  }
  return null;
}

function isRemoteActionNotCallableMessage(message: string): boolean {
  return /not callable|not exposed|not available|unknown action/i.test(message);
}

function isRemoteActionNotCallableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return isRemoteActionNotCallableMessage(message);
}

function unsupportedOptionalActionKey(
  targetId: string,
  projectId: string,
  request: RemoteRuntimeActionRequest,
): string {
  return `${targetId}\0${projectId}\0${request.domain}.${request.action}`;
}

export class RemoteConnectionPool {
  private readonly entries = new Map<string, Promise<PoolEntry>>();
  private readonly localPortForwards = new Map<
    string,
    Promise<LocalPortForwardEntry>
  >();
  private readonly unsupportedOptionalActionKeys = new Set<string>();
  private readonly pendingDisconnects = new Set<string>();
  private readonly resolvedEntryPromises = new Set<Promise<PoolEntry>>();
  private readonly connectFailureBackoffByTargetId = new Map<
    string,
    ConnectFailureBackoff
  >();
  private readonly disconnectGenerationByTargetId = new Map<string, number>();
  private readonly evictionListeners = new Set<
    (targetId: string, error: Error) => void
  >();

  constructor(
    private readonly registry: RemoteTargetRegistry,
    private readonly appVersion: string,
  ) {}

  async connect(
    target: RemoteRuntimeTarget,
    options: RemoteConnectionPoolConnectOptions = {},
  ): Promise<RemoteRuntimeConnectResult> {
    return (await this.connectEntry(target, options)).result;
  }

  onEntryEvicted(listener: (targetId: string, error: Error) => void): () => void {
    this.evictionListeners.add(listener);
    return () => {
      this.evictionListeners.delete(listener);
    };
  }

  /**
   * Register a running Mac VM (with installed ade-runtime) as a remote target.
   * Called by macosVmService when guestReadiness reaches `runtime_ready`. The
   * entry is keyed on the SSH triple so re-registering the same VM is a no-op
   * — we look up an existing target before save() to avoid touching mtime /
   * triggering downstream consumers on repeated runtime-ready events.
   */
  registerMacosVmTarget(args: {
    vmName: string;
    ipAddress: string;
    username: string;
  }): RemoteRuntimeTarget {
    const existing = this.registry.list().find(
      (target) =>
        target.hostname === args.ipAddress
        && target.sshUser === args.username
        && target.port === 22,
    );
    if (existing) return existing;
    return this.registry.save({
      name: `Mac VM · ${args.vmName}`,
      hostname: args.ipAddress,
      sshUser: args.username,
      port: 22,
      sshKeyPath: null,
    });
  }

  private async connectEntry(
    target: RemoteRuntimeTarget,
    options: RemoteConnectionPoolConnectOptions = {},
  ): Promise<PoolEntry> {
    const existing = this.entries.get(target.id);
    if (existing) {
      this.pendingDisconnects.delete(target.id);
      return await existing;
    }
    if (options.bypassFailureBackoff) {
      this.connectFailureBackoffByTargetId.delete(target.id);
    } else {
      this.assertConnectNotBackingOff(target.id);
    }
    const pending = bootstrapRemoteRuntime({
      target,
      registry: this.registry,
      resourcesPath: process.resourcesPath ?? app.getAppPath(),
      appVersion: this.appVersion,
    });
    let entryPromise: Promise<PoolEntry>;
    entryPromise = pending.then(({ client, ssh, result }) => {
      const entry = { client, ssh, result };
      this.clearUnsupportedOptionalActionsForTarget(target.id);
      this.connectFailureBackoffByTargetId.delete(target.id);
      this.resolvedEntryPromises.add(entryPromise);
      this.attachEntryLifecycle(target.id, entryPromise, entry);
      return entry;
    });
    this.entries.set(target.id, entryPromise);
    try {
      return await entryPromise;
    } catch (error) {
      this.entries.delete(target.id);
      this.pendingDisconnects.delete(target.id);
      this.resolvedEntryPromises.delete(entryPromise);
      this.noteConnectFailure(target.id, error);
      throw error;
    }
  }

  async projects(targetId: string): Promise<unknown> {
    const entry = await this.requireEntry(targetId);
    return await entry.client.call("projects.list", {});
  }

  async projectsForTarget(target: RemoteRuntimeTarget): Promise<unknown> {
    return await this.withEntryForTarget(
      target,
      (entry) => entry.client.call("projects.list", {}),
      { retryOnConnectionError: true },
    );
  }

  async callMachineForTarget(
    target: RemoteRuntimeTarget,
    method: string,
    params: Record<string, unknown> = {},
    options: { retryOnConnectionError?: boolean; timeoutMs?: number } = {},
  ): Promise<unknown> {
    return await this.withEntryForTarget(
      target,
      (entry) => {
        assertMachineProjectCapability(entry, method);
        return options.timeoutMs
          ? entry.client.call(method, params, { timeoutMs: options.timeoutMs })
          : entry.client.call(method, params);
      },
      { retryOnConnectionError: options.retryOnConnectionError ?? true },
    );
  }

  async addProject(
    targetId: string,
    rootPath: string,
  ): Promise<RemoteRuntimeProjectRecord> {
    const entry = await this.requireEntry(targetId);
    return await this.addProjectWithEntry(entry, rootPath);
  }

  async addProjectForTarget(
    target: RemoteRuntimeTarget,
    rootPath: string,
  ): Promise<RemoteRuntimeProjectRecord> {
    const entry = await this.connectEntry(target);
    return await this.addProjectWithEntry(entry, rootPath);
  }

  async callAction(
    targetId: string,
    projectId: string,
    request: RemoteRuntimeActionRequest,
  ): Promise<RemoteRuntimeActionResult> {
    const entry = await this.requireEntry(targetId);
    return await this.callActionWithEntry(entry, projectId, request);
  }

  async callActionForTarget(
    target: RemoteRuntimeTarget,
    projectId: string,
    request: RemoteRuntimeActionRequest,
  ): Promise<RemoteRuntimeActionResult> {
    return await this.withEntryForTarget(
      target,
      (entry) => this.callActionWithEntry(entry, projectId, request),
      { retryOnConnectionError: shouldRetryRemoteRuntimeAction(request) },
    );
  }

  async ensureLocalPortForward(
    targetId: string,
    request: RemoteRuntimePortForwardRequest,
  ): Promise<RemoteRuntimePortForward> {
    const remoteHost = normalizeForwardRemoteHost(request.remoteHost);
    const remotePort = normalizeForwardPort(request.remotePort);
    const key = portForwardKey(targetId, remoteHost, remotePort);
    const existing = this.localPortForwards.get(key);
    if (existing) {
      const entry = await existing;
      entry.lastUsedAt = Date.now();
      return snapshotPortForward(entry);
    }

    const pending = (async (): Promise<LocalPortForwardEntry> => {
      const entry = await this.requireEntry(targetId);
      const createdAt = Date.now();
      const label =
        typeof request.label === "string" && request.label.trim()
          ? request.label.trim()
          : null;
      const server = net.createServer((socket) => {
        const activeEntry = this.entries.get(targetId);
        if (!activeEntry) {
          socket.destroy(new Error(`Remote target is not connected: ${targetId}`));
          return;
        }
        entry.ssh.forwardOut(
          LOCAL_FORWARD_HOST,
          0,
          remoteHost,
          remotePort,
          (error, stream) => {
            if (error) {
              socket.destroy(error);
              return;
            }
            const closeBoth = () => {
              try {
                socket.destroy();
              } catch {}
              try {
                stream.destroy();
              } catch {}
            };
            socket.once("error", closeBoth);
            stream.once("error", closeBoth);
            socket.once("close", closeBoth);
            stream.once("close", closeBoth);
            socket.pipe(stream).pipe(socket);
          },
        );
      });

      return await new Promise<LocalPortForwardEntry>((resolve, reject) => {
        let settled = false;
        const rejectStart = (error: Error) => {
          if (settled) return;
          settled = true;
          try {
            server.close();
          } catch {}
          reject(error);
        };
        server.once("error", rejectStart);
        server.listen(0, LOCAL_FORWARD_HOST, () => {
          if (settled) return;
          server.off("error", rejectStart);
          const address = server.address();
          if (!address || typeof address === "string") {
            rejectStart(new Error("Local remote-preview forward did not bind to a TCP port."));
            return;
          }
          settled = true;
          const localPort = address.port;
          const forward: LocalPortForwardEntry = {
            targetId,
            remoteHost,
            remotePort,
            localHost: LOCAL_FORWARD_HOST,
            localPort,
            localUrl: `http://${LOCAL_FORWARD_HOST}:${localPort}`,
            label,
            createdAt,
            lastUsedAt: createdAt,
            server,
          };
          resolve(forward);
        });
      });
    })();
    this.localPortForwards.set(key, pending);
    try {
      const forward = await pending;
      forward.server.once("close", () => {
        if (this.localPortForwards.get(key) === pending) {
          this.localPortForwards.delete(key);
        }
      });
      return snapshotPortForward(forward);
    } catch (error) {
      if (this.localPortForwards.get(key) === pending) {
        this.localPortForwards.delete(key);
      }
      throw error;
    }
  }

  async callSyncForTarget(
    target: RemoteRuntimeTarget,
    projectId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return await this.withEntryForTarget(
      target,
      (entry) => entry.client.call(method, {
        ...params,
        projectId,
      }),
      { retryOnConnectionError: RETRYABLE_REMOTE_SYNC_METHODS.has(method) },
    );
  }

  async listActionRegistryForTarget(
    target: RemoteRuntimeTarget,
    projectId: string,
  ): Promise<AdeActionRegistryEntry[]> {
    return await this.withEntryForTarget(
      target,
      async (entry) => {
        const value = await entry.client.call("ade/actions/call", {
          projectId,
          name: "list_ade_actions",
          arguments: { domain: "all" },
        });
        return normalizeAdeActionRegistry(value);
      },
      { retryOnConnectionError: true },
    );
  }

  private async addProjectWithEntry(
    entry: PoolEntry,
    rootPath: string,
  ): Promise<RemoteRuntimeProjectRecord> {
    const project = await ensureRemoteProject(entry.client, rootPath);
    entry.result.projects = [
      project,
      ...entry.result.projects.filter(
        (candidate) => candidate.projectId !== project.projectId,
      ),
    ];
    return project;
  }

  private async callActionWithEntry(
    entry: PoolEntry,
    projectId: string,
    request: RemoteRuntimeActionRequest,
  ): Promise<RemoteRuntimeActionResult> {
    const optionalFallback = optionalRemoteActionFallbackResult(request);
    const optionalFallbackKey = optionalFallback
      ? unsupportedOptionalActionKey(entry.result.target.id, projectId, request)
      : null;
    if (
      optionalFallback &&
      optionalFallbackKey &&
      this.unsupportedOptionalActionKeys.has(optionalFallbackKey)
    ) {
      return optionalFallback;
    }
    const params = {
      projectId,
      name: "run_ade_action",
      arguments: {
        domain: request.domain,
        action: request.action,
        ...(request.args ? { args: request.args } : {}),
        ...(Object.prototype.hasOwnProperty.call(request, "arg")
          ? { arg: request.arg }
          : {}),
        ...(request.argsList ? { argsList: request.argsList } : {}),
      },
    };
    const callOptions = remoteRuntimeActionCallOptions(request);
    let value: unknown;
    try {
      value = callOptions
        ? await entry.client.call("ade/actions/call", params, callOptions)
        : await entry.client.call("ade/actions/call", params);
    } catch (error) {
      if (optionalFallback && optionalFallbackKey && isRemoteActionNotCallableError(error)) {
        this.unsupportedOptionalActionKeys.add(optionalFallbackKey);
        return optionalFallback;
      }
      throw error;
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (record.ok === false) {
        const error =
          record.error &&
          typeof record.error === "object" &&
          !Array.isArray(record.error)
            ? (record.error as Record<string, unknown>)
            : {};
        const message = typeof error.message === "string"
          ? error.message
          : "Remote ADE service action failed.";
        if (optionalFallback && optionalFallbackKey && isRemoteActionNotCallableMessage(message)) {
          this.unsupportedOptionalActionKeys.add(optionalFallbackKey);
          return optionalFallback;
        }
        throw new Error(
          message,
        );
      }
      return {
        domain:
          typeof record.domain === "string" ? record.domain : request.domain,
        action:
          typeof record.action === "string" ? record.action : request.action,
        result: record.result,
        statusHints:
          record.statusHints &&
          typeof record.statusHints === "object" &&
          !Array.isArray(record.statusHints)
            ? (record.statusHints as Record<string, unknown>)
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

  async streamEvents(
    targetId: string,
    projectId: string,
    request: RemoteRuntimeStreamEventsRequest = {},
  ): Promise<RemoteRuntimeStreamEventsResult> {
    const entry = await this.requireEntry(targetId);
    return await this.streamEventsWithEntry(entry, projectId, request);
  }

  private async streamEventsWithEntry(
    entry: PoolEntry,
    projectId: string,
    request: RemoteRuntimeStreamEventsRequest = {},
  ): Promise<RemoteRuntimeStreamEventsResult> {
    const value = await entry.client.call("ade/actions/call", {
      projectId,
      name: "stream_events",
      arguments: {
        cursor: clampCursor(request.cursor),
        limit: clampLimit(request.limit),
        ...(isRemoteRuntimeEventCategory(request.category)
          ? { category: request.category }
          : {}),
      },
    });

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (record.ok === false) {
        const error =
          record.error &&
          typeof record.error === "object" &&
          !Array.isArray(record.error)
            ? (record.error as Record<string, unknown>)
            : {};
        throw new Error(
          typeof error.message === "string"
            ? error.message
            : "Remote ADE service event stream failed.",
        );
      }

      const eventEpoch =
        typeof record.eventEpoch === "string" && record.eventEpoch.trim()
          ? record.eventEpoch.trim()
          : null;
      return {
        events: Array.isArray(record.events)
          ? record.events
              .map(normalizeBufferedEvent)
              .filter(
                (event): event is RemoteRuntimeBufferedEvent => event != null,
              )
          : [],
        nextCursor:
          typeof record.nextCursor === "number" &&
          Number.isFinite(record.nextCursor)
            ? Math.max(0, Math.floor(record.nextCursor))
            : clampCursor(request.cursor),
        hasMore: record.hasMore === true,
        ...(eventEpoch ? { eventEpoch } : {}),
      };
    }

    return {
      events: [],
      nextCursor: clampCursor(request.cursor),
      hasMore: false,
    };
  }

  async streamEventsForTarget(
    target: RemoteRuntimeTarget,
    projectId: string,
    request: RemoteRuntimeStreamEventsRequest = {},
  ): Promise<RemoteRuntimeStreamEventsResult> {
    return await this.withEntryForTarget(
      target,
      (entry) => this.streamEventsWithEntry(entry, projectId, request),
      { retryOnConnectionError: true },
    );
  }

  async subscribeEvents(
    targetId: string,
    projectId: string,
    request: RemoteRuntimeStreamEventsRequest = {},
    onEvent: (event: RemoteRuntimeBufferedEvent) => void,
    onEnded?: () => void,
  ): Promise<() => void> {
    const entry = await this.requireEntry(targetId);
    return await subscribeToRuntimeEvents(
      entry.client,
      projectId,
      request,
      onEvent,
      onEnded,
    );
  }

  async subscribeEventsForTarget(
    target: RemoteRuntimeTarget,
    projectId: string,
    request: RemoteRuntimeStreamEventsRequest = {},
    onEvent: (event: RemoteRuntimeBufferedEvent) => void,
    onEnded?: () => void,
  ): Promise<() => void> {
    return await this.withEntryForTarget(
      target,
      (entry) =>
        subscribeToRuntimeEvents(
          entry.client,
          projectId,
          request,
          onEvent,
          onEnded,
        ),
      { retryOnConnectionError: true },
    );
  }

  disconnect(targetId: string): void {
    this.bumpDisconnectGeneration(targetId);
    this.closeLocalPortForwardsForTarget(targetId);
    const existing = this.entries.get(targetId);
    if (!existing) return;
    if (this.resolvedEntryPromises.has(existing)) {
      this.entries.delete(targetId);
      this.resolvedEntryPromises.delete(existing);
      void existing
        .then((entry) => {
          if (entry.dispose) {
            entry.dispose(true, false);
            return;
          }
          closePoolEntryResources(entry, true, true);
        })
        .catch(() => {});
      return;
    }
    this.pendingDisconnects.add(targetId);
    void existing
      ?.then((entry) => {
        if (!this.pendingDisconnects.delete(targetId)) return;
        if (this.entries.get(targetId) === existing) {
          this.entries.delete(targetId);
        }
        this.resolvedEntryPromises.delete(existing);
        if (entry.dispose) {
          entry.dispose(true, false);
          return;
        }
        closePoolEntryResources(entry, true, true);
      })
      .catch(() => {
        this.pendingDisconnects.delete(targetId);
        this.resolvedEntryPromises.delete(existing);
        if (this.entries.get(targetId) === existing) {
          this.entries.delete(targetId);
        }
      });
  }

  dispose(): void {
    for (const targetId of [...this.entries.keys()]) {
      this.closeLocalPortForwardsForTarget(targetId);
    }
    for (const targetId of [...this.entries.keys()]) {
      this.disconnect(targetId);
    }
  }

  private closeLocalPortForwardsForTarget(targetId: string): void {
    for (const [key, pending] of [...this.localPortForwards.entries()]) {
      if (!key.startsWith(`${targetId}\0`)) continue;
      this.localPortForwards.delete(key);
      void pending
        .then((entry) => {
          try {
            entry.server.close();
          } catch {}
        })
        .catch(() => {});
    }
  }

  private clearUnsupportedOptionalActionsForTarget(targetId: string): void {
    for (const key of [...this.unsupportedOptionalActionKeys]) {
      if (key.startsWith(`${targetId}\0`)) {
        this.unsupportedOptionalActionKeys.delete(key);
      }
    }
  }

  private async requireEntry(targetId: string): Promise<PoolEntry> {
    const entry = this.entries.get(targetId);
    if (!entry) throw new Error(`Remote target is not connected: ${targetId}`);
    return await entry;
  }

  private async withEntryForTarget<T>(
    target: RemoteRuntimeTarget,
    operation: (entry: PoolEntry) => Promise<T>,
    options: { retryOnConnectionError: boolean },
  ): Promise<T> {
    const entry = await this.connectEntry(target);
    const disconnectGeneration =
      this.disconnectGenerationByTargetId.get(target.id) ?? 0;
    try {
      return await operation(entry);
    } catch (error) {
      if (!isRemoteRuntimeConnectionError(error)) throw error;
      if (
        (this.disconnectGenerationByTargetId.get(target.id) ?? 0) !==
        disconnectGeneration
      ) {
        throw error;
      }
      this.disconnect(target.id);
      const reconnectTarget = this.registry.get(target.id) ?? target;
      const nextEntry = await this.connectEntry(reconnectTarget);
      if (options.retryOnConnectionError) {
        return await operation(nextEntry);
      }
      throw new Error(
        "Remote ADE service connection was interrupted before ADE could confirm the action result. " +
          "ADE reconnected to the machine; retry the action if it is still needed.",
      );
    }
  }

  private attachEntryLifecycle(
    targetId: string,
    entryPromise: Promise<PoolEntry>,
    entry: PoolEntry,
  ): void {
    let cleanedUp = false;
    const notifyEvicted = (error: Error) => {
      for (const listener of [...this.evictionListeners]) {
        try {
          listener(targetId, error);
        } catch {
          // Lifecycle notifications are best-effort.
        }
      }
    };
    const evict = (
      closeClient: boolean,
      notify = true,
      error = new Error("Remote ADE service connection was interrupted."),
    ) => {
      if (this.entries.get(targetId) === entryPromise) {
        this.entries.delete(targetId);
      }
      this.resolvedEntryPromises.delete(entryPromise);
      if (cleanedUp) return;
      cleanedUp = true;
      this.closeLocalPortForwardsForTarget(targetId);
      closePoolEntryResources(entry, closeClient, true);
      if (notify) notifyEvicted(error);
    };

    entry.client.onDisconnect((error) => evict(false, true, error));
    entry.ssh.once("close", () => evict(true));
    entry.ssh.once("error", (error) => evict(true, true, error instanceof Error ? error : new Error(String(error))));
    entry.dispose = evict;
  }

  private assertConnectNotBackingOff(targetId: string): void {
    const backoff = this.connectFailureBackoffByTargetId.get(targetId);
    if (!backoff) return;
    const remainingMs = backoff.retryAfterMs - Date.now();
    if (remainingMs <= 0) {
      this.connectFailureBackoffByTargetId.delete(targetId);
      return;
    }
    const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
    throw new Error(
      `Remote ADE service connection failed recently (${backoff.error.message}). Retrying in ${seconds}s.`,
    );
  }

  private noteConnectFailure(targetId: string, error: unknown): void {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    const previous = this.connectFailureBackoffByTargetId.get(targetId);
    const failureCount = (previous?.failureCount ?? 0) + 1;
    const backoffMs = Math.min(
      CONNECT_FAILURE_MAX_BACKOFF_MS,
      CONNECT_FAILURE_BASE_BACKOFF_MS * 2 ** Math.max(0, failureCount - 1),
    );
    this.connectFailureBackoffByTargetId.set(targetId, {
      error: normalizedError,
      failureCount,
      retryAfterMs: Date.now() + backoffMs,
    });
  }

  private bumpDisconnectGeneration(targetId: string): void {
    this.disconnectGenerationByTargetId.set(
      targetId,
      (this.disconnectGenerationByTargetId.get(targetId) ?? 0) + 1,
    );
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

function isRemoteRuntimeEventCategory(
  value: unknown,
): value is RemoteRuntimeEventCategory {
  return (
    value === "orchestrator" ||
    value === "dag_mutation" ||
    value === "runtime" ||
    value === "pty"
  );
}

function normalizeBufferedEvent(
  value: unknown,
): RemoteRuntimeBufferedEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "number" || !Number.isFinite(record.id)) return null;
  if (typeof record.timestamp !== "string") return null;
  if (!isRemoteRuntimeEventCategory(record.category)) return null;
  const payload =
    record.payload &&
    typeof record.payload === "object" &&
    !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
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
    throw new Error("Remote ADE service did not return an action registry.");
  }
  const record = value as Record<string, unknown>;
  if (record.ok === false) {
    const error =
      record.error &&
      typeof record.error === "object" &&
      !Array.isArray(record.error)
        ? (record.error as Record<string, unknown>)
        : {};
    throw new Error(
      typeof error.message === "string"
        ? error.message
        : "Remote ADE service action registry lookup failed.",
    );
  }
  const rawActions = Array.isArray(record.actions) ? record.actions : null;
  if (!rawActions) {
    throw new Error("Remote ADE service did not return an action registry.");
  }

  const grouped = new Map<string, Map<string, { name: string; description?: string }>>();
  for (const raw of rawActions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const actionRecord = raw as Record<string, unknown>;
    const domain =
      typeof actionRecord.domain === "string" ? actionRecord.domain.trim() : "";
    const action =
      typeof actionRecord.action === "string" ? actionRecord.action.trim() : "";
    if (!domain || !action) continue;
    const description =
      typeof actionRecord.description === "string" && actionRecord.description.trim()
        ? actionRecord.description.trim()
        : undefined;
    const domainActions = grouped.get(domain) ?? new Map<string, { name: string; description?: string }>();
    domainActions.set(action, {
      name: action,
      ...(description ? { description } : {}),
    });
    grouped.set(domain, domainActions);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([domain, actions]) => ({
      domain,
      actions: [...actions.values()].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    }));
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

  const removeNotificationListener = client.onNotification(
    "runtime/event",
    (params) => {
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
    },
  );
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
      ...(isRemoteRuntimeEventCategory(request.category)
        ? { category: request.category }
        : {}),
      ...(typeof request.replay === "boolean" ? { replay: request.replay } : {}),
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
      void client
        .call("runtimeEvents.unsubscribe", { subscriptionId: id })
        .catch(() => {});
    }
  };
}

function readSubscriptionId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "ADE service event subscription did not return a subscription id.",
    );
  }
  const id = (value as Record<string, unknown>).subscriptionId;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error(
      "ADE service event subscription did not return a subscription id.",
    );
  }
  return id.trim();
}

function normalizeRuntimeEventNotification(
  value: unknown,
): RuntimeEventNotification | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const subscriptionId =
    typeof record.subscriptionId === "string" && record.subscriptionId.trim()
      ? record.subscriptionId.trim()
      : null;
  const projectId =
    typeof record.projectId === "string" ? record.projectId : "";
  const event = normalizeBufferedEvent(record.event);
  if (subscriptionId == null || !projectId || !event) return null;
  return { subscriptionId, projectId, event };
}
