import { app, BrowserWindow, powerMonitor, type WebContents } from "electron";
import { createTrustedIpcHandle } from "./trustedRendererSender";
import type { ProductAnalyticsService } from "../analytics/productAnalyticsService";
import { cloudAsleepForUse, cloudRestChanged, cloudUpdateBlocker, cloudWakeForUse } from "../adeCloud/cloudWakeHook";
import { showRememberedOpenDialog } from "../shared/rememberedOpenDialog";
import { resolveMovedProjectRoot } from "../../../../../ade-cli/src/services/projects/projectMove/moveJournal";
import { thisMachineDisplayName } from "../../../../../ade-cli/src/services/sync/deviceRegistryService";
import { accountProjectIdForCopy, localLinkOwnership } from "../../../../../ade-cli/src/services/projects/localLinkOwnership";
import { isMachineScopeRootPath, MACHINE_SCOPE_ROOT_PATH } from "../../../shared/machineScope";
import type { DeeplinkOwnership } from "../../../shared/deeplinks";
import path from "node:path";
import { IPC } from "../../../shared/ipc";
import type {
  ProjectRemovalOutcome,
  ProjectRemovalRequest,
  RemoteProjectRemovalInspection,
} from "../../../shared/projectRemoval";
import { describeReportForMachine, type HostReachabilityReport } from "../../../shared/connectionDiagnosis";
import { remoteProjectBindingKey } from "../../../shared/projectIdentity";
import { THIS_MACHINE_ID } from "../../../shared/machineIdentity";
import { AdeExpectedError } from "../../../shared/expectedError";
import type {
  CloneProjectInput,
  CreateProjectInput,
  AdeActionRegistryEntry,
  AdeAccountLocalMachineIdentity,
  ListMyGitHubReposInput,
  ListMyGitHubReposResult,
  OpenProjectBinding,
  PersonalChatCallArgs,
  PersonalChatMachineTarget,
  PersonalChatCallResponse,
  PersonalChatStreamEventsArgs,
  PersonalChatStreamEventsResult,
  ProjectInfo,
  ProjectBrowseInput,
  ProjectBrowseResult,
  ProjectDetail,
  ProjectIcon,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeActionRequest,
  RemoteRuntimeActionResult,
  RemoteRuntimeBufferedEvent,
  RemoteRuntimeConnectResult,
  RemoteRuntimeDiscoveryResult,
  RemoteRuntimeDoctorResult,
  RemoteRuntimeEventCategory,
  RemoteRuntimeEventNotificationPayload,
  RemoteRuntimeLocalPairingInfo,
  RemoteRuntimePairWithMachineArgs,
  RemoteRuntimePairWithMachineResult,
  RemoteRuntimeParsedPairingInput,
  RemoteRuntimePortForward,
  RemoteRuntimePortForwardRequest,
  RemoteRuntimeProjectRecord,
  RemoteRuntimeHandoffStoragePreflightArgs,
  RemoteRuntimeHandoffStoragePreflightResult,
  RemoteRuntimeCloneProjectOptions,
  RemoteRuntimeSshHostKeyTrustStatus,
  RemoteRuntimeStreamEventsRequest,
  RemoteRuntimeStreamEventsResult,
  RemoteRuntimeTarget,
  RemoteRuntimeTargetInput,
  RemoteRuntimeTrustSshHostKeyResult,
  RemoteRuntimeUpdateAndRestartResult,
  RuntimeActivitySummary,
  UpdateImpact,
  RuntimeEventsReleaseRequest,
  RuntimeEventsReleaseResult,
  SyncWebPairingInfo,
} from "../../../shared/types";
import { isRemoteRuntimeEventCategory, REMOTE_TARGET_NOT_FOUND_MESSAGE } from "../../../shared/types/remoteRuntime";
import { parseRuntimeUpdateImpact, UNKNOWN_UPDATE_IMPACT } from "../../../shared/updateImpact";
import { PROJECT_ICON_DIALOG_EXTENSIONS } from "../../../shared/projectIcons";
import { readProjectIconForUpload } from "../projects/projectIconResolver";
import type { ChatAttachmentStagingMode } from "../../../shared/types/chat";
import {
  LEGACY_MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_BYTES,
} from "../../../shared/chatAttachmentLimits";
import type { LocalRuntimeConnectionPool } from "../localRuntime/localRuntimeConnectionPool";
import { createFileWatchLedger, type FileWatchLedger } from "../files/fileWatchLedger";
import { matchRemoteProjectByRootPath } from "../attention/remoteProjectIdentity";
import { RemoteConnectionPool } from "../remoteRuntime/remoteConnectionPool";
import type { RemoteArtifactRangeReader } from "../computerUse/artifactStreamProtocol";
import {
  RemoteConnectionService,
  type AccountMachineReconciliationResult,
} from "../remoteRuntime/remoteConnectionService";
import { discoverLanRuntimes } from "../remoteRuntime/runtimeDiscovery";
import { RemoteTargetRegistry } from "../remoteRuntime/remoteTargetRegistry";
import { updateViaRemoteTerminal } from "../remoteRuntime/remoteTerminalUpdate";
import { getMachineMainLogger } from "../logging/machineLogger";
import { REMOTE_MACHINE_UPDATE_TIMEOUT_MS } from "../localRuntime/localRuntimeTimeoutPolicy";
import { isWindowsSelfInstallBlocked } from "../../../shared/updateVersions";
import { DesktopPairedMachineStore } from "../remoteRuntime/syncPairedMachineStore";
import { parseRemoteRuntimePairingInput } from "../remoteRuntime/pairingInput";
import { hasKnownSshHostKeyForTarget } from "../remoteRuntime/sshTransport";
import { shouldSendPtyDataToWebContents } from "../pty/ptyDataSubscriptions";
import { shouldSendAppControlFrameToWebContents } from "../appControl/appControlFrameSubscriptions";
import { adeActionAccess, isBackgroundAdeWrite } from "../../../shared/adeActionAccess";
import { goneTargetMachineKey, noteGoneTarget, reachGoneTarget } from "../machines/goneTargets";
import { sameMachineKey } from "../../../shared/machineAddress";
import { appControlFrameEventLaneId } from "../../../shared/appControlFrameDemand";
import { forgetRemoteTunnelOrigins, recordRemoteTunnelOrigin } from "../builtInBrowser/remoteTunnelOrigins";
import { getSharedAccountAuthService } from "../../../../../ade-cli/src/services/account/sharedAccountAuthService";
import { getOrCreateLocalAccountMachineIdentity } from "../account/localMachineIdentity";
import {
  createRuntimeEventSubscriptionRegistry,
  type RuntimeEventWindowSubscription,
} from "./runtimeEventSubscriptionRegistry";

type RuntimeBridgeArgs = {
  productAnalyticsService?: Pick<ProductAnalyticsService, "capture">;
  appVersion: string;
  /**
   * Retained for callers; the bridge itself no longer reads global state — the
   * only handler that did (`remoteRuntimeCheckLocalWork`) was removed with its
   * last caller.
   */
  globalStatePath: string;
  getWindowSession?: (windowId: number | null) => {
    windowId: number | null;
    project: ProjectInfo | null;
    binding: OpenProjectBinding | null;
    openProjectTabs?: ProjectInfo[];
    pendingLocalProjectRoots?: string[];
    knownLocalProjectRoots?: string[];
  };
  authorizeLocalRuntimeRoot?: (
    session: WindowRuntimeSession | null | undefined,
    requestedRootPath: string,
  ) => string | null;
  bindRemoteProject?: (
    windowId: number | null,
    binding: OpenProjectBinding & { kind: "remote" },
  ) => void;
  localRuntimeConnectionPool?: LocalRuntimeConnectionPool | null;
  getGitHubTokenForRemoteClone?: (() => string | null | Promise<string | null>) | null;
  getLocalMachineIdentity?: (() => AdeAccountLocalMachineIdentity) | null;
};

const RUNTIME_ACTION_CLIENT_ID_FIELD = "__adeRuntimeClientId";

/**
 * File watches each page still holds on each runtime, so the stops a page
 * never sent can be sent for it (see `fileWatchLedger.ts`). Keyed by the
 * page's sender id, then by runtime.
 */
type PageFileWatches = Map<string, {
  ledger: FileWatchLedger;
  /** Sends a file action to this runtime over its current connection. */
  call: (request: RemoteRuntimeActionRequest) => Promise<unknown>;
  /** The connection that carried these watches closed; the runtime let them go. */
  connectionLost: boolean;
}>;
const fileWatchesBySender = new Map<number, PageFileWatches>();

const localFileWatchRuntimeKey = (rootPath: string): string => `local:${localRuntimeRootKey(rootPath)}`;
const remoteFileWatchRuntimeKey = (targetId: string, projectId: string): string => `remote:${targetId}:${projectId}`;

/** The page's connection to a runtime closed. The runtime releases the watches that connection opened. */
function notePageRuntimeDisconnected(senderId: number, runtimeKey: string): void {
  const entry = fileWatchesBySender.get(senderId)?.get(runtimeKey);
  if (entry && entry.ledger.size > 0) entry.connectionLost = true;
}

/**
 * The page is connected to the runtime again. Open the watches it still holds
 * once more, so a Files view that stayed mounted across the reconnect keeps
 * its updates.
 */
