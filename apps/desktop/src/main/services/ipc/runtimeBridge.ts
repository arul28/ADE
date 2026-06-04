import { BrowserWindow, ipcMain, powerMonitor, type WebContents } from "electron";
import fs from "node:fs";
import path from "node:path";
import { IPC } from "../../../shared/ipc";
import type {
  CloneProjectInput,
  CreateProjectInput,
  AdeActionRegistryEntry,
  ListMyGitHubReposInput,
  ListMyGitHubReposResult,
  OpenProjectBinding,
  ProjectInfo,
  ProjectBrowseInput,
  ProjectBrowseResult,
  ProjectDetail,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeActionRequest,
  RemoteRuntimeActionResult,
  RemoteRuntimeBufferedEvent,
  RemoteRuntimeConnectResult,
  RemoteRuntimeDiscoveryResult,
  RemoteRuntimeEventNotificationPayload,
  RemoteRuntimeLocalWorkCheckResult,
  RemoteRuntimeProjectRecord,
  RemoteRuntimeProjectWorkSummary,
  RemoteRuntimeSshHostKeyTrustStatus,
  RemoteRuntimeStreamEventsRequest,
  RemoteRuntimeStreamEventsResult,
  RemoteRuntimeTarget,
  RemoteRuntimeTargetInput,
  RemoteRuntimeTrustSshHostKeyResult,
} from "../../../shared/types";
import type { LocalRuntimeConnectionPool } from "../localRuntime/localRuntimeConnectionPool";
import { RemoteConnectionPool } from "../remoteRuntime/remoteConnectionPool";
import { RemoteConnectionService } from "../remoteRuntime/remoteConnectionService";
import { discoverLanRuntimes } from "../remoteRuntime/runtimeDiscovery";
import { RemoteTargetRegistry } from "../remoteRuntime/remoteTargetRegistry";
import { hasKnownSshHostKeyForTarget } from "../remoteRuntime/sshTransport";
import { runGit } from "../git/git";
import { getProjectWorkSummary } from "../projects/projectDetailService";
import { readGlobalState } from "../state/globalState";
import { shouldSendPtyDataToWebContents } from "../pty/ptyDataSubscriptions";

type RuntimeBridgeArgs = {
  appVersion: string;
  globalStatePath: string;
  getWindowSession?: (windowId: number | null) => {
    windowId: number | null;
    project: ProjectInfo | null;
    binding: OpenProjectBinding | null;
    openProjectTabs?: ProjectInfo[];
    pendingLocalProjectRoots?: string[];
  };
  bindRemoteProject?: (
    windowId: number | null,
    binding: OpenProjectBinding & { kind: "remote" },
  ) => void;
  localRuntimeConnectionPool?: LocalRuntimeConnectionPool | null;
  getGitHubTokenForRemoteClone?: (() => string | null) | null;
};

const RUNTIME_ACTION_CLIENT_ID_FIELD = "__adeRuntimeClientId";
const REMOTE_RUNTIME_SYNC_METHODS = new Set([
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
  "modelPicker.getFavorites",
  "modelPicker.setFavorites",
  "modelPicker.toggleFavorite",
  "modelPicker.getRecents",
  "modelPicker.pushRecent",
]);

type RuntimeEventWindowSubscription = {
  bindingKey: string;
  requestKey: string;
  cleanup: (() => void) | null;
};

type RuntimeEventSubscribe = (
  onEvent: (event: RemoteRuntimeBufferedEvent) => void,
  onEnded: () => void,
) => Promise<() => void>;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRemoteRuntimeSyncMethod(value: string): boolean {
  return REMOTE_RUNTIME_SYNC_METHODS.has(value);
}

function withRuntimeActionClientMetadata(
  request: RemoteRuntimeActionRequest,
  senderId: number,
): RemoteRuntimeActionRequest {
  if (
    request.domain !== "file" ||
    (request.action !== "watchWorkspace" &&
      request.action !== "stopWatching") ||
    !Number.isInteger(senderId) ||
    senderId <= 0
  ) {
    return request;
  }

  const args = isObjectRecord(request.args) ? request.args : {};
  return {
    ...request,
    args: {
      ...args,
      [RUNTIME_ACTION_CLIENT_ID_FIELD]: senderId,
    },
  };
}

