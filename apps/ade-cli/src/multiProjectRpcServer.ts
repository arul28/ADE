import { createAdeRpcRequestHandler } from "./adeRpcServer";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { browseProjectDirectories } from "../../desktop/src/main/services/projects/projectBrowserService";
import {
  getProjectDetail,
  getProjectWorkSummary,
} from "../../desktop/src/main/services/projects/projectDetailService";
import { inspectProjectPath } from "../../desktop/src/main/services/projects/projectPathInspector";
import { createProjectScaffoldService } from "../../desktop/src/main/services/projects/projectScaffoldService";
import { runGit } from "../../desktop/src/main/services/git/git";
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
import { resolveRemoteProjectIcon } from "./services/projects/projectIconResolver";
import {
  ProjectRegistry,
  type ProjectId,
} from "./services/projects/projectRegistry";
import { ProjectScopeRegistry } from "./services/projects/projectScope";
import { PersonalChatScope } from "./services/personalChats/personalChatScope";
import { createHeadlessGitHubService } from "./headlessLinearServices";
import {
  callerHasRoleAtLeast,
  isCtoOnlyAdeAction,
} from "../../desktop/src/main/services/adeActions/registry";
import { normalizeAdeRuntimeRole, resolveSessionRole } from "./runtimeRoles";
import type { SyncPeerDeviceType } from "../../desktop/src/shared/types";
import {
  callAccountAction,
  type AccountAuthService,
} from "./services/account/accountAuthService";
import {
  getSharedAccountAuthService,
  registerAccountConfigProjectRoot,
} from "./services/account/sharedAccountAuthService";

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
  personalChatScope?: Pick<PersonalChatScope, "capabilities" | "call" | "streamEvents" | "dispose">;
  accountAuthService?: AccountAuthService;
};