function restorePageFileWatches(senderId: number, runtimeKey: string): void {
  const entry = fileWatchesBySender.get(senderId)?.get(runtimeKey);
  if (!entry?.connectionLost) return;
  entry.connectionLost = false;
  for (const ref of entry.ledger.refs()) {
    void entry.call({
      domain: "file",
      action: "watchWorkspace",
      args: { ...ref.args, [RUNTIME_ACTION_CLIENT_ID_FIELD]: senderId },
    }).catch(() => {
      // The connection closed again; its end marks the entry for the next reconnect.
    });
  }
}

function releasePageFileWatches(senderId: number): void {
  const runtimes = fileWatchesBySender.get(senderId);
  if (!runtimes) return;
  for (const { ledger, call } of runtimes.values()) {
    for (const ref of ledger.drain()) {
      void call({
        domain: "file",
        action: "stopWatching",
        args: { ...ref.args, [RUNTIME_ACTION_CLIENT_ID_FIELD]: senderId },
      }).catch(() => {
        // The runtime is gone or unreachable; its own connection cleanup covers it.
      });
    }
  }
  runtimes.clear();
}

/**
 * Record a file watch or stop that a runtime accepted for `sender`. The first
 * watch also ties the page's lifetime to its watches: a new document committed
 * in the main frame (a reload), a dead renderer and a destroyed window all end the
 * page without its cleanup running.
 */
function trackPageFileWatch(
  sender: WebContents,
  runtimeKey: string,
  request: RemoteRuntimeActionRequest,
  call: (request: RemoteRuntimeActionRequest) => Promise<unknown>,
): void {
  if (request.domain !== "file") return;
  if (request.action !== "watchWorkspace" && request.action !== "stopWatching") return;
  const { [RUNTIME_ACTION_CLIENT_ID_FIELD]: clientId, ...args } = isObjectRecord(request.args) ? request.args : {};
  // The id the runtime counted this watch under. Read from the request: the
  // page can be gone by now, and a destroyed sender has no id to read.
  if (typeof clientId !== "number") return;
  const senderId = clientId;
  if (sender.isDestroyed()) {
    // The page closed while the runtime answered, so its `destroyed` event is
    // past. A watch the runtime just accepted has nobody left to stop it.
    if (request.action === "watchWorkspace") {
      void call({ ...request, action: "stopWatching" }).catch(() => {
        // The runtime is gone or unreachable; its own connection cleanup covers it.
      });
    }
    return;
  }
  let runtimes = fileWatchesBySender.get(senderId);
  if (!runtimes) {
    if (request.action === "stopWatching") return;
    runtimes = new Map();
    fileWatchesBySender.set(senderId, runtimes);
    const release = () => releasePageFileWatches(senderId);
    // `did-navigate` reports a main-frame document that committed. A
    // navigation that only started can still end with the page alive (a
    // download, a 204, an abort), and an in-page route change keeps the page.
    sender.on("did-navigate", release);
    sender.on("render-process-gone", release);
    sender.once("destroyed", () => {
      release();
      fileWatchesBySender.delete(senderId);
    });
  }
  let entry = runtimes.get(runtimeKey);
  if (!entry) {
    if (request.action === "stopWatching") return;
    entry = { ledger: createFileWatchLedger(), call, connectionLost: false };
    runtimes.set(runtimeKey, entry);
  }
  entry.call = call;
  if (request.action === "watchWorkspace") entry.ledger.noteWatch(args, senderId);
  else entry.ledger.noteStop(args, senderId);
}
/**
 * A confirmation dialog waits on this, so it is a few seconds, not a work
 * budget. One deadline covers the ask and its older-machine fallback.
 */
const REMOTE_MACHINE_UPDATE_IMPACT_TIMEOUT_MS = 3_000;
/**
 * The bound on one personal-chats event poll, under the 30s IPC default. A
 * poll is a read from a cursor, so one that runs long (a brain still starting,
 * a busy remote machine) answers with an empty page at the same cursor and the
 * renderer polls again, instead of failing as an IPC timeout.
 */
const PERSONAL_CHAT_EVENT_POLL_DEADLINE_MS = 20_000;

function boundedPersonalChatEventPoll(
  poll: Promise<PersonalChatStreamEventsResult>,
  cursor: number | undefined,
): Promise<PersonalChatStreamEventsResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const emptyPage = new Promise<PersonalChatStreamEventsResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ events: [], nextCursor: cursor ?? 0, hasMore: false }),
      PERSONAL_CHAT_EVENT_POLL_DEADLINE_MS,
    );
    timer.unref?.();
  });
  return Promise.race([poll, emptyPage]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

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
  "sync.getRuntimeName",
  "sync.setRuntimeName",
  "sync.clearRuntimeName",
  "sync.setActiveLanePresence",
  "modelPicker.getFavorites",
  "modelPicker.setFavorites",
  "modelPicker.toggleFavorite",
  "modelPicker.getRecents",
  "modelPicker.pushRecent",
]);

type RuntimeEventSubscriptionInit = Pick<
  RemoteRuntimeStreamEventsResult,
  "nextCursor" | "hasMore" | "eventEpoch" | "gap" | "oldestCursor"
>;

type RuntimeEventSubscribe = (
  onEvent: (event: RemoteRuntimeBufferedEvent, eventEpoch?: string | null) => void,
  onEnded: () => void,
  onSubscribed?: (result: RuntimeEventSubscriptionInit) => void,
) => Promise<() => void>;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeRuntimeStreamEventsRequest(value: unknown): RemoteRuntimeStreamEventsRequest {
  if (!isObjectRecord(value)) return {};
  const request: RemoteRuntimeStreamEventsRequest = {};
  if (typeof value.cursor === "number" && Number.isFinite(value.cursor)) {
    request.cursor = value.cursor;
  }
  if (typeof value.limit === "number" && Number.isFinite(value.limit)) {
    request.limit = value.limit;
  }
  if (value.category !== undefined && value.category !== null) {
    // REFUSED, not dropped. Silently discarding the category turned a
    // subscription for one category into an UNCATEGORISED one — every category
    // the buffer carries, which is the opposite of what the caller asked for.
    // A renderer naming a category it may not have gets an error it can see.
    if (!isRemoteRuntimeEventCategory(value.category)) {
      throw new Error("Unknown runtime event category.");
    }
    request.category = value.category;
  }
  if (typeof value.replay === "boolean") {
    request.replay = value.replay;
  }
  return request;
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
  // Local roots this window opened earlier in the session stay authorized after
  // the tab rebinds to another machine: a chat pinned to "This computer" is a
  // per-lane fact, and the window losing its local binding does not make that
  // lane someone else's. Still window-scoped and still only roots the window
  // opened itself — never a renderer-supplied path.
  for (const rootPath of session?.knownLocalProjectRoots ?? []) {
    addRoot(rootPath);
  }

  return roots;
}