type WindowRuntimeSession = NonNullable<
  ReturnType<NonNullable<RuntimeBridgeArgs["getWindowSession"]>>
>;

function normalizeLocalRuntimeRootPath(
  rootPath: string | null | undefined,
): string | null {
  const trimmed = typeof rootPath === "string" ? rootPath.trim() : "";
  if (!trimmed) return null;
  return path.resolve(trimmed);
}

function localRuntimeRootKey(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function collectAuthorizedLocalRuntimeRoots(
  session: WindowRuntimeSession | null | undefined,
): Map<string, string> {
  const roots = new Map<string, string>();
  const addRoot = (rootPath: string | null | undefined): void => {
    const normalized = normalizeLocalRuntimeRootPath(rootPath);
    if (!normalized) return;
    const key = localRuntimeRootKey(normalized);
    if (!roots.has(key)) roots.set(key, normalized);
  };

  if (session?.binding?.kind === "local") addRoot(session.binding.rootPath);
  addRoot(session?.project?.rootPath);
  for (const project of session?.openProjectTabs ?? []) {
    addRoot(project.rootPath);
  }
  for (const rootPath of session?.pendingLocalProjectRoots ?? []) {
    addRoot(rootPath);
  }

  return roots;
}

function resolveAuthorizedLocalRuntimeRootPath(
  session: WindowRuntimeSession | null | undefined,
  requestedRootPath: string | null | undefined,
): string | null {
  const roots = collectAuthorizedLocalRuntimeRoots(session);
  const requested = normalizeLocalRuntimeRootPath(requestedRootPath);
  if (requested) {
    return roots.get(localRuntimeRootKey(requested)) ?? null;
  }

  const fallbackRoot =
    session?.binding?.kind === "local"
      ? session.binding.rootPath
      : (session?.project?.rootPath ?? null);
  const normalizedFallback = normalizeLocalRuntimeRootPath(fallbackRoot);
  return normalizedFallback
    ? roots.get(localRuntimeRootKey(normalizedFallback)) ?? null
    : null;
}

function canBindRemoteProjectToSender(
  windowId: number | null,
  sender: WebContents,
): boolean {
  if (sender.isDestroyed()) return false;
  if (windowId == null) return true;
  const window = BrowserWindow.fromId(windowId);
  if (!window || window.isDestroyed()) return false;
  return !window.webContents.isDestroyed();
}

function normalizeGitRemoteForComparison(
  value: string | null | undefined,
): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  const withoutGitSuffix = trimmed.replace(/\.git$/i, "");
  if (!withoutGitSuffix.includes("://")) {
    const scpLike = /^(?:[^@/:]+@)?([^:]+):(.+)$/.exec(withoutGitSuffix);
    if (scpLike?.[1] && scpLike[2]) {
      return `${scpLike[1].toLowerCase()}/${scpLike[2].replace(/^\/+/, "")}`.toLowerCase();
    }
  }
  try {
    const parsed = new URL(withoutGitSuffix);
    return `${parsed.hostname.toLowerCase()}/${parsed.pathname.replace(/^\/+/, "")}`.toLowerCase();
  } catch {
    return withoutGitSuffix.toLowerCase();
  }
}

async function inspectLocalWorkForRemoteOrigin(args: {
  rootPath: string;
  displayName: string;
  remoteOriginKey: string;
}): Promise<RemoteRuntimeLocalWorkCheckResult["matches"][number] | null> {
  if (!fs.existsSync(args.rootPath)) return null;
  const origin = await runGit(["remote", "get-url", "origin"], {
    cwd: args.rootPath,
    timeoutMs: 8_000,
  });
  if (origin.exitCode !== 0) return null;
  const originUrl = origin.stdout.trim();
  if (normalizeGitRemoteForComparison(originUrl) !== args.remoteOriginKey)
    return null;
  const workSummary = await getProjectWorkSummary(args.rootPath).catch(
    () => null,
  );
  const dirtyCount = workSummary?.dirtyFileCount ?? 0;
  if (dirtyCount <= 0) return null;
  return {
    rootPath: args.rootPath,
    displayName: args.displayName,
    gitOriginUrl: originUrl,
    dirtyCount,
    workSummary,
  };
}

