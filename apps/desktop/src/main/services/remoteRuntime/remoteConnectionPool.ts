import { app } from "electron";
import type { Client } from "ssh2";
import type {
  RemoteRuntimeActionRequest,
  RemoteRuntimeActionResult,
  RemoteRuntimeBufferedEvent,
  RemoteRuntimeConnectResult,
  RemoteRuntimeEventCategory,
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

type RuntimeEventNotification = {
  subscriptionId: string;
  projectId: string;
  event: RemoteRuntimeBufferedEvent;
};

function isRemoteRuntimeConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /remote (?:runtime|ADE service) connection (?:closed|failed)|stream closed|channel closed|connection lost|socket closed/i.test(
    message,
  );
}

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
  "file.quickOpen",
  "terminal.activeForChat",
  "terminal.preview",
]);

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

export class RemoteConnectionPool {
  private readonly entries = new Map<string, Promise<PoolEntry>>();
  private readonly evictionListeners = new Set<
    (targetId: string, error: Error) => void
  >();

  constructor(
    private readonly registry: RemoteTargetRegistry,
    private readonly appVersion: string,
  ) {}

  async connect(
    target: RemoteRuntimeTarget,
  ): Promise<RemoteRuntimeConnectResult> {
    return (await this.connectEntry(target)).result;
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

  private async connectEntry(target: RemoteRuntimeTarget): Promise<PoolEntry> {
    const existing = this.entries.get(target.id);
    if (existing) return await existing;
    const pending = bootstrapRemoteRuntime({
      target,
      registry: this.registry,
      resourcesPath: process.resourcesPath ?? app.getAppPath(),
      appVersion: this.appVersion,
    });
    let entryPromise: Promise<PoolEntry>;
    entryPromise = pending.then(({ client, ssh, result }) => {
      const entry = { client, ssh, result };
      this.attachEntryLifecycle(target.id, entryPromise, entry);
      return entry;
    });
    this.entries.set(target.id, entryPromise);
    try {
      return await entryPromise;
    } catch (error) {
      this.entries.delete(target.id);
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
      (entry) =>
        options.timeoutMs
          ? entry.client.call(method, params, { timeoutMs: options.timeoutMs })
          : entry.client.call(method, params),
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
      { retryOnConnectionError: true },
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
    const value = await entry.client.call("ade/actions/call", {
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
            : "Remote ADE service action failed.",
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
    const existing = this.entries.get(targetId);
    this.entries.delete(targetId);
    void existing
      ?.then((entry) => {
        if (entry.dispose) {
          entry.dispose(true, false);
          return;
        }
        try {
          entry.client.close();
        } catch {}
        try {
          entry.ssh.end();
        } catch {}
      })
      .catch(() => {});
  }

  dispose(): void {
    for (const targetId of [...this.entries.keys()]) {
      this.disconnect(targetId);
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
    try {
      return await operation(entry);
    } catch (error) {
      if (!isRemoteRuntimeConnectionError(error)) throw error;
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
      if (cleanedUp) return;
      cleanedUp = true;
      if (closeClient) {
        try {
          entry.client.close();
        } catch {}
      }
      try {
        entry.ssh.end();
      } catch {}
      if (notify) notifyEvicted(error);
    };

    entry.client.onDisconnect((error) => evict(false, true, error));
    entry.ssh.once("close", () => evict(true));
    entry.ssh.once("error", (error) => evict(true, true, error instanceof Error ? error : new Error(String(error))));
    entry.dispose = evict;
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
    value === "mission" ||
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
