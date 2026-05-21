import { createAdeRpcRequestHandler } from "./adeRpcServer";
import os from "node:os";
import path from "node:path";
import { browseProjectDirectories } from "../../desktop/src/main/services/projects/projectBrowserService";
import {
  getProjectDetail,
  getProjectWorkSummary,
} from "../../desktop/src/main/services/projects/projectDetailService";
import { createProjectScaffoldService } from "../../desktop/src/main/services/projects/projectScaffoldService";
import type { Logger } from "../../desktop/src/main/services/logging/logger";
import type {
  CloneProjectInput,
  CreateProjectInput,
  ListMyGitHubReposInput,
  ProjectBrowseInput,
} from "../../desktop/src/shared/types";
import type { BufferedEvent } from "./eventBuffer";
import {
  JsonRpcError,
  JsonRpcErrorCode,
  type JsonRpcHandler,
  type JsonRpcRequest,
} from "./jsonrpc";
import { resolveMachineAdeLayout } from "./services/projects/machineLayout";
import {
  ProjectRegistry,
  type ProjectId,
} from "./services/projects/projectRegistry";
import { ProjectScopeRegistry } from "./services/projects/projectScope";
import { createHeadlessGitHubService } from "./headlessLinearServices";
import type { SyncPeerDeviceType } from "../../desktop/src/shared/types";

type HandlerEntry = {
  handler: JsonRpcHandler & { dispose?: () => void };
};

type RuntimeEventCategory = BufferedEvent["category"];
type JsonRpcNotifier = (method: string, params?: unknown) => void;
type RuntimeEventSubscription = {
  id: string;
  projectId: ProjectId;
  unsubscribe: () => void;
};

export type MultiProjectRpcHandlerOptions = {
  serverVersion: string;
  projectRegistry?: ProjectRegistry;
  scopeRegistry?: ProjectScopeRegistry;
  disposeScopesOnDispose?: boolean;
  onShutdown?: (() => void) | null;
};