function resolveAuthorizedLocalRuntimeRootPath(
  session: WindowRuntimeSession | null | undefined,
  requestedRootPath: string | null | undefined,
  authorizeLocalRuntimeRoot?: RuntimeBridgeArgs["authorizeLocalRuntimeRoot"],
): string | null {
  // This computer's own settings (`shared/machineScope.ts`): no project, so
  // any window of this desktop may reach them.
  if (isMachineScopeRootPath(requestedRootPath)) return MACHINE_SCOPE_ROOT_PATH;
  const roots = collectAuthorizedLocalRuntimeRoots(session);
  const requested = normalizeLocalRuntimeRootPath(requestedRootPath);
  if (requested) {
    const alreadyAuthorized = roots.get(localRuntimeRootKey(requested));
    if (alreadyAuthorized) return alreadyAuthorized;
    // A window that still holds a project's folder from before a move reaches
    // it at its new folder, when this window may use that one.
    const moved = resolveMovedProjectRoot(requested);
    if (moved !== requested) {
      const movedAuthorized = roots.get(localRuntimeRootKey(moved));
      if (movedAuthorized) return movedAuthorized;
    }
    const additionallyAuthorized = authorizeLocalRuntimeRoot?.(session, requested);
    const normalizedAdditional = normalizeLocalRuntimeRootPath(additionallyAuthorized);
    return normalizedAdditional &&
      localRuntimeRootKey(normalizedAdditional) === localRuntimeRootKey(requested)
      ? normalizedAdditional
      : null;
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

// A window bound to the same local project shares that binding's key; any other
// authorized root gets a root-scoped key of its own.
function localRuntimeEventBindingKey(
  binding: WindowRuntimeSession["binding"] | null | undefined,
  rootPath: string,
): string {
  return binding?.kind === "local" &&
    localRuntimeRootKey(binding.rootPath) === localRuntimeRootKey(rootPath)
    ? binding.key
    : `local:${rootPath}`;
}

/**
 * The `open` half of the pair → connect → open chain failed: the runtime was
 * reached, but the project the caller named is not on it (or was never named).
 *
 * A CLASS rather than a message match, because the Activity click-through picks
 * the user's recovery instruction from this distinction — "open this project"
 * versus "make sure ADE is running there". Matching the sentence instead meant
 * a copy edit silently handed the user the wrong instruction, with nothing
 * failing to say so.
 */
export class RemoteProjectNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteProjectNotFoundError";
  }
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

export type RuntimeBridgeRegistration = {
  snapshot(): RemoteRuntimeConnectionSnapshot;
  reconcileAccountOwnership(
    currentOwnerUserId: string | null,
  ): AccountMachineReconciliationResult;
  getLocalMachineIdentity(): AdeAccountLocalMachineIdentity;
  resolveTargetIdForMachineKey(machineKey: string): string | null;
  /**
   * Whether a target is already connected. Opportunistic background readers
   * gate on this so a failed call never spends the target's automatic-reconnect
   * budget.
   */
  isTargetConnected(targetId: string): boolean;
  /** Display name for the paired machine, for user-facing failure copy. */
  resolveTargetNameForMachineKey(machineKey: string): string | null;
  /**
   * Removes the saved targets of one machine that no longer exists: by its
   * account machine key, or by its hostname (a cloud computer's instance id).
   * Returns the removed target ids.
   */
  removeTargetsForMachine(machine: { machineKey: string | null; hostname: string | null }): string[];
  /** One chunk of a proof file on a paired computer, for the media server. */
  readRemoteArtifactRange: RemoteArtifactRangeReader;
  /**
   * Machine-scoped RPC to an already-paired target, for main-process callers
   * that have no project binding — account-wide usage, which asks each machine
   * for its own rollup. Not the renderer path: `IPC.remoteRuntimeCallSync`
   * keeps its own method allowlist and this deliberately does not widen it.
   */
  callMachineMethod<T>(
    targetId: string,
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T>;
  openRemoteProjectForWindow(args: {
    targetId: string;
    projectId: string;
    /**
     * The owning machine's project root. Activity items carry it, and it is the
     * only project identity that survives the uuid-vs-registry-id split, so it
     * is the fallback when `projectId` matches nothing on the runtime.
     */
    rootPath?: string | null;
    windowId: number | null;
  }): Promise<OpenProjectBinding & { kind: "remote" }>;
  /**
   * Main-process access to a paired computer for work no window owns: an ADE
   * Cloud lane launch (`cloudLaneLaunchService.ts`) sets up its computer and
   * hands the launch to that computer's brain with the window closed.
   */
  remoteForMain: {
    /**
     * Connects (waking a sleeping cloud computer). Resolves once connected,
     * with the launch kinds its brain advertised (`chatLaunchKinds`; empty
     * from an older brain); throws otherwise.
     */
    connect(targetId: string): Promise<{ chatLaunchKinds: string[] }>;
    projects(targetId: string): Promise<RemoteRuntimeProjectRecord[]>;
    defaultParentDir(targetId: string): Promise<string>;
    /** Clones with the computer's own Git sign-in; no credential from here goes with it. */
    cloneProject(targetId: string, input: CloneProjectInput): Promise<RemoteRuntimeProjectRecord>;
    resolveBinding(targetId: string, projectId: string, rootPath: string): Promise<OpenProjectBinding & { kind: "remote" }>;
    /** One runtime action through a pin; the action's own result. */
    callAction(binding: OpenProjectBinding & { kind: "remote" }, request: RemoteRuntimeActionRequest): Promise<unknown>;
    /** Streams one file from this computer to the pin's project there; the path there. */
    uploadAttachment(binding: OpenProjectBinding & { kind: "remote" }, input: { sourcePath: string; filename: string }): Promise<{ path: string }>;
    /** The pin's runtime events of one category; `onEnded` when the stream stops by itself. */
    subscribeEvents(
      binding: OpenProjectBinding & { kind: "remote" },
      category: RemoteRuntimeEventCategory,
      onEvent: (event: RemoteRuntimeBufferedEvent) => void,
      onEnded: () => void,
    ): Promise<() => void>;
  };
};

/**
 * Re-exported from the Electron-free module so services outside the IPC layer
 * (the usage rollup publisher, the CLI-hosted brain) can resolve the same
 * machine key without importing this bridge.
 */
export { getOrCreateLocalAccountMachineIdentity };

export function registerRuntimeBridge({
  productAnalyticsService,
  appVersion,
  authorizeLocalRuntimeRoot,
  bindRemoteProject,
  getGitHubTokenForRemoteClone,
  getLocalMachineIdentity,
  getWindowSession,
  localRuntimeConnectionPool,
}: RuntimeBridgeArgs): RuntimeBridgeRegistration {
  // Registered from inside registerIpc, so these channels sit behind the same
  // deny-by-default sender check as the rest of the app's IPC surface.
  const handle = createTrustedIpcHandle(getMachineMainLogger());
  const remoteTargetRegistry = new RemoteTargetRegistry();
  const pairedMachineStore = new DesktopPairedMachineStore();
  const accountAuthService = getSharedAccountAuthService({
    projectRoots: () => [],
  });
  const getAccountRelayProof = async (): Promise<{
    userId: string;
    token: string;
  } | null> => {
    const status = accountAuthService.getStatus();
    const userId = status.signedIn ? status.userId?.trim() ?? "" : "";
    if (!userId) return null;
    const token = (await accountAuthService.getAccessToken()).trim();
    const refreshedStatus = accountAuthService.getStatus();
    if (
      !token
      || !refreshedStatus.signedIn
      || refreshedStatus.userId?.trim() !== userId
    ) return null;
    return { userId, token };
  };
  const getAuthorizedAccountOwnerId = async (): Promise<string | null> =>
    (await getAccountRelayProof())?.userId ?? null;
  const remoteConnectionPool = new RemoteConnectionPool(
    remoteTargetRegistry,
    appVersion,
    pairedMachineStore,
    {
      getAccountRelayProof,
    },
  );
  const remoteConnectionService = new RemoteConnectionService(
    remoteTargetRegistry,
    remoteConnectionPool,
    {
      appVersion,
      logger: getMachineMainLogger(),
      onDialOutcome: (outcome) => {
        productAnalyticsService?.capture({
          event: "ade_feature_used",
          surface: "desktop",
          properties: {
            feature: "connections",
            action: "remote_connect",
            outcome: outcome === "failed" ? "failed" : "completed",
          },
          projectId: null,
          dedupeKey: `remote_connect:${outcome}`,
          minimumIntervalMs: 60 * 60 * 1_000,
        });
      },
      getAccountRelayProof,
      getAuthorizedAccountOwnerId,
      // A dev desktop shares this computer's machine pairing with the installed
      // ADE; reconnecting saved machines on its own would take them away from it.
      // ADE_DEV_REMOTE_AUTOCONNECT=1 opts a dev app in on purpose.
      explicitConnectOnly: !app.isPackaged && process.env.ADE_DEV_REMOTE_AUTOCONNECT !== "1",
      // A sleeping cloud box wakes when the person uses it (registerCloudIpc).
      wakeForUse: cloudWakeForUse,
      // A sleeping one is shown as not connected, not as a failed connection.
      asleepForUse: cloudAsleepForUse,
      // A rest that starts or ends tells the windows (registerCloudIpc).
      onCloudRestChanged: cloudRestChanged,
    },
    pairedMachineStore,
  );
  /** The folder a pinned remote call sends with its project id, or null. */
  const pinFolder = (value: unknown): string | null =>
    typeof value === "string" ? value.trim() || null : null;
  /** A saved remote target by id. One that is gone (removed, or never saved here) is the caller's to fix. */
  /**
   * A saved remote target by id. A pin to a connection that is gone (removed,
   * or a saved chat's stand-in) uses its machine's connection now
   * (machines/goneTargets.ts); one that reaches nothing is the caller's to fix.
   */
  const savedOrGoneTarget = (id: string | null | undefined): RemoteRuntimeTarget | null => {
    if (!id) return null;
    const saved = remoteConnectionService.getTarget(id);
    if (saved) return saved;
    const goneKey = goneTargetMachineKey(id);
    return goneKey ? targetForMachineKey(goneKey) : null;
  };
  const requireRemoteTarget = (id: string | null | undefined) => {
    const target = savedOrGoneTarget(id);
    if (!target) throw new AdeExpectedError(REMOTE_TARGET_NOT_FOUND_MESSAGE, "user");
    return target;
  };
  /**
   * The target a runtime action goes to. A person's write through a pin whose
   * machine has no connection saved here first reaches it through the account
   * (contract C2), which wakes a sleeping cloud computer, as a write through a
   * saved connection does. A read or a background write (window focus, a view)
   * never wakes one, the same rule as `remoteConnectionService.callAction`; the
   * window reads the chat's saved copy instead.
   */
  const targetForAction = async (id: string, domain: string, action: string): Promise<RemoteRuntimeTarget> => {
    if (!savedOrGoneTarget(id) && adeActionAccess(domain, action) === "write" && !isBackgroundAdeWrite(domain, action)) {
      const reached = await reachGoneTarget(id, { domain, action });
      // The machine's own reason (off the account, out of hours, unreachable), not "not found".
      if (reached && !reached.ok) throw new AdeExpectedError(reached.message, "user");
    }
    return requireRemoteTarget(id);
  };
  // The media server's `/remote/...` route reads a proof video from a paired
  // computer through this, one bounded chunk per call. The broker on that
  // machine resolves the path inside its own `.ade/artifacts` and refuses the rest.
  const readRemoteArtifactRange: RemoteArtifactRangeReader = async ({ targetId, projectId, relativePath, offset, length }) => {
    const response = await remoteConnectionService.callAction(targetId, projectId, {
      domain: "computer_use_artifacts",
      action: "readArtifactRange",
      args: { uri: relativePath, offset, length },
    });
    return response.result;
  };
  const {
    addRuntimeEventSubscription,
    attachRuntimeEventSubscriptionCleanup,
    cleanupRuntimeEventSubscriptions,
    getRuntimeEventSubscription,
    refreshRuntimeEventSubscription,
    removeRuntimeEventSubscription,
  } = createRuntimeEventSubscriptionRegistry();
  const remoteOpenProjectGenerations = new Map<string, number>();
  let remoteOpenProjectGeneration = 0;
  let lastDiscoveredMachines: RemoteRuntimeDiscoveryResult["machines"] = [];
  // A sighting after a failure clears a demoted LAN address without a dial (see
  // pairedEndpointIsFailing). So discovery also runs at launch and on wake or
  // unlock, not only when the target list opens. Overlapping runs share one
  // browse, and no connect waits on one.
  let lanDiscoveryInFlight: Promise<RemoteRuntimeDiscoveryResult> | null = null;
  const refreshLanDiscovery = (): Promise<RemoteRuntimeDiscoveryResult> => {
    lanDiscoveryInFlight ??= (async () => {
      const observedAt = Date.now();
      const result = await discoverLanRuntimes();
      lastDiscoveredMachines = result.machines;
      remoteConnectionService.rememberDiscoveredMachines(result.machines, observedAt);
      return result;
    })().finally(() => {
      lanDiscoveryInFlight = null;
    });
    return lanDiscoveryInFlight;
  };
  const logLanDiscoveryFailure = (error: unknown): void => {
    console.warn("remote_runtime.lan_discovery_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  };

  remoteConnectionPool.onPortForwardsInvalidated((targetId) => {
    // Two caches outlive the tunnel unless they are told. The browser's
    // remote-origin registry maps a local origin to (machine, remote port) and
    // gates per-chat agent approvals on it, so a recycled port would inherit
    // an approval a human granted for a different tunnel. The preload memoizes
    // forwards per (target, port) to keep navigations off the IPC path, and a
    // stale entry there is the `ERR_CONNECTION_REFUSED` a reconnected machine
    // reported for a port that had already moved.
    forgetRemoteTunnelOrigins(targetId);
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.webContents.isDestroyed()) continue;
      window.webContents.send(IPC.remoteRuntimePortForwardsInvalidated, { targetId });
    }
  });

  remoteConnectionService.onSnapshotChanged((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.webContents.isDestroyed()) continue;
      window.webContents.send(
        IPC.remoteRuntimeConnectionSnapshotChanged,
        snapshot,
      );
    }
  });
  if (process.env.ADE_DISABLE_REMOTE_AUTOCONNECT !== "1") {
    const autoconnectTimer = setTimeout(() => {
      // Refresh or reject the persisted account lease before any saved target is
      // allowed to open the pool. A failed refresh authoritatively means signed
      // out for account-owned machine trust; local PIN/link/SSH trust remains.
      void remoteConnectionService.reconcileAuthorizedAccountOwnership()
        .then(() => remoteConnectionService.startAutoconnect())
        .catch((error) => {
          // Fail closed: do not start saved-target autoconnect when account trust
          // could not be reconciled. Explicit connection paths remain guarded.
          console.warn("remote_runtime.account_reconciliation_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        // Discovery starts only after the first connects are under way, so it
        // never runs ahead of one. It runs even when account trust did not
        // reconcile: it only records what this network advertises.
        .finally(() => {
          void refreshLanDiscovery().catch(logLanDiscoveryFailure);
        });
    }, 0);
    autoconnectTimer.unref?.();
  }
  const probeRemoteConnectionsAfterWake = (): void => {
    remoteConnectionService.probeSavedConnections();
    void refreshLanDiscovery().catch(logLanDiscoveryFailure);
  };
  // A quit that goes through must not redial a dropped machine on the way out.
  app.once?.("will-quit", () => remoteConnectionService.stopHostReturnWatches());
  powerMonitor?.on?.("resume", probeRemoteConnectionsAfterWake);
  powerMonitor?.on?.("unlock-screen", probeRemoteConnectionsAfterWake);

  const targetForMachineKey = (machineKey: string): RemoteRuntimeTarget | null => {
    const normalized = machineKey.trim();
    if (!normalized) return null;
    return remoteConnectionService.listTargets().find(
      (target) => sameMachineKey(target.pairedMachine?.machineKey, normalized),
    ) ?? null;
  };

  const registration: RuntimeBridgeRegistration = {
    snapshot: () => remoteConnectionService.snapshot(),
    reconcileAccountOwnership: (currentOwnerUserId) =>
      remoteConnectionService.reconcileAccountOwnership(currentOwnerUserId),
    getLocalMachineIdentity: () =>
      getLocalMachineIdentity?.() ?? getOrCreateLocalAccountMachineIdentity(),
    resolveTargetIdForMachineKey: (machineKey) =>
      targetForMachineKey(machineKey)?.id ?? null,
    isTargetConnected: (targetId) => remoteConnectionService.isConnected(targetId),
    resolveTargetNameForMachineKey: (machineKey) => {
      const target = targetForMachineKey(machineKey);
      return target?.name?.trim() || target?.hostname?.trim() || null;
    },
    removeTargetsForMachine: ({ machineKey, hostname }) => {
      const key = machineKey?.trim() || null;
      const host = hostname?.trim().toLowerCase() || null;
      const ids = remoteConnectionService.listTargets()
        .filter((target) => (key && sameMachineKey(target.pairedMachine?.machineKey, key))
          || (host && target.hostname?.trim().toLowerCase() === host))
        .map((target) => target.id);
      for (const id of ids) {
        // A machine that moved or went away: pins to it still reach its
        // machine by key (machines/goneTargets.ts). A connection the person
        // removes by hand is never remembered, so nothing pairs it again.
        noteGoneTarget(id, remoteConnectionService.getTarget(id)?.pairedMachine?.machineKey);
        remoteConnectionService.removeTarget(id);
      }
      return ids;
    },
    readRemoteArtifactRange,
    callMachineMethod: <T,>(
      targetId: string,
      method: string,
      params?: Record<string, unknown>,
      options?: { timeoutMs?: number },
    ) => remoteConnectionService.callMachineMethod<T>(targetId, method, params ?? {}, options ?? {}),
    openRemoteProjectForWindow: async ({ targetId, projectId, rootPath, windowId }) => {
      const binding = await resolveRemoteProjectBinding(targetId, projectId, rootPath);
      bindRemoteProject?.(windowId, binding);
      return binding;
    },
    remoteForMain: {
      connect: async (targetId) => {
        // Resolves only once connected; a failure throws.
        const connected = await remoteConnectionService.connect(requireRemoteTarget(targetId).id, { explicit: true });
        return { chatLaunchKinds: connected.capabilities?.chatLaunchKinds ?? [] };
      },
      projects: (targetId) => remoteConnectionService.projects(requireRemoteTarget(targetId).id),
      defaultParentDir: (targetId) => remoteConnectionService.getDefaultParentDir(requireRemoteTarget(targetId).id),
      cloneProject: (targetId, input) => remoteConnectionService.cloneProject(requireRemoteTarget(targetId).id, stripCloneAuthHeader(input)),
      resolveBinding: (targetId, projectId, rootPath) => resolveRemoteProjectBinding(targetId, projectId, rootPath),
      callAction: async (binding, request) => (await remoteConnectionService.callAction(
        requireRemoteTarget(binding.targetId).id,
        binding.projectId,
        request,
        { projectRootPath: binding.rootPath },
      )).result,
      uploadAttachment: (binding, input) => remoteConnectionService.uploadChatAttachment({
        targetId: requireRemoteTarget(binding.targetId).id,
        projectId: binding.projectId,
        sourcePath: input.sourcePath,
        filename: input.filename,
      }),
      subscribeEvents: (binding, category, onEvent, onEnded) => remoteConnectionService.subscribeEvents(
        requireRemoteTarget(binding.targetId).id,
        binding.projectId,
        { category },
        (event) => onEvent(event),
        onEnded,
        undefined,
        { projectRootPath: binding.rootPath },
      ),
    },
  };

  async function resolveRemoteProjectBinding(
    rawTargetId: string,
    rawProjectId: string,
    rawRootPath?: string | null,
  ): Promise<OpenProjectBinding & { kind: "remote" }> {
    const targetId = rawTargetId.trim();
    const projectId = rawProjectId.trim();
    const rootPath = rawRootPath?.trim() ?? "";
    const target = requireRemoteTarget(targetId);
    if (!projectId && !rootPath) {
      throw new RemoteProjectNotFoundError("Remote project is required.");
    }

    const connection = await remoteConnectionService.connect(target.id, {
      explicit: true,
    });
    // Two id spaces reach this lookup. A project opened from the runtime's own
    // catalog carries the machine-registry id; an Activity item carries the
    // owning machine's `ade.db` uuid, which `projects.list` has never heard of.
    // Resolve by id first, then fall back to the project root both sides agree
    // on, or every cross-machine click-through dies here.
    const resolveProject = (
      candidates: readonly RemoteRuntimeProjectRecord[],
    ): RemoteRuntimeProjectRecord | null =>
      (projectId
        ? candidates.find((candidate) => candidate.projectId === projectId)
        : undefined)
      ?? matchRemoteProjectByRootPath(candidates, rootPath)
      ?? null;

    let project = resolveProject(connection.projects);
    if (!project) {
      project = resolveProject(await remoteConnectionService.projects(target.id));
    }
    if (!project) {
      throw new RemoteProjectNotFoundError("Remote project was not found on this runtime.");
    }

    return {
      kind: "remote",
      key: remoteProjectBindingKey(target.id, project.projectId),
      targetId: target.id,
      runtimeName: target.name,
      transport: target.transport ?? "ssh",
      hostname: target.hostname,
      projectId: project.projectId,
      rootPath: project.rootPath,
      displayName: project.displayName || path.basename(project.rootPath),
      gitOriginUrl: project.gitOriginUrl,
      iconDataUrl: project.icon?.dataUrl ?? null,
    };
  }

  // One shape for the (binding, category, replay) subscription key, so the
  // release handler can rebuild exactly the key the subscribe path registered.
  const runtimeEventRequestKeyPrefix = (
    bindingKey: string,
    category: RemoteRuntimeEventCategory | undefined,
  ): string => `${bindingKey}:${category ?? "*"}:`;

  const runtimeEventRequestKey = (
    bindingKey: string,
    request: RemoteRuntimeStreamEventsRequest,
  ): string =>
    `${runtimeEventRequestKeyPrefix(bindingKey, request.category)}${
      request.replay === false ? "live" : "replay"
    }`;

  /**
   * Strip the categories a renderer may not see from a POLLED batch.
   *
   * `streamEventsForRoot` returns whatever the buffer drained, and the preload
   * casts the result rather than normalizing it — so the pushed path's guard
   * does not cover this one. Cheap, and it means the exclusion holds on every
   * route out of main rather than on the one that happens to be watched.
   */
  const withRendererVisibleEvents = (
    batch: RemoteRuntimeStreamEventsResult,
  ): RemoteRuntimeStreamEventsResult => ({
    ...batch,
    events: batch.events.filter((event) => isRemoteRuntimeEventCategory(event.category)),
  });

  /**
   * The lane of an App Control screencast frame, or `undefined` when the event
   * is anything else. Frames are gated per window like `pty_data`.
   */
  const appControlFrameLaneIdOf = (
    event: RemoteRuntimeBufferedEvent,
  ): string | null | undefined => {
    if (event.payload.type !== "app_control_event") return undefined;
    const inner = isObjectRecord(event.payload.event) ? event.payload.event : null;
    if (inner?.type !== "frame") return undefined;
    const frame = isObjectRecord(inner.frame) ? inner.frame : null;
    return appControlFrameEventLaneId({
      laneId: typeof inner.laneId === "string" ? inner.laneId : null,
      frame: { laneId: typeof frame?.laneId === "string" ? frame.laneId : null },
    });
  };

  const shouldForwardRuntimeEvent = (
    sender: WebContents,
    event: RemoteRuntimeBufferedEvent,
  ): boolean => {
    // Only categories the renderer knows; an older runtime may still emit
    // one this build dropped.
    if (!isRemoteRuntimeEventCategory(event.category)) return false;
    const appControlFrameLaneId = appControlFrameLaneIdOf(event);
    if (appControlFrameLaneId !== undefined) {
      return shouldSendAppControlFrameToWebContents(sender, appControlFrameLaneId);
    }
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
    subscription: RuntimeEventWindowSubscription,
    event: RemoteRuntimeBufferedEvent,
    eventEpoch?: string | null,
  ): void => {
    const { sender, bindingKey, requestKey } = subscription;
    if (
      getRuntimeEventSubscription(sender.id, requestKey) !== subscription ||
      sender.isDestroyed()
    )
      return;
    if (eventEpoch) subscription.eventEpoch = eventEpoch;
    if (!shouldForwardRuntimeEvent(sender, event)) return;
    const payload: RemoteRuntimeEventNotificationPayload = {
      bindingKey,
      event,
      ...(eventEpoch ? { eventEpoch } : {}),
    };
    try {
      sender.send(IPC.runtimeEvent, payload);
    } catch {
      // Renderer may have gone away between the destroyed check and send.
    }
  };

  const ensureRuntimeEventSubscription = async (
    sender: WebContents,
    bindingKey: string,
    requestKey: string,
    subscribe: RuntimeEventSubscribe,
    fileWatchRuntimeKey: string,
  ): Promise<Partial<RuntimeEventSubscriptionInit> | null> => {
    // `requestKey` is prefixed with `bindingKey`, so an identical request key is
    // an identical binding: a pump already owns a live subscription and only
    // needs its idle-expiry clock refreshed. Several pumps of one window can
    // share it (the bound pump and a chat pinned to the same copy), and only
    // the one that subscribed saw the subscribe answer. Each poll gets the
    // current epoch, so a pump that did not subscribe still sees a restarted
    // runtime and rewinds; without it, it drops every event of the new runtime.
    const existing = refreshRuntimeEventSubscription(sender.id, requestKey);
    if (existing) return existing.eventEpoch ? { eventEpoch: existing.eventEpoch } : null;
    const subscription = addRuntimeEventSubscription({
      sender,
      bindingKey,
      requestKey,
      cleanup: null,
    });
    const onEnded = () => {
      removeRuntimeEventSubscription(sender.id, requestKey, subscription);
      notePageRuntimeDisconnected(sender.id, fileWatchRuntimeKey);
    };
    let subscriptionInit: Partial<RuntimeEventSubscriptionInit> | null = null;
    try {
      const cleanup = await subscribe(
        (event, eventEpoch) => sendRuntimeEvent(subscription, event, eventEpoch),
        onEnded,
        (result) => {
          subscriptionInit = result;
          if (result.eventEpoch) subscription.eventEpoch = result.eventEpoch;
        },
      );
      if (
        !attachRuntimeEventSubscriptionCleanup(
          sender.id,
          requestKey,
          subscription,
          cleanup,
        )
      ) {
        cleanup();
        return subscriptionInit;
      }
      restorePageFileWatches(sender.id, fileWatchRuntimeKey);
      return subscriptionInit;
    } catch (error) {
      if (!subscription.cleanup) {
        removeRuntimeEventSubscription(sender.id, requestKey, subscription);
      }
      console.warn("Runtime event subscription failed", error);
      throw error;
    }
  };

  const personalChatBindingForSender = (sender: WebContents): OpenProjectBinding | null => {
    const windowId = BrowserWindow.fromWebContents(sender)?.id ?? null;
    return getWindowSession?.(windowId)?.binding ?? null;
  };

  /**
   * The remote target a personal-chat call goes to, or null for this
   * computer. A call that names its machine goes there; one that does not
   * goes to the machine the window is bound to.
   */
  const personalChatRemoteTargetId = (
    sender: WebContents,
    target: PersonalChatMachineTarget | null | undefined,
  ): string | null => {
    const named = typeof target?.machineId === "string" ? target.machineId.trim() : "";
    if (named) return named === THIS_MACHINE_ID ? null : named;
    const binding = personalChatBindingForSender(sender);
    return binding?.kind === "remote" ? binding.targetId : null;
  };

  handle(
    IPC.personalChatsCall,
    async (
      event,
      request: PersonalChatCallArgs,
      target?: PersonalChatMachineTarget | null,
    ): Promise<PersonalChatCallResponse> => {
      if (!request || typeof request !== "object" || typeof request.action !== "string") {
        throw new Error("A personal chat action is required.");
      }
      const remoteTargetId = personalChatRemoteTargetId(event.sender, target);
      if (remoteTargetId) {
        return await remoteConnectionService.callMachineMethod<PersonalChatCallResponse>(
          remoteTargetId,
          "personalChats.call",
          request as unknown as Record<string, unknown>,
        );
      }
      if (!localRuntimeConnectionPool) {
        throw new Error("The local ADE brain is unavailable for personal chats.");
      }
      return await localRuntimeConnectionPool.callSync<PersonalChatCallResponse>(
        "personalChats.call",
        request as unknown as Record<string, unknown>,
      );
    },
  );

  handle(
    IPC.personalChatsStreamEvents,
    async (
      event,
      request: PersonalChatStreamEventsArgs = {},
      target?: PersonalChatMachineTarget | null,
    ): Promise<PersonalChatStreamEventsResult> => {
      const normalized: PersonalChatStreamEventsArgs = {
        ...(typeof request?.cursor === "number" && Number.isFinite(request.cursor)
          ? { cursor: Math.max(0, Math.floor(request.cursor)) }
          : {}),
        ...(typeof request?.limit === "number" && Number.isFinite(request.limit)
          ? { limit: Math.max(1, Math.min(500, Math.floor(request.limit))) }
          : {}),
      };
      const remoteTargetId = personalChatRemoteTargetId(event.sender, target);
      if (remoteTargetId) {
        return await boundedPersonalChatEventPoll(
          remoteConnectionService.callMachineMethod<PersonalChatStreamEventsResult>(
            remoteTargetId,
            "personalChats.streamEvents",
            normalized as Record<string, unknown>,
          ),
          normalized.cursor,
        );
      }
      if (!localRuntimeConnectionPool) {
        throw new Error("The local ADE brain is unavailable for personal chats.");
      }
      return await boundedPersonalChatEventPoll(
        localRuntimeConnectionPool.callSync<PersonalChatStreamEventsResult>(
          "personalChats.streamEvents",
          normalized as Record<string, unknown>,
        ),
        normalized.cursor,
      );
    },
  );

  handle(
    IPC.remoteRuntimeListTargets,
    async (): Promise<RemoteRuntimeTarget[]> => {
      return remoteConnectionService.listTargets();
    },
  );

  // Which account computer and project a link to something in this project
  // should name, so it opens there from anywhere. A remote binding names its
  // host (the paired machine's account key) and that host's canonical project
  // id; a local one, this computer and the canonical id of its root. Answered
  // here from what this desktop already knows, without a call to the host.
  handle(
    IPC.remoteRuntimeLinkOwnership,
    async (_event, args: { binding?: OpenProjectBinding | null } | null): Promise<DeeplinkOwnership | null> => {
      const binding = args?.binding ?? null;
      if (!binding) return null;
      if (binding.kind === "remote") {
        const target = remoteConnectionService.listTargets().find((entry) => entry.id === binding.targetId);
        const accountMachineKey = target?.pairedMachine?.machineKey?.trim() ?? "";
        const projectId = binding.projectId?.trim() ?? "";
        if (!accountMachineKey || !projectId) return null;
        // The account project of that copy, from this computer's list (L33).
        const accountProjectId = accountProjectIdForCopy(accountMachineKey, projectId);
        return { accountMachineKey, projectId, ...(accountProjectId ? { accountProjectId } : {}) };
      }
      return localLinkOwnership(binding.rootPath ?? "", {
        logger: getMachineMainLogger(),
        ...(getLocalMachineIdentity ? { identity: getLocalMachineIdentity } : {}),
      });
    },
  );

  handle(
    IPC.remoteRuntimeGetConnectionSnapshot,
    async (): Promise<RemoteRuntimeConnectionSnapshot> => {
      return remoteConnectionService.snapshot();
    },
  );

  handle(
    IPC.remoteRuntimeListDiscoveredMachines,
    async (): Promise<RemoteRuntimeDiscoveryResult> => {
      return await refreshLanDiscovery();
    },
  );

  handle(
    IPC.remoteRuntimeParsePairingInput,
    async (_event, arg: { text?: string }): Promise<RemoteRuntimeParsedPairingInput> => {
      return parseRemoteRuntimePairingInput(
        typeof arg?.text === "string" ? arg.text : "",
      );
    },
  );

  handle(
    IPC.remoteRuntimePairWithMachine,
    async (
      _event,
      arg: RemoteRuntimePairWithMachineArgs,
    ): Promise<RemoteRuntimePairWithMachineResult> => {
      return await remoteConnectionService.pairWithMachine({
        input: typeof arg?.input === "string" ? arg.input : "",
        pin: typeof arg?.pin === "string" ? arg.pin : "",
        deviceName: typeof arg?.deviceName === "string" ? arg.deviceName : "",
      });
    },
  );

  handle(
    IPC.remoteRuntimeGetLocalPairingInfo,
    async (): Promise<RemoteRuntimeLocalPairingInfo> => {
      if (!localRuntimeConnectionPool) {
        throw new Error("Local ADE runtime connection is not available.");
      }
      const info = await localRuntimeConnectionPool.callSync<SyncWebPairingInfo>(
        "sync.getDesktopPairingInfo",
      );
      const url = typeof info?.pairingUrl === "string" ? info.pairingUrl.trim() : "";
      const machineName = typeof info?.machineName === "string"
        ? info.machineName.trim()
        : "";
      if (!url || !machineName) {
        throw new Error("Local ADE runtime did not return pairing information.");
      }
      return {
        url,
        pin: typeof info.code === "string" && info.code.trim()
          ? info.code.trim()
          : null,
        machineName,
        relayAvailable: info.relayEnabled === true || info.hasRelayCandidate === true,
      };
    },
  );

  handle(
    IPC.remoteRuntimeRunDoctor,
    async (_event, arg: { id?: string }): Promise<RemoteRuntimeDoctorResult> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const discovered = lastDiscoveredMachines.find((machine) =>
        machine.id === id || machine.hostIdentity === id) ?? null;
      return await remoteConnectionService.runDoctor(
        id,
        discovered,
      );
    },
  );

  // "Can my other devices reach that computer?", asked of the connected
  // machine's own brain: the same check as the This computer card, run there.
  handle(
    IPC.remoteRuntimeCheckReachability,
    async (_event, arg: { id?: string }): Promise<HostReachabilityReport> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const target = id ? remoteConnectionService.getTarget(id) : null;
      if (!target) throw new Error("This machine isn't saved on this computer anymore.");
      const connected = remoteConnectionService.snapshot().connections
        .some((connection) => connection.target.id === target.id && connection.state === "connected");
      if (!connected) {
        throw new Error("Connect to this machine first, or use Test to see why it can't be reached.");
      }
      try {
        const report = await remoteConnectionService.callMachineMethod<HostReachabilityReport>(
          target.id,
          "sync.checkReachability",
          {},
          // The relay self-probe on that machine can take ~12 s; a replay would run it twice.
          { timeoutMs: 30_000, retryOnConnectionError: false },
        );
        return describeReportForMachine(report, target.name?.trim() || target.hostname);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/method not found|-32601/i.test(message)) {
          throw new Error("That machine runs an older ADE that can't check itself. Update it, then check again.");
        }
        throw error;
      }
    },
  );

  handle(
    IPC.remoteRuntimeSaveTarget,
    async (
      _event,
      arg: RemoteRuntimeTargetInput,
    ): Promise<RemoteRuntimeTarget> => {
      const discovered = remoteConnectionService.findDiscoveredTargetInputMatch(
        lastDiscoveredMachines,
        arg,
      );
      return remoteConnectionService.saveTarget(arg, discovered);
    },
  );

  handle(
    IPC.remoteRuntimeSetAutoConnect,
    async (
      _event,
      arg: { id?: string; enabled?: boolean },
    ): Promise<RemoteRuntimeTarget> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      if (!id) throw new Error("Remote target id is required.");
      return remoteConnectionService.setAutoConnect(id, arg?.enabled === true);
    },
  );

  handle(
    IPC.remoteRuntimeRemoveTarget,
    async (_event, arg: { id: string }): Promise<{ removed: boolean }> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      if (!id) return { removed: false };
      return { removed: remoteConnectionService.removeTarget(id) };
    },
  );

  handle(
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

  handle(
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

  handle(
    IPC.remoteRuntimeConnect,
    async (
      _event,
      arg: { id: string },
    ): Promise<RemoteRuntimeConnectResult> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      return await remoteConnectionService.connect(id, { explicit: true });
    },
  );

  handle(
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

  handle(
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

  handle(
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

  handle(
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

  // Pick an image on THIS machine and store it as the icon of a project that
  // lives on the remote host, so every device listing that host sees it.
  handle(
    IPC.remoteRuntimeChooseProjectIcon,
    async (
      event,
      arg: { id: string; rootPath: string },
    ): Promise<ProjectIcon | null> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const rootPath =
        typeof arg?.rootPath === "string" ? arg.rootPath.trim() : "";
      if (!rootPath) throw new Error("Remote project path is required.");
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options: Electron.OpenDialogOptions = {
        title: "Choose project icon",
        properties: ["openFile"],
        filters: [{ name: "Images", extensions: [...PROJECT_ICON_DIALOG_EXTENSIONS] }],
      };
      const result = await showRememberedOpenDialog(win, options);
      const selectedPath = result.canceled ? undefined : result.filePaths[0];
      if (!selectedPath) return null;

      return await remoteConnectionService.setProjectIcon(
        id,
        rootPath,
        await readProjectIconForUpload(selectedPath),
      );
    },
  );

  handle(
    IPC.remoteRuntimeRemoveProjectIcon,
    async (
      _event,
      arg: { id: string; rootPath: string },
    ): Promise<ProjectIcon | null> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const rootPath =
        typeof arg?.rootPath === "string" ? arg.rootPath.trim() : "";
      if (!rootPath) throw new Error("Remote project path is required.");
      return await remoteConnectionService.removeProjectIcon(id, rootPath);
    },
  );

  handle(
    IPC.remoteRuntimeInspectProjectRemoval,
    async (
      _event,
      arg: { id: string; projectId: string },
    ): Promise<RemoteProjectRemovalInspection> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const projectId = typeof arg?.projectId === "string" ? arg.projectId.trim() : "";
      if (!projectId) throw new Error("Remote project id is required.");
      return await remoteConnectionService.inspectProjectRemoval(id, projectId);
    },
  );

  handle(
    IPC.remoteRuntimeRemoveProjectCopy,
    async (
      _event,
      arg: { id: string; projectId: string; request?: Partial<ProjectRemovalRequest> },
    ): Promise<ProjectRemovalOutcome> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const projectId = typeof arg?.projectId === "string" ? arg.projectId.trim() : "";
      if (!projectId) throw new Error("Remote project id is required.");
      const request = arg?.request ?? {};
      return await remoteConnectionService.removeProjectCopy(id, projectId, {
        deleteFolder: request.deleteFolder === true,
        stateToken: typeof request.stateToken === "string" ? request.stateToken : null,
        acceptWork: request.acceptWork === true,
      });
    },
  );

  handle(
    IPC.remoteRuntimeGetDefaultParentDir,
    async (_event, arg: { id: string }): Promise<string> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      return await remoteConnectionService.getDefaultParentDir(id);
    },
  );

  handle(
    IPC.remoteRuntimeGetHandoffStoragePreflight,
    async (
      _event,
      arg: { id: string; input: RemoteRuntimeHandoffStoragePreflightArgs },
    ): Promise<RemoteRuntimeHandoffStoragePreflightResult> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      return await remoteConnectionService.getHandoffStoragePreflight(id, arg?.input);
    },
  );

  handle(
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

  handle(
    IPC.remoteRuntimeCloneProject,
    async (
      _event,
      arg: {
        id: string;
        input?: CloneProjectInput;
        options?: RemoteRuntimeCloneProjectOptions;
      },
    ): Promise<RemoteRuntimeProjectRecord> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const input = arg?.input ?? { url: "", parentDir: "" };
      const safeInput = stripCloneAuthHeader(input);
      let githubAuthHeader: string | null = null;
      const target = remoteConnectionService.getTarget(id);
      const destinationCredentialsOnly = arg?.options?.credentialMode === "destination_only";
      if (!destinationCredentialsOnly && target && hasKnownSshHostKeyForTarget(target)) {
        try {
          githubAuthHeader = createGitHubAuthHeader(
            await getGitHubTokenForRemoteClone?.() ?? null,
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

  handle(
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

  handle(
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
        const binding = await resolveRemoteProjectBinding(id, projectId);
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

  handle(
    IPC.remoteRuntimeListActionRegistry,
    async (
      _event,
      arg: { id: string; projectId: string },
    ): Promise<AdeActionRegistryEntry[]> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const projectId =
        typeof arg?.projectId === "string" ? arg.projectId.trim() : "";
      const target = requireRemoteTarget(id);
      if (!projectId) throw new Error("Remote project is required.");
      return await remoteConnectionService.listActionRegistry(
        target.id,
        projectId,
      );
    },
  );

  handle(
    IPC.remoteRuntimeCallAction,
    async (
      event,
      arg: {
        id: string;
        projectId: string;
        /** The pin's folder: finds the project when the machine doesn't list the pin's id. */
        projectRootPath?: string | null;
        request: RemoteRuntimeActionRequest;
      },
    ): Promise<RemoteRuntimeActionResult> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const projectId =
        typeof arg?.projectId === "string" ? arg.projectId.trim() : "";
      const projectRootPath = pinFolder(arg?.projectRootPath);
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
      if (!projectId) throw new Error("Remote project is required.");
      if (!domain || !action)
        throw new Error("Remote action domain and action are required.");
      const target = await targetForAction(id, domain, action);
      const actionRequest = withRuntimeActionClientMetadata(
        { ...request!, domain, action },
        event.sender.id,
      );
      const result = await remoteConnectionService.callAction(
        target.id,
        projectId,
        actionRequest,
        { projectRootPath },
      );
      trackPageFileWatch(event.sender, remoteFileWatchRuntimeKey(target.id, projectId), actionRequest, (fileRequest) =>
        remoteConnectionService.callAction(target.id, projectId, fileRequest, { projectRootPath }));
      return result;
    },
  );

  handle(
    IPC.remoteRuntimeAttachmentUploadCapability,
    async (
      _event,
      arg: { id: string },
    ): Promise<ChatAttachmentStagingMode> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      // No target named: nothing can be probed, so answer with the mode every
      // host supports rather than inventing a second "unknown" vocabulary.
      if (!id) return { mode: "base64", maxBytes: LEGACY_MAX_CHAT_ATTACHMENT_BYTES };
      return await remoteConnectionService.getAttachmentUploadCapability(id);
    },
  );

  handle(
    IPC.remoteRuntimeUploadChatAttachment,
    async (
      _event,
      arg: { id: string; projectId: string; filename: string } & (
        /** A file on this machine. */
        | { sourcePath: string }
        /** Or base64 bytes with no file behind them, such as a pasted image, and the machine's upload limit. */
        | { data: string; maxBytes?: number }
      ),
    ): Promise<{ path: string }> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const projectId = typeof arg?.projectId === "string" ? arg.projectId.trim() : "";
      const filename = typeof arg?.filename === "string" ? arg.filename.trim() : "";
      if (!id) throw new Error("Remote target id is required.");
      if (!projectId) throw new Error("Remote project is required.");
      if (arg && "data" in arg && typeof arg.data === "string" && arg.data) {
        return await remoteConnectionService.uploadChatAttachmentBytes({
          targetId: id,
          projectId,
          data: arg.data,
          filename,
          maxBytes: typeof arg.maxBytes === "number" ? arg.maxBytes : MAX_CHAT_ATTACHMENT_BYTES,
        });
      }
      const sourcePath = arg && "sourcePath" in arg && typeof arg.sourcePath === "string"
        ? arg.sourcePath.trim()
        : "";
      if (!sourcePath) throw new Error("Attachment source path is required.");
      return await remoteConnectionService.uploadChatAttachment({
        targetId: id,
        projectId,
        sourcePath,
        filename,
      });
    },
  );

  handle(
    IPC.remoteRuntimeEnsurePortForward,
    async (
      _event,
      arg: {
        id: string;
        request: RemoteRuntimePortForwardRequest;
      },
    ): Promise<RemoteRuntimePortForward> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const request =
        arg?.request &&
        typeof arg.request === "object" &&
        !Array.isArray(arg.request)
          ? arg.request
          : null;
      const remotePort = Number(request?.remotePort);
      const remoteHost =
        typeof request?.remoteHost === "string"
          ? request.remoteHost.trim()
          : null;
      const label =
        typeof request?.label === "string" ? request.label.trim() : null;
      if (!id) throw new Error("Remote target id is required.");
      if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
        throw new Error("Remote port must be an integer from 1 to 65535.");
      }
      const forward = await remoteConnectionService.ensurePortForward(id, {
        remoteHost,
        remotePort,
        label,
      });
      // The browser's per-chat origin approvals key on origin, and a forward's
      // local port is reused across machines and sessions. Record what this one
      // currently stands for so one tunnel's approval cannot be inherited by
      // another (see `remoteTunnelOrigins`).
      recordRemoteTunnelOrigin({
        localHost: forward.localHost,
        localPort: forward.localPort,
        machineKey: id,
        remotePort: forward.remotePort,
      });
      return forward;
    },
  );

  handle(
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
      const target = requireRemoteTarget(id);
      if (!projectId) throw new Error("Remote project is required.");
      if (!isRemoteRuntimeSyncMethod(method))
        throw new Error("Remote sync method is not exposed.");
      return await remoteConnectionService.callSync(
        target.id,
        projectId,
        method,
        params,
      );
    },
  );

  handle(
    IPC.remoteRuntimeUpdateAndRestart,
    async (
      _event,
      arg: { id: string; targetVersion?: string | null },
    ): Promise<RemoteRuntimeUpdateAndRestartResult> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const targetVersion =
        typeof arg?.targetVersion === "string" && arg.targetVersion.trim()
          ? arg.targetVersion.trim()
          : null;
      const target = requireRemoteTarget(id);
      // A build whose app cannot install updates would answer "installing" and
      // then abort, so it gets its updater run in a terminal instead.
      const status = remoteConnectionService.snapshot().connections
        .find((connection) => connection.target.id === target.id);
      // a cloud box from an older template would install the update and
      // keep running the old ADE, so it says why before anything is sent.
      const blocked = await cloudUpdateBlocker(target);
      if (blocked) {
        return {
          ok: false,
          updateApplied: false,
          currentVersion: status?.version ?? null,
          targetVersion,
          steps: [{ id: "check", status: "failed", detail: blocked }],
          message: blocked,
          route: "standalone",
          pendingVersion: null,
        };
      }
      if (status?.state === "connected" && isWindowsSelfInstallBlocked(status.version, status.arch)) {
        return await updateViaRemoteTerminal({
          status,
          targetVersion,
          callAction: (targetId, projectId, request) =>
            remoteConnectionService.callAction(targetId, projectId, request),
          isConnected: () => remoteConnectionService.snapshot().connections
            .some((connection) => connection.target.id === target.id && connection.state === "connected"),
          logger: getMachineMainLogger(),
          timeoutMs: REMOTE_MACHINE_UPDATE_TIMEOUT_MS,
        });
      }
      return await remoteConnectionService.callMachineMethod<
        RemoteRuntimeUpdateAndRestartResult
      >(
        target.id,
        "machine.updateAndRestart",
        {
          targetVersion,
          // Who asked, for the other machine's logs and its agents' continue
          // message. An older brain ignores the field.
          requestedBy: {
            machineName: (await thisMachineDisplayName()) ?? undefined,
            clientKind: "desktop",
          },
        },
        {
          // Downloading and installing a build can take minutes, and the
          // restart itself drops the connection — a silent retry would run the
          // whole update a second time.
          timeoutMs: REMOTE_MACHINE_UPDATE_TIMEOUT_MS,
          retryOnConnectionError: false,
        },
      );
    },
  );

  handle(
    IPC.remoteRuntimeGetUpdateImpact,
    async (_event, arg: { id: string }): Promise<UpdateImpact> => {
      // Never rejects: the caller is a confirmation dialog, and a machine that
      // cannot answer (or is gone) is "unknown", not an error to show.
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const target = id ? remoteConnectionService.getTarget(id) : null;
      if (!target) return UNKNOWN_UPDATE_IMPACT;
      const deadlineMs = Date.now() + REMOTE_MACHINE_UPDATE_IMPACT_TIMEOUT_MS;
      const ask = async (method: string): Promise<unknown> => {
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) throw new Error("The update-impact deadline passed.");
        return await remoteConnectionService.callMachineMethod<unknown>(
          target.id,
          method,
          {},
          { timeoutMs: remainingMs, retryOnConnectionError: false },
        );
      };
      try {
        const impact = parseRuntimeUpdateImpact(await ask("runtime.updateImpact"));
        return impact ? { ...impact, checked: true } : UNKNOWN_UPDATE_IMPACT;
      } catch {
        // A machine that needs this update usually predates the method. It can
        // still say whether anything is running, just not what.
        try {
          const activity = await ask("runtime.activitySummary") as Partial<RuntimeActivitySummary> | null;
          if (typeof activity?.idle !== "boolean") return UNKNOWN_UPDATE_IMPACT;
          return { ...UNKNOWN_UPDATE_IMPACT, checked: true, busyWithoutDetail: !activity.idle };
        } catch {
          return UNKNOWN_UPDATE_IMPACT;
        }
      }
    },
  );

  handle(
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
        authorizeLocalRuntimeRoot,
      );
      if (!rootPath) {
        throw new Error(
          "Local runtime project is not available for this window.",
        );
      }
      return await localRuntimeConnectionPool.listActionRegistryForRoot(rootPath);
    },
  );

  handle(
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
        authorizeLocalRuntimeRoot,
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
      const result = await localRuntimeConnectionPool.callActionForRoot(
        rootPath,
        actionRequest,
      );
      const pool = localRuntimeConnectionPool;
      trackPageFileWatch(event.sender, localFileWatchRuntimeKey(rootPath), actionRequest, (fileRequest) =>
        pool.callActionForRoot(rootPath, fileRequest));
      return result;
    },
  );

  handle(
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
        authorizeLocalRuntimeRoot,
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

  handle(
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
        authorizeLocalRuntimeRoot,
      );
      if (!rootPath) {
        throw new Error(
          "Local runtime project is not available for this window.",
        );
      }
      const request = normalizeRuntimeStreamEventsRequest(arg?.request);
      const requestedRootPath = normalizeLocalRuntimeRootPath(arg?.rootPath);
      if (binding?.kind === "local" || requestedRootPath) {
        const bindingKey = localRuntimeEventBindingKey(binding, rootPath);
        const subscribe = (
          onEvent: (event: RemoteRuntimeBufferedEvent, eventEpoch?: string | null) => void,
          onEnded: () => void,
          onSubscribed?: (result: RuntimeEventSubscriptionInit) => void,
        ) =>
          localRuntimeConnectionPool.subscribeEventsForRoot(
            rootPath,
            {
              cursor: request.cursor,
              limit: request.limit,
              category: request.category,
              replay: request.replay,
            },
            onEvent,
            onEnded,
            onSubscribed,
          );
        const requestKey = runtimeEventRequestKey(bindingKey, request);
        const subscriptionInit = await ensureRuntimeEventSubscription(
          event.sender,
          bindingKey,
          requestKey,
          subscribe,
          localFileWatchRuntimeKey(rootPath),
        );
        return {
          events: [],
          nextCursor: subscriptionInit?.nextCursor ?? request.cursor ?? 0,
          hasMore: subscriptionInit?.hasMore === true,
          ...(subscriptionInit?.eventEpoch ? { eventEpoch: subscriptionInit.eventEpoch } : {}),
          ...(subscriptionInit?.gap === true ? { gap: true } : {}),
          ...(typeof subscriptionInit?.oldestCursor === "number" ? { oldestCursor: subscriptionInit.oldestCursor } : {}),
        };
      }
      return withRendererVisibleEvents(
        await localRuntimeConnectionPool.streamEventsForRoot(rootPath, request),
      );
    },
  );

  handle(
    IPC.remoteRuntimeStreamEvents,
    async (
      event,
      arg: {
        id: string;
        projectId: string;
        /** The pin's folder, as for `remoteRuntimeCallAction`. */
        projectRootPath?: string | null;
        request?: RemoteRuntimeStreamEventsRequest;
      },
    ): Promise<RemoteRuntimeStreamEventsResult> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const projectId =
        typeof arg?.projectId === "string" ? arg.projectId.trim() : "";
      const projectRootPath = pinFolder(arg?.projectRootPath);
      if (!id) throw new Error("Remote target id is required.");
      if (!projectId) throw new Error("Remote project id is required.");
      const target = requireRemoteTarget(id);
      const request = normalizeRuntimeStreamEventsRequest(arg?.request);
      // Keys stay on the pin's own id, so a release names the same stream; only
      // the machine is asked by the id it lists, found at each (re)subscribe.
      const bindingKey = remoteProjectBindingKey(target.id, projectId);
      const requestKey = runtimeEventRequestKey(bindingKey, request);
      const subscribe = (
        onEvent: (event: RemoteRuntimeBufferedEvent, eventEpoch?: string | null) => void,
        onEnded: () => void,
        onSubscribed?: (result: RuntimeEventSubscriptionInit) => void,
      ) =>
        remoteConnectionService.subscribeEvents(
          target.id,
          projectId,
          {
            cursor: request.cursor,
            limit: request.limit,
            category: request.category,
            replay: request.replay,
          },
          onEvent,
          onEnded,
          onSubscribed,
          { projectRootPath },
        );
      if (request.replay === false) {
        const subscriptionInit = await ensureRuntimeEventSubscription(
          event.sender,
          bindingKey,
          requestKey,
          subscribe,
          remoteFileWatchRuntimeKey(target.id, projectId),
        );
        return {
          events: [],
          nextCursor: subscriptionInit?.nextCursor ?? request.cursor ?? 0,
          hasMore: subscriptionInit?.hasMore === true,
          ...(subscriptionInit?.eventEpoch ? { eventEpoch: subscriptionInit.eventEpoch } : {}),
          ...(subscriptionInit?.gap === true ? { gap: true } : {}),
          ...(typeof subscriptionInit?.oldestCursor === "number" ? { oldestCursor: subscriptionInit.oldestCursor } : {}),
        };
      }
      const result = withRendererVisibleEvents(
        await remoteConnectionService.streamEvents(target.id, projectId, request, { projectRootPath }),
      );
      // A pump that started live already has a push stream for this binding and
      // category. A second, replaying one would send every event over the wire
      // twice (and through the paid relay when that is the route), so a caught-up
      // poll only keeps the live one alive.
      const liveRequestKey = runtimeEventRequestKey(bindingKey, { ...request, replay: false });
      if (refreshRuntimeEventSubscription(event.sender.id, liveRequestKey)) return result;
      void ensureRuntimeEventSubscription(
        event.sender,
        bindingKey,
        requestKey,
        subscribe,
        remoteFileWatchRuntimeKey(target.id, projectId),
      ).catch(() => {});
      return result;
    },
  );

  // Idle expiry alone leaves a switched-away binding streaming for up to a
  // minute per switch, into a renderer that discards every event. The pump that
  // stops reading says so explicitly; expiry stays as the backstop for renderers
  // that die without one. The argument mirrors the subscribe call so main can
  // re-derive the same request key rather than trust one the renderer guessed.
  handle(
    IPC.runtimeEventsRelease,
    async (
      event,
      arg: RuntimeEventsReleaseRequest,
    ): Promise<RuntimeEventsReleaseResult> => {
      // Enforce the contract's exclusive union at runtime: exactly one complete
      // binding shape — remote `{id, projectId}` XOR local `{rootPath}`. A
      // mixed or partial payload is rejected outright instead of being
      // ambiguously interpreted (e.g. `{id, rootPath}` silently going local).
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      const projectId =
        typeof arg?.projectId === "string" ? arg.projectId.trim() : "";
      const rawRootPath =
        typeof arg?.rootPath === "string" ? arg.rootPath.trim() : "";
      const remoteShape = Boolean(id && projectId);
      const localShape = Boolean(rawRootPath);
      if (remoteShape === localShape || Boolean(id) !== Boolean(projectId)) {
        return { released: 0 };
      }
      let bindingKey: string | null = null;
      if (remoteShape) {
        bindingKey = remoteProjectBindingKey(id, projectId);
      } else {
        const windowId = BrowserWindow.fromWebContents(event.sender)?.id ?? null;
        const session = getWindowSession ? getWindowSession(windowId) : null;
        const rootPath = resolveAuthorizedLocalRuntimeRootPath(
          session,
          rawRootPath,
          authorizeLocalRuntimeRoot,
        );
        if (rootPath) {
          bindingKey = localRuntimeEventBindingKey(session?.binding, rootPath);
        }
      }
      if (!bindingKey) return { released: 0 };
      // A pump's replay flag flips from `live` to `replay` once it is caught up,
      // so it can own both key variants. Release the whole (binding, category).
      const prefix = runtimeEventRequestKeyPrefix(
        bindingKey,
        isRemoteRuntimeEventCategory(arg?.category) ? arg.category : undefined,
      );
      const released = cleanupRuntimeEventSubscriptions(
        event.sender.id,
        (subscription) => subscription.requestKey.startsWith(prefix),
      );
      return { released };
    },
  );

  handle(
    IPC.remoteRuntimeDisconnect,
    async (
      event,
      arg: { id: string; manual?: boolean },
    ): Promise<{ disconnected: boolean }> => {
      const id = typeof arg?.id === "string" ? arg.id.trim() : "";
      if (!id) return { disconnected: false };
      // Drop every subscription this window holds against the target, not just
      // the most recent one: a window can hold the active pump plus one or more
      // pinned pumps on the same remote runtime.
      cleanupRuntimeEventSubscriptions(event.sender.id, (subscription) =>
        subscription.bindingKey.startsWith(`remote:${id}:`),
      );
      remoteConnectionService.disconnect(id, { manual: arg.manual !== false });
      return { disconnected: true };
    },
  );

  return registration;
}