async function getRemoteProjectWorkSummary(args: {
  targetId: string;
  rootPath: string | null;
  remoteConnectionService: RemoteConnectionService;
}): Promise<RemoteRuntimeProjectWorkSummary | null> {
  if (!args.targetId || !args.rootPath) return null;
  return await args.remoteConnectionService
    .getProjectWorkSummary(args.targetId, args.rootPath)
    .catch(() => null);
}

function createGitHubAuthHeader(token: string | null | undefined): string | null {
  const trimmed = token?.trim();
  if (!trimmed) return null;
  const basic = Buffer.from(`x-access-token:${trimmed}`, "utf8").toString("base64");
  return `basic ${basic}`;
}

function stripCloneAuthHeader(input: CloneProjectInput): CloneProjectInput {
  const { githubAuthHeader: _githubAuthHeader, ...safeInput } = input;
  return safeInput;
}

export function registerRuntimeBridge({
  appVersion,
  bindRemoteProject,
  getGitHubTokenForRemoteClone,
  getWindowSession,
  globalStatePath,
  localRuntimeConnectionPool,
}: RuntimeBridgeArgs): void {
  const remoteTargetRegistry = new RemoteTargetRegistry();
  const remoteConnectionPool = new RemoteConnectionPool(
    remoteTargetRegistry,
    appVersion,
  );
  const remoteConnectionService = new RemoteConnectionService(
    remoteTargetRegistry,
    remoteConnectionPool,
  );
  const runtimeEventSubscriptions = new Map<
    number,
    RuntimeEventWindowSubscription
  >();
  const runtimeEventWatchedSenders = new Set<number>();
  const remoteOpenProjectGenerations = new Map<string, number>();
  let remoteOpenProjectGeneration = 0;

  remoteConnectionService.onSnapshotChanged((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.webContents.isDestroyed()) continue;
      window.webContents.send(
        IPC.remoteRuntimeConnectionSnapshotChanged,
        snapshot,
      );
    }
  });
  const autoconnectTimer = setTimeout(() => {
    remoteConnectionService.startAutoconnect();
  }, 0);
  autoconnectTimer.unref?.();
  const probeRemoteConnectionsAfterWake = (): void => {
    remoteConnectionService.probeSavedConnections();
  };
  powerMonitor?.on?.("resume", probeRemoteConnectionsAfterWake);
  powerMonitor?.on?.("unlock-screen", probeRemoteConnectionsAfterWake);

  const cleanupRuntimeEventSubscription = (senderId: number): void => {
    const existing = runtimeEventSubscriptions.get(senderId);
    runtimeEventSubscriptions.delete(senderId);
    try {
      existing?.cleanup?.();
    } catch {
      // Best-effort subscription cleanup.
    }
  };

  const watchRuntimeEventSender = (sender: WebContents): void => {
    if (runtimeEventWatchedSenders.has(sender.id)) return;
    runtimeEventWatchedSenders.add(sender.id);
    sender.once("destroyed", () => {
      runtimeEventWatchedSenders.delete(sender.id);
      cleanupRuntimeEventSubscription(sender.id);
    });
  };

  const shouldForwardRuntimeEvent = (
    sender: WebContents,
    event: RemoteRuntimeBufferedEvent,
  ): boolean => {
    if (event.category !== "pty") return true;
    if (event.payload.type !== "pty_data") return true;
    const ptyEvent = isObjectRecord(event.payload.event)
      ? event.payload.event
      : null;
    const ptyId = typeof ptyEvent?.ptyId === "string"
      ? ptyEvent.ptyId
      : "";
    return !ptyId || shouldSendPtyDataToWebContents(sender, ptyId);
  };

  const sendRuntimeEvent = (
    sender: WebContents,
    bindingKey: string,
    requestKey: string,
    event: RemoteRuntimeBufferedEvent,
  ): void => {
    const existing = runtimeEventSubscriptions.get(sender.id);
    if (
      !existing ||
      existing.bindingKey !== bindingKey ||
      existing.requestKey !== requestKey ||
      sender.isDestroyed()
    )
      return;
    if (!shouldForwardRuntimeEvent(sender, event)) return;
    const payload: RemoteRuntimeEventNotificationPayload = {
      bindingKey,
      event,
    };
    try {
      sender.send(IPC.runtimeEvent, payload);
    } catch {
      // Renderer may have gone away between the destroyed check and send.
    }
  };

  const ensureRuntimeEventSubscription = (
    sender: WebContents,
    bindingKey: string,
    requestKey: string,
    subscribe: RuntimeEventSubscribe,
  ): void => {
    const existing = runtimeEventSubscriptions.get(sender.id);
    if (existing?.requestKey === requestKey) return;
    cleanupRuntimeEventSubscription(sender.id);
    watchRuntimeEventSender(sender);
    runtimeEventSubscriptions.set(sender.id, { bindingKey, requestKey, cleanup: null });
    const onEnded = () => {
      const current = runtimeEventSubscriptions.get(sender.id);
      if (current?.requestKey === requestKey && current.bindingKey === bindingKey) {
        runtimeEventSubscriptions.delete(sender.id);
      }
    };
    void subscribe(
      (event) => sendRuntimeEvent(sender, bindingKey, requestKey, event),
      onEnded,
    )
      .then((cleanup) => {
        const current = runtimeEventSubscriptions.get(sender.id);
        if (
          !current ||
          current.requestKey !== requestKey ||
          current.bindingKey !== bindingKey ||
          sender.isDestroyed()
        ) {
          cleanup();
          return;
        }
        current.cleanup = cleanup;
      })
      .catch((error) => {
        const current = runtimeEventSubscriptions.get(sender.id);
        if (current?.requestKey === requestKey && current.bindingKey === bindingKey && !current.cleanup) {
          runtimeEventSubscriptions.delete(sender.id);
        }
        console.warn("Runtime event subscription failed", error);
      });
  };

  ipcMain.handle(
    IPC.remoteRuntimeListTargets,
    async (): Promise<RemoteRuntimeTarget[]> => {
      return remoteConnectionService.listTargets();
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeGetConnectionSnapshot,
    async (): Promise<RemoteRuntimeConnectionSnapshot> => {
      return remoteConnectionService.snapshot();
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeListDiscoveredMachines,
    async (): Promise<RemoteRuntimeDiscoveryResult> => {
      return discoverLanRuntimes();
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeSaveTarget,
    async (
      _event,
      arg: RemoteRuntimeTargetInput,
    ): Promise<RemoteRuntimeTarget> => {
      return remoteConnectionService.saveTarget(arg);
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeRemoveTarget,
    async (_event, arg: { id: string }): Promise<{ removed: boolean }> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      if (!id) return { removed: false };
      return { removed: remoteConnectionService.removeTarget(id) };
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeGetSshHostKeyTrust,
    async (
      _event,
      arg: { id: string },
    ): Promise<RemoteRuntimeSshHostKeyTrustStatus> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      if (!id) throw new Error("Remote target id is required.");
      return await remoteConnectionService.getSshHostKeyTrust(id);
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeTrustSshHostKey,
    async (
      _event,
      arg: { id: string; fingerprintSha256: string },
    ): Promise<RemoteRuntimeTrustSshHostKeyResult> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const fingerprintSha256 =
        typeof arg?.fingerprintSha256 === "string"
          ? arg.fingerprintSha256.trim()
          : "";
      if (!id) throw new Error("Remote target id is required.");
      if (!fingerprintSha256)
        throw new Error("SSH host key fingerprint is required.");
      return await remoteConnectionService.trustSshHostKey(
        id,
        fingerprintSha256,
      );
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeConnect,
    async (
      _event,
      arg: { id: string },
    ): Promise<RemoteRuntimeConnectResult> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      return await remoteConnectionService.connect(id);
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeListProjects,
    async (
      _event,
      arg: { id: string },
    ): Promise<RemoteRuntimeProjectRecord[]> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      if (!id) return [];
      return await remoteConnectionService.projects(id);
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeAddProject,
    async (
      _event,
      arg: { id: string; rootPath: string },
    ): Promise<RemoteRuntimeProjectRecord> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const rootPath =
        typeof arg?.rootPath === "string" ? arg.rootPath.trim() : "";
      if (!rootPath) throw new Error("Remote project path is required.");
      return await remoteConnectionService.addProject(id, rootPath);
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeBrowseDirectories,
    async (
      _event,
      arg: { id: string; args?: ProjectBrowseInput },
    ): Promise<ProjectBrowseResult> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      return await remoteConnectionService.browseDirectories(
        id,
        arg?.args ?? {},
      );
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeGetProjectDetail,
    async (
      _event,
      arg: { id: string; rootPath: string },
    ): Promise<ProjectDetail> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const rootPath =
        typeof arg?.rootPath === "string" ? arg.rootPath.trim() : "";
      if (!rootPath) throw new Error("Remote project path is required.");
      return await remoteConnectionService.getProjectDetail(id, rootPath);
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeGetDefaultParentDir,
    async (_event, arg: { id: string }): Promise<string> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      return await remoteConnectionService.getDefaultParentDir(id);
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeCreateProject,
    async (
      _event,
      arg: { id: string; input?: CreateProjectInput },
    ): Promise<RemoteRuntimeProjectRecord> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      return await remoteConnectionService.createProject(
        id,
        arg?.input ?? { name: "", parentDir: "" },
      );
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeCloneProject,
    async (
      _event,
      arg: { id: string; input?: CloneProjectInput },
    ): Promise<RemoteRuntimeProjectRecord> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const input = arg?.input ?? { url: "", parentDir: "" };
      const safeInput = stripCloneAuthHeader(input);
      let githubAuthHeader: string | null = null;
      const target = remoteConnectionService.getTarget(id);
      if (target && hasKnownSshHostKeyForTarget(target)) {
        try {
          githubAuthHeader = createGitHubAuthHeader(
            getGitHubTokenForRemoteClone?.() ?? null,
          );
        } catch {
          githubAuthHeader = null;
        }
      }
      return await remoteConnectionService.cloneProject(
        id,
        githubAuthHeader
          ? { ...safeInput, githubAuthHeader }
          : safeInput,
      );
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeListMyGitHubRepos,
    async (
      _event,
      arg: { id: string; input?: ListMyGitHubReposInput },
    ): Promise<ListMyGitHubReposResult> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      return await remoteConnectionService.listMyGitHubRepos(
        id,
        arg?.input ?? {},
      );
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeOpenProject,
    async (
      event,
      arg: { id: string; projectId: string },
    ): Promise<OpenProjectBinding & { kind: "remote" }> => {
      const windowId = BrowserWindow.fromWebContents(event.sender)?.id ?? null;
      const generationKey =
        windowId == null
          ? `webContents:${event.sender.id}`
          : `window:${windowId}`;
      const requestGeneration = ++remoteOpenProjectGeneration;
      remoteOpenProjectGenerations.set(generationKey, requestGeneration);
      const isLatestOpenRequest = (): boolean =>
        remoteOpenProjectGenerations.get(generationKey) === requestGeneration;

      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const projectId =
        typeof arg?.projectId === "string" ? arg.projectId.trim() : "";
      try {
        const target = id ? remoteConnectionService.getTarget(id) : null;
        if (!target) throw new Error("Remote target was not found.");
        if (!projectId) throw new Error("Remote project is required.");

        const connection = await remoteConnectionService.connect(target.id);
        let project =
          connection.projects.find(
            (candidate) => candidate.projectId === projectId,
          ) ?? null;
        if (!project) {
          const projects = await remoteConnectionService.projects(target.id);
          project =
            projects.find((candidate) => candidate.projectId === projectId) ??
            null;
        }
        if (!project)
          throw new Error("Remote project was not found on this runtime.");

        const binding: OpenProjectBinding & { kind: "remote" } = {
          kind: "remote",
          key: `remote:${target.id}:${project.projectId}`,
          targetId: target.id,
          runtimeName: target.name,
          projectId: project.projectId,
          rootPath: project.rootPath,
          displayName: project.displayName || path.basename(project.rootPath),
        };
        if (
          isLatestOpenRequest() &&
          canBindRemoteProjectToSender(windowId, event.sender)
        ) {
          bindRemoteProject?.(windowId, binding);
        }
        return binding;
      } finally {
        if (isLatestOpenRequest()) {
          remoteOpenProjectGenerations.delete(generationKey);
        }
      }
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeListActionRegistry,
    async (
      _event,
      arg: { id: string; projectId: string },
    ): Promise<AdeActionRegistryEntry[]> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const projectId =
        typeof arg?.projectId === "string" ? arg.projectId.trim() : "";
      const target = id ? remoteConnectionService.getTarget(id) : null;
      if (!target) throw new Error("Remote target was not found.");
      if (!projectId) throw new Error("Remote project is required.");
      await remoteConnectionService.connect(target.id);
      return await remoteConnectionPool.listActionRegistryForTarget(
        target,
        projectId,
      );
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeCallAction,
    async (
      event,
      arg: {
        id: string;
        projectId: string;
        request: RemoteRuntimeActionRequest;
      },
    ): Promise<RemoteRuntimeActionResult> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const projectId =
        typeof arg?.projectId === "string" ? arg.projectId.trim() : "";
      const request =
        arg?.request &&
        typeof arg.request === "object" &&
        !Array.isArray(arg.request)
          ? arg.request
          : null;
      const target = id ? remoteConnectionService.getTarget(id) : null;
      const domain =
        typeof request?.domain === "string" ? request.domain.trim() : "";
      const action =
        typeof request?.action === "string" ? request.action.trim() : "";
      if (!target) throw new Error("Remote target was not found.");
      if (!projectId) throw new Error("Remote project is required.");
      if (!domain || !action)
        throw new Error("Remote action domain and action are required.");
      await remoteConnectionService.connect(target.id);
      const actionRequest = withRuntimeActionClientMetadata(
        { ...request!, domain, action },
        event.sender.id,
      );
      return await remoteConnectionPool.callActionForTarget(
        target,
        projectId,
        actionRequest,
      );
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeCallSync,
    async (
      _event,
      arg: {
        id: string;
        projectId: string;
        method: string;
        params?: Record<string, unknown>;
      },
    ): Promise<unknown> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const projectId =
        typeof arg?.projectId === "string" ? arg.projectId.trim() : "";
      const method = typeof arg?.method === "string" ? arg.method.trim() : "";
      const params = isObjectRecord(arg?.params) ? arg.params : {};
      const target = id ? remoteConnectionService.getTarget(id) : null;
      if (!target) throw new Error("Remote target was not found.");
      if (!projectId) throw new Error("Remote project is required.");
      if (!isRemoteRuntimeSyncMethod(method))
        throw new Error("Remote sync method is not exposed.");
      await remoteConnectionService.connect(target.id);
      return await remoteConnectionPool.callSyncForTarget(
        target,
        projectId,
        method,
        params,
      );
    },
  );

  ipcMain.handle(
    IPC.localRuntimeListActionRegistry,
    async (
      event,
      arg: { rootPath?: string | null } = {},
    ): Promise<AdeActionRegistryEntry[]> => {
      if (!localRuntimeConnectionPool) {
        throw new Error("Local ADE runtime connection is not available for this window.");
      }
      const windowId = BrowserWindow.fromWebContents(event.sender)?.id ?? null;
      const session = getWindowSession ? getWindowSession(windowId) : null;
      const rootPath = resolveAuthorizedLocalRuntimeRootPath(
        session,
        arg?.rootPath,
      );
      if (!rootPath) {
        throw new Error(
          "Local runtime project is not available for this window.",
        );
      }
      return await localRuntimeConnectionPool.listActionRegistryForRoot(rootPath);
    },
  );

  ipcMain.handle(
    IPC.localRuntimeCallAction,
    async (
      event,
      arg: { rootPath?: string | null; request: RemoteRuntimeActionRequest },
    ): Promise<RemoteRuntimeActionResult> => {
      if (!localRuntimeConnectionPool) {
        throw new Error("Local ADE runtime connection is not available for this window.");
      }
      const request =
        arg?.request &&
        typeof arg.request === "object" &&
        !Array.isArray(arg.request)
          ? arg.request
          : null;
      const domain =
        typeof request?.domain === "string" ? request.domain.trim() : "";
      const action =
        typeof request?.action === "string" ? request.action.trim() : "";
      if (!domain || !action)
        throw new Error("Local runtime action domain and action are required.");

      const windowId = BrowserWindow.fromWebContents(event.sender)?.id ?? null;
      const session = getWindowSession ? getWindowSession(windowId) : null;
      const rootPath = resolveAuthorizedLocalRuntimeRootPath(
        session,
        arg?.rootPath,
      );
      if (!rootPath) {
        throw new Error(
          "Local runtime project is not available for this window.",
        );
      }
      const actionRequest = withRuntimeActionClientMetadata(
        { ...request!, domain, action },
        event.sender.id,
      );
      return await localRuntimeConnectionPool.callActionForRoot(
        rootPath,
        actionRequest,
      );
    },
  );

  ipcMain.handle(
    IPC.localRuntimeCallSync,
    async (
      event,
      arg: { rootPath?: string | null; method: string; params?: Record<string, unknown> },
    ): Promise<unknown> => {
      if (!localRuntimeConnectionPool) {
        throw new Error("Local ADE runtime connection is not available for this window.");
      }
      const method = typeof arg?.method === "string" ? arg.method.trim() : "";
      const params = isObjectRecord(arg?.params) ? arg.params : {};
      if (!isRemoteRuntimeSyncMethod(method))
        throw new Error("Local sync method is not exposed.");

      const windowId = BrowserWindow.fromWebContents(event.sender)?.id ?? null;
      const session = getWindowSession ? getWindowSession(windowId) : null;
      const rootPath = resolveAuthorizedLocalRuntimeRootPath(
        session,
        arg?.rootPath,
      );
      if (!rootPath) {
        throw new Error(
          "Local runtime project is not available for this window.",
        );
      }
      return await localRuntimeConnectionPool.callSyncForRoot(
        rootPath,
        method,
        params,
      );
    },
  );

  ipcMain.handle(
    IPC.localRuntimeStreamEvents,
    async (
      event,
      arg: { rootPath?: string | null; request?: RemoteRuntimeStreamEventsRequest },
    ): Promise<RemoteRuntimeStreamEventsResult> => {
      if (!localRuntimeConnectionPool) {
        throw new Error("Local ADE runtime connection is not available for this window.");
      }

      const windowId = BrowserWindow.fromWebContents(event.sender)?.id ?? null;
      const session = getWindowSession ? getWindowSession(windowId) : null;
      const binding = session?.binding;
      const rootPath = resolveAuthorizedLocalRuntimeRootPath(
        session,
        arg?.rootPath,
      );
      if (!rootPath) {
        throw new Error(
          "Local runtime project is not available for this window.",
        );
      }
      const requestedRootPath = normalizeLocalRuntimeRootPath(arg?.rootPath);
      if (binding?.kind === "local" || requestedRootPath) {
        const bindingKey =
          binding?.kind === "local" &&
          localRuntimeRootKey(binding.rootPath) === localRuntimeRootKey(rootPath)
            ? binding.key
            : `local:${rootPath}`;
        ensureRuntimeEventSubscription(
          event.sender,
          bindingKey,
          `${bindingKey}:${arg?.request?.category ?? "*"}`,
          (onEvent, onEnded) =>
            localRuntimeConnectionPool.subscribeEventsForRoot(
              rootPath,
              {
                cursor: arg?.request?.cursor,
                limit: arg?.request?.limit,
                category: arg?.request?.category,
              },
              onEvent,
              onEnded,
            ),
        );
        return {
          events: [],
          nextCursor: arg?.request?.cursor ?? 0,
          hasMore: false,
        };
      }
      return await localRuntimeConnectionPool.streamEventsForRoot(
        rootPath,
        arg?.request ?? {},
      );
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeStreamEvents,
    async (
      event,
      arg: {
        id: string;
        projectId: string;
        request?: RemoteRuntimeStreamEventsRequest;
      },
    ): Promise<RemoteRuntimeStreamEventsResult> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const projectId =
        typeof arg?.projectId === "string" ? arg.projectId.trim() : "";
      if (!id) throw new Error("Remote target id is required.");
      if (!projectId) throw new Error("Remote project id is required.");
      const target = remoteConnectionService.getTarget(id);
      if (!target) throw new Error("Remote target was not found.");
      await remoteConnectionService.connect(target.id);
      ensureRuntimeEventSubscription(
        event.sender,
        `remote:${target.id}:${projectId}`,
        `remote:${target.id}:${projectId}:${arg?.request?.category ?? "*"}`,
        (onEvent, onEnded) =>
          remoteConnectionPool.subscribeEventsForTarget(
            target,
            projectId,
            {
              cursor: arg?.request?.cursor,
              limit: arg?.request?.limit,
              category: arg?.request?.category,
            },
            onEvent,
            onEnded,
          ),
      );
      return remoteConnectionPool.streamEventsForTarget(
        target,
        projectId,
        arg?.request ?? {},
      );
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeCheckLocalWork,
    async (
      _event,
      arg: { id?: string; project?: RemoteRuntimeProjectRecord },
    ): Promise<RemoteRuntimeLocalWorkCheckResult> => {
      const targetId = typeof arg?.id === "string" ? arg.id.trim() : "";
      const project =
        arg?.project &&
        typeof arg.project === "object" &&
        !Array.isArray(arg.project)
          ? arg.project
          : null;
      const remoteProjectId =
        typeof project?.projectId === "string" ? project.projectId : "";
      const remoteDisplayName =
        typeof project?.displayName === "string" && project.displayName.trim()
          ? project.displayName.trim()
          : typeof project?.rootPath === "string"
            ? path.basename(project.rootPath)
            : "remote project";
      const remoteGitOriginUrl =
        typeof project?.gitOriginUrl === "string" && project.gitOriginUrl.trim()
          ? project.gitOriginUrl.trim()
          : null;
      const remoteWorkSummary = await getRemoteProjectWorkSummary({
        targetId,
        rootPath:
          typeof project?.rootPath === "string" && project.rootPath.trim()
            ? project.rootPath.trim()
            : null,
        remoteConnectionService,
      });
      const remoteOriginKey =
        normalizeGitRemoteForComparison(remoteGitOriginUrl);
      if (!remoteOriginKey) {
        return {
          remoteProjectId,
          remoteDisplayName,
          remoteGitOriginUrl,
          remoteWorkSummary,
          matches: [],
          hasDirtyWork: false,
        };
      }

      const state = readGlobalState(globalStatePath);
      const recents = (state.recentProjects ?? [])
        .slice(0, 100)
        .map((entry) => ({
          rootPath: entry.rootPath,
          displayName: entry.displayName,
        }));
      const localRuntimeProjects = localRuntimeConnectionPool
        ? await localRuntimeConnectionPool
            .projects()
            .catch(() => [] as RemoteRuntimeProjectRecord[])
        : [];
      const entriesByRoot = new Map<
        string,
        { rootPath: string; displayName: string }
      >();
      for (const entry of recents) {
        if (!entry.rootPath) continue;
        entriesByRoot.set(path.resolve(entry.rootPath), entry);
      }
      for (const project of localRuntimeProjects) {
        if (!project.rootPath) continue;
        const rootPath = path.resolve(project.rootPath);
        if (entriesByRoot.has(rootPath)) continue;
        entriesByRoot.set(rootPath, {
          rootPath: project.rootPath,
          displayName: project.displayName || path.basename(project.rootPath),
        });
      }
      const matches = (
        await Promise.all(
          [...entriesByRoot.values()].map((entry) =>
            inspectLocalWorkForRemoteOrigin({
              rootPath: entry.rootPath,
              displayName: entry.displayName,
              remoteOriginKey,
            }),
          ),
        )
      ).filter(
        (
          entry,
        ): entry is RemoteRuntimeLocalWorkCheckResult["matches"][number] =>
          entry != null,
      );

      return {
        remoteProjectId,
        remoteDisplayName,
        remoteGitOriginUrl,
        remoteWorkSummary,
        matches,
        hasDirtyWork: matches.length > 0,
      };
    },
  );

  ipcMain.handle(
    IPC.remoteRuntimeDisconnect,
    async (_event, arg: { id: string }): Promise<{ disconnected: boolean }> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      if (!id) return { disconnected: false };
      remoteConnectionService.disconnect(id);
      return { disconnected: true };
    },
  );
}