const RUNTIME_METHODS = new Set([
  "ade/initialize",
  "ade/initialized",
  "ping",
  "shutdown",
  "exit",
  "runtime/info",
  "machineInfo.get",
  "projects.list",
  "projects.add",
  "projects.remove",
  "projects.touch",
  "projects.browseDirectories",
  "projects.getDetail",
  "projects.getWorkSummary",
  "projects.getDefaultParentDir",
  "projects.create",
  "projects.clone",
  "projects.listMyGitHubRepos",
  "runtimeEvents.subscribe",
  "runtimeEvents.unsubscribe",
  "sync.getStatus",
  "sync.refreshDiscovery",
  "sync.listDevices",
  "sync.updateLocalDevice",
  "sync.connectToBrain",
  "sync.disconnectFromBrain",
  "sync.forgetDevice",
  "sync.getTransferReadiness",
  "sync.transferBrainToLocal",
  "sync.getPin",
  "sync.setPin",
  "sync.generatePin",
  "sync.clearPin",
  "sync.setActiveLanePresence",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeParams(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

const machineProjectLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readProjectBrowseInput(
  params: Record<string, unknown>,
): ProjectBrowseInput {
  const input: ProjectBrowseInput = {};
  const partialPath = readOptionalString(params.partialPath);
  if (partialPath) input.partialPath = partialPath;
  if (typeof params.cwd === "string") input.cwd = params.cwd.trim() || null;
  if (typeof params.limit === "number" && Number.isFinite(params.limit))
    input.limit = params.limit;
  return input;
}

function readCreateProjectInput(
  params: Record<string, unknown>,
): CreateProjectInput {
  const name = readOptionalString(params.name);
  const parentDir = readOptionalString(params.parentDir);
  if (!name)
    throw new JsonRpcError(
      JsonRpcErrorCode.invalidParams,
      "projects.create requires name.",
    );
  if (!parentDir)
    throw new JsonRpcError(
      JsonRpcErrorCode.invalidParams,
      "projects.create requires parentDir.",
    );
  return { name, parentDir };
}

function readCloneProjectInput(
  params: Record<string, unknown>,
): CloneProjectInput {
  const url = readOptionalString(params.url);
  const parentDir = readOptionalString(params.parentDir);
  const name = readOptionalString(params.name);
  const githubAuthHeader = readOptionalString(params.githubAuthHeader);
  if (!url)
    throw new JsonRpcError(
      JsonRpcErrorCode.invalidParams,
      "projects.clone requires url.",
    );
  if (!parentDir)
    throw new JsonRpcError(
      JsonRpcErrorCode.invalidParams,
      "projects.clone requires parentDir.",
    );
  return {
    url,
    parentDir,
    ...(name ? { name } : {}),
    ...(githubAuthHeader ? { githubAuthHeader } : {}),
  };
}

function readListMyReposInput(
  params: Record<string, unknown>,
): ListMyGitHubReposInput {
  const search = readOptionalString(params.search);
  return search ? { search } : {};
}

function createMachineProjectScaffoldService() {
  const githubService = createHeadlessGitHubService(
    process.cwd(),
    machineProjectLogger,
  );
  return createProjectScaffoldService({
    logger: machineProjectLogger,
    githubService: githubService as never,
  });
}

function defaultParentDir(projectRegistry: ProjectRegistry): string {
  const first = projectRegistry.list()[0]?.rootPath;
  if (first) return path.dirname(first);
  return path.join(os.homedir(), "Projects");
}

function readProjectId(params: Record<string, unknown>): ProjectId | null {
  const value = params.projectId;
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function omitProjectId(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const { projectId: _projectId, ...rest } = params;
  return rest;
}

function readEventCategory(value: unknown): RuntimeEventCategory | null {
  return value === "orchestrator" ||
    value === "dag_mutation" ||
    value === "runtime" ||
    value === "mission" ||
    value === "pty"
    ? value
    : null;
}

function readCursor(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function readLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(1000, Math.floor(value)))
    : 100;
}

export function createMultiProjectRpcRequestHandler(
  options: MultiProjectRpcHandlerOptions,
): JsonRpcHandler & {
  dispose: () => void;
  setNotifier: (notify: JsonRpcNotifier | null) => void;
} {
  const projectRegistry = options.projectRegistry ?? new ProjectRegistry();
  const handlers = new Map<ProjectId, Promise<HandlerEntry>>();
  const eventSubscriptions = new Map<string, RuntimeEventSubscription>();
  const disposeProjectRuntimeCaches = (projectId: ProjectId): void => {
    const cached = handlers.get(projectId);
    handlers.delete(projectId);
    if (cached) {
      void cached.then((entry) => entry.handler.dispose?.()).catch(() => {});
    }
    for (const subscription of [...eventSubscriptions.values()]) {
      if (subscription.projectId !== projectId) continue;
      subscription.unsubscribe();
      eventSubscriptions.delete(subscription.id);
    }
  };
  const scopeRegistry =
    options.scopeRegistry ??
    new ProjectScopeRegistry(projectRegistry);
  const removeScopeDisposeListener =
    typeof (scopeRegistry as Partial<ProjectScopeRegistry>).onDispose ===
    "function"
      ? scopeRegistry.onDispose(disposeProjectRuntimeCaches)
      : null;
  let initializedParams: Record<string, unknown> | null = null;
  let notifier: JsonRpcNotifier | null = null;
  let nextSubscriptionId = 1;

  const emitRuntimeEvent = (
    subscriptionId: string,
    projectId: ProjectId,
    event: BufferedEvent,
  ): void => {
    notifier?.("runtime/event", {
      subscriptionId,
      projectId,
      event,
    });
  };

  const getProjectHandler = async (
    projectId: ProjectId,
  ): Promise<HandlerEntry> => {
    const cached = handlers.get(projectId);
    if (cached) return await cached;

    const pending = (async () => {
      const scope = await scopeRegistry.get(projectId);
      const handler = createAdeRpcRequestHandler({
        runtime: scope.runtime,
        serverVersion: options.serverVersion,
        onActionsListChanged: () => {},
      });
      if (initializedParams) {
        await handler({
          jsonrpc: "2.0",
          id: "initialize-project-scope",
          method: "ade/initialize",
          params: initializedParams,
        });
      }
      return { handler };
    })();
    handlers.set(projectId, pending);

    try {
      return await pending;
    } catch (error) {
      handlers.delete(projectId);
      throw error;
    }
  };

  const subscribeRuntimeEvents = async (params: Record<string, unknown>) => {
    const projectId = readProjectId(params);
    if (!projectId) {
      throw new JsonRpcError(
        JsonRpcErrorCode.invalidParams,
        "runtimeEvents.subscribe requires projectId.",
      );
    }
    const category =
      params.category == null ? null : readEventCategory(params.category);
    if (params.category != null && !category) {
      throw new JsonRpcError(
        JsonRpcErrorCode.invalidParams,
        "runtimeEvents.subscribe category is invalid.",
      );
    }
    const cursor = readCursor(params.cursor);
    const limit = readLimit(params.limit);
    const replay = params.replay !== false;
    const scope = await scopeRegistry.get(projectId);
    const subscriptionId = `runtime-events-${nextSubscriptionId++}`;
    const shouldForward = (event: BufferedEvent): boolean =>
      !category || event.category === category;
    const unsubscribe = scope.runtime.eventBuffer.subscribe((event) => {
      if (shouldForward(event))
        emitRuntimeEvent(subscriptionId, projectId, event);
    });
    eventSubscriptions.set(subscriptionId, {
      id: subscriptionId,
      projectId,
      unsubscribe,
    });

    const replayResult = replay
      ? scope.runtime.eventBuffer.drain(cursor, limit)
      : { events: [], nextCursor: cursor, hasMore: false };
    for (const event of replayResult.events) {
      if (shouldForward(event))
        emitRuntimeEvent(subscriptionId, projectId, event);
    }
    return {
      subscriptionId,
      nextCursor: replayResult.nextCursor,
      hasMore: replayResult.hasMore,
    };
  };

  const unsubscribeRuntimeEvents = (params: Record<string, unknown>) => {
    const subscriptionId =
      typeof params.subscriptionId === "string"
        ? params.subscriptionId.trim()
        : "";
    if (!subscriptionId) {
      throw new JsonRpcError(
        JsonRpcErrorCode.invalidParams,
        "runtimeEvents.unsubscribe requires subscriptionId.",
      );
    }
    const subscription = eventSubscriptions.get(subscriptionId);
    if (!subscription) return { removed: false };
    subscription.unsubscribe();
    eventSubscriptions.delete(subscriptionId);
    return { removed: true };
  };

  const getSyncService = async (params: Record<string, unknown>) => {
    const projectId = readProjectId(params);
    const scope = await scopeRegistry.ensureSyncHost(projectId ?? undefined);
    const syncService = scope?.runtime.syncService ?? null;
    if (!syncService) {
      throw new JsonRpcError(
        JsonRpcErrorCode.invalidRequest,
        "Sync service is not available. Register a project first.",
      );
    }
    return syncService;
  };

  const handler = (async (request: JsonRpcRequest): Promise<unknown | null> => {
    const method = typeof request.method === "string" ? request.method : "";
    const params = safeParams(request.params);

    if (method === "ade/initialize") {
      initializedParams = params;
      return {
        protocolVersion:
          typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : "2025-06-18",
        runtimeInfo: {
          name: "ade-rpc",
          version: options.serverVersion,
          buildHash:
            typeof process.env.ADE_RUNTIME_BUILD_HASH === "string" &&
            process.env.ADE_RUNTIME_BUILD_HASH.trim()
              ? process.env.ADE_RUNTIME_BUILD_HASH.trim()
              : null,
          multiProject: true,
          pid: process.pid,
        },
        capabilities: {
          actions: {
            listChanged: true,
          },
          projects: true,
          machineProjects: {
            browseDirectories: true,
            getDetail: true,
            getWorkSummary: true,
            getDefaultParentDir: true,
            create: true,
            clone: true,
            listMyGitHubRepos: true,
          },
        },
      };
    }

    if (method === "ade/initialized") {
      return null;
    }

    if (!initializedParams) {
      throw new JsonRpcError(
        JsonRpcErrorCode.invalidRequest,
        "Server must be initialized first.",
      );
    }

    if (method === "ping") {
      return { pong: true, at: new Date().toISOString() };
    }

    if (method === "runtime/info" || method === "machineInfo.get") {
      const layout = resolveMachineAdeLayout();
      return {
        version: options.serverVersion,
        runtimeKind: "headless",
        adeDir: layout.adeDir,
        socketPath: layout.socketPath,
        projectCount: projectRegistry.list().length,
      };
    }

    if (method === "projects.list") {
      return projectRegistry.list();
    }

    if (method === "projects.add") {
      const rootPath =
        typeof params.rootPath === "string" ? params.rootPath.trim() : "";
      if (!rootPath) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidParams,
          "projects.add requires rootPath.",
        );
      }
      return projectRegistry.add(rootPath);
    }

    if (method === "projects.remove") {
      const projectId = readProjectId(params);
      if (!projectId) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidParams,
          "projects.remove requires projectId.",
        );
      }
      await scopeRegistry.dispose(projectId);
      handlers.delete(projectId);
      return { removed: projectRegistry.remove(projectId) };
    }

    if (method === "projects.touch") {
      const projectId = readProjectId(params);
      if (!projectId) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidParams,
          "projects.touch requires projectId.",
        );
      }
      return projectRegistry.touch(projectId);
    }

    if (method === "projects.browseDirectories") {
      return await browseProjectDirectories(readProjectBrowseInput(params));
    }

    if (method === "projects.getDetail") {
      const rootPath = readOptionalString(params.rootPath);
      if (!rootPath) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidParams,
          "projects.getDetail requires rootPath.",
        );
      }
      return await getProjectDetail(rootPath);
    }

    if (method === "projects.getWorkSummary") {
      const rootPath = readOptionalString(params.rootPath);
      if (!rootPath) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidParams,
          "projects.getWorkSummary requires rootPath.",
        );
      }
      return await getProjectWorkSummary(rootPath);
    }

    if (method === "projects.getDefaultParentDir") {
      return defaultParentDir(projectRegistry);
    }

    if (method === "projects.create") {
      const result =
        await createMachineProjectScaffoldService().createLocalProject(
          readCreateProjectInput(params),
        );
      return projectRegistry.add(result.rootPath);
    }

    if (method === "projects.clone") {
      const result =
        await createMachineProjectScaffoldService().cloneRepository(
          readCloneProjectInput(params),
        );
      return projectRegistry.add(result.rootPath);
    }

    if (method === "projects.listMyGitHubRepos") {
      return await createMachineProjectScaffoldService().listMyGitHubRepos(
        readListMyReposInput(params),
      );
    }

    if (method === "runtimeEvents.subscribe") {
      return await subscribeRuntimeEvents(params);
    }

    if (method === "runtimeEvents.unsubscribe") {
      return unsubscribeRuntimeEvents(params);
    }

    if (method === "sync.getStatus") {
      const syncService = await getSyncService(params);
      return await syncService.getStatus({
        includeTransferReadiness: params.includeTransferReadiness === true,
        forceTransferReadiness: params.forceTransferReadiness === true,
      });
    }

    if (method === "sync.refreshDiscovery") {
      return await (await getSyncService(params)).refreshDiscovery();
    }

    if (method === "sync.listDevices") {
      return await (await getSyncService(params)).listDevices();
    }

    if (method === "sync.updateLocalDevice") {
      const name = typeof params.name === "string" ? params.name : undefined;
      const deviceType =
        typeof params.deviceType === "string"
          ? (params.deviceType as SyncPeerDeviceType)
          : undefined;
      return await (
        await getSyncService(params)
      ).updateLocalDevice({
        ...(name !== undefined ? { name } : {}),
        ...(deviceType !== undefined ? { deviceType } : {}),
      });
    }

    if (method === "sync.connectToBrain") {
      const syncService = await getSyncService(params);
      return await syncService.connectToBrain(
        omitProjectId(params) as Parameters<
          typeof syncService.connectToBrain
        >[0],
      );
    }

    if (method === "sync.disconnectFromBrain") {
      return await (await getSyncService(params)).disconnectFromBrain();
    }

    if (method === "sync.forgetDevice") {
      const deviceId =
        typeof params.deviceId === "string" ? params.deviceId : "";
      return await (await getSyncService(params)).forgetDevice(deviceId);
    }

    if (method === "sync.getTransferReadiness") {
      return await (await getSyncService(params)).getTransferReadiness();
    }

    if (method === "sync.transferBrainToLocal") {
      return await (await getSyncService(params)).transferBrainToLocal();
    }

    if (method === "sync.getPin") {
      return { pin: (await getSyncService(params)).getPin() };
    }

    if (method === "sync.setPin") {
      const pin = typeof params.pin === "string" ? params.pin : "";
      return await (await getSyncService(params)).setPin(pin);
    }

    if (method === "sync.generatePin") {
      return await (await getSyncService(params)).generatePin();
    }

    if (method === "sync.clearPin") {
      return await (await getSyncService(params)).clearPin();
    }

    if (method === "sync.setActiveLanePresence") {
      const laneIds = Array.isArray(params.laneIds)
        ? params.laneIds.filter(
            (laneId): laneId is string => typeof laneId === "string",
          )
        : [];
      await (await getSyncService(params)).setActiveLanePresence(laneIds);
      return null;
    }

    if (method === "shutdown") {
      process.nextTick(() => options.onShutdown?.());
      return {};
    }

    if (method === "exit") {
      process.nextTick(() => process.exit(0));
      return {};
    }

    if (RUNTIME_METHODS.has(method)) {
      throw new JsonRpcError(
        JsonRpcErrorCode.methodNotFound,
        `Method not found: ${method}`,
      );
    }

    const projectId = readProjectId(params);
    if (!projectId) {
      throw new JsonRpcError(
        JsonRpcErrorCode.invalidParams,
        `Method ${method} requires params.projectId.`,
      );
    }

    const entry = await getProjectHandler(projectId);
    return await entry.handler({
      ...request,
      params: omitProjectId(params),
    });
  }) as JsonRpcHandler & {
    dispose: () => void;
    setNotifier: (notify: JsonRpcNotifier | null) => void;
  };

  handler.dispose = () => {
    for (const subscription of eventSubscriptions.values()) {
      subscription.unsubscribe();
    }
    eventSubscriptions.clear();
    for (const cached of handlers.values()) {
      void cached.then((entry) => entry.handler.dispose?.()).catch(() => {});
    }
    handlers.clear();
    removeScopeDisposeListener?.();
    if (options.disposeScopesOnDispose ?? !options.scopeRegistry) {
      void scopeRegistry.disposeAll();
    }
  };

  handler.setNotifier = (notify: JsonRpcNotifier | null) => {
    notifier = notify;
  };

  return handler;
}