const RUNTIME_METHODS = new Set([
  "ade/initialize",
  "ade/initialized",
  "ping",
  "shutdown",
  "exit",
  "runtime/info",
  "account.call",
  "personalChats.call",
  "personalChats.streamEvents",
  "machineInfo.get",
  "projects.list",
  "projects.add",
  "projects.remove",
  "projects.touch",
  "projects.browseDirectories",
  "projects.getDetail",
  "projects.getWorkSummary",
  "projects.inspectPath",
  "projects.getDefaultParentDir",
  "projects.getHandoffStoragePreflight",
  "projects.create",
  "projects.clone",
  "projects.listMyGitHubRepos",
  "runtimeEvents.subscribe",
  "runtimeEvents.unsubscribe",
  "sync.switchHost",
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
  "sync.getRuntimeName",
  "sync.setRuntimeName",
  "sync.clearRuntimeName",
  "sync.getDesktopPairingInfo",
  "sync.setActiveLanePresence",
  "sync.getCloudRelayStatus",
  "sync.setCloudRelayEnabled",
  "sync.getRequireDpop",
  "sync.setRequireDpop",
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

type ResolvedProjectIcon = ReturnType<typeof resolveRemoteProjectIcon>;

// Frozen so the shared fallback can't be mutated by a consumer and corrupt
// every subsequent budget-exceeded project record.
const EMPTY_PROJECT_ICON: ResolvedProjectIcon = Object.freeze({
  dataUrl: null,
  sourcePath: null,
  mimeType: null,
});

// `projects.list` is on the connect-critical path (bootstrapRemoteRuntime awaits
// it before a target is "connected"), so bound the icon work it does: resolve at
// most this many icons and this many inlined bytes per call. A large or
// slow-filesystem registry then can't stall a connect just to render tab
// artwork — projects past the budget fall back to a null icon.
const LIST_ICON_COUNT_BUDGET = 64;
const LIST_ICON_BYTE_BUDGET = 12 * 1024 * 1024;

// Stamp a single project record with its host-resolved icon so a remote desktop
// can render the real project logo. Used for the records returned by
// add/create/clone (which feed the desktop's cached connection.projects), so a
// freshly registered project opens with its icon instead of a blank folder.
// Best-effort: a failed resolve degrades to a null icon and never throws.
function decorateProjectWithIcon<T extends { rootPath: string }>(
  record: T,
): T & { icon: ResolvedProjectIcon } {
  return { ...record, icon: resolveRemoteProjectIcon(record.rootPath) };
}

// Decorate a full project list with icons under the connect-path budget above.
// Icons are resolved for the most-recently-opened projects first (those most
// likely to be open as tabs) while the returned array stays in registry order.
function decorateProjectListWithIcons<T extends { rootPath: string; lastOpenedAt: number }>(
  records: readonly T[],
): Array<T & { icon: ResolvedProjectIcon }> {
  const icons = new Map<number, ResolvedProjectIcon>();
  let count = 0;
  let bytes = 0;
  const byRecency = records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => b.record.lastOpenedAt - a.record.lastOpenedAt);
  for (const { record, index } of byRecency) {
    if (count >= LIST_ICON_COUNT_BUDGET || bytes >= LIST_ICON_BYTE_BUDGET) break;
    const icon = resolveRemoteProjectIcon(record.rootPath);
    count += 1;
    if (icon.dataUrl) bytes += icon.dataUrl.length;
    icons.set(index, icon);
  }
  return records.map((record, index) => ({
    ...record,
    icon: icons.get(index) ?? EMPTY_PROJECT_ICON,
  }));
}

function defaultParentDir(projectRegistry: ProjectRegistry): string {
  const first = projectRegistry.list()[0]?.rootPath;
  if (first) return path.dirname(first);
  return path.join(os.homedir(), "Projects");
}

async function inspectHandoffStorage(params: Record<string, unknown>) {
  const parentDir = readOptionalString(params.parentDir);
  const repoName = readOptionalString(params.repoName);
  if (!parentDir) {
    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "projects.getHandoffStoragePreflight requires parentDir.");
  }
  if (
    !repoName
    || repoName === "."
    || repoName === ".."
    || repoName.includes("\0")
    || repoName.includes("/")
    || repoName.includes("\\")
  ) {
    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "projects.getHandoffStoragePreflight requires a valid repoName.");
  }
  const normalizedParent = path.resolve(parentDir);
  const targetPath = path.join(normalizedParent, repoName);
  const blockingErrors: string[] = [];
  const warnings: string[] = [];
  if (!fs.existsSync(normalizedParent)) {
    blockingErrors.push(`Destination folder does not exist: ${normalizedParent}`);
  } else if (!fs.statSync(normalizedParent).isDirectory()) {
    blockingErrors.push(`Destination path is not a folder: ${normalizedParent}`);
  } else {
    try {
      fs.accessSync(normalizedParent, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    } catch {
      blockingErrors.push(`ADE cannot write to destination folder: ${normalizedParent}`);
    }
  }
  const targetExists = fs.existsSync(targetPath);
  if (targetExists) {
    blockingErrors.push(`A file or folder already exists at ${targetPath}. Add that repository to ADE or choose another destination.`);
  }
  const requiredBytes = 1_073_741_824;
  let freeBytes = 0;
  if (fs.existsSync(normalizedParent)) {
    try {
      const stats = fs.statfsSync(normalizedParent, { bigint: true });
      freeBytes = Number(stats.bavail * stats.bsize);
    } catch (error) {
      warnings.push(`ADE could not read free disk space: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const hasEnoughSpace = freeBytes >= requiredBytes;
  if (freeBytes > 0 && !hasEnoughSpace) {
    blockingErrors.push("The destination does not have enough free space for a safe clone and lane worktree.");
  } else if (freeBytes > 0 && freeBytes < requiredBytes * 2) {
    warnings.push("Disk space is above the minimum, but there is limited room for dependencies and build artifacts.");
  }
  const originUrl = readOptionalString(params.originUrl);
  const branchRef = readOptionalString(params.branchRef)?.replace(/^refs\/heads\//, "") ?? null;
  const sourceHeadSha = readOptionalString(params.sourceHeadSha);
  if (originUrl || branchRef || sourceHeadSha) {
    if (!originUrl || !branchRef || !sourceHeadSha) {
      blockingErrors.push("Destination Git authentication preflight is missing repository, branch, or commit details.");
    } else if (
      originUrl.includes("\0")
      || branchRef.includes("\0")
      || branchRef.startsWith("-")
      || branchRef.length > 255
      || !/^[0-9a-f]{40,64}$/i.test(sourceHeadSha)
    ) {
      blockingErrors.push("Destination Git authentication preflight received invalid repository details.");
    } else if (fs.existsSync(normalizedParent) && fs.statSync(normalizedParent).isDirectory()) {
      const githubService = createHeadlessGitHubService(normalizedParent, machineProjectLogger);
      let destinationAuthHeader = "";
      if (githubService.parseGitHubRepoFromRemoteUrl(originUrl) && /^https:\/\//i.test(originUrl)) {
        try {
          const token = githubService.getTokenOrThrow();
          const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
          destinationAuthHeader = `AUTHORIZATION: basic ${basic}`;
        } catch {
          // The destination may still have a system credential helper. Let
          // Git try it with terminal prompting disabled below.
        }
      }
      const remoteArgs = [
        "ls-remote",
        "--heads",
        originUrl,
        `refs/heads/${branchRef}`,
      ];
      const remote = await runGit(
        remoteArgs,
        {
          cwd: normalizedParent,
          timeoutMs: 30_000,
          env: {
            GIT_TERMINAL_PROMPT: "0",
            GCM_INTERACTIVE: "Never",
            ...(destinationAuthHeader
              ? {
                  // Keep destination-owned credentials out of command-line
                  // arguments, which may be visible to other local processes.
                  GIT_CONFIG_COUNT: "1",
                  GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
                  GIT_CONFIG_VALUE_0: destinationAuthHeader,
                }
              : {}),
          },
          maxOutputBytes: 64_000,
        },
      );
      if (remote.exitCode !== 0) {
        const detail = (remote.stderr.trim() || remote.stdout.trim() || "check the destination Git credential manager").slice(0, 1_000);
        blockingErrors.push(`The destination cannot read the published repository with its own Git credentials: ${detail}`);
      } else {
        const remoteHeadSha = remote.stdout.trim().split(/\s+/)[0] ?? "";
        if (remoteHeadSha !== sourceHeadSha) {
          blockingErrors.push("The destination sees a different published branch commit than the source machine.");
        }
      }
    }
  }
  return {
    parentDir: normalizedParent,
    targetPath,
    freeBytes,
    requiredBytes,
    hasEnoughSpace,
    targetExists,
    blockingErrors,
    warnings,
  };
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
  const registerAccountProjects = (): void => {
    for (const project of projectRegistry.list()) {
      registerAccountConfigProjectRoot(project.rootPath);
    }
  };
  registerAccountProjects();
  const accountAuthService = options.accountAuthService ?? getSharedAccountAuthService({
    projectRoots: () => projectRegistry.list().map((project) => project.rootPath),
  });
  const ownsPersonalChatScope = options.personalChatScope == null;
  const personalChatScope = options.personalChatScope ?? new PersonalChatScope();
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
    eventEpoch: string,
  ): void => {
    notifier?.("runtime/event", {
      subscriptionId,
      projectId,
      event,
      eventEpoch,
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
    const eventEpoch = scope.runtime.eventBuffer.epoch();
    const shouldForward = (event: BufferedEvent): boolean =>
      !category || event.category === category;
    const unsubscribe = scope.runtime.eventBuffer.subscribe((event) => {
      if (shouldForward(event))
        emitRuntimeEvent(subscriptionId, projectId, event, eventEpoch);
    });
    eventSubscriptions.set(subscriptionId, {
      id: subscriptionId,
      projectId,
      unsubscribe,
    });

    const replayResult = replay
      ? scope.runtime.eventBuffer.drain(cursor, limit)
      : {
          events: [],
          nextCursor: scope.runtime.eventBuffer.latestCursor(),
          hasMore: false,
          eventEpoch,
          gap: false,
          oldestCursor: null,
        };
    for (const event of replayResult.events) {
      if (shouldForward(event))
        emitRuntimeEvent(subscriptionId, projectId, event, replayResult.eventEpoch);
    }
    return {
      subscriptionId,
      nextCursor: replayResult.nextCursor,
      hasMore: replayResult.hasMore,
      eventEpoch: replayResult.eventEpoch,
      gap: replayResult.gap === true,
      oldestCursor: replayResult.oldestCursor ?? null,
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

  const getSyncService = async () => {
    const scope = await scopeRegistry.resolveActiveSyncHost();
    const syncService = scope?.runtime.syncService ?? null;
    if (!syncService) {
      throw new JsonRpcError(
        JsonRpcErrorCode.invalidRequest,
        "Sync service is not available. Register a project first.",
      );
    }
    return syncService;
  };

  const trimmedEnvOrNull = (key: string): string | null => {
    const value = process.env[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };

  // The entrypoint cannot change during the process lifetime, so hash it once
  // and reuse the result. Kept per-handler (not module-scoped) so tests that
  // mutate `process.argv[1]` between handlers each recompute a fresh hash.
  // `undefined` means "not computed yet"; `null` is a cached failure
  // (missing/unreadable entrypoint) that must not retry on every call.
  let cachedRuntimeBuildHash: string | null | undefined;

  const computeRuntimeBuildHash = (): string | null => {
    if (cachedRuntimeBuildHash !== undefined) return cachedRuntimeBuildHash;
    const entrypoint = process.argv[1];
    if (typeof entrypoint !== "string" || !entrypoint.trim()) {
      cachedRuntimeBuildHash = null;
      return null;
    }
    try {
      const resolved = path.resolve(entrypoint);
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        cachedRuntimeBuildHash = null;
        return null;
      }
      cachedRuntimeBuildHash = createHash("sha256")
        .update(fs.readFileSync(resolved))
        .digest("hex");
      return cachedRuntimeBuildHash;
    } catch {
      cachedRuntimeBuildHash = null;
      return null;
    }
  };

  const resolveRuntimeEnvInfo = () => {
    const projectRoot = trimmedEnvOrNull("ADE_PROJECT_ROOT");
    const packageChannel = trimmedEnvOrNull("ADE_PACKAGE_CHANNEL");
    return {
      buildHash: trimmedEnvOrNull("ADE_RUNTIME_BUILD_HASH") ?? computeRuntimeBuildHash(),
      defaultRole: normalizeAdeRuntimeRole(process.env.ADE_DEFAULT_ROLE),
      packageChannel,
      projectRoot: projectRoot ? path.resolve(projectRoot) : null,
    };
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
          ...resolveRuntimeEnvInfo(),
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
            inspectPath: true,
            getDefaultParentDir: true,
            handoffStoragePreflight: true,
            create: true,
            clone: true,
            listMyGitHubRepos: true,
          },
          personalChats: personalChatScope.capabilities(),
          account: true,
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
      const envInfo = resolveRuntimeEnvInfo();
      return {
        version: options.serverVersion,
        runtimeKind: "headless",
        ...envInfo,
        pid: process.pid,
        runtimeInfo: {
          name: "ade-rpc",
          version: options.serverVersion,
          ...envInfo,
          multiProject: true,
          pid: process.pid,
        },
        adeDir: layout.adeDir,
        socketPath: layout.socketPath,
        projectCount: projectRegistry.list().length,
      };
    }

    if (method === "account.call") {
      const action = typeof params.action === "string" ? params.action.trim() : "";
      if (!action) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidParams,
          "account.call requires action.",
        );
      }
      // Gate credential-bearing account actions (getToken/startLogin/pollLogin/
      // signOut) to cto-role callers, mirroring the run_ade_action gate in
      // adeRpcServer. The caller's requested role (from ade/initialize identity)
      // is clamped to the brain's ADE_DEFAULT_ROLE ceiling, so a subagent that
      // honestly asserts a non-cto role cannot reach these actions. `status`
      // stays open to any role.
      const identityRecord =
        isRecord(initializedParams) && isRecord(initializedParams.identity)
          ? (initializedParams.identity as Record<string, unknown>)
          : null;
      const requestedRole = normalizeAdeRuntimeRole(
        identityRecord ? identityRecord.role : null,
      );
      const callerRole = resolveSessionRole(
        normalizeAdeRuntimeRole(process.env.ADE_DEFAULT_ROLE),
        requestedRole,
      );
      if (isCtoOnlyAdeAction("account", action) && !callerHasRoleAtLeast(callerRole, "cto")) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidRequest,
          `account.${action} requires the cto role.`,
        );
      }
      // `ade login` connects with autoRegisterProject:false, so the invoking
      // project is never in projects.json. Register its root as an account-config
      // source (WITHOUT projects.add) so startLogin can read that project's
      // CLERK_* secrets; this preserves the "login does no projects.add" invariant.
      if (action === "startLogin") {
        const startArgs = isRecord(params.args) ? params.args : {};
        const startProjectRoot =
          typeof startArgs.projectRoot === "string" ? startArgs.projectRoot.trim() : "";
        if (startProjectRoot) {
          registerAccountConfigProjectRoot(startProjectRoot);
        }
      }
      registerAccountProjects();
      return await callAccountAction({
        service: accountAuthService,
        action,
        actionArgs: isRecord(params.args) ? params.args : {},
      });
    }

    if (method === "personalChats.call") {
      return await personalChatScope.call(params.action, params.args);
    }

    if (method === "personalChats.streamEvents") {
      return await personalChatScope.streamEvents(params);
    }

    if (method === "projects.list") {
      return decorateProjectListWithIcons(projectRegistry.list());
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
      return decorateProjectWithIcon(projectRegistry.add(rootPath));
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

    if (method === "projects.inspectPath") {
      const targetPath = readOptionalString(params.path);
      if (!targetPath) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidParams,
          "projects.inspectPath requires path.",
        );
      }
      // Deliberately uncached: desktop main's inspectProjectPathCached relies
      // on lane attach/adopt IPC hooks for invalidation, which never fire in
      // this long-lived daemon — a cache here could serve pre-attach results.
      return await inspectProjectPath(targetPath);
    }

    if (method === "projects.getDefaultParentDir") {
      return defaultParentDir(projectRegistry);
    }

    if (method === "projects.getHandoffStoragePreflight") {
      return await inspectHandoffStorage(params);
    }

    if (method === "projects.create") {
      const result =
        await createMachineProjectScaffoldService().createLocalProject(
          readCreateProjectInput(params),
        );
      return decorateProjectWithIcon(projectRegistry.add(result.rootPath));
    }

    if (method === "projects.clone") {
      const result =
        await createMachineProjectScaffoldService().cloneRepository(
          readCloneProjectInput(params),
        );
      return decorateProjectWithIcon(projectRegistry.add(result.rootPath));
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
      const syncService = await getSyncService();
      return await syncService.getStatus({
        includeTransferReadiness: params.includeTransferReadiness === true,
        forceTransferReadiness: params.forceTransferReadiness === true,
      });
    }

    if (method === "sync.refreshDiscovery") {
      return await (await getSyncService()).refreshDiscovery();
    }

    if (method === "sync.listDevices") {
      return await (await getSyncService()).listDevices();
    }

    if (method === "sync.updateLocalDevice") {
      const name = typeof params.name === "string" ? params.name : undefined;
      const deviceType =
        typeof params.deviceType === "string"
          ? (params.deviceType as SyncPeerDeviceType)
          : undefined;
      return await (
        await getSyncService()
      ).updateLocalDevice({
        ...(name !== undefined ? { name } : {}),
        ...(deviceType !== undefined ? { deviceType } : {}),
      });
    }

    if (method === "sync.connectToBrain") {
      const syncService = await getSyncService();
      return await syncService.connectToBrain(
        omitProjectId(params) as Parameters<
          typeof syncService.connectToBrain
        >[0],
      );
    }

    if (method === "sync.disconnectFromBrain") {
      return await (await getSyncService()).disconnectFromBrain();
    }

    if (method === "sync.forgetDevice") {
      const deviceId =
        typeof params.deviceId === "string" ? params.deviceId : "";
      return await (await getSyncService()).forgetDevice(deviceId);
    }

    if (method === "sync.getTransferReadiness") {
      return await (await getSyncService()).getTransferReadiness();
    }

    if (method === "sync.transferBrainToLocal") {
      return await (await getSyncService()).transferBrainToLocal();
    }

    if (method === "sync.getPin") {
      return { pin: (await getSyncService()).getPin() };
    }

    if (method === "sync.setPin") {
      const pin = typeof params.pin === "string" ? params.pin : "";
      return await (await getSyncService()).setPin(pin);
    }

    if (method === "sync.generatePin") {
      return await (await getSyncService()).generatePin();
    }

    if (method === "sync.clearPin") {
      return await (await getSyncService()).clearPin();
    }

    if (method === "sync.getRuntimeName") {
      return { runtimeName: (await getSyncService()).getRuntimeName() };
    }

    if (method === "sync.setRuntimeName") {
      const name = typeof params.name === "string" ? params.name : "";
      return await (await getSyncService()).setRuntimeName(name);
    }

    if (method === "sync.clearRuntimeName") {
      return await (await getSyncService()).clearRuntimeName();
    }

    if (method === "sync.getDesktopPairingInfo") {
      const syncService = await getSyncService();
      // This daemon socket is the trusted desktop-local surface. The paired
      // command path still consults the descriptor's viewerAllowed=false
      // policy before it can reach the same handler.
      return await syncService.executeRemoteCommand({
        commandId: `local-runtime-${randomUUID()}`,
        action: "sync.getDesktopPairingInfo",
        args: {},
      });
    }

    if (method === "sync.getCloudRelayStatus") {
      return (await getSyncService()).getCloudRelayStatus();
    }

    if (method === "sync.setCloudRelayEnabled") {
      return await (await getSyncService()).setCloudRelayEnabled(params.enabled === true);
    }

    if (method === "sync.getRequireDpop") {
      return (await getSyncService()).getRequireDpop();
    }

    if (method === "sync.setRequireDpop") {
      return (await getSyncService()).setRequireDpop(params.requireDpop === true);
    }

    if (method === "sync.setActiveLanePresence") {
      const laneIds = Array.isArray(params.laneIds)
        ? params.laneIds.filter(
            (laneId): laneId is string => typeof laneId === "string",
          )
        : [];
      await (await getSyncService()).setActiveLanePresence(laneIds);
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
    if (ownsPersonalChatScope) void personalChatScope.dispose();
  };

  handler.setNotifier = (notify: JsonRpcNotifier | null) => {
    notifier = notify;
  };

  return handler;
}
