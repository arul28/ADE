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
import type { RuntimeRpcClient } from "./runtimeRpcClient";
import { bootstrapRemoteRuntime, ensureRemoteProject } from "./remoteBootstrap";
import type { RemoteTargetRegistry } from "./remoteTargetRegistry";

type PoolEntry = {
  client: RuntimeRpcClient;
  ssh: Client;
  result: RemoteRuntimeConnectResult;
  dispose?: (closeClient: boolean) => void;
};

type RuntimeEventNotification = {
  subscriptionId: string;
  projectId: string;
  event: RemoteRuntimeBufferedEvent;
};

function isRemoteRuntimeConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /remote (?:runtime|ADE service) connection (?:closed|failed)|stream closed|channel closed|connection lost|socket closed/i.test(message);
}

export class RemoteConnectionPool {
  private readonly entries = new Map<string, Promise<PoolEntry>>();

  constructor(
    private readonly registry: RemoteTargetRegistry,
    private readonly appVersion: string,
  ) {}

  async connect(target: RemoteRuntimeTarget): Promise<RemoteRuntimeConnectResult> {
    return (await this.connectEntry(target)).result;
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

  async addProject(targetId: string, rootPath: string): Promise<RemoteRuntimeProjectRecord> {
    const entry = await this.requireEntry(targetId);
    return await this.addProjectWithEntry(entry, rootPath);
  }

  async addProjectForTarget(target: RemoteRuntimeTarget, rootPath: string): Promise<RemoteRuntimeProjectRecord> {
    const entry = await this.connectEntry(target);
    return await this.addProjectWithEntry(entry, rootPath);
  }

  async callAction(targetId: string, projectId: string, request: RemoteRuntimeActionRequest): Promise<RemoteRuntimeActionResult> {
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
      { retryOnConnectionError: false },
    );
  }

  async callSyncForTarget(
    target: RemoteRuntimeTarget,
    projectId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const entry = await this.connectEntry(target);
    return await entry.client.call(method, {
      ...params,
      projectId,
    });
  }

  private async addProjectWithEntry(entry: PoolEntry, rootPath: string): Promise<RemoteRuntimeProjectRecord> {
    const project = await ensureRemoteProject(entry.client, rootPath);
    entry.result.projects = [
      project,
      ...entry.result.projects.filter((candidate) => candidate.projectId !== project.projectId),
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
        throw new Error(typeof error.message === "string" ? error.message : "Remote ADE service action failed.");
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
        ...(isRemoteRuntimeEventCategory(request.category) ? { category: request.category } : {}),
      },
    });

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (record.ok === false) {
        const error = record.error && typeof record.error === "object" && !Array.isArray(record.error)
          ? record.error as Record<string, unknown>
          : {};
        throw new Error(typeof error.message === "string" ? error.message : "Remote ADE service event stream failed.");
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
    return await subscribeToRuntimeEvents(entry.client, projectId, request, onEvent, onEnded);
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
      (entry) => subscribeToRuntimeEvents(entry.client, projectId, request, onEvent, onEnded),
      { retryOnConnectionError: true },
    );
  }

  disconnect(targetId: string): void {
    const existing = this.entries.get(targetId);
    this.entries.delete(targetId);
    void existing?.then((entry) => {
      if (entry.dispose) {
        entry.dispose(true);
        return;
      }
      try { entry.client.close(); } catch {}
      try { entry.ssh.end(); } catch {}
    }).catch(() => {});
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
      const nextEntry = await this.connectEntry(target);
      if (options.retryOnConnectionError) {
        return await operation(nextEntry);
      }
      throw new Error(
        "Remote ADE service connection was interrupted before ADE could confirm the action result. " +
        "ADE reconnected to the machine; retry the action if it is still needed.",
      );
    }
  }

  private attachEntryLifecycle(targetId: string, entryPromise: Promise<PoolEntry>, entry: PoolEntry): void {
    let cleanedUp = false;
    const evict = (closeClient: boolean) => {
      if (this.entries.get(targetId) === entryPromise) {
        this.entries.delete(targetId);
      }
      if (cleanedUp) return;
      cleanedUp = true;
      if (closeClient) {
        try { entry.client.close(); } catch {}
      }
      try { entry.ssh.end(); } catch {}
    };

    entry.client.onDisconnect(() => evict(false));
    entry.ssh.once("close", () => evict(true));
    entry.ssh.once("error", () => evict(true));
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
