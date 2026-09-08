import { existsSync } from "node:fs";
import { WebContentsView, app, nativeImage, screen, session } from "electron";
import type { BrowserWindow, DownloadItem, WebContents } from "electron";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  BuiltInBrowserActionTraceEntry,
  BuiltInBrowserAgentActionArgs,
  BuiltInBrowserAgentActionResult,
  BuiltInBrowserBoundsArgs,
  BuiltInBrowserClearArgs,
  BuiltInBrowserClearPermissionsArgs,
  BuiltInBrowserClearPermissionsResult,
  BuiltInBrowserClaimArgs,
  BuiltInBrowserClickArgs,
  BuiltInBrowserContextItem,
  BuiltInBrowserCreateTabArgs,
  BuiltInBrowserDiagnostics,
  BuiltInBrowserDispatchKeyArgs,
  BuiltInBrowserDomSnapshot,
  BuiltInBrowserElementSnapshot,
  BuiltInBrowserElementTargetArgs,
  BuiltInBrowserEndHandoffArgs,
  BuiltInBrowserEndSessionArgs,
  BuiltInBrowserEventPayload,
  BuiltInBrowserHandoffEndedBy,
  BuiltInBrowserHandoffResult,
  BuiltInBrowserHandoffWaitResult,
  BuiltInBrowserStartHandoffArgs,
  BuiltInBrowserTabHandoff,
  BuiltInBrowserWaitForHandoffArgs,
  BuiltInBrowserFrame,
  BuiltInBrowserListSessionsArgs,
  BuiltInBrowserNavigateArgs,
  BuiltInBrowserObservation,
  BuiltInBrowserObservationArgs,
  BuiltInBrowserObservationElementMap,
  BuiltInBrowserOpenPanelArgs,
  BuiltInBrowserOriginAccessResult,
  BuiltInBrowserPermissionsResult,
  BuiltInBrowserPreviewStreamResult,
  BuiltInBrowserProfileDiagnostics,
  BuiltInBrowserProjectScopeArgs,
  BuiltInBrowserRequestOriginAccessArgs,
  BuiltInBrowserScrollArgs,
  BuiltInBrowserScreenshot,
  BuiltInBrowserSelectPointArgs,
  BuiltInBrowserSelectResult,
  BuiltInBrowserSession,
  BuiltInBrowserSessionResult,
  BuiltInBrowserSessionsResult,
  BuiltInBrowserStartSessionArgs,
  BuiltInBrowserStatus,
  BuiltInBrowserTab,
  BuiltInBrowserTabArgs,
  BuiltInBrowserTabTargetArgs,
  BuiltInBrowserTraceArgs,
  BuiltInBrowserTraceResult,
  BuiltInBrowserWaitArgs,
  BuiltInBrowserFillArgs,
  BuiltInBrowserTypeTextArgs,
  BuiltInBrowserDevToolsMode,
  BuiltInBrowserDevToolsResult,
  BuiltInBrowserDragArgs,
  BuiltInBrowserEmulationResult,
  BuiltInBrowserEmulationState,
  DevServerRecord,
  DevServersArgs,
  DevServersResult,
  BuiltInBrowserExportHarArgs,
  BuiltInBrowserExportHarResult,
  BuiltInBrowserFindInPageArgs,
  BuiltInBrowserFindInPageResult,
  BuiltInBrowserHoverArgs,
  BuiltInBrowserNetworkLogArgs,
  BuiltInBrowserNetworkLogEntry,
  BuiltInBrowserNetworkLoggingResult,
  BuiltInBrowserNetworkLogResult,
  BuiltInBrowserRecordingEndedBy,
  BuiltInBrowserSelectOptionArgs,
  BuiltInBrowserSetDevToolsArgs,
  BuiltInBrowserSetEmulationArgs,
  BuiltInBrowserSetNetworkLoggingArgs,
  BuiltInBrowserSetZoomArgs,
  BuiltInBrowserStartPreviewStreamArgs,
  BuiltInBrowserStartRecordingArgs,
  BuiltInBrowserStartRecordingResult,
  BuiltInBrowserStopFindInPageArgs,
  BuiltInBrowserStopFindInPageResult,
  BuiltInBrowserStopPreviewStreamArgs,
  BuiltInBrowserStopRecordingArgs,
  BuiltInBrowserStopRecordingResult,
  BuiltInBrowserUploadFileArgs,
  BuiltInBrowserZoomResult,
} from "../../../shared/types";
import {
  BUILT_IN_BROWSER_PARKED_PREVIEW_MARGIN,
  BUILT_IN_BROWSER_PARKED_PREVIEW_MIN_HEIGHT,
  BUILT_IN_BROWSER_PARKED_PREVIEW_MIN_WIDTH,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { isRecord } from "../shared/utils";
import { pathKey } from "../shared/pathCompare";
import {
  AGENT_DOM_COLLECTOR_FUNCTION,
  AGENT_ELEMENT_MAP_OVERLAY_FUNCTION,
  keyEventForAgentInput,
  parseObservationElementHandle,
  sanitizeObservationPathSegment,
} from "../../../shared/agentObservation";
import {
  agentActionTargetForTrace,
  resolveAgentElementLocatePayload,
  agentHasElementTarget as hasElementTarget,
  applyAgentObservationHandles as applyObservationHandles,
  finiteNumber,
  normalizeAgentDomSnapshot as normalizeDomSnapshot,
  normalizeAgentElementSnapshot as normalizeElementSnapshot,
  normalizeAgentFrame as normalizeFrame,
  optionalFiniteNumber,
  stringOrNull,
} from "../../../shared/agentObservationNormalizers";
import {
  pruneAgentObservationCacheRoot as pruneObservationCacheRoot,
  pruneAgentObservationDirectory as pruneObservationDirectory,
} from "../shared/agentObservationCache";
import {
  BUILT_IN_BROWSER_PARTITION,
  emptyToNull,
  errorMessage,
  normalizeDimension,
} from "./builtInBrowserConstants";
import { isAllowedNavigationUrl, normalizeBrowserUrl } from "./builtInBrowserNavigation";
import {
  builtInBrowserTabTitle,
  createBuiltInBrowserTabCapabilities,
} from "./builtInBrowserTabCapabilities";
import { evaluateInTab } from "./builtInBrowserCdp";
import {
  BuiltInBrowserHandoffActiveError,
  handoffOrigin,
  normalizeHandoffTimeoutMs,
} from "./builtInBrowserHandoff";
import { createBuiltInBrowserAgentAccessController } from "./builtInBrowserAgentAccess";
import { configureBuiltInBrowserAuthentication } from "./builtInBrowserAuthentication";
import { migrateLegacyBuiltInBrowserProfiles } from "./builtInBrowserProfileMigration";
import {
  createBuiltInBrowserPermissionController,
} from "./builtInBrowserPermissions";
import { configureBuiltInBrowserSessionWebAuthn } from "./builtInBrowserWebAuthn";
import {
  createBuiltInBrowserStateStore,
  type BuiltInBrowserRestoredCollection,
} from "./builtInBrowserStateStore";
import {
  BUILT_IN_BROWSER_DEFAULT_ZOOM_FACTOR,
  BUILT_IN_BROWSER_OBSERVATION_NETWORK_LOG_LIMIT,
  clampBuiltInBrowserEmulationViewScale,
  createBuiltInBrowserNetworkLog,
  type BuiltInBrowserNetworkLogStore,
} from "./builtInBrowserCapabilities";
import { devServerRegistry as sharedDevServerRegistry } from "../devServers/devServerRegistry";
import type { DevServerRegistry } from "../devServers/devServerRegistry";
import type {
  BuiltInBrowserRecorderFactory,
  BuiltInBrowserRecordingSession,
  CaptureWindowLike,
} from "./builtInBrowserRecording";

const BROWSER_PARTITION = BUILT_IN_BROWSER_PARTITION;
const SCREENSHOT_TIMEOUT_MS = 3_000;
const ELEMENT_SCREENSHOT_TIMEOUT_MS = 2_000;
const DEBUGGER_TIMEOUT_MS = 3_000;
const MAX_BROWSER_TABS = 10;
const DEFAULT_OBSERVATION_KEEP_COUNT = 3;
const MAX_OBSERVATION_KEEP_COUNT = 20;
const DEFAULT_OBSERVATION_MAX_ELEMENTS = 80;
const MAX_OBSERVATION_MAX_ELEMENTS = 200;
const MAX_ELEMENT_MAP_ELEMENTS = 80;
const MAX_BROWSER_CONSOLE_DIAGNOSTICS = 40;
const MAX_BROWSER_NETWORK_DIAGNOSTICS = 80;
const MAX_BROWSER_TRACE_ENTRIES = 80;
const DEFAULT_BROWSER_TRACE_LIMIT = 20;
const MAX_BROWSER_TRACE_LIMIT = 80;
const MAX_BROWSER_SESSIONS = 80;
const DEFAULT_ACTION_OBSERVE_DELAY_MS = 150;
const MAX_ACTION_OBSERVE_DELAY_MS = 5_000;
const DEFAULT_BROWSER_WAIT_TIMEOUT_MS = 5_000;
const MAX_BROWSER_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_BROWSER_NETWORK_IDLE_MS = 500;
const MAX_BROWSER_NETWORK_IDLE_MS = 10_000;
const DEFAULT_TAB_LEASE_TTL_MS = 10 * 60_000;
const MAX_TAB_LEASE_TTL_MS = 60 * 60_000;
const DEFAULT_OBSERVATION_MAX_AGE_MS = 30 * 60_000;
const OBSERVATION_CACHE_DIR = path.join(".ade", "cache", "browser-observations");
const INSPECT_BINDING_NAME = "__adeBuiltInBrowserInspectSelect";
const DOWNLOAD_FILENAME_UNSAFE_RE = /[<>:"/\\|?*\x00-\x1F]/g;
const RESERVED_BROWSER_DOWNLOAD_PATH_KEYS = new Set<string>();
const MANAGED_BROWSER_WEB_CONTENTS = new WeakSet<WebContents>();
type BrowserCollection = {
  key: string;
  projectRoot: string | null;
};

type BrowserInspectPoint = {
  x: number;
  y: number;
};

type DebuggerMessageListener = (
  event: Electron.Event,
  method: string,
  params: unknown,
  sessionId: string,
) => void;

type DebuggerDetachListener = (event: Electron.Event, reason: string) => void;

type NodeMetadata = {
  tagName: string | null;
  role: string | null;
  label: string | null;
  value: string | null;
  selector: string | null;
  testId: string | null;
  text: string | null;
  frame: BuiltInBrowserFrame;
  viewport: BuiltInBrowserFrame;
  pixelRatio: number;
  url: string | null;
  title: string | null;
  metadata: Record<string, unknown>;
};

type CdpResolveNodeResponse = {
  object?: {
    objectId?: string;
  };
};

type CdpCallFunctionResponse = {
  result?: {
    value?: unknown;
  };
  exceptionDetails?: unknown;
};


type CdpScreenshotResponse = {
  data?: string;
};

type CdpGetNodeForLocationResponse = {
  backendNodeId?: number;
};

type CdpRuntimeBindingCalledParams = {
  name?: string;
  payload?: string;
};

type CdpInputMouseButton = "left" | "middle" | "right" | "none";

export type BrowserTabState = {
  id: string;
  view: WebContentsView | null;
  webContents: WebContents;
  ownsWebContents: boolean;
  consoleDiagnostics: BuiltInBrowserDiagnostics["console"];
  networkDiagnostics: BuiltInBrowserDiagnostics["network"];
  pendingNetworkRequests: Map<string, BrowserPendingNetworkRequest>;
  lastNetworkActivityAtMs: number;
  waiters: Set<() => void>;
  actionTrace: BuiltInBrowserActionTraceEntry[];
  ownerLaneId: string | null;
  ownerChatSessionId: string | null;
  ownerClaimedAt: string | null;
  ownerLeaseExpiresAt: string | null;
  agentNavigationGuard: {
    laneId: string | null;
    chatSessionId: string | null;
  } | null;
  /**
   * Set while a human holds this tab at an agent's request (login, CAPTCHA,
   * HTTP auth, client cert). The agent lease is moved into
   * `handoff.previousOwner` and restored on hand-back, so a handoff cannot
   * silently donate the tab to whichever agent claims it next.
   */
  handoff: BrowserTabHandoffState | null;
  zoomFactor: number;
  emulation: BuiltInBrowserEmulationState | null;
  /**
   * The tab was created with no URL, so it is parked on `about:blank` as a
   * launchpad rather than a page. Cleared the moment it navigates anywhere.
   */
  isLaunchpad: boolean;
  /** Last favicon Chromium reported, and the origin it belongs to. */
  faviconUrl: string | null;
  faviconOrigin: string | null;
  devToolsMode: BuiltInBrowserDevToolsMode | null;
  networkLoggingEnabled: boolean;
  networkLog: BuiltInBrowserNetworkLogStore;
  networkLogPending: Map<string, BuiltInBrowserNetworkLogEntry>;
  recording: BuiltInBrowserRecordingSession | null;
  /**
   * Error tallies since this tab's last main-frame navigation, which is what
   * the Work tools pane's red activity dot reports. Kept as counters rather
   * than derived from the diagnostic buffers because those are capped rolling
   * windows — a page that logs 200 errors would otherwise report the last 50.
   */
  consoleErrorCount: number;
  failedRequestCount: number;
  /** CDP owners that must keep the debugger attached between actions. */
  debuggerHolds: Set<BrowserDebuggerHoldOwner>;
  cdpListener: DebuggerMessageListener | null;
  findRequestId: number | null;
  /**
   * In-flight `findInPage` waiters for this tab, each able to re-target itself
   * at a newer request id. Chromium discards a delayed short-query find when
   * the next one arrives, so without this the superseded waiter waits out its
   * full timeout on a request that will never be answered.
   */
  findWaiters: Set<(requestId: number) => void>;
};

/**
 * CDP consumers that need the debugger attached across many commands.
 *
 * `network` is the opt-in request log; `emulation` is a device override, which
 * Chromium drops the instant the DevTools session that set it detaches — which
 * is exactly why device presets used to change the label and nothing else.
 */
export type BrowserDebuggerHoldOwner = "network" | "emulation";

/**
 * Side-channel for the parts of a login handoff that are not the browser's job:
 * raising the requesting chat's hand, sending the phone push, clearing both on
 * hand-back, and writing the "Handed back to the agent" line into the chat.
 *
 * Injected rather than imported so the browser service keeps no dependency on
 * the session/chat stack — and so a headless test can assert the flip without
 * standing one up.
 */
export type BuiltInBrowserHandoffListener = (event: BuiltInBrowserHandoffLifecycleEvent) => void;

export type BuiltInBrowserHandoffLifecycleEvent =
  | {
      kind: "started";
      tabId: string;
      handoff: BuiltInBrowserTabHandoff;
    }
  | {
      kind: "ended";
      tabId: string;
      handoff: BuiltInBrowserTabHandoff;
      endedBy: BuiltInBrowserHandoffEndedBy;
      durationMs: number;
    };

type BrowserTabHandoffState = BuiltInBrowserTabHandoff & {
  startedAtMs: number;
  /** Auto hand-back timer; cleared on every exit path so it cannot outlive the tab. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Resolved by whichever path ends the handoff, so `waitForHandoff` can block. */
  waiters: Set<(outcome: { endedBy: BuiltInBrowserHandoffEndedBy; durationMs: number }) => void>;
};

type BrowserPendingNetworkRequest = {
  id: string;
  url: string;
  method: string | null;
  resourceType: string | null;
  startedAt: string;
  startedAtMs: number;
};

type BrowserActionTraceDraft = {
  id: string;
  action: string;
  startedAt: string;
  startedAtMs: number;
  before: { url: string | null; title: string | null };
  target: Record<string, unknown> | null;
};

type BrowserSessionState = {
  id: string;
  tabId: string;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  ownerLaneId: string | null;
  ownerChatSessionId: string | null;
  lastObservationId: string | null;
  lastTraceEntryId: string | null;
};

export type BuiltInBrowserElementTargetInput = BuiltInBrowserObservationArgs & BuiltInBrowserElementTargetArgs;
type BrowserDownloadListener = (
  event: { preventDefault: () => void },
  item: DownloadItem,
  downloadWebContents: WebContents,
) => void;

type BrowserNetworkObserver = {
  onRequestStarted: (details: Record<string, unknown>) => void;
  onRequestFinished: (details: Record<string, unknown>, error: string | null) => void;
};

function createBrowserNetworkRouter() {
  const configuredSessions = new WeakSet<Electron.Session>();
  const observers = new Set<BrowserNetworkObserver>();

  return {
    configureSession(browserSession: Electron.Session): void {
      if (configuredSessions.has(browserSession)) return;
      configuredSessions.add(browserSession);
      const webRequest = browserSession.webRequest as unknown as {
        onBeforeRequest?: (listener: (details: Record<string, unknown>, callback?: (response: { cancel?: boolean }) => void) => void) => void;
        onCompleted?: (listener: (details: Record<string, unknown>) => void) => void;
        onErrorOccurred?: (listener: (details: Record<string, unknown>) => void) => void;
      };
      webRequest.onBeforeRequest?.((details, callback) => {
        for (const observer of observers) observer.onRequestStarted(details);
        callback?.({});
      });
      webRequest.onCompleted?.((details) => {
        for (const observer of observers) observer.onRequestFinished(details, null);
      });
      webRequest.onErrorOccurred?.((details) => {
        const error = stringOrNull(details.error) ?? "request failed";
        for (const observer of observers) observer.onRequestFinished(details, error);
      });
    },
    subscribe(observer: BrowserNetworkObserver): () => void {
      observers.add(observer);
      return () => observers.delete(observer);
    },
  };
}

function normalizedProjectRoot(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/**
 * Comparison key for a project root.
 *
 * The daemon, a shell cwd and Electron all spell the same directory
 * differently — drive-letter case, mixed separators — and a raw `===` just
 * misses, which shows up as "no ADE browser window is open for project …" or,
 * worse, a second collection whose key the renderer never uses. `pathKey` is
 * the repo's platform-aware answer (see `windows-quirks.md` §1); it does not
 * resolve, so the value is resolved first.
 */
function projectRootKey(value: string | null | undefined): string | null {
  const normalized = normalizedProjectRoot(value);
  return normalized ? pathKey(path.resolve(normalized)) : null;
}

function collectionForProjectRoot(
  projectRoot: string | null | undefined,
  kind: "personal" | "window" = "window",
): BrowserCollection {
  const normalized = normalizedProjectRoot(projectRoot);
  if (!normalized) {
    return {
      key: kind,
      projectRoot: null,
    };
  }
  // Hash the comparison key, not the raw spelling: two spellings of one
  // directory must land in one collection. Changing this input is why the
  // persisted STATE_VERSION moved to 3.
  const key = createHash("sha256").update(projectRootKey(normalized) ?? normalized).digest("hex").slice(0, 16);
  return {
    key: `project-${key}`,
    projectRoot: normalized,
  };
}

/**
 * "The pane has no tab open" — a state, not a fault.
 *
 * Thrown so the IPC boundary can answer a trusted renderer with a typed
 * `{ ok: false, reason: "no_tab" }` instead of an exception, while an agent
 * still sees a failed request.
 */
export class BuiltInBrowserNoTabError extends Error {
  readonly reason = "no_tab" as const;

  constructor(message: string) {
    super(message);
    this.name = "BuiltInBrowserNoTabError";
  }
}

export function isBuiltInBrowserNoTabError(error: unknown): boolean {
  return error instanceof BuiltInBrowserNoTabError
    || (error instanceof Error && error.name === "BuiltInBrowserNoTabError");
}

export function createBuiltInBrowserService(args: {
  getLogger?: () => Logger;
  getProjectRootForWindow?: (win: BrowserWindow) => string | null | undefined;
  getWindowForProjectRoot?: (projectRoot: string) => BrowserWindow | null | undefined;
  onEvent?: ((payload: BuiltInBrowserEventPayload, targetWindow?: BrowserWindow | null) => void) | null;
  stateFilePath?: string | null;
  permissionFilePath?: string | null;
  /**
   * Login-handoff side effects that belong to the chat stack, not the browser:
   * raising and clearing the requesting session's hand, the phone push, and the
   * "Handed back to the agent" transcript line. See
   * {@link BuiltInBrowserHandoffListener}.
   */
  onHandoff?: BuiltInBrowserHandoffListener | null;
  /** Test seam for the hidden renderer that encodes tab recordings. */
  createRecordingWindow?: (() => CaptureWindowLike) | null;
  /** Test seam that replaces the whole recorder (skips Electron entirely). */
  createTabRecorder?: BuiltInBrowserRecorderFactory | null;
  /**
   * Passive dev-server discovery fed by the PTY output pipeline. Defaults to
   * the process-wide registry; tests inject their own.
   */
  devServers?: DevServerRegistry | null;
  /**
   * `browser.autoOpenDevServer` for the project the detection came from.
   * Defaults to enabled — the setting exists so a person who does not want ADE
   * opening tabs can say so, not so the feature has to be discovered before it
   * works.
   *
   * The record is passed because this service is process-wide while the setting
   * is per project: resolving it from the foreground project meant a project
   * that had opted out still got tabs whenever another project's window was in
   * front, and vice versa.
   */
  isDevServerAutoOpenEnabled?: ((record: DevServerRecord) => boolean | Promise<boolean>) | null;
}) {
  type WindowBrowserService = ReturnType<typeof createBuiltInBrowserWindowService>;
  type WindowBrowserEntry = {
    win: BrowserWindow;
    service: WindowBrowserService;
  };

  const windowServices = new Map<string, WindowBrowserEntry>();
  const activeServiceKeyByWindow = new Map<number, string>();
  const windowClosedListeners = new Map<number, { win: BrowserWindow; listener: () => void }>();
  let activeWindowId: number | null = null;
  const fallbackServices = new Map<"window" | "personal", WindowBrowserService>();
  let lastStorageFlushAt: string | null = null;
  const userDataPath = app.isReady?.() ? app.getPath("userData") : null;
  const stateFilePath = args.stateFilePath === null
    ? null
    : args.stateFilePath ?? (userDataPath ? path.join(userDataPath, "ade-browser-state.json") : null);
  const stateStore = stateFilePath
    ? createBuiltInBrowserStateStore({ filePath: stateFilePath, getLogger: args.getLogger })
    : null;
  const permissionFilePath = args.permissionFilePath === null
    ? null
    : args.permissionFilePath ?? (userDataPath ? path.join(userDataPath, "ade-browser-permissions.json") : null);
  const personalObservationRootPath = userDataPath
    ? path.join(userDataPath, "browser-observations")
    : null;
  const resolveParentWindow = (): BrowserWindow | null => {
    if (activeWindowId != null) {
      const activeWindow = windowClosedListeners.get(activeWindowId)?.win ?? null;
      if (activeWindow && !activeWindow.isDestroyed()) return activeWindow;
    }
    for (const { win } of windowClosedListeners.values()) {
      if (!win.isDestroyed()) return win;
    }
    return null;
  };
  const permissionController = createBuiltInBrowserPermissionController({
    filePath: permissionFilePath,
    isManagedWebContents: (webContents) => Boolean(webContents && MANAGED_BROWSER_WEB_CONTENTS.has(webContents)),
    resolveParentWindow,
    getLogger: args.getLogger,
  });
  const agentAccessController = createBuiltInBrowserAgentAccessController({
    hasAllowedPermissionForOrigin: (origin) => permissionController.hasAllowedDecisionForOrigin(origin),
    resolveParentWindow,
    getLogger: args.getLogger,
  });
  const networkRouter = createBrowserNetworkRouter();
  const profileMigrationPromise = userDataPath
    ? migrateLegacyBuiltInBrowserProfiles({
        userDataPath,
        getSession: (partition) => session.fromPartition(partition),
        getLogger: args.getLogger,
      }).catch((error) => {
        let migrationLogger = null;
        try {
          migrationLogger = args.getLogger?.() ?? null;
        } catch {
          // Logging must never prevent the browser profile from opening.
        }
        migrationLogger?.warn("built_in_browser.profile_migration_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      })
    : Promise.resolve(null);

  const createServiceForWindow = (win: BrowserWindow, collection: BrowserCollection): WindowBrowserService =>
    createBuiltInBrowserWindowService({
      getLogger: args.getLogger,
      onEvent: (payload) => args.onEvent?.(payload, win),
      collection,
      restoredState: stateStore?.restore(collection.key) ?? null,
      onStateChange: (state) => stateStore?.record(collection.key, state),
      observationRootPath: collection.projectRoot
        ? path.join(collection.projectRoot, OBSERVATION_CACHE_DIR)
        : personalObservationRootPath,
      permissionController,
      agentAccessController,
      networkRouter,
      waitForProfileMigration: () => profileMigrationPromise.then(() => undefined),
      onHandoff: args.onHandoff ?? null,
      createRecordingWindow: args.createRecordingWindow ?? null,
      createTabRecorder: args.createTabRecorder ?? null,
    });

  const serviceKey = (windowId: number, collection: BrowserCollection): string =>
    `${windowId}:${collection.key}`;

  const collectionForWindow = (win: BrowserWindow): BrowserCollection => {
    const projectRoot = args.getProjectRootForWindow?.(win);
    return normalizedProjectRoot(projectRoot)
      ? collectionForProjectRoot(projectRoot)
      : collectionForProjectRoot(null, "window");
  };

  const projectRootForWindow = (win: BrowserWindow): string | null =>
    normalizedProjectRoot(args.getProjectRootForWindow?.(win));

  const projectRootsMatch = (left: string | null | undefined, right: string | null | undefined): boolean => {
    const leftKey = projectRootKey(left);
    const rightKey = projectRootKey(right);
    return Boolean(leftKey && leftKey === rightKey);
  };

  const projectRootFromInput = (input: unknown): string | null => {
    if (!isRecord(input)) return null;
    const projectRoot = input.projectRoot;
    return typeof projectRoot === "string" ? normalizedProjectRoot(projectRoot) : null;
  };

  const requestsPersonalCollection = (input: unknown): boolean =>
    isRecord(input) && input.tabCollection === "personal";

  const liveWindowForProjectRoot = (projectRoot: string): BrowserWindow | null => {
    const normalized = normalizedProjectRoot(projectRoot);
    if (!normalized) return null;
    const resolved = args.getWindowForProjectRoot?.(normalized) ?? null;
    if (isLiveWindow(resolved)) {
      return resolved;
    }
    for (const { win } of windowClosedListeners.values()) {
      if (!isLiveWindow(win)) continue;
      if (projectRootsMatch(projectRootForWindow(win), normalized)) return win;
    }
    return null;
  };

  const detachInactiveWindowServices = (win: BrowserWindow, activeKey: string): void => {
    for (const [key, entry] of windowServices) {
      if (entry.win.id !== win.id || key === activeKey) continue;
      entry.service.detachFromWindow(false);
    }
  };

  const disposeWindowServices = (win: BrowserWindow): void => {
    for (const [key, entry] of windowServices) {
      if (entry.win.id !== win.id) continue;
      entry.service.dispose();
      windowServices.delete(key);
    }
    activeServiceKeyByWindow.delete(win.id);
    if (activeWindowId === win.id) activeWindowId = null;
  };

  const ensureWindowClosedListener = (win: BrowserWindow): void => {
    if (windowClosedListeners.has(win.id)) return;
    const listener = () => {
      disposeWindowServices(win);
      windowClosedListeners.delete(win.id);
    };
    windowClosedListeners.set(win.id, { win, listener });
    win.once("closed", listener);
  };

  const serviceForWindowCollection = (
    win: BrowserWindow,
    collection: BrowserCollection,
    options: { markActive?: boolean } = {},
  ): WindowBrowserService => {
    const key = serviceKey(win.id, collection);
    const existing = windowServices.get(key);
    if (options.markActive) {
      activeServiceKeyByWindow.set(win.id, key);
      detachInactiveWindowServices(win, key);
    }
    if (existing) return existing.service;

    for (const fallback of fallbackServices.values()) fallback.dispose();
    fallbackServices.clear();
    ensureWindowClosedListener(win);
    const service = createServiceForWindow(win, collection);
    windowServices.set(key, { win, service });
    return service;
  };

  const serviceForWindow = (win: BrowserWindow): WindowBrowserService =>
    serviceForWindowCollection(win, collectionForWindow(win), { markActive: true });

  const activeService = (): WindowBrowserService => {
    if (activeWindowId != null) {
      const activeWindow = windowClosedListeners.get(activeWindowId)?.win;
      if (isLiveWindow(activeWindow)) return serviceForWindow(activeWindow);
      const activeKey = activeServiceKeyByWindow.get(activeWindowId);
      const active = activeKey ? windowServices.get(activeKey) : null;
      if (active) return active.service;
    }
    const first = windowServices.values().next().value as WindowBrowserEntry | undefined;
    if (first) return first.service;
    let fallbackService = fallbackServices.get("window") ?? null;
    if (!fallbackService) {
      fallbackService = createBuiltInBrowserWindowService({
        getLogger: args.getLogger,
        onEvent: (payload) => args.onEvent?.(payload, null),
        collection: collectionForProjectRoot(null, "window"),
        restoredState: stateStore?.restore("window") ?? null,
        onStateChange: (state) => stateStore?.record("window", state),
        observationRootPath: personalObservationRootPath,
        permissionController,
        agentAccessController,
        networkRouter,
        waitForProfileMigration: () => profileMigrationPromise.then(() => undefined),
        onHandoff: args.onHandoff ?? null,
        createRecordingWindow: args.createRecordingWindow ?? null,
        createTabRecorder: args.createTabRecorder ?? null,
      });
      fallbackServices.set("window", fallbackService);
    }
    return fallbackService;
  };

  const isLiveWindow = (value: unknown): value is BrowserWindow =>
    Boolean(
      value
      && typeof (value as { id?: unknown }).id === "number"
      && typeof (value as { isDestroyed?: unknown }).isDestroyed === "function"
      && !(value as { isDestroyed: () => boolean }).isDestroyed()
    );

  const serviceForProjectRoot = (projectRoot: string): WindowBrowserService => {
    const normalized = normalizedProjectRoot(projectRoot);
    if (!normalized) return activeService();
    const win = liveWindowForProjectRoot(normalized);
    if (!win) {
      throw new Error(`No ADE browser window is open for project: ${normalized}`);
    }
    const service = serviceForWindowCollection(win, collectionForProjectRoot(normalized), {
      markActive: projectRootsMatch(projectRootForWindow(win), normalized),
    });
    service.attachToWindow(win);
    return service;
  };

  const serviceForPersonalCollection = (sourceWindow?: BrowserWindow | null): WindowBrowserService => {
    const activeWindow = activeWindowId == null
      ? null
      : windowClosedListeners.get(activeWindowId)?.win ?? null;
    const win = isLiveWindow(sourceWindow)
      ? sourceWindow
      : isLiveWindow(activeWindow)
        ? activeWindow
        : null;
    if (!win) {
      let fallbackService = fallbackServices.get("personal") ?? null;
      if (!fallbackService) {
        fallbackService = createBuiltInBrowserWindowService({
          getLogger: args.getLogger,
          onEvent: (payload) => args.onEvent?.(payload, null),
          collection: collectionForProjectRoot(null, "personal"),
          restoredState: stateStore?.restore("personal") ?? null,
          onStateChange: (state) => stateStore?.record("personal", state),
          observationRootPath: personalObservationRootPath,
          permissionController,
          agentAccessController,
          networkRouter,
          waitForProfileMigration: () => profileMigrationPromise.then(() => undefined),
          onHandoff: args.onHandoff ?? null,
        });
        fallbackServices.set("personal", fallbackService);
      }
      return fallbackService;
    }
    activeWindowId = win.id;
    const service = serviceForWindowCollection(win, collectionForProjectRoot(null, "personal"), { markActive: true });
    service.attachToWindow(win);
    return service;
  };

  const serviceForInput = (
    input?: BuiltInBrowserProjectScopeArgs | null,
    sourceWindow?: BrowserWindow | null,
  ): WindowBrowserService => {
    if (requestsPersonalCollection(input)) return serviceForPersonalCollection(sourceWindow);
    const projectRoot = projectRootFromInput(input);
    if (projectRoot) return serviceForProjectRoot(projectRoot);
    if (isLiveWindow(sourceWindow)) return serviceForWindow(sourceWindow);
    return activeService();
  };

  /**
   * Project-scoped read that never constructs, never attaches, never marks a
   * window active, and returns `null` instead of throwing when there is nothing
   * to read.
   *
   * This is a plain `windowServices` lookup on purpose. `serviceForProjectRoot`
   * is the write path: it calls `attachToWindow` and can mark the collection
   * active. Even `serviceForWindowCollection` is a *creating* resolver — on a
   * miss it disposes every fallback service and builds a window service, whose
   * factory restores and `loadURL`s every persisted tab in the shared,
   * authenticated browser profile. The runtime daemon's Work-tools mirror polls
   * this on a timer for a phone that may not even be looking, once per project,
   * so materializing a background project's collection here would background-load
   * that project's tabs for a pane nobody opened.
   *
   * A window that is open for the project but has never used the Browser pane
   * therefore reads as `null` too. That is NOT the same state as no window at
   * all, and callers must not render it as one — ask
   * `hasLiveWindowForProjectRoot` to tell the two apart.
   *
   * A blank or null root reads as `null` rather than falling through to
   * `activeService()`: that is the creating, marking write path, and this
   * function's whole contract is that it is not. The frontmost-window fallback
   * for a project-less caller lives at the one call site that wants it
   * (`getStatusForProjectScope`), where it is visible.
   */
  const readOnlyServiceForProjectRoot = (
    projectRoot: string | null,
  ): WindowBrowserService | null => {
    const normalized = normalizedProjectRoot(projectRoot);
    if (!normalized) return null;
    const win = liveWindowForProjectRoot(normalized);
    if (!win) return null;
    const key = serviceKey(win.id, collectionForProjectRoot(normalized));
    return windowServices.get(key)?.service ?? null;
  };

  /**
   * Does a live window on this machine serve `projectRoot` at all — whether or
   * not its Browser pane was ever opened?
   *
   * The distinction the read above cannot make on its own: "the desktop doesn't
   * have this project open" and "it does, you just haven't opened the Browser
   * tool" are opposite instructions, and giving the second user the first
   * sentence tells them to open something already in front of them. Pure: this
   * is window bookkeeping only, with no collection lookup and no construction.
   */
  const hasLiveWindowForProjectRoot = (projectRoot: string | null): boolean => {
    const normalized = normalizedProjectRoot(projectRoot);
    if (!normalized) return false;
    return liveWindowForProjectRoot(normalized) != null;
  };

  /* ── Dev-server discovery ───────────────────────────────────────────────── */

  const devServers = args.devServers ?? sharedDevServerRegistry;
  /** `${laneId}:${port}` keys already auto-opened during this app session. */
  const autoOpenedDevServers = new Set<string>();

  const allWindowServices = (): WindowBrowserService[] => [
    ...[...windowServices.values()].map((entry) => entry.service),
    ...fallbackServices.values(),
  ];

  /**
   * Picks the collection a detected dev server belongs to.
   *
   * A lane whose chat already holds a browser tab gets the new tab in the same
   * pane it is already using. Otherwise the only safe target is a Browser tool
   * with nothing open at all: dropping a tab into a pane someone is working in
   * would be exactly the kind of surprise this feature must not cause.
   *
   * That empty pane also has to belong to the detecting terminal's own project.
   * `activeService()` is whichever window is frontmost, which on a two-project
   * machine is routinely not the lane's — and a `localhost` tab that appears in
   * a different project's Browser tool is both a surprise and, since every
   * surface filters on `status.collectionProjectRoot`, invisible where it was
   * wanted. A detection with no project (a project-less terminal) has no such
   * constraint to check.
   */
  const devServerTargetService = (record: DevServerRecord): WindowBrowserService | null => {
    const laneId = record.source.laneId;
    const projectRoot = normalizedProjectRoot(record.source.projectRoot);
    if (laneId) {
      for (const service of allWindowServices()) {
        if (service.getStatus().tabs.some((tab) => tab.ownerLaneId === laneId)) return service;
      }
    }
    // `activeService()` unconditionally, with no "are there any services yet"
    // guard: on a machine that has not opened the pane at all it materializes
    // the window-collection fallback, which is the empty pane a detection is
    // allowed to drop a tab into. The guard used to be load-bearing only by
    // accident — the chip's own `activeService()` call ran first and created
    // that fallback — and this resolver now runs BEFORE the chip, so relying on
    // that ordering would silently stop auto-opening on a cold pane.
    const active = activeService();
    const activeStatus = active.getStatus();
    if (activeStatus.tabs.length > 0) return null;
    if (projectRoot && !projectRootsMatch(activeStatus.collectionProjectRoot, projectRoot)) return null;
    return active;
  };

  /**
   * The collection a detection's chip is stamped with.
   *
   * Every surface filters `dev-server-detected` on
   * `status.collectionProjectRoot` (`browserPanelNormalizers.ts#eventProjectRoot`),
   * so this is what decides which launchpad shows the chip — and stamping it
   * with whatever window is frontmost put one project's `localhost` URL in
   * another project's pane while the lane's own pane dropped it.
   *
   * The auto-open target wins when it is the lane's project, because that is
   * where the tab will land. Otherwise the record's own project decides, read
   * through the non-constructing lookup: a project whose Browser pane was never
   * opened yields `null` and no chip at all. That is the honest outcome — there
   * is no pane to render it, and materializing one here would restore and load
   * a background project's persisted tabs for a chip nobody is looking at.
   */
  const devServerChipService = (
    record: DevServerRecord,
    targetService: WindowBrowserService | null,
  ): WindowBrowserService | null => {
    const projectRoot = normalizedProjectRoot(record.source.projectRoot);
    if (!projectRoot) return targetService ?? activeService();
    if (
      targetService
      && projectRootsMatch(targetService.getStatus().collectionProjectRoot, projectRoot)
    ) {
      return targetService;
    }
    return readOnlyServiceForProjectRoot(projectRoot);
  };

  const handleDevServerDetected = async (record: DevServerRecord): Promise<void> => {
    const laneId = record.source.laneId;
    const key = `${laneId ?? ""}:${record.port}`;
    // Once per (lane, port) per app session: a dev server that restarts twenty
    // times during a watch run must not open twenty tabs.
    if (autoOpenedDevServers.has(key)) return;
    autoOpenedDevServers.add(key);
    // Resolved before the chip is emitted, and unconditionally — even when
    // auto-open is off and nothing will be opened. Every surface filters
    // `dev-server-detected` on `status.collectionProjectRoot`
    // (`browserPanelNormalizers.ts#eventProjectRoot`), so a chip stamped with
    // whatever collection happens to be frontmost is dropped by the lane's own
    // panel and merged into a different project's launchpad. This resolver is
    // synchronous, so it costs nothing to do it here.
    const targetService = devServerTargetService(record);
    const chipService = devServerChipService(record, targetService);
    // Still tell surfaces about it even when nothing opened: the launchpad chips
    // and the corner card want the server either way.
    const emitChipOnly = (): void => {
      // No collection for the detecting project means no pane to render this
      // chip in. Emitting it anyway would stamp it with someone else's
      // collection, which is how a lane's `localhost` URL ended up in another
      // project's launchpad; the record stays in the registry, so the pane
      // lists it the moment it is opened.
      if (!chipService) return;
      args.onEvent?.({
        type: "dev-server-detected",
        server: record,
        tabId: null,
        autoOpened: false,
        status: chipService.getStatus(),
        detectedAt: record.detectedAt,
      }, null);
    };
    // Chip FIRST, unconditionally, before anything that can await at all.
    // The claim below goes through the agent-access gate, which may raise a
    // native prompt and sit on it forever — and `autoOpenedDevServers` has
    // already been marked, so nothing retries. Emitting after the claim meant a
    // detected dev server was invisible in every surface for as long as an
    // unanswered prompt stood. The auto-open predicate is no safer to wait on:
    // it walks every project context awaiting `laneService.getSummary`, a daemon
    // round trip in the runtime-backed build, and a wedged lane service would
    // stall the chip the same way. Consumers already tolerate a second
    // `dev-server-detected` for the same record (the launchpad keys on port),
    // so the enriched `autoOpened` event below is a refinement, not a duplicate.
    emitChipOnly();
    let enabled = true;
    try {
      enabled = (await args.isDevServerAutoOpenEnabled?.(record)) ?? true;
    } catch {
      enabled = true;
    }
    const service = enabled ? targetService : null;
    if (!service) return;
    // The detection is triggered by whatever a terminal *printed*, and an agent
    // controls its own terminal — so an unclaimed auto-open would let a printed
    // ready line navigate the shared, globally-authenticated browser profile
    // with no owner and no origin grant. Every auto-open therefore goes through
    // a lane claim, which is what puts it in front of the agent-access gate;
    // when there is no lane to claim for, or the claim is refused, the person
    // keeps the launchpad chip and clicks it themselves.
    if (!laneId) return;
    let status: BuiltInBrowserStatus;
    try {
      // Background tab, no panel request, no focus steal: the person finds out
      // from the corner card, not by having their pane yanked.
      status = await service.createTab({
        url: record.url,
        activate: false,
        openPanel: false,
        laneId,
      });
    } catch (error) {
      args.getLogger?.().debug("built_in_browser.dev_server_auto_open_denied", {
        port: record.port,
        laneId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Already chipped above — the person can still open it by hand.
      return;
    }
    const openedTabId = status.tabs.at(-1)?.id ?? null;
    args.onEvent?.({
      type: "dev-server-detected",
      server: record,
      tabId: openedTabId,
      autoOpened: true,
      status,
      detectedAt: record.detectedAt,
    }, null);
  };

  const unsubscribeDevServers = devServers.onDetected((record) => {
    void handleDevServerDetected(record).catch((error) => {
      args.getLogger?.().debug("built_in_browser.dev_server_auto_open_failed", {
        port: record.port,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  const flushStorage = async (): Promise<void> => {
    const startedAt = Date.now();
    await profileMigrationPromise;
    const browserSession = session.fromPartition(BROWSER_PARTITION);
    const results = await Promise.allSettled([
      stateStore?.flush() ?? Promise.resolve(),
      permissionController.flush(),
      Promise.resolve().then(() => browserSession.cookies.flushStore()),
      Promise.resolve().then(() => browserSession.flushStorageData()),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to flush ADE browser storage.");
    }
    lastStorageFlushAt = new Date().toISOString();
    try {
      args.getLogger?.().info("built_in_browser.storage_flushed", {
        partition: BROWSER_PARTITION,
        durationMs: Date.now() - startedAt,
      });
    } catch {
      // Storage is already flushed; logging must not turn a successful flush into a shutdown failure.
    }
  };

  return {
    flushStorage,
    /** Stops the dev-server subscription; used when a test disposes a service. */
    stopDevServerWatch(): void {
      unsubscribeDevServers();
    },
    getDevServers(input: DevServersArgs = {}): DevServersResult {
      return { servers: devServers.list(input) };
    },
    listPermissions(): BuiltInBrowserPermissionsResult {
      return { permissions: permissionController.list() };
    },
    async clearPermissions(input: BuiltInBrowserClearPermissionsArgs = {}): Promise<BuiltInBrowserClearPermissionsResult> {
      const removed = await permissionController.clear(input);
      return { removed, permissions: permissionController.list() };
    },
    async getProfileDiagnostics(): Promise<BuiltInBrowserProfileDiagnostics> {
      await profileMigrationPromise;
      const browserSession = session.fromPartition(BROWSER_PARTITION);
      const cookies = await browserSession.cookies.get({});
      let cacheSizeBytes: number | null = null;
      try {
        cacheSizeBytes = await browserSession.getCacheSize();
      } catch (error) {
        args.getLogger?.().debug("built_in_browser.cache_size_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const cookieDomains = [...new Set(cookies
        .map((cookie) => cookie.domain?.replace(/^\./, "").toLowerCase())
        .filter((domain): domain is string => Boolean(domain)))]
        .sort();
      const persistentCookieCount = cookies.filter((cookie) => cookie.expirationDate != null).length;
      return {
        partition: BROWSER_PARTITION,
        storageProfileKey: "global",
        persistentProfile: true,
        cookieCount: cookies.length,
        persistentCookieCount,
        sessionCookieCount: cookies.length - persistentCookieCount,
        cookieDomains,
        cacheSizeBytes,
        persistedPermissionDecisionCount: permissionController.count(),
        tabRestorationEnabled: Boolean(stateStore),
        lastStorageFlushAt,
      };
    },
    attachToWindow(nextWin: BrowserWindow): void {
      activeWindowId = nextWin.id;
      serviceForWindow(nextWin).attachToWindow(nextWin);
    },
    getStatus(
      inputOrSourceWindow?: BuiltInBrowserTabTargetArgs | BrowserWindow | null,
      sourceWindow?: BrowserWindow | null,
    ): BuiltInBrowserStatus {
      const input = isLiveWindow(inputOrSourceWindow) ? null : inputOrSourceWindow ?? null;
      const win = sourceWindow ?? (isLiveWindow(inputOrSourceWindow) ? inputOrSourceWindow : null);
      return serviceForInput(input, win).getStatusForInput(input ?? {});
    },
    /**
     * Side-effect-free status for one project's collection, for the desktop
     * bridge's `getStatusForRuntime`.
     *
     * `null` means "there is nothing to read for that project" — either no
     * window on this machine has it open, or one does and its Browser pane was
     * never used. The caller must render that as its own state, not as this
     * machine's browser, because falling back to the frontmost window would
     * show one project's tabs to another project's Work-tools pane; ask
     * {@link hasWindowForProjectScope} which of the two absences it is.
     *
     * A `null`/blank `projectRoot` (a project-less daemon) keeps the
     * frontmost-window behaviour, and is the one path here that can construct:
     * such a caller has no project to be shown the wrong tabs for.
     */
    getStatusForProjectScope(projectRoot: string | null): BuiltInBrowserStatus | null {
      if (!normalizedProjectRoot(projectRoot)) return activeService().getStatusForInput({});
      const scoped = readOnlyServiceForProjectRoot(projectRoot);
      if (!scoped) return null;
      return scoped.getStatusForInput({});
    },
    /**
     * Whether a live window on this machine serves the project, independent of
     * whether its Browser pane was ever opened. Side-effect-free.
     *
     * Pairs with {@link getStatusForProjectScope}: `null` status + `true` here
     * is "the pane was never opened", `null` + `false` is "this project is not
     * open on this Mac". Only the second may say so to a human.
     */
    hasWindowForProjectScope(projectRoot: string | null): boolean {
      return hasLiveWindowForProjectRoot(projectRoot);
    },
    requestOriginAccess(
      input: BuiltInBrowserRequestOriginAccessArgs = {},
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserOriginAccessResult> {
      return serviceForInput(input, sourceWindow).requestOriginAccess(input);
    },
    claim(input: BuiltInBrowserClaimArgs = {}, sourceWindow?: BrowserWindow | null): BuiltInBrowserStatus {
      return serviceForInput(input, sourceWindow).claim(input);
    },
    startHandoff(input: BuiltInBrowserStartHandoffArgs, sourceWindow?: BrowserWindow | null): BuiltInBrowserHandoffResult {
      return serviceForInput(input, sourceWindow).startHandoff(input);
    },
    /** Human-only: reachable from the renderer's `Hand back`, never from the agent bridge. */
    endHandoff(input: BuiltInBrowserEndHandoffArgs = {}, sourceWindow?: BrowserWindow | null): BuiltInBrowserHandoffResult {
      return serviceForInput(input, sourceWindow).endHandoff(input);
    },
    waitForHandoff(
      input: BuiltInBrowserWaitForHandoffArgs = {},
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserHandoffWaitResult> {
      return serviceForInput(input, sourceWindow).waitForHandoff(input);
    },
    startSession(input: BuiltInBrowserStartSessionArgs = {}, sourceWindow?: BrowserWindow | null): BuiltInBrowserSessionResult {
      return serviceForInput(input, sourceWindow).startSession(input);
    },
    listSessions(inputOrSourceWindow?: BuiltInBrowserListSessionsArgs | BrowserWindow | null, sourceWindow?: BrowserWindow | null): BuiltInBrowserSessionsResult {
      const input = isLiveWindow(inputOrSourceWindow) ? {} : inputOrSourceWindow ?? {};
      return serviceForInput(input, sourceWindow ?? (isLiveWindow(inputOrSourceWindow) ? inputOrSourceWindow : null)).listSessions(input);
    },
    endSession(input: BuiltInBrowserEndSessionArgs, sourceWindow?: BrowserWindow | null): BuiltInBrowserSessionResult {
      return serviceForInput(input, sourceWindow).endSession(input);
    },
    showPanel(input: BuiltInBrowserOpenPanelArgs = {}, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserStatus> {
      return serviceForInput(input, sourceWindow).showPanel(input);
    },
    setBounds(nextBounds: BuiltInBrowserBoundsArgs, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserStatus> {
      return serviceForInput(nextBounds, sourceWindow).setBounds(nextBounds);
    },
    navigate(input: BuiltInBrowserNavigateArgs, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserStatus> {
      return serviceForInput(input, sourceWindow).navigate(input);
    },
    createTab(input: BuiltInBrowserCreateTabArgs = {}, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserStatus> {
      return serviceForInput(input, sourceWindow).createTab(input);
    },
    switchTab(input: BuiltInBrowserTabArgs, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserStatus> {
      return serviceForInput(input, sourceWindow).switchTab(input);
    },
    closeTab(input: BuiltInBrowserTabArgs, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserStatus> {
      return serviceForInput(input, sourceWindow).closeTab(input);
    },
    reload(inputOrSourceWindow?: BuiltInBrowserTabTargetArgs | BrowserWindow | null, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserStatus> {
      const input = isLiveWindow(inputOrSourceWindow) ? {} : inputOrSourceWindow ?? {};
      return serviceForInput(input, sourceWindow ?? (isLiveWindow(inputOrSourceWindow) ? inputOrSourceWindow : null)).reload(input);
    },
    goBack(inputOrSourceWindow?: BuiltInBrowserTabTargetArgs | BrowserWindow | null, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserStatus> {
      const input = isLiveWindow(inputOrSourceWindow) ? {} : inputOrSourceWindow ?? {};
      return serviceForInput(input, sourceWindow ?? (isLiveWindow(inputOrSourceWindow) ? inputOrSourceWindow : null)).goBack(input);
    },
    goForward(inputOrSourceWindow?: BuiltInBrowserTabTargetArgs | BrowserWindow | null, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserStatus> {
      const input = isLiveWindow(inputOrSourceWindow) ? {} : inputOrSourceWindow ?? {};
      return serviceForInput(input, sourceWindow ?? (isLiveWindow(inputOrSourceWindow) ? inputOrSourceWindow : null)).goForward(input);
    },
    stop(inputOrSourceWindow?: BuiltInBrowserTabTargetArgs | BrowserWindow | null, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserStatus> {
      const input = isLiveWindow(inputOrSourceWindow) ? {} : inputOrSourceWindow ?? {};
      return serviceForInput(input, sourceWindow ?? (isLiveWindow(inputOrSourceWindow) ? inputOrSourceWindow : null)).stop(input);
    },
    observe(inputOrSourceWindow?: BuiltInBrowserObservationArgs | BrowserWindow | null, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserObservation> {
      const input = isLiveWindow(inputOrSourceWindow) ? {} : inputOrSourceWindow ?? {};
      return serviceForInput(input, sourceWindow ?? (isLiveWindow(inputOrSourceWindow) ? inputOrSourceWindow : null)).observe(input);
    },
    getTrace(inputOrSourceWindow?: BuiltInBrowserTraceArgs | BrowserWindow | null, sourceWindow?: BrowserWindow | null): BuiltInBrowserTraceResult {
      const input = isLiveWindow(inputOrSourceWindow) ? {} : inputOrSourceWindow ?? {};
      return serviceForInput(input, sourceWindow ?? (isLiveWindow(inputOrSourceWindow) ? inputOrSourceWindow : null)).getTrace(input);
    },
    click(input: BuiltInBrowserClickArgs, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserAgentActionResult> {
      return serviceForInput(input, sourceWindow).click(input);
    },
    typeText(input: BuiltInBrowserTypeTextArgs, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserAgentActionResult> {
      return serviceForInput(input, sourceWindow).typeText(input);
    },
    dispatchKey(input: BuiltInBrowserDispatchKeyArgs, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserAgentActionResult> {
      return serviceForInput(input, sourceWindow).dispatchKey(input);
    },
    scroll(input: BuiltInBrowserScrollArgs, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserAgentActionResult> {
      return serviceForInput(input, sourceWindow).scroll(input);
    },
    fill(input: BuiltInBrowserFillArgs, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserAgentActionResult> {
      return serviceForInput(input, sourceWindow).fill(input);
    },
    clear(input: BuiltInBrowserClearArgs, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserAgentActionResult> {
      return serviceForInput(input, sourceWindow).clear(input);
    },
    wait(input: BuiltInBrowserWaitArgs, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserAgentActionResult> {
      return serviceForInput(input, sourceWindow).wait(input);
    },
    startInspect(
      inputOrSourceWindow?: BuiltInBrowserTabTargetArgs | BrowserWindow | null,
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserStatus> {
      const input = isLiveWindow(inputOrSourceWindow) ? null : inputOrSourceWindow ?? null;
      const win = sourceWindow ?? (isLiveWindow(inputOrSourceWindow) ? inputOrSourceWindow : null);
      return serviceForInput(input, win).startInspect(input ?? {});
    },
    stopInspect(
      inputOrSourceWindow?: BuiltInBrowserTabTargetArgs | BrowserWindow | null,
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserStatus> {
      const input = isLiveWindow(inputOrSourceWindow) ? null : inputOrSourceWindow ?? null;
      const win = sourceWindow ?? (isLiveWindow(inputOrSourceWindow) ? inputOrSourceWindow : null);
      return serviceForInput(input, win).stopInspect(input ?? {});
    },
    captureScreenshot(inputOrSourceWindow?: BuiltInBrowserTabTargetArgs | BrowserWindow | null, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserScreenshot> {
      const input = isLiveWindow(inputOrSourceWindow) ? {} : inputOrSourceWindow ?? {};
      return serviceForInput(input, sourceWindow ?? (isLiveWindow(inputOrSourceWindow) ? inputOrSourceWindow : null)).captureScreenshot(input);
    },
    selectPoint(input: BuiltInBrowserSelectPointArgs, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserSelectResult> {
      return serviceForInput(input, sourceWindow).selectPoint(input);
    },
    selectCurrent(
      inputOrSourceWindow?: BuiltInBrowserTabTargetArgs | BrowserWindow | null,
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserSelectResult> {
      const input = isLiveWindow(inputOrSourceWindow) ? null : inputOrSourceWindow ?? null;
      const win = sourceWindow ?? (isLiveWindow(inputOrSourceWindow) ? inputOrSourceWindow : null);
      return serviceForInput(input, win).selectCurrent(input ?? {});
    },
    clearSelection(
      inputOrSourceWindow?: BuiltInBrowserTabTargetArgs | BrowserWindow | null,
      sourceWindow?: BrowserWindow | null,
    ): Promise<{ ok: true }> {
      const input = isLiveWindow(inputOrSourceWindow) ? null : inputOrSourceWindow ?? null;
      const win = sourceWindow ?? (isLiveWindow(inputOrSourceWindow) ? inputOrSourceWindow : null);
      return serviceForInput(input, win).clearSelection(input ?? {});
    },
    setEmulation(
      input: BuiltInBrowserSetEmulationArgs = {},
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserEmulationResult> {
      return serviceForInput(input, sourceWindow).setEmulation(input);
    },
    setZoom(
      input: BuiltInBrowserSetZoomArgs = {},
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserZoomResult> {
      return serviceForInput(input, sourceWindow).setZoom(input);
    },
    findInPage(
      input: BuiltInBrowserFindInPageArgs,
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserFindInPageResult> {
      return serviceForInput(input, sourceWindow).findInPage(input);
    },
    stopFindInPage(
      input: BuiltInBrowserStopFindInPageArgs = {},
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserStopFindInPageResult> {
      return serviceForInput(input, sourceWindow).stopFindInPage(input);
    },
    setDevTools(
      input: BuiltInBrowserSetDevToolsArgs,
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserDevToolsResult> {
      return serviceForInput(input, sourceWindow).setDevTools(input);
    },
    setNetworkLogging(
      input: BuiltInBrowserSetNetworkLoggingArgs,
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserNetworkLoggingResult> {
      return serviceForInput(input, sourceWindow).setNetworkLogging(input);
    },
    getNetworkLog(
      input: BuiltInBrowserNetworkLogArgs = {},
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserNetworkLogResult> {
      return serviceForInput(input, sourceWindow).getNetworkLog(input);
    },
    exportHar(
      input: BuiltInBrowserExportHarArgs = {},
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserExportHarResult> {
      return serviceForInput(input, sourceWindow).exportHar(input);
    },
    hover(
      input: BuiltInBrowserHoverArgs,
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserAgentActionResult> {
      return serviceForInput(input, sourceWindow).hover(input);
    },
    drag(
      input: BuiltInBrowserDragArgs,
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserAgentActionResult> {
      return serviceForInput(input, sourceWindow).drag(input);
    },
    selectOption(
      input: BuiltInBrowserSelectOptionArgs,
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserAgentActionResult> {
      return serviceForInput(input, sourceWindow).selectOption(input);
    },
    uploadFile(
      input: BuiltInBrowserUploadFileArgs,
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserAgentActionResult> {
      return serviceForInput(input, sourceWindow).uploadFile(input);
    },
    startRecording(
      input: BuiltInBrowserStartRecordingArgs = {},
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserStartRecordingResult> {
      return serviceForInput(input, sourceWindow).startRecording(input);
    },
    stopRecording(
      input: BuiltInBrowserStopRecordingArgs = {},
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserStopRecordingResult> {
      return serviceForInput(input, sourceWindow).stopRecording(input);
    },
    startPreviewStream(
      input: BuiltInBrowserStartPreviewStreamArgs = {},
      sourceWindow?: BrowserWindow | null,
    ): BuiltInBrowserPreviewStreamResult {
      return serviceForInput(input, sourceWindow).startPreviewStream(input);
    },
    stopPreviewStream(
      input: BuiltInBrowserStopPreviewStreamArgs = {},
      sourceWindow?: BrowserWindow | null,
    ): BuiltInBrowserPreviewStreamResult {
      return serviceForInput(input, sourceWindow).stopPreviewStream(input);
    },
    dispose(): void {
      for (const { win, listener } of windowClosedListeners.values()) {
        if (!win.isDestroyed()) {
          try {
            win.removeListener("closed", listener);
          } catch {
            // ignore stale window links
          }
        }
      }
      windowClosedListeners.clear();
      for (const entry of windowServices.values()) {
        entry.service.dispose();
      }
      windowServices.clear();
      activeServiceKeyByWindow.clear();
      for (const fallback of fallbackServices.values()) fallback.dispose();
      fallbackServices.clear();
      activeWindowId = null;
    },
  };
}

function createBuiltInBrowserWindowService(args: {
  getLogger?: () => Logger;
  onEvent?: ((payload: BuiltInBrowserEventPayload) => void) | null;
  collection: BrowserCollection;
  restoredState?: BuiltInBrowserRestoredCollection | null;
  onStateChange?: ((state: BuiltInBrowserRestoredCollection) => void) | null;
  observationRootPath: string | null;
  permissionController: ReturnType<typeof createBuiltInBrowserPermissionController>;
  agentAccessController: ReturnType<typeof createBuiltInBrowserAgentAccessController>;
  networkRouter: ReturnType<typeof createBrowserNetworkRouter>;
  waitForProfileMigration: () => Promise<void>;
  onHandoff?: BuiltInBrowserHandoffListener | null;
  /** Test seam for the hidden recording renderer. */
  createRecordingWindow?: (() => CaptureWindowLike) | null;
  /** Test seam that replaces the whole recorder (skips Electron entirely). */
  createTabRecorder?: BuiltInBrowserRecorderFactory | null;
}) {
  let win: BrowserWindow | null = null;
  let winClosedListener: (() => void) | null = null;
  /**
   * "Is anybody previewing this tab?", answered by the capability module.
   *
   * A holder rather than a direct call because `tabCapabilities` is built at the
   * bottom of this factory, long after `attachViewsToCurrentWindow` is defined;
   * until it exists the answer is simply "no", which is the pre-preview
   * behaviour.
   */
  let hasPreviewWatchers: (tabId: string) => boolean = () => false;
  let tabs: BrowserTabState[] = [];
  let browserSessions: BrowserSessionState[] = [];
  let activeTabId: string | null = null;
  let bounds: BuiltInBrowserFrame = { x: 0, y: 0, width: 0, height: 0 };
  let visible = false;
  /**
   * How much the pane shrank the emulated device to fit (1 = no shrink).
   *
   * Owned by the renderer's letterbox math and delivered with bounds, because
   * it changes on every pane resize. It only matters while a device preset is
   * active; with no emulation Chromium is already laying out at the native
   * view's own size.
   */
  let emulationViewScale = 1;
  let inspecting = false;
  let debuggerAttachedForInspect = false;
  let debuggerMessageListener: DebuggerMessageListener | null = null;
  let debuggerDetachListener: DebuggerDetachListener | null = null;
  let inspectListenerWebContents: WebContents | null = null;
  let browserDownloadListener: BrowserDownloadListener | null = null;
  let unsubscribeNetworkObserver: (() => void) | null = null;
  let lastSelectedItem: BuiltInBrowserContextItem | null = null;
  let lastSelectedTabId: string | null = null;
  let handlingInspectNode = false;
  let browserSessionConfigured = false;
  let lastEmittedStatusKey: string | null = null;
  let restoringTabs = false;
  let disposed = false;
  const configuredWebContents = new WeakSet<WebContents>();
  const renderProcessRecoveryTabs = new Set<string>();
  let configuredBrowserSession: ReturnType<typeof browserSessionForProfile> | null = null;

  const logger = (): Logger | null => {
    try {
      return args.getLogger?.() ?? null;
    } catch {
      return null;
    }
  };

  const observationRootPath = normalizedProjectRoot(args.observationRootPath);
  const observationRelativeBasePath = args.collection.projectRoot ?? observationRootPath;
  const observationDirectory = (tab: BrowserTabState): string => {
    if (!observationRootPath) {
      throw new Error("Browser observations are unavailable because no scratch root is configured.");
    }
    return path.join(
      observationRootPath,
      sanitizeObservationPathSegment(args.collection.key),
      sanitizeObservationPathSegment(tab.id),
    );
  };

  const emit = (payload: BuiltInBrowserEventPayload): void => {
    try {
      args.onEvent?.(payload);
    } catch (error) {
      logger()?.warn("built_in_browser.event_emit_failed", {
        err: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const emitStatus = (): void => {
    const status = getStatus();
    if (!restoringTabs && args.onStateChange) {
      const liveTabs = tabs.filter((tab) => !tab.webContents.isDestroyed());
      const activeIndex = Math.max(0, liveTabs.findIndex((tab) => tab.id === activeTabId));
      args.onStateChange({
        tabs: liveTabs.map((tab) => ({ url: tab.webContents.getURL() })),
        activeIndex,
      });
    }
    let key: string | null = null;
    try {
      key = JSON.stringify(status);
    } catch {
      key = null;
    }
    if (key !== null && key === lastEmittedStatusKey) return;
    lastEmittedStatusKey = key;
    emit({ type: "status", status });
  };

  const emitError = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    logger()?.warn("built_in_browser.error", { err: message });
    emit({ type: "error", message, occurredAt: new Date().toISOString() });
  };

  const currentCursorPointInView = (): BrowserInspectPoint | null => {
    if (!win || win.isDestroyed() || !visible || bounds.width <= 0 || bounds.height <= 0) return null;
    try {
      const cursor = screen.getCursorScreenPoint();
      const contentBounds = win.getContentBounds();
      const x = cursor.x - contentBounds.x - bounds.x;
      const y = cursor.y - contentBounds.y - bounds.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return null;
      return { x: Math.round(x), y: Math.round(y) };
    } catch {
      return null;
    }
  };

  const stopInspectQuietly = async (logKey: string): Promise<void> => {
    try {
      await stopInspect();
    } catch (error) {
      logger()?.debug(logKey, {
        err: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const removeTabViewFromWindow = (tab: BrowserTabState): void => {
    if (!win || win.isDestroyed()) return;
    if (!tab.view) return;
    try {
      win.contentView.removeChildView(tab.view);
    } catch {
      // ignore stale view/window links
    }
  };

  const removeTabViewsFromWindow = (): void => {
    for (const tab of tabs) {
      removeTabViewFromWindow(tab);
    }
  };

  const sessionSnapshot = (entry: BrowserSessionState): BuiltInBrowserSession => ({
    id: entry.id,
    tabId: entry.tabId,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    endedAt: entry.endedAt,
    ownerLaneId: entry.ownerLaneId,
    ownerChatSessionId: entry.ownerChatSessionId,
    lastObservationId: entry.lastObservationId,
    lastTraceEntryId: entry.lastTraceEntryId,
  });

  const activeSessionById = (sessionId: string | null | undefined): BrowserSessionState | null => {
    const normalized = stringOrNull(sessionId);
    if (!normalized) return null;
    return browserSessions.find((entry) => entry.id === normalized && !entry.endedAt) ?? null;
  };

  const sessionFromInput = (input: BuiltInBrowserTabTargetArgs = {}): BrowserSessionState | null => {
    const sessionId = stringOrNull(input.sessionId);
    if (!sessionId) return null;
    const entry = activeSessionById(sessionId);
    if (!entry) {
      const ended = browserSessions.find((sessionEntry) => sessionEntry.id === sessionId) ?? null;
      if (ended?.endedAt) throw new Error(`Browser session ended: ${sessionId}`);
      throw new Error(`Browser session not found: ${sessionId}`);
    }
    return entry;
  };

  const touchSession = (
    entry: BrowserSessionState | null,
    patch: Partial<Pick<BrowserSessionState, "lastObservationId" | "lastTraceEntryId">> = {},
  ): void => {
    if (!entry || entry.endedAt) return;
    entry.updatedAt = new Date().toISOString();
    if (patch.lastObservationId !== undefined) entry.lastObservationId = patch.lastObservationId;
    if (patch.lastTraceEntryId !== undefined) entry.lastTraceEntryId = patch.lastTraceEntryId;
  };

  const endSessionsForMissingTabs = (liveTabIds: Set<string>, endedAt = new Date().toISOString()): void => {
    for (const entry of browserSessions) {
      if (!entry.endedAt && !liveTabIds.has(entry.tabId)) {
        entry.endedAt = endedAt;
        entry.updatedAt = endedAt;
      }
    }
  };

  const endSessionsForTab = (tabId: string, endedAt = new Date().toISOString()): void => {
    for (const entry of browserSessions) {
      if (!entry.endedAt && entry.tabId === tabId) {
        entry.endedAt = endedAt;
        entry.updatedAt = endedAt;
      }
    }
  };

  const pruneBrowserSessions = (): void => {
    if (browserSessions.length <= MAX_BROWSER_SESSIONS) return;
    const active = browserSessions.filter((entry) => !entry.endedAt);
    const ended = browserSessions
      .filter((entry) => entry.endedAt)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const remainingEndedCount = Math.max(0, MAX_BROWSER_SESSIONS - active.length);
    browserSessions = [...active, ...ended.slice(-remainingEndedCount)];
  };

  const pruneDestroyedTabs = (): void => {
    const nextTabs = tabs.filter((tab) => !tab.webContents.isDestroyed());
    if (nextTabs.length !== tabs.length) {
      for (const tab of tabs) {
        if (!nextTabs.includes(tab)) teardownTabCapabilities(tab);
      }
      tabs = nextTabs;
    }
    endSessionsForMissingTabs(new Set(tabs.map((tab) => tab.id)));
    pruneBrowserSessions();
    if (lastSelectedTabId && !tabs.some((tab) => tab.id === lastSelectedTabId)) {
      clearSelectionInternal();
    }
    if (activeTabId && !tabs.some((tab) => tab.id === activeTabId)) {
      activeTabId = tabs[0]?.id ?? null;
    }
  };

  const activeTab = (): BrowserTabState | null => {
    pruneDestroyedTabs();
    const tab = tabs.find((entry) => entry.id === activeTabId) ?? tabs[0] ?? null;
    if (!tab || tab.webContents.isDestroyed()) return null;
    return tab;
  };

  const currentWebContents = (): WebContents | null => activeTab()?.webContents ?? null;

  const tabById = (tabId: string | null | undefined): BrowserTabState | null => {
    const normalized = stringOrNull(tabId);
    if (!normalized) return null;
    pruneDestroyedTabs();
    const tab = tabs.find((entry) => entry.id === normalized) ?? null;
    if (!tab || tab.webContents.isDestroyed()) return null;
    return tab;
  };

  const targetTabFromInput = (
    input: BuiltInBrowserTabTargetArgs = {},
    emptyMessage: string,
  ): BrowserTabState => {
    const sessionEntry = sessionFromInput(input);
    const tabId = stringOrNull(input.tabId);
    if (sessionEntry) {
      if (tabId && tabId !== sessionEntry.tabId) {
        throw new Error(`Browser session ${sessionEntry.id} belongs to tab ${sessionEntry.tabId}, not ${tabId}.`);
      }
      const tab = tabById(sessionEntry.tabId);
      if (!tab) {
        endSessionsForTab(sessionEntry.tabId);
        throw new Error(`Browser session ${sessionEntry.id} tab is no longer available.`);
      }
      return tab;
    }
    if (tabId) {
      const tab = tabById(tabId);
      if (!tab) throw new Error(`Browser tab not found: ${tabId}`);
      return tab;
    }
    const ownedTab = reusableOwnedTabForInput(input);
    if (ownedTab) return ownedTab;
    const tab = activeTab();
    if (!tab) throw new BuiltInBrowserNoTabError(emptyMessage);
    return tab;
  };

  const tabForWebContents = (wc: WebContents): BrowserTabState | null => {
    pruneDestroyedTabs();
    return tabs.find((entry) => entry.webContents.id === wc.id) ?? null;
  };

  const claimTabOwnerFromInput = (
    tab: BrowserTabState | null,
    input: BuiltInBrowserClaimArgs = {},
  ): boolean => {
    if (!tab || tab.webContents.isDestroyed()) return false;
    // A handed-off tab belongs to the human until they hand it back. Read paths
    // that opportunistically renew a lease (status, session listing) must not
    // quietly re-issue one here, or the pane would flip back to "agent owns
    // this tab" while the human is still typing their password into it.
    if (tab.handoff) return false;
    const laneId = stringOrNull(input.laneId);
    const chatSessionId = stringOrNull(input.chatSessionId);
    if (!laneId && !chatSessionId) return false;
    assertTabLeaseAvailable(tab, input);
    let changed = false;
    if (laneId && laneId !== tab.ownerLaneId) {
      tab.ownerLaneId = laneId;
      changed = true;
    }
    if (chatSessionId && chatSessionId !== tab.ownerChatSessionId) {
      tab.ownerChatSessionId = chatSessionId;
      changed = true;
    }
    const leaseExpiresAt = new Date(Date.now() + normalizeLeaseTtlMs(input.leaseTtlMs)).toISOString();
    if (tab.ownerLeaseExpiresAt !== leaseExpiresAt) {
      tab.ownerLeaseExpiresAt = leaseExpiresAt;
      changed = true;
    }
    if (changed) tab.ownerClaimedAt = new Date().toISOString();
    return changed;
  };

  const assertTabLeaseAvailable = (
    tab: BrowserTabState,
    input: Pick<BuiltInBrowserClaimArgs, "laneId" | "chatSessionId" | "force"> = {},
  ): void => {
    if (input.force) return;
    const laneId = stringOrNull(input.laneId);
    const chatSessionId = stringOrNull(input.chatSessionId);
    if (!laneId && !chatSessionId) return;
    if (isLeaseExpired(tab.ownerLeaseExpiresAt)) return;
    if (tab.ownerChatSessionId) {
      if (chatSessionId && tab.ownerChatSessionId !== chatSessionId) {
        throw new Error(
          `Browser tab ${tab.id} is leased by chat ${tab.ownerChatSessionId}${tab.ownerLaneId ? ` in lane ${tab.ownerLaneId}` : ""}. Pass --force to take over the tab.`,
        );
      }
      if (!chatSessionId && laneId && tab.ownerLaneId === laneId) {
        throw new Error(
          `Browser tab ${tab.id} is leased by chat ${tab.ownerChatSessionId}${tab.ownerLaneId ? ` in lane ${tab.ownerLaneId}` : ""}. Pass --force to take over the tab.`,
        );
      }
    }
    if (!laneId || !tab.ownerLaneId || tab.ownerLaneId === laneId) return;
    throw new Error(
      `Browser tab ${tab.id} is leased by lane ${tab.ownerLaneId}. Pass --force to take over the tab.`,
    );
  };

  const armAgentNavigationGuard = (
    tab: BrowserTabState,
    input: Pick<BuiltInBrowserClaimArgs, "laneId" | "chatSessionId">,
  ): void => {
    const laneId = stringOrNull(input.laneId);
    const chatSessionId = stringOrNull(input.chatSessionId);
    if (!laneId && !chatSessionId) return;
    tab.agentNavigationGuard = {
      laneId,
      chatSessionId,
    };
  };

  const reclaimTabForHumanNavigation = (
    tab: BrowserTabState,
    input: Pick<BuiltInBrowserClaimArgs, "laneId" | "chatSessionId">,
  ): void => {
    if (stringOrNull(input.laneId) || stringOrNull(input.chatSessionId)) return;
    tab.ownerLaneId = null;
    tab.ownerChatSessionId = null;
    tab.ownerClaimedAt = null;
    tab.ownerLeaseExpiresAt = null;
    tab.agentNavigationGuard = null;
  };

  /**
   * Refuse agent traffic aimed at a handed-off tab.
   *
   * Scoped to callers that identify as an agent: the same service methods back
   * the renderer's own toolbar, and the human must stay free to navigate,
   * reload and close the tab they were just handed.
   */
  const assertHandoffAllowsAgentAction = (
    tab: BrowserTabState,
    input: Pick<BuiltInBrowserClaimArgs, "laneId" | "chatSessionId"> = {},
  ): void => {
    if (!tab.handoff) return;
    if (!stringOrNull(input.laneId) && !stringOrNull(input.chatSessionId)) return;
    throw new BuiltInBrowserHandoffActiveError(tab.id, tab.handoff.reason);
  };

  const prepareAgentActionTab = async <T extends BuiltInBrowserAgentActionArgs>(
    tab: BrowserTabState,
    input: T,
  ): Promise<void> => {
    await args.waitForProfileMigration();
    assertHandoffAllowsAgentAction(tab, input);
    assertTabLeaseAvailable(tab, input);
    await args.agentAccessController.requireUrlAccess(
      tab.webContents.getURL(),
      input,
      "The agent requested an interactive browser action.",
    );
    claimTabOwnerFromInput(tab, input);
    armAgentNavigationGuard(tab, input);
  };

  const prepareAgentReadTab = (
    tab: BrowserTabState,
    input: BuiltInBrowserTabTargetArgs,
  ): void => {
    assertTabLeaseAvailable(tab, input);
    args.agentAccessController.assertUrlAccessSync(tab.webContents.getURL(), input);
    claimTabOwnerFromInput(tab, input);
  };

  const prepareAgentReadTabAsync = async (
    tab: BrowserTabState,
    input: BuiltInBrowserTabTargetArgs,
    reason: string,
  ): Promise<void> => {
    await args.waitForProfileMigration();
    assertHandoffAllowsAgentAction(tab, input);
    assertTabLeaseAvailable(tab, input);
    await args.agentAccessController.requireUrlAccess(tab.webContents.getURL(), input, reason);
    claimTabOwnerFromInput(tab, input);
  };

  /**
   * Resolve the tab a capability targets AND clear the agent-consent gate, in
   * one call.
   *
   * These two steps were written out separately at every capability, and
   * nothing enforced the pair: a new capability that resolved a tab and forgot
   * `prepareAgentReadTabAsync` compiled, reviewed clean, and silently skipped
   * consent. Binding them means a capability cannot obtain a tab without also
   * asking. Agent *actions* (which drive the page) go through
   * `runTracedAgentAction`/`prepareAgentActionTab` instead — a stricter gate.
   */
  const prepareTabCapability = async (
    input: BuiltInBrowserTabTargetArgs,
    args: { emptyMessage: string; consentReason: string },
  ): Promise<BrowserTabState> => {
    const tab = targetTabFromInput(input, args.emptyMessage);
    await prepareAgentReadTabAsync(tab, input, args.consentReason);
    return tab;
  };

  const copyTabOwner = (from: BrowserTabState | null, to: BrowserTabState): void => {
    if (!from) return;
    to.ownerLaneId = from.ownerLaneId;
    to.ownerChatSessionId = from.ownerChatSessionId;
    to.ownerClaimedAt = from.ownerClaimedAt;
    to.ownerLeaseExpiresAt = from.ownerLeaseExpiresAt;
    to.agentNavigationGuard = from.agentNavigationGuard ? { ...from.agentNavigationGuard } : null;
  };

  const tabMatchesOwnerInput = (
    tab: BrowserTabState,
    input: Pick<BuiltInBrowserClaimArgs, "laneId" | "chatSessionId"> = {},
  ): boolean => {
    const laneId = stringOrNull(input.laneId);
    const chatSessionId = stringOrNull(input.chatSessionId);
    // A handed-off tab is still the agent's tab — just held by a human for the
    // moment — so match on the lease waiting to be restored. Without this the
    // requesting agent could not even see the tab in `browser status` while it
    // waits, and `browser open` would silently start a second tab, stranding
    // the sign-in the person just completed.
    const ownerLaneId = tab.ownerLaneId ?? tab.handoff?.previousOwner.laneId ?? null;
    const ownerChatSessionId = tab.ownerChatSessionId ?? tab.handoff?.previousOwner.chatSessionId ?? null;
    if (chatSessionId) {
      return ownerChatSessionId === chatSessionId && (!laneId || !ownerLaneId || ownerLaneId === laneId);
    }
    if (laneId) return ownerLaneId === laneId && !ownerChatSessionId;
    return false;
  };

  /** No lease and no handoff waiting to be handed back: free for the taking. */
  const isUnownedTab = (tab: BrowserTabState): boolean =>
    !tab.ownerLaneId
    && !tab.ownerChatSessionId
    && !tab.handoff?.previousOwner.laneId
    && !tab.handoff?.previousOwner.chatSessionId;

  const reusableOwnedTabForInput = (input: BuiltInBrowserClaimArgs = {}): BrowserTabState | null => {
    pruneDestroyedTabs();
    // Prefer the tab the user most recently activated for this lane; otherwise
    // fall back to the newest matching tab (reverse creation order) so a lane
    // with multiple owned tabs doesn't keep driving the oldest one.
    const current = activeTab();
    if (current && tabMatchesOwnerInput(current, input)) return current;
    return [...tabs].reverse().find((entry) => tabMatchesOwnerInput(entry, input)) ?? null;
  };

  const clearSelectionInternal = (): void => {
    const hadSelection = Boolean(lastSelectedItem);
    lastSelectedItem = null;
    lastSelectedTabId = null;
    if (!hadSelection) return;
    emit({ type: "selection-cleared", item: null, clearedAt: new Date().toISOString() });
  };

  const notifyTabActivity = (tab: BrowserTabState | null): void => {
    if (!tab || tab.webContents.isDestroyed() || tab.waiters.size === 0) return;
    const waiters = [...tab.waiters];
    tab.waiters.clear();
    for (const notify of waiters) notify();
  };

  const noteNetworkActivity = (tab: BrowserTabState | null, happenedAtMs = Date.now()): void => {
    if (!tab || tab.webContents.isDestroyed()) return;
    tab.lastNetworkActivityAtMs = happenedAtMs;
    notifyTabActivity(tab);
  };

  const waitForTabActivity = async (tab: BrowserTabState, timeoutMs: number): Promise<void> => {
    if (timeoutMs <= 0 || tab.webContents.isDestroyed()) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = (): void => {
        if (timer) clearTimeout(timer);
        tab.waiters.delete(done);
        resolve();
      };
      timer = setTimeout(done, timeoutMs);
      tab.waiters.add(done);
    });
  };

  /**
   * Publishes the tab's error tally.
   *
   * Emitted on change only, and only from the two paths that can move it, so
   * the Work pane's red dot is push-driven: nothing polls `observe` to find out
   * whether a page is broken.
   */
  const publishTabDiagnostics = (tab: BrowserTabState): void => {
    emit({
      type: "diagnostics",
      tabId: tab.id,
      consoleErrorCount: tab.consoleErrorCount,
      failedRequestCount: tab.failedRequestCount,
      updatedAt: new Date().toISOString(),
    });
  };

  /**
   * Coalesced tally publish, matching App Control's identical surface.
   *
   * A page in an error loop (a `console.error` inside a render, a failing
   * retry) produced one IPC event per error, fanned out to every window, to
   * move the same red dot. 250 ms is the debounce the Work-tools state service
   * already uses for this class of signal.
   */
  const DIAGNOSTICS_COALESCE_MS = 250;
  const diagnosticsTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const emitTabDiagnostics = (tab: BrowserTabState): void => {
    if (diagnosticsTimers.has(tab.id)) return;
    const timer = setTimeout(() => {
      diagnosticsTimers.delete(tab.id);
      publishTabDiagnostics(tab);
    }, DIAGNOSTICS_COALESCE_MS);
    timer.unref?.();
    diagnosticsTimers.set(tab.id, timer);
  };

  const cancelPendingTabDiagnostics = (tabId: string): void => {
    const timer = diagnosticsTimers.get(tabId);
    if (!timer) return;
    clearTimeout(timer);
    diagnosticsTimers.delete(tabId);
  };

  /** A navigation is a fresh page, so its predecessor's errors stop counting. */
  const resetTabDiagnosticCounts = (tab: BrowserTabState): void => {
    if (tab.consoleErrorCount === 0 && tab.failedRequestCount === 0) return;
    tab.consoleErrorCount = 0;
    tab.failedRequestCount = 0;
    // A reset is a state transition, not a storm: publish it now, and cancel a
    // coalesced emit so the old tally cannot land after the zero.
    cancelPendingTabDiagnostics(tab.id);
    publishTabDiagnostics(tab);
  };

  const pushConsoleDiagnostic = (
    tab: BrowserTabState,
    diagnostic: BuiltInBrowserDiagnostics["console"][number],
  ): void => {
    tab.consoleDiagnostics = [...tab.consoleDiagnostics, diagnostic].slice(-MAX_BROWSER_CONSOLE_DIAGNOSTICS);
    if (diagnostic.level === "error") {
      tab.consoleErrorCount += 1;
      emitTabDiagnostics(tab);
    }
    notifyTabActivity(tab);
  };

  const pushNetworkDiagnostic = (
    tab: BrowserTabState,
    diagnostic: BuiltInBrowserDiagnostics["network"][number],
  ): void => {
    tab.networkDiagnostics = [...tab.networkDiagnostics, diagnostic].slice(-MAX_BROWSER_NETWORK_DIAGNOSTICS);
    // A transport failure or a 4xx/5xx both read as "this page is broken" to
    // the person glancing at the corner card; a 304 or a 200 does not.
    if (diagnostic.error != null || (diagnostic.statusCode != null && diagnostic.statusCode >= 400)) {
      tab.failedRequestCount += 1;
      emitTabDiagnostics(tab);
    }
    notifyTabActivity(tab);
  };

  const tabForWebContentsId = (webContentsId: unknown): BrowserTabState | null => {
    const id = typeof webContentsId === "number" && Number.isFinite(webContentsId) ? webContentsId : null;
    if (id == null) return null;
    pruneDestroyedTabs();
    return tabs.find((entry) => entry.webContents.id === id) ?? null;
  };

  const snapshotDiagnostics = (tab: BrowserTabState): BuiltInBrowserDiagnostics => ({
    capturedAt: new Date().toISOString(),
    pendingRequestCount: tab.pendingNetworkRequests.size,
    console: tab.consoleDiagnostics.slice(-MAX_BROWSER_CONSOLE_DIAGNOSTICS),
    network: tab.networkDiagnostics.slice(-MAX_BROWSER_NETWORK_DIAGNOSTICS),
    // The full request log is opt-in, so an observation only carries it while
    // `setNetworkLogging` is on for this tab. Keeps the default payload small.
    ...(tab.networkLoggingEnabled
      ? {
          networkLog: {
            enabled: true as const,
            recordedCount: tab.networkLog.size,
            droppedCount: tab.networkLog.droppedCount,
            recent: tab.networkLog.list().slice(-BUILT_IN_BROWSER_OBSERVATION_NETWORK_LOG_LIMIT),
          },
        }
      : {}),
  });

  const trackNetworkRequestStart = (details: Record<string, unknown>): void => {
    const tab = tabForWebContentsId(details.webContentsId);
    if (!tab) return;
    const requestId = requestIdFromWebRequestDetails(details) ?? randomUUID();
    const startedAtMs = Date.now();
    tab.pendingNetworkRequests.set(requestId, {
      id: requestId,
      url: stringOrNull(details.url) ?? "about:blank",
      method: stringOrNull(details.method),
      resourceType: stringOrNull(details.resourceType),
      startedAt: new Date().toISOString(),
      startedAtMs,
    });
    noteNetworkActivity(tab, startedAtMs);
  };

  const trackNetworkRequestEnd = (details: Record<string, unknown>, error: string | null): void => {
    const tab = tabForWebContentsId(details.webContentsId);
    if (!tab) return;
    const requestId = requestIdFromWebRequestDetails(details);
    const pending = requestId ? tab.pendingNetworkRequests.get(requestId) ?? null : null;
    if (requestId) tab.pendingNetworkRequests.delete(requestId);
    const endedAtMs = Date.now();
    const statusCode = optionalFiniteNumber(details.statusCode);
    noteNetworkActivity(tab, endedAtMs);
    if (!error && statusCode != null && statusCode < 400) return;
    pushNetworkDiagnostic(tab, {
      url: stringOrNull(details.url) ?? pending?.url ?? "about:blank",
      method: stringOrNull(details.method) ?? pending?.method ?? null,
      resourceType: stringOrNull(details.resourceType) ?? pending?.resourceType ?? null,
      statusCode,
      error,
      startedAt: pending?.startedAt ?? null,
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: pending ? Math.max(0, endedAtMs - pending.startedAtMs) : null,
    });
  };

  const beginActionTrace = (
    tab: BrowserTabState,
    action: string,
    input: Record<string, unknown>,
  ): BrowserActionTraceDraft => ({
    id: `trace-${Date.now()}-${randomUUID()}`,
    action,
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    before: tabSnapshotForTrace(tab),
    target: actionTargetForTrace(action, input),
  });

  const finishActionTrace = (
    tab: BrowserTabState,
    draft: BrowserActionTraceDraft,
    status: BuiltInBrowserActionTraceEntry["status"],
    extra: { sessionId?: string | null; observationId?: string | null; error?: unknown } = {},
  ): BuiltInBrowserActionTraceEntry => {
    const endedAtMs = Date.now();
    const entry: BuiltInBrowserActionTraceEntry = {
      id: draft.id,
      tabId: tab.id,
      sessionId: extra.sessionId ?? null,
      action: draft.action,
      status,
      startedAt: draft.startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.max(0, endedAtMs - draft.startedAtMs),
      before: draft.before,
      after: tabSnapshotForTrace(tab),
      target: draft.target,
      observationId: extra.observationId ?? null,
      error: extra.error == null ? null : errorMessage(extra.error),
    };
    tab.actionTrace = [...tab.actionTrace, entry].slice(-MAX_BROWSER_TRACE_ENTRIES);
    // Pushed as well as buffered: surfaces that caption "what the agent just
    // did" (the Work tab's corner card) would otherwise have to poll `getTrace`
    // on a timer to notice. Agent actions are human-paced, so this is a handful
    // of events per minute, not a stream.
    emit({ type: "trace", tabId: tab.id, entry });
    return entry;
  };

  const runTracedAgentAction = async (
    tab: BrowserTabState,
    action: string,
    input: BuiltInBrowserAgentActionArgs,
    fn: () => Promise<BuiltInBrowserAgentActionResult>,
  ): Promise<BuiltInBrowserAgentActionResult> => {
    const sessionEntry = sessionFromInput(input);
    const traceDraft = beginActionTrace(tab, action, input as Record<string, unknown>);
    try {
      await prepareAgentActionTab(tab, input);
      const result = await fn();
      const trace = finishActionTrace(tab, traceDraft, "ok", {
        sessionId: sessionEntry?.id ?? null,
        observationId: result.observation?.id ?? null,
      });
      touchSession(sessionEntry, { lastTraceEntryId: trace.id });
      return {
        ...result,
        trace,
        session: sessionEntry ? sessionSnapshot(sessionEntry) : result.session,
      };
    } catch (error) {
      const trace = finishActionTrace(tab, traceDraft, "error", {
        sessionId: sessionEntry?.id ?? null,
        error,
      });
      touchSession(sessionEntry, { lastTraceEntryId: trace.id });
      throw error;
    }
  };

  /**
   * Trace a capability that reads or configures a tab rather than driving the
   * page — emulation, zoom, find, DevTools, network logging, recording.
   *
   * Same shape as {@link runTracedAgentAction} minus the agent-action consent
   * gate and the result decoration, and it stamps the same `sessionId` and
   * advances the same `session.lastTraceEntryId`. Before this existed the three
   * hand-traced capabilities landed entries with `sessionId: null` that never
   * moved the session cursor, so `ade browser proof` and the Work-tab corner
   * card disagreed about where a session got to depending on which capability
   * was used.
   *
   * THE RULE for a new capability: it drives the page → `runTracedAgentAction`;
   * it reads or configures the tab → this. The only capabilities that leave no
   * entry at all are `getStatus`, `getTrace` and `getNetworkLog`, which read a
   * buffer the caller already owns and change nothing — an entry per call there
   * would only pad the trace the corner card and `ade browser proof` render.
   */
  const runTracedTabCapability = async <T>(
    tab: BrowserTabState,
    action: string,
    input: BuiltInBrowserTabTargetArgs,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const sessionEntry = sessionFromInput(input);
    const traceDraft = beginActionTrace(tab, action, input as Record<string, unknown>);
    try {
      const result = await fn();
      const trace = finishActionTrace(tab, traceDraft, "ok", { sessionId: sessionEntry?.id ?? null });
      touchSession(sessionEntry, { lastTraceEntryId: trace.id });
      return result;
    } catch (error) {
      const trace = finishActionTrace(tab, traceDraft, "error", {
        sessionId: sessionEntry?.id ?? null,
        error,
      });
      touchSession(sessionEntry, { lastTraceEntryId: trace.id });
      throw error;
    }
  };

  /**
   * Trace entry for a recording that ended without the agent asking for it.
   *
   * `stopRecording` is traced by `runTracedTabCapability`. The two automatic
   * endings — the wall-clock cap and a login hand-off — are not on that path,
   * and used to leave behind only a log line that no agent and no surface
   * reads: the REC pill just vanished, and the agent's next `stopRecording`
   * threw a generic "is not recording". `ade browser trace` is the one place
   * the skill tells an agent to look, so both endings write the same
   * `stopRecording`-shaped entry there with `endedBy` naming what did it.
   */
  const traceAutoEndedRecording = (
    tab: BrowserTabState,
    endedBy: BuiltInBrowserRecordingEndedBy,
    extra: { durationMs?: number | null; frameCount?: number | null } = {},
  ): void => {
    try {
      const draft = beginActionTrace(tab, "stopRecording", {
        endedBy,
        ...(extra.durationMs == null ? {} : { durationMs: extra.durationMs }),
        ...(extra.frameCount == null ? {} : { frameCount: extra.frameCount }),
      });
      finishActionTrace(tab, draft, "ok");
    } catch (error) {
      // Never let bookkeeping break the ending it is describing.
      logger()?.debug("built_in_browser.recording_auto_stop_trace_failed", {
        tabId: tab.id,
        err: errorMessage(error),
      });
    }
  };

  const recoverTabAfterRenderProcessGone = async (
    tab: BrowserTabState,
    details: Electron.RenderProcessGoneDetails,
  ): Promise<void> => {
    const crashedWebContents = tab.webContents;
    if (renderProcessRecoveryTabs.has(tab.id) || crashedWebContents.isDestroyed()) return;
    const crashedUrl = emptyToNull(crashedWebContents.getURL()) ?? "about:blank";
    const reason = details.reason || "unknown";
    if (reason === "clean-exit") {
      notifyTabActivity(tab);
      emitStatus();
      return;
    }
    renderProcessRecoveryTabs.add(tab.id);
    const exitCode = Number.isFinite(details.exitCode) ? `, exit code ${details.exitCode}` : "";
    const exitMessage = `ADE browser tab renderer exited (${reason}${exitCode}).`;
    try {
      tab.pendingNetworkRequests.clear();
      pushNetworkDiagnostic(tab, {
        url: crashedUrl,
        method: null,
        resourceType: "mainFrame",
        statusCode: null,
        error: exitMessage,
        startedAt: null,
        endedAt: new Date().toISOString(),
        durationMs: null,
      });
      if (tab.id === activeTabId) {
        clearSelectionInternal();
        await stopInspectQuietly("built_in_browser.render_process_gone_stop_inspect_failed");
      }
      if (tab.webContents !== crashedWebContents) {
        emitError(new Error(`${exitMessage} Recovery skipped because the tab target changed.`));
        return;
      }
      if (crashedWebContents.isDestroyed()) {
        emitError(new Error(`${exitMessage} Recovery skipped because the browser tab was destroyed.`));
        return;
      }
      await crashedWebContents.loadURL("about:blank");
      emitError(new Error(`${exitMessage} Recovered the tab to a blank page.`));
    } catch (error) {
      logger()?.warn("built_in_browser.render_process_recovery_failed", {
        tabId: tab.id,
        reason,
        err: errorMessage(error),
      });
      emitError(new Error(`ADE browser tab renderer exited and recovery failed: ${errorMessage(error)}`));
    } finally {
      renderProcessRecoveryTabs.delete(tab.id);
      notifyTabActivity(tab);
      emitStatus();
    }
  };

  const configureBrowserWebContents = (wc: WebContents): void => {
    if (configuredWebContents.has(wc)) return;
    configuredWebContents.add(wc);
    MANAGED_BROWSER_WEB_CONTENTS.add(wc);
    wc.once("destroyed", () => {
      MANAGED_BROWSER_WEB_CONTENTS.delete(wc);
    });
    configureBuiltInBrowserAuthentication({
      webContents: wc,
      resolveParentWindow: () => (win && !win.isDestroyed() ? win : null),
      getAgentIdentity: () => tabForWebContents(wc)?.agentNavigationGuard ?? null,
      recordAuthenticatedOrigin: (url, identity) => {
        args.agentAccessController.recordHumanAuthentication(url, identity);
      },
      getLogger: args.getLogger,
    });
    wc.on("console-message", (_event, level, message, line, sourceId) => {
      const tab = tabForWebContents(wc);
      if (!tab) return;
      pushConsoleDiagnostic(tab, {
        level: normalizeConsoleLevel(level),
        message: String(message ?? "").slice(0, 2_000),
        sourceId: stringOrNull(sourceId),
        line: optionalFiniteNumber(line),
        column: null,
        timestamp: new Date().toISOString(),
      });
    });
    wc.setWindowOpenHandler((details) => {
      const opener = tabForWebContents(wc) ?? activeTab();
      const popupUrl = popupUrlForOpen(details.url);
      if (!popupUrl) return { action: "deny" };
      const guard = opener?.agentNavigationGuard;
      if (
        guard
        && args.agentAccessController.isUrlAccessRequiredSync(popupUrl, guard)
      ) {
        emitError(new Error(
          `Blocked an agent-triggered popup to ${popupUrl}. Navigate to that origin explicitly so ADE can request human approval.`,
        ));
        return { action: "deny" };
      }
      return {
        action: "allow",
        createWindow: (options) => {
          const activate = details.disposition !== "background-tab";
          const popupWebContents = (
            options as Electron.BrowserWindowConstructorOptions & { webContents?: WebContents }
          ).webContents;
          const nextView = popupWebContents
            ? new WebContentsView({ webContents: popupWebContents })
            : new WebContentsView({ webPreferences: browserWebPreferences() });
          const tab = createPopupTabStateFromView(popupUrl, opener, nextView, { activate });
          if (!popupWebContents) {
            void tab.webContents.loadURL(popupUrl).catch((error) => {
              emitError(new Error(`Could not load deferred browser popup: ${errorMessage(error)}`));
            });
          }
          return tab.webContents;
        },
      };
    });
    const enforceAgentNavigation = (
      event: Electron.Event,
      url: string,
      kind: "navigation" | "redirect",
    ): void => {
      if (!isAllowedNavigationUrl(url)) {
        event.preventDefault();
        emitError(new Error(`Blocked unsupported browser navigation protocol: ${url}`));
        return;
      }
      const tab = tabForWebContents(wc);
      const guard = tab?.agentNavigationGuard;
      if (
        !guard
        || !args.agentAccessController.isUrlAccessRequiredSync(url, guard)
      ) {
        return;
      }
      event.preventDefault();
      void args.agentAccessController.authorizeUrl(
        url,
        guard,
        kind === "redirect"
          ? "An agent-triggered request is redirecting to another browser origin."
          : "An agent-triggered page action is navigating to another browser origin.",
      ).then(async (result) => {
        if (!result.granted || wc.isDestroyed()) {
          if (!result.granted) {
            emitError(new Error(
              `Blocked agent-triggered ${kind} to ${result.origin ?? url}.`,
            ));
          }
          return;
        }
        if (kind === "redirect") {
          emitError(new Error(
            `Blocked agent-triggered redirect to ${result.origin ?? url} after recording approval. Retry the original navigation to continue safely.`,
          ));
          return;
        }
        await wc.loadURL(url);
      }).catch(emitError);
    };
    wc.on("will-navigate", (event, url) => enforceAgentNavigation(event, url, "navigation"));
    wc.on("will-redirect", (event, url) => enforceAgentNavigation(event, url, "redirect"));
    wc.on("did-start-loading", () => {
      noteNetworkActivity(tabForWebContents(wc));
      emitStatus();
    });
    wc.on("did-stop-loading", () => {
      noteNetworkActivity(tabForWebContents(wc));
      emitStatus();
    });
    wc.on("did-navigate", (_event, url: string) => {
      const tab = tabForWebContents(wc);
      notifyTabActivity(tab);
      if (tab) {
        resetTabDiagnosticCounts(tab);
        // A URL means this is a real page now, not a launchpad.
        if (tab.isLaunchpad && originOrNull(url) != null) tab.isLaunchpad = false;
        // Chromium only pushes `page-favicon-updated` when the new document has
        // one, so a site without a favicon would otherwise keep wearing the
        // previous origin's icon.
        const nextOrigin = originOrNull(url);
        if (tab.faviconOrigin !== nextOrigin) {
          tab.faviconUrl = null;
          tab.faviconOrigin = nextOrigin;
        }
      }
      if (tab?.id === lastSelectedTabId) {
        clearSelectionInternal();
      }
      // Chromium tracks zoom per origin, so a cross-origin navigation drops the
      // tab's zoom. Re-apply the tab's own factor so the setting is per tab.
      if (tab && tab.zoomFactor !== BUILT_IN_BROWSER_DEFAULT_ZOOM_FACTOR) {
        tabCapabilities.applyTabZoom(tab, tab.zoomFactor);
      }
      if (tab) tabCapabilities.reapplyTabEmulation(tab);
      emitStatus();
    });
    wc.on("page-favicon-updated", (_event, favicons: string[]) => {
      const tab = tabForWebContents(wc);
      if (!tab) return;
      const next = pickBrowserFaviconUrl(favicons);
      if (!next || next === tab.faviconUrl) return;
      tab.faviconUrl = next;
      tab.faviconOrigin = wc.isDestroyed() ? null : originOrNull(wc.getURL());
      emitStatus();
    });
    wc.on("found-in-page", (_event, result) => {
      const tab = tabForWebContents(wc);
      if (!tab) return;
      emit({
        type: "found-in-page",
        tabId: tab.id,
        requestId: result.requestId,
        activeMatchOrdinal: result.activeMatchOrdinal ?? null,
        matches: result.matches ?? null,
        finalUpdate: Boolean(result.finalUpdate),
        foundAt: new Date().toISOString(),
      });
    });
    wc.on("devtools-opened", () => {
      const tab = tabForWebContents(wc);
      if (!tab) return;
      if (!tab.devToolsMode) tab.devToolsMode = "right";
      emitStatus();
    });
    wc.on("devtools-closed", () => {
      const tab = tabForWebContents(wc);
      if (!tab) return;
      tab.devToolsMode = null;
      emitStatus();
    });
    wc.on("did-navigate-in-page", () => {
      const tab = tabForWebContents(wc);
      notifyTabActivity(tab);
      if (tab?.id === lastSelectedTabId) {
        clearSelectionInternal();
      }
      emitStatus();
    });
    wc.on("page-title-updated", () => {
      notifyTabActivity(tabForWebContents(wc));
      emitStatus();
    });
    wc.on("render-process-gone", (_event, details) => {
      const tab = tabForWebContents(wc);
      logger()?.warn("built_in_browser.render_process_gone", {
        reason: details.reason,
        exitCode: details.exitCode,
        tabId: tab?.id ?? null,
        url: tab && !wc.isDestroyed() ? urlForBrowserLog(wc.getURL()) : null,
      });
      if (!tab) {
        emitStatus();
        return;
      }
      void recoverTabAfterRenderProcessGone(tab, details).catch((error) => {
        emitError(new Error(`ADE browser tab renderer recovery failed: ${errorMessage(error)}`));
        emitStatus();
      });
    });
    wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      const tab = tabForWebContents(wc);
      if (tab) {
        noteNetworkActivity(tab);
        pushNetworkDiagnostic(tab, {
          url: stringOrNull(validatedURL) ?? emptyToNull(wc.getURL()) ?? "about:blank",
          method: null,
          resourceType: "mainFrame",
          statusCode: null,
          error: errorDescription || `Browser load failed with code ${errorCode}`,
          startedAt: null,
          endedAt: new Date().toISOString(),
          durationMs: null,
        });
      }
      logger()?.warn("built_in_browser.did_fail_load", {
        errorCode,
        errorDescription,
        validatedURL,
      });
      emitError(new Error(errorDescription || `Browser load failed with code ${errorCode}`));
      emitStatus();
    });
  };

  const browserWebPreferences = (): Electron.WebPreferences => ({
    partition: BROWSER_PARTITION,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    backgroundThrottling: false,
  });

  const createTabStateForView = (nextView: WebContentsView): BrowserTabState => {
    // Match a normal browser canvas. Many sites leave their root background
    // transparent, so a dark ADE-specific backing color makes light pages
    // unreadable even though the site's own text remains dark.
    nextView.setBackgroundColor("#ffffff");
    nextView.setBounds(toElectronRect(bounds));
    nextView.setVisible(false);

    const wc = nextView.webContents;
    configureBrowserWebContents(wc);
    return {
      id: `tab-${randomUUID()}`,
      view: nextView,
      webContents: wc,
      ownsWebContents: true,
      consoleDiagnostics: [],
      networkDiagnostics: [],
      pendingNetworkRequests: new Map(),
      lastNetworkActivityAtMs: Date.now(),
      waiters: new Set(),
      actionTrace: [],
      ownerLaneId: null,
      ownerChatSessionId: null,
      ownerClaimedAt: null,
      ownerLeaseExpiresAt: null,
      agentNavigationGuard: null,
      handoff: null,
      zoomFactor: BUILT_IN_BROWSER_DEFAULT_ZOOM_FACTOR,
      emulation: null,
      isLaunchpad: false,
      faviconUrl: null,
      faviconOrigin: null,
      devToolsMode: null,
      networkLoggingEnabled: false,
      networkLog: createBuiltInBrowserNetworkLog(),
      networkLogPending: new Map(),
      recording: null,
      consoleErrorCount: 0,
      failedRequestCount: 0,
      debuggerHolds: new Set(),
      cdpListener: null,
      findRequestId: null,
      findWaiters: new Set(),
    };
  };

  const createTabState = (): BrowserTabState => {
    configureBrowserSession();
    return createTabStateForView(new WebContentsView({
      webPreferences: browserWebPreferences(),
    }));
  };

  const popupUrlForOpen = (url: string): string | null => {
    const popupUrl = stringOrNull(url) ?? "about:blank";
    if (!isAllowedNavigationUrl(popupUrl)) {
      emitError(new Error(`Blocked unsupported browser popup protocol: ${url}`));
      return null;
    }
    if (tabs.length >= MAX_BROWSER_TABS) {
      emitError(new Error(`ADE browser is limited to ${MAX_BROWSER_TABS} tabs. Close a tab before opening another.`));
      return null;
    }
    return popupUrl;
  };

  const createPopupTabStateFromView = (
    popupUrl: string,
    opener: BrowserTabState | null,
    nextView: WebContentsView,
    options: { activate: boolean },
  ): BrowserTabState => {
    configureBrowserSession();
    const tab = createTabStateForView(nextView);
    copyTabOwner(opener, tab);
    tabs = [...tabs, tab];
    const shouldActivate = options.activate || !activeTab();
    if (shouldActivate) {
      if (inspecting) {
        inspecting = false;
        void teardownInspectWebContents(inspectListenerWebContents).catch((error) => {
          logger()?.debug("built_in_browser.popup_stop_inspect_failed", {
            err: error instanceof Error ? error.message : String(error),
          });
        });
      }
      activeTabId = tab.id;
      clearSelectionInternal();
    }
    attachViewsToCurrentWindow();
    if (shouldActivate) {
      requestOpenPanel({ url: popupUrl, tabId: tab.id });
    }
    emitStatus();
    return tab;
  };

  const ensureActiveTab = (): BrowserTabState => {
    const existing = activeTab();
    if (existing) return existing;
    const tab = createTabState();
    tabs = [...tabs, tab];
    activeTabId = tab.id;
    attachViewsToCurrentWindow();
    emitStatus();
    return tab;
  };

  /**
   * Where a tab nobody is looking at but somebody is *previewing* gets put.
   *
   * A `WebContentsView` that has been removed from the window — or merely
   * `setVisible(false)` — has no compositor surface, and with no surface every
   * capture path fails: `capturePage()` resolves an empty image and CDP
   * `Page.captureScreenshot` never answers at all. That is fatal for the Work
   * tab's corner card, whose whole job is to picture a browser the panel is NOT
   * showing.
   *
   * Parking it one window-width to the right keeps the view attached and
   * visible — so Chromium keeps compositing it — while the window's own content
   * rect clips it away completely. Only tabs with a live preview subscriber pay
   * for this; everything else is still detached outright.
   */
  const parkedPreviewRect = (panelRect: Electron.Rectangle): Electron.Rectangle => {
    const contentWidth = win && !win.isDestroyed() ? win.getContentBounds().width : 0;
    return {
      x: Math.max(0, contentWidth) + BUILT_IN_BROWSER_PARKED_PREVIEW_MARGIN,
      y: 0,
      // A panel that was never opened has zero bounds, and a zero-sized view
      // captures nothing; the floor is what makes the first preview paint.
      width: Math.max(panelRect.width, BUILT_IN_BROWSER_PARKED_PREVIEW_MIN_WIDTH),
      height: Math.max(panelRect.height, BUILT_IN_BROWSER_PARKED_PREVIEW_MIN_HEIGHT),
    };
  };

  const attachViewsToCurrentWindow = (): void => {
    if (!win || win.isDestroyed()) return;
    const electronRect = toElectronRect(bounds);
    for (const tab of tabs) {
      if (tab.webContents.isDestroyed()) continue;
      if (!tab.view) {
        applyTabLifecycle(tab, visible && tab.id === activeTabId);
        continue;
      }
      const isActive = tab.id === activeTabId;
      const shouldAttach = visible && isActive;
      if (!shouldAttach) {
        if (hasPreviewWatchers(tab.id)) {
          if (!win.contentView.children.includes(tab.view)) {
            win.contentView.addChildView(tab.view);
          }
          tab.view.setBounds(parkedPreviewRect(electronRect));
          tab.view.setVisible(true);
          // Still not the active tab: parked means composited, not attended, so
          // it stays muted like any other background tab.
          applyTabLifecycle(tab, false);
          continue;
        }
        tab.view.setVisible(false);
        removeTabViewFromWindow(tab);
        applyTabLifecycle(tab, false);
        continue;
      }
      if (!win.contentView.children.includes(tab.view)) {
        win.contentView.addChildView(tab.view);
      }
      tab.view.setBounds(electronRect);
      tab.view.setVisible(true);
      applyTabLifecycle(tab, true);
    }
  };

  const applyTabLifecycle = (tab: BrowserTabState, active: boolean): void => {
    const wc = tab.webContents;
    if (wc.isDestroyed()) return;
    try {
      wc.setAudioMuted(!active);
    } catch {
      // ignore optional platform support differences
    }
  };

  const browserSessionForProfile = () => session.fromPartition(BROWSER_PARTITION);

  const removeBrowserDownloadListener = (): void => {
    if (!browserDownloadListener) return;
    const browserSession = configuredBrowserSession as (ReturnType<typeof browserSessionForProfile> & {
      off?: (event: "will-download", listener: BrowserDownloadListener) => void;
      removeListener?: (event: "will-download", listener: BrowserDownloadListener) => void;
    }) | null;
    try {
      if (typeof browserSession?.off === "function") {
        browserSession.off("will-download", browserDownloadListener);
      } else {
        browserSession?.removeListener?.("will-download", browserDownloadListener);
      }
    } catch {
      // ignore session teardown races
    }
    browserDownloadListener = null;
  };

  const configureBrowserSession = (): void => {
    if (browserSessionConfigured) return;
    const browserSession = browserSessionForProfile();
    configuredBrowserSession = browserSession;
    configureBuiltInBrowserSessionWebAuthn(browserSession, logger);
    args.permissionController.configureSession(browserSession);
    unsubscribeNetworkObserver = args.networkRouter.subscribe({
      onRequestStarted: trackNetworkRequestStart,
      onRequestFinished: trackNetworkRequestEnd,
    });
    args.networkRouter.configureSession(browserSession);
    browserDownloadListener = (event, item, downloadWebContents) => {
      const tab = tabForWebContents(downloadWebContents);
      if (!tab) {
        if (downloadWebContents && MANAGED_BROWSER_WEB_CONTENTS.has(downloadWebContents)) return;
        event.preventDefault();
        emitError(new Error("Blocked ADE browser download from unmanaged webContents."));
        return;
      }
      const startedAt = new Date().toISOString();
      const downloadUrl = stringOrNull(item.getURL());
      const fileName = sanitizeDownloadFilename(item.getFilename());
      let savePath: string | null = null;
      try {
        savePath = builtInBrowserDownloadPath(fileName, RESERVED_BROWSER_DOWNLOAD_PATH_KEYS);
        item.setSavePath(savePath);
        RESERVED_BROWSER_DOWNLOAD_PATH_KEYS.add(downloadPathReservationKey(savePath));
      } catch (error) {
        event.preventDefault();
        emitError(new Error(`Could not start ADE browser download: ${errorMessage(error)}`));
        return;
      }
      logger()?.info("built_in_browser.download_started", {
        urlOrigin: downloadUrlOrigin(downloadUrl),
        fileName,
        tabId: tab?.id ?? null,
      });

      item.once("done", (_doneEvent, state) => {
        if (savePath) RESERVED_BROWSER_DOWNLOAD_PATH_KEYS.delete(downloadPathReservationKey(savePath));
        const endedAt = new Date().toISOString();
        const error = state === "completed" ? null : `Download ${state}`;
        if (tab) {
          pushNetworkDiagnostic(tab, {
            url: downloadUrlForDiagnostics(downloadUrl) ?? "about:blank",
            method: "GET",
            resourceType: "download",
            statusCode: null,
            error,
            startedAt,
            endedAt,
            durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
          });
          noteNetworkActivity(tab);
        }
        logger()?.info(state === "completed" ? "built_in_browser.download_completed" : "built_in_browser.download_finished_non_success", {
          urlOrigin: downloadUrlOrigin(downloadUrl),
          fileName,
          state,
          tabId: tab?.id ?? null,
        });
        if (error) emitError(new Error(error));
        emitStatus();
      });
    };
    browserSession.on("will-download", browserDownloadListener);
    browserSessionConfigured = true;
  };

  const attachToWindow = (nextWin: BrowserWindow): void => {
    if (win === nextWin) {
      attachViewsToCurrentWindow();
      emitStatus();
      return;
    }
    if (win && winClosedListener) {
      win.removeListener("closed", winClosedListener);
      winClosedListener = null;
    }
    removeTabViewsFromWindow();

    win = nextWin;
    winClosedListener = () => {
      win = null;
      winClosedListener = null;
      emitStatus();
    };
    win.once("closed", winClosedListener);
    attachViewsToCurrentWindow();
    emitStatus();
  };

  const detachFromWindow = (shouldEmitStatus = true): void => {
    if (win && winClosedListener) {
      win.removeListener("closed", winClosedListener);
      winClosedListener = null;
    }
    removeTabViewsFromWindow();
    win = null;
    visible = false;
    if (shouldEmitStatus) emitStatus();
  };

  function getStatus(): BuiltInBrowserStatus {
    pruneDestroyedTabs();
    const currentTab = activeTab();
    const wc = currentTab?.webContents ?? null;
    const tabSnapshots = tabs
      .filter((tab) => !tab.webContents.isDestroyed())
      .map(tabStatus);
    return {
      attached: Boolean(
        win
        && !win.isDestroyed()
        && currentTab
        && (!currentTab.view || win.contentView.children.includes(currentTab.view))
      ),
      partition: BROWSER_PARTITION,
      storageProfileKey: "global",
      collectionKey: args.collection.key,
      collectionProjectRoot: args.collection.projectRoot,
      persistentProfile: true,
      visible,
      bounds,
      activeTabId: currentTab?.id ?? null,
      tabs: tabSnapshots,
      url: wc ? emptyToNull(wc.getURL()) : null,
      title: wc ? emptyToNull(wc.getTitle()) : null,
      isLoading: wc?.isLoading() ?? false,
      canGoBack: wc?.canGoBack() ?? false,
      canGoForward: wc?.canGoForward() ?? false,
      isInspecting: inspecting,
      hasSelection: lastSelectedItem !== null,
      ownerLaneId: currentTab?.ownerLaneId ?? null,
      ownerChatSessionId: currentTab?.ownerChatSessionId ?? null,
      ownerClaimedAt: currentTab?.ownerClaimedAt ?? null,
      ownerLeaseExpiresAt: currentTab?.ownerLeaseExpiresAt ?? null,
    };
  }

  function scopeStatusForInput(status: BuiltInBrowserStatus, input: unknown): BuiltInBrowserStatus {
    const record = isRecord(input) ? input : {};
    const identity = {
      laneId: stringOrNull(record.laneId),
      chatSessionId: stringOrNull(record.chatSessionId),
    };
    if (!identity.laneId && !identity.chatSessionId) return status;
    const liveTabs = tabs.filter((tab) => !tab.webContents.isDestroyed());
    const visibleTabIds = new Set(
      liveTabs.filter((tab) => tabMatchesOwnerInput(tab, identity)).map((tab) => tab.id),
    );
    // A tab nobody owns is not a secret — hiding it left `ade browser status`
    // reporting 0 tabs against a pane the human can see full, with no tab id to
    // claim and no `--all`, so `browser open` silently started another tab.
    // Tabs owned by a *different* chat stay hidden.
    const claimableTabIds = new Set(
      liveTabs
        .filter((tab) => !visibleTabIds.has(tab.id) && isUnownedTab(tab))
        .map((tab) => tab.id),
    );
    const scopedTabs = status.tabs
      .filter((tab) => visibleTabIds.has(tab.id) || claimableTabIds.has(tab.id))
      .map((tab) => (claimableTabIds.has(tab.id) ? { ...tab, claimable: true as const } : tab));
    if (status.activeTabId && visibleTabIds.has(status.activeTabId)) {
      return { ...status, tabs: scopedTabs };
    }
    return {
      ...status,
      attached: false,
      activeTabId: null,
      tabs: scopedTabs,
      url: null,
      title: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      isInspecting: false,
      hasSelection: false,
      ownerLaneId: null,
      ownerChatSessionId: null,
      ownerClaimedAt: null,
      ownerLeaseExpiresAt: null,
    };
  }

  function getStatusForInput(input: BuiltInBrowserTabTargetArgs = {}): BuiltInBrowserStatus {
    if (tabs.length > 0 && (input.tabId || input.sessionId)) {
      const tab = targetTabFromInput(input, "No active browser tab.");
      prepareAgentReadTab(tab, input);
    }
    return scopeStatusForInput(getStatus(), input);
  }

  async function requestOriginAccess(
    input: BuiltInBrowserRequestOriginAccessArgs = {},
  ): Promise<BuiltInBrowserOriginAccessResult> {
    await args.waitForProfileMigration();
    await tabRestorationPromise;
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before requesting origin access.");
    assertHandoffAllowsAgentAction(tab, input);
    assertTabLeaseAvailable(tab, input);
    const result = await args.agentAccessController.authorizeUrl(
      tab.webContents.getURL(),
      input,
      "The agent requested access to inspect or control this browser tab.",
    );
    if (!result.granted) {
      throw new Error(`Human approval was denied for ADE agent access to ${result.origin ?? "this browser origin"}.`);
    }
    reclaimTabForHumanNavigation(tab, input);
    claimTabOwnerFromInput(tab, input);
    emitStatus();
    return { ...result, status: scopeStatusForInput(getStatus(), input) };
  }

  function claim(input: BuiltInBrowserClaimArgs = {}): BuiltInBrowserStatus {
    const tabId = stringOrNull(input.tabId);
    const tab = tabId ? tabById(tabId) : activeTab();
    if (tabId && !tab) throw new Error(`Browser tab not found: ${tabId}`);
    if (tab) assertHandoffAllowsAgentAction(tab, input);
    if (tab) prepareAgentReadTab(tab, input);
    emitStatus();
    return scopeStatusForInput(getStatus(), input);
  }

  /* ── Login handoff ─────────────────────────────────────────────────────── */

  const notifyHandoffListener = (event: BuiltInBrowserHandoffLifecycleEvent): void => {
    try {
      args.onHandoff?.(event);
    } catch (error) {
      // The hand-raise is a courtesy on top of the ownership flip. If the chat
      // side throws, the browser must still be in the human's hands.
      logger()?.warn("built_in_browser.handoff_listener_failed", {
        kind: event.kind,
        tabId: event.tabId,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /**
   * Close an open handoff and put the tab back in the agent's hands.
   *
   * Every exit path funnels through here — the human's `Hand back`, the auto
   * hand-back offer, the timeout timer, and tab close — so the lease restore,
   * the trace entry, the event, and the waiter wake-up cannot drift apart.
   */
  const endHandoffInternal = (
    tab: BrowserTabState,
    endedBy: BuiltInBrowserHandoffEndedBy,
  ): { handoff: BuiltInBrowserTabHandoff; durationMs: number } | null => {
    const handoff = tab.handoff;
    if (!handoff) return null;
    if (handoff.timer) clearTimeout(handoff.timer);
    const snapshot = handoffSnapshot(handoff)!;
    const durationMs = Math.max(0, Date.now() - handoff.startedAtMs);
    tab.handoff = null;
    // Re-issue the suspended lease to the same owner with a fresh TTL. Restoring
    // the ORIGINAL expiry would hand back a tab whose lease had already lapsed
    // during the sign-in the agent itself asked for.
    if (handoff.previousOwner.laneId || handoff.previousOwner.chatSessionId) {
      tab.ownerLaneId = handoff.previousOwner.laneId;
      tab.ownerChatSessionId = handoff.previousOwner.chatSessionId;
      tab.ownerClaimedAt = new Date().toISOString();
      tab.ownerLeaseExpiresAt = new Date(Date.now() + normalizeLeaseTtlMs(null)).toISOString();
    }
    const traceDraft = beginActionTrace(tab, "handoff-end", {
      reason: handoff.reason,
      endedBy,
      durationMs,
    });
    finishActionTrace(tab, traceDraft, "ok");
    const endedAt = new Date().toISOString();
    emit({ type: "handoff-ended", tabId: tab.id, handoff: snapshot, endedBy, durationMs, endedAt });
    const waiters = [...handoff.waiters];
    handoff.waiters.clear();
    for (const notify of waiters) notify({ endedBy, durationMs });
    notifyHandoffListener({ kind: "ended", tabId: tab.id, handoff: snapshot, endedBy, durationMs });
    logger()?.info("built_in_browser.handoff_ended", {
      tabId: tab.id,
      endedBy,
      durationMs,
    });
    return { handoff: snapshot, durationMs };
  };

  /** Tab teardown path: a closed or crashed tab can never be handed back. */
  const endHandoffForClosedTab = (tab: BrowserTabState): void => {
    if (!tab.handoff) return;
    endHandoffInternal(tab, "tab-closed");
    emitStatus();
  };

  /**
   * Stop the agent's capture surfaces for the duration of a login handoff.
   *
   * A handoff exists precisely because the human is about to type a password,
   * a TOTP code, or walk an OAuth redirect. `assertHandoffAllowsAgentAction`
   * only refuses *new* agent calls; a recording and a network log armed before
   * the handoff keep running through the sign-in and are readable again the
   * moment the tab comes back. So both sinks are closed here, and the buffered
   * log is dropped — an IdP callback carries the authorization code in its URL.
   *
   * Nothing re-arms on hand-back: an agent that wants to record again has to
   * ask again, which is the only version of this the human can reason about.
   */
  const suspendAgentCaptureForHandoff = (tab: BrowserTabState): void => {
    // Flip the flags first and synchronously: `startHandoff` must not return
    // while a CDP network frame or a video chunk can still land in a buffer.
    const recording = tab.recording;
    const wasLoggingNetwork = tab.networkLoggingEnabled;
    tab.recording = null;
    tab.networkLoggingEnabled = false;
    if (recording) {
      // `abort` leaves the partial file in the tab's scratch directory rather
      // than promoting it to a result: it is not proof of anything the agent did.
      try {
        recording.abort();
      } catch (error) {
        logger()?.debug("built_in_browser.handoff_recording_abort_failed", { err: errorMessage(error) });
      }
      emit({
        type: "recording",
        tabId: tab.id,
        recording: null,
        frameCount: 0,
        endedBy: "handoff",
        tabTitle: builtInBrowserTabTitle(tab),
        updatedAt: new Date().toISOString(),
      });
      traceAutoEndedRecording(tab, "handoff");
    }
    if (wasLoggingNetwork) {
      tab.networkLog.clear();
      tab.networkLogPending.clear();
      releaseDebuggerHold(tab, "network");
      const wc = tab.webContents;
      if (!wc.isDestroyed()) {
        void sendDebuggerCommand(wc, "Network.disable").catch((error) => {
          logger()?.debug("built_in_browser.handoff_network_disable_failed", { err: errorMessage(error) });
        });
      }
    }
    if (recording || wasLoggingNetwork) {
      logger()?.info("built_in_browser.handoff_capture_suspended", {
        tabId: tab.id,
        recording: Boolean(recording),
        networkLogging: wasLoggingNetwork,
      });
    }
  };

  function startHandoff(input: BuiltInBrowserStartHandoffArgs): BuiltInBrowserHandoffResult {
    const reason = stringOrNull(input.reason);
    if (!reason) {
      throw new Error("A login handoff needs a --reason so the human knows what to sign in to.");
    }
    const tab = targetTabFromInput(input, "No active browser tab. Open the page that needs a sign-in first.");
    if (tab.handoff) {
      // Idempotent for the requester (a retried CLI call), refused for anyone
      // else so two agents cannot queue behind one human.
      const requester = stringOrNull(input.chatSessionId);
      if (requester && requester === tab.handoff.requestedByChatSessionId) {
        return {
          tabId: tab.id,
          handoff: handoffSnapshot(tab.handoff),
          status: scopeStatusForInput(getStatus(), input),
        };
      }
      throw new BuiltInBrowserHandoffActiveError(tab.id, tab.handoff.reason);
    }
    assertTabLeaseAvailable(tab, input);
    const timeoutMs = normalizeHandoffTimeoutMs(input.timeoutMs);
    const startedAtMs = Date.now();
    const currentUrl = tab.webContents.isDestroyed() ? null : emptyToNull(tab.webContents.getURL());
    const handoff: BrowserTabHandoffState = {
      reason,
      startedAt: new Date(startedAtMs).toISOString(),
      expiresAt: new Date(startedAtMs + timeoutMs).toISOString(),
      requestedByChatSessionId: stringOrNull(input.chatSessionId),
      requestedByLaneId: stringOrNull(input.laneId),
      startedAtOrigin: handoffOrigin(currentUrl),
      previousOwner: {
        laneId: tab.ownerLaneId ?? stringOrNull(input.laneId),
        chatSessionId: tab.ownerChatSessionId ?? stringOrNull(input.chatSessionId),
      },
      startedAtMs,
      timer: null,
      waiters: new Set(),
    };
    tab.handoff = handoff;
    // Suspend the lease rather than leave it in place: the pane's owner text has
    // to read "you own this tab", and a lapsed-lease sweep must not hand the tab
    // to a different agent while the human is mid-login.
    tab.ownerLaneId = null;
    tab.ownerChatSessionId = null;
    tab.ownerClaimedAt = null;
    tab.ownerLeaseExpiresAt = null;
    // The navigation guard exists to keep an agent on the origin it was granted.
    // The human is about to be redirected through an identity provider, so it
    // would block exactly the sign-in the agent asked for.
    tab.agentNavigationGuard = null;
    suspendAgentCaptureForHandoff(tab);
    handoff.timer = setTimeout(() => {
      if (tab.handoff !== handoff) return;
      endHandoffInternal(tab, "timeout");
      emitStatus();
    }, timeoutMs);
    handoff.timer.unref?.();

    const traceDraft = beginActionTrace(tab, "handoff-start", { reason, timeoutMs });
    finishActionTrace(tab, traceDraft, "ok", { sessionId: sessionFromInput(input)?.id ?? null });
    const snapshot = handoffSnapshot(handoff)!;
    emit({ type: "handoff-started", tabId: tab.id, handoff: snapshot, startedAt: handoff.startedAt });
    // Reveal the pane through the same open-request the renderer already honours
    // only when the window is on the Work tab — a handoff must not yank a user
    // out of the tab they are actually looking at.
    requestOpenPanel({ tabId: tab.id });
    emitStatus();
    notifyHandoffListener({ kind: "started", tabId: tab.id, handoff: snapshot });
    logger()?.info("built_in_browser.handoff_started", {
      tabId: tab.id,
      chatSessionId: snapshot.requestedByChatSessionId,
      laneId: snapshot.requestedByLaneId,
      timeoutMs,
    });
    return { tabId: tab.id, handoff: snapshot, status: scopeStatusForInput(getStatus(), input) };
  }

  function endHandoff(input: BuiltInBrowserEndHandoffArgs = {}): BuiltInBrowserHandoffResult {
    const tab = targetTabFromInput(input, "No active browser tab to hand back.");
    const endedBy: BuiltInBrowserHandoffEndedBy = input.endedBy === "auto-offer" ? "auto-offer" : "human";
    const result = endHandoffInternal(tab, endedBy);
    if (result) emitStatus();
    return {
      tabId: tab.id,
      handoff: result?.handoff ?? null,
      status: scopeStatusForInput(getStatus(), input),
    };
  }

  /**
   * Block until the tab's handoff ends. This is what makes `ade browser handoff`
   * naturally pause the agent's next step instead of leaving it to poll status.
   */
  async function waitForHandoff(
    input: BuiltInBrowserWaitForHandoffArgs = {},
  ): Promise<BuiltInBrowserHandoffWaitResult> {
    const tab = targetTabFromInput(input, "No active browser tab to wait on.");
    const handoff = tab.handoff;
    if (!handoff) {
      return { tabId: tab.id, ended: true, endedBy: null, durationMs: null, handoff: null };
    }
    const snapshot = handoffSnapshot(handoff)!;
    const remainingMs = Math.max(1_000, Date.parse(handoff.expiresAt) - Date.now());
    const waitMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
      ? Math.max(1_000, Math.floor(input.timeoutMs))
      : remainingMs + 5_000;
    const outcome = await new Promise<{ endedBy: BuiltInBrowserHandoffEndedBy; durationMs: number } | null>(
      (resolve) => {
        const notify = (result: { endedBy: BuiltInBrowserHandoffEndedBy; durationMs: number }): void => {
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          handoff.waiters.delete(notify);
          resolve(null);
        }, waitMs);
        timer.unref?.();
        handoff.waiters.add(notify);
      },
    );
    return {
      tabId: tab.id,
      ended: Boolean(outcome),
      endedBy: outcome?.endedBy ?? null,
      durationMs: outcome?.durationMs ?? null,
      handoff: outcome ? null : snapshot,
    };
  }

  function startSession(input: BuiltInBrowserStartSessionArgs = {}): BuiltInBrowserSessionResult {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before starting a browser session.");
    prepareAgentReadTab(tab, input);
    const now = new Date().toISOString();
    const sessionEntry: BrowserSessionState = {
      id: `bs-${Date.now()}-${randomUUID()}`,
      tabId: tab.id,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
      ownerLaneId: stringOrNull(input.laneId) ?? tab.ownerLaneId,
      ownerChatSessionId: stringOrNull(input.chatSessionId) ?? tab.ownerChatSessionId,
      lastObservationId: null,
      lastTraceEntryId: null,
    };
    browserSessions = [...browserSessions, sessionEntry];
    pruneBrowserSessions();
    emitStatus();
    return { session: sessionSnapshot(sessionEntry), status: scopeStatusForInput(getStatus(), input) };
  }

  function listSessions(input: BuiltInBrowserListSessionsArgs = {}): BuiltInBrowserSessionsResult {
    pruneDestroyedTabs();
    const tabId = stringOrNull(input.tabId);
    const laneId = stringOrNull(input.laneId);
    const chatSessionId = stringOrNull(input.chatSessionId);
    if (tabId) {
      const tab = tabById(tabId);
      if (!tab) throw new Error(`Browser tab not found: ${tabId}`);
      prepareAgentReadTab(tab, input);
    }
    const sessions = browserSessions
      .filter((entry) => (input.includeEnded ? true : !entry.endedAt))
      .filter((entry) => (tabId ? entry.tabId === tabId : true))
      .filter((entry) => (chatSessionId ? entry.ownerChatSessionId === chatSessionId : true))
      .filter((entry) => (laneId ? entry.ownerLaneId === laneId : true))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(sessionSnapshot);
    return { sessions };
  }

  function endSession(input: BuiltInBrowserEndSessionArgs): BuiltInBrowserSessionResult {
    const sessionId = stringOrNull(input.sessionId);
    if (!sessionId) throw new Error("Browser session id is required.");
    const entry = browserSessions.find((sessionEntry) => sessionEntry.id === sessionId) ?? null;
    if (!entry) throw new Error(`Browser session not found: ${sessionId}`);
    const tab = tabById(entry.tabId);
    if (tab) prepareAgentReadTab(tab, input);
    if (!input.force) {
      const laneId = stringOrNull(input.laneId);
      const chatSessionId = stringOrNull(input.chatSessionId);
      if (chatSessionId && entry.ownerChatSessionId && chatSessionId !== entry.ownerChatSessionId) {
        throw new Error(`Browser session ${sessionId} is owned by chat ${entry.ownerChatSessionId}.`);
      }
      if (laneId && entry.ownerLaneId && laneId !== entry.ownerLaneId) {
        throw new Error(`Browser session ${sessionId} is owned by lane ${entry.ownerLaneId}.`);
      }
    }
    if (!entry.endedAt) {
      const now = new Date().toISOString();
      entry.endedAt = now;
      entry.updatedAt = now;
    }
    pruneBrowserSessions();
    emitStatus();
    return { session: sessionSnapshot(entry), status: scopeStatusForInput(getStatus(), input) };
  }

  const requestOpenPanel = (input: BuiltInBrowserOpenPanelArgs = {}): BuiltInBrowserStatus => {
    const status = getStatus();
    const requestedTab = tabById(input.tabId) ?? activeTab();
    const tabId = stringOrNull(input.tabId) ?? requestedTab?.id ?? status.activeTabId;
    const url = stringOrNull(input.url) ?? (requestedTab && !requestedTab.webContents.isDestroyed() ? emptyToNull(requestedTab.webContents.getURL()) : null) ?? status.url;
    emit({
      type: "open-request",
      status,
      tabId,
      url,
      requestedAt: new Date().toISOString(),
    });
    return scopeStatusForInput(status, input);
  };

  async function showPanel(input: BuiltInBrowserOpenPanelArgs = {}): Promise<BuiltInBrowserStatus> {
    const tabId = stringOrNull(input.tabId);
    const url = stringOrNull(input.url);
    if (url) {
      return navigate({
        projectRoot: input.projectRoot,
        url,
        tabId,
        openPanel: true,
        laneId: input.laneId,
        chatSessionId: input.chatSessionId,
        force: input.force,
        leaseTtlMs: input.leaseTtlMs,
      });
    }
    if (tabId) {
      return switchTab({
        projectRoot: input.projectRoot,
        tabId,
        openPanel: true,
        laneId: input.laneId,
        chatSessionId: input.chatSessionId,
        force: input.force,
        leaseTtlMs: input.leaseTtlMs,
      });
    }
    return requestOpenPanel(input);
  }

  async function setBounds(nextBounds: BuiltInBrowserBoundsArgs): Promise<BuiltInBrowserStatus> {
    await tabRestorationPromise;
    if (disposed) return scopeStatusForInput(getStatus(), nextBounds);
    const normalized: BuiltInBrowserFrame = {
      x: normalizeDimension(nextBounds.x),
      y: normalizeDimension(nextBounds.y),
      width: normalizeDimension(nextBounds.width),
      height: normalizeDimension(nextBounds.height),
    };
    const nextVisible = nextBounds.visible && normalized.width > 0 && normalized.height > 0;
    const nextScale = clampBuiltInBrowserEmulationViewScale(
      typeof nextBounds.scale === "number" ? nextBounds.scale : 1,
    );
    const scaleChanged = nextScale !== emulationViewScale;
    const unchanged = (
      normalized.x === bounds.x
      && normalized.y === bounds.y
      && normalized.width === bounds.width
      && normalized.height === bounds.height
      && nextVisible === visible
      && !scaleChanged
    );
    if (unchanged) return scopeStatusForInput(getStatus(), nextBounds);
    bounds = normalized;
    visible = nextVisible;
    emulationViewScale = nextScale;
    // A resize changes the fit factor, and the fit factor is part of the
    // override. Only emulating tabs care; everything else is already laid out
    // at the view's own size.
    if (scaleChanged) {
      for (const tab of tabs) {
        if (tab.emulation) tabCapabilities.reapplyTabEmulation(tab);
      }
    }
    // Showing the pane must not conjure a tab: closing the last tab is how a
    // person says "I'm done", and re-opening one behind their back is what made
    // the browser reappear on google.com every time. Zero tabs is a valid state
    // and the pane renders its launchpad for it.
    if (visible || tabs.length) {
      attachViewsToCurrentWindow();
    }
    emitStatus();
    return scopeStatusForInput(getStatus(), nextBounds);
  }

  async function navigate(input: BuiltInBrowserNavigateArgs): Promise<BuiltInBrowserStatus> {
    await args.waitForProfileMigration();
    await tabRestorationPromise;
    const targetUrl = normalizeBrowserUrl(input.url);
    const explicitNewTab = Boolean(input.newTab);
    const reuseOwnedTab = Boolean(input.reuseOwnedTab) && !explicitNewTab && !input.tabId;
    const reusableOwnedTab = reuseOwnedTab ? reusableOwnedTabForInput(input) : null;
    const createNewTab = explicitNewTab || (reuseOwnedTab && !reusableOwnedTab);
    const shouldActivate = input.openPanel === true || input.activate !== false || !activeTabId;
    if (createNewTab && tabs.length >= MAX_BROWSER_TABS) {
      throw new Error(`ADE browser is limited to ${MAX_BROWSER_TABS} tabs. Close a tab before opening another.`);
    }
    // Validate tabId BEFORE any side effects (stopInspect/clearSelection) so an invalid id
    // doesn't leave the service with cleared inspect/selection state.
    let existingTab: BrowserTabState | null = null;
    if (!createNewTab && input.tabId) {
      existingTab = tabs.find((entry) => entry.id === input.tabId) ?? null;
      if (!existingTab) throw new Error(`Browser tab not found: ${input.tabId}`);
    } else if (reusableOwnedTab) {
      existingTab = reusableOwnedTab;
    }
    const leaseTarget = createNewTab ? null : existingTab ?? activeTab();
    if (leaseTarget) assertHandoffAllowsAgentAction(leaseTarget, input);
    if (leaseTarget) assertTabLeaseAvailable(leaseTarget, input);
    await args.agentAccessController.requireUrlAccess(
      targetUrl,
      input,
      "The agent requested navigation to this browser origin.",
    );
    const targetTabBeforeNavigate = createNewTab ? null : existingTab ?? activeTab();
    const targetIsInspectTab = Boolean(inspecting && targetTabBeforeNavigate && targetTabBeforeNavigate.id === activeTabId);
    const nextActiveTabId = shouldActivate ? existingTab?.id ?? null : activeTabId;
    const switchingTabs = shouldActivate && (createNewTab || (nextActiveTabId ? nextActiveTabId !== activeTabId : input.tabId && input.tabId !== activeTabId));
    if (switchingTabs || targetIsInspectTab) {
      await stopInspectQuietly("built_in_browser.navigate_stop_inspect_failed");
    }
    if (switchingTabs) {
      clearSelectionInternal();
    }
    let tab = createNewTab ? createTabState() : null;
    if (tab) {
      tabs = [...tabs, tab];
      if (shouldActivate) activeTabId = tab.id;
    } else if (existingTab) {
      tab = existingTab;
      if (shouldActivate) activeTabId = tab.id;
    } else {
      tab = ensureActiveTab();
    }
    reclaimTabForHumanNavigation(tab, input);
    claimTabOwnerFromInput(tab, input);
    armAgentNavigationGuard(tab, input);
    const wc = tab.webContents;
    attachViewsToCurrentWindow();
    await wc.loadURL(targetUrl);
    if (input.openPanel) {
      requestOpenPanel({ url: targetUrl, tabId: tab.id, laneId: input.laneId, chatSessionId: input.chatSessionId });
    }
    emitStatus();
    return scopeStatusForInput(getStatus(), input);
  }

  async function createTab(input: BuiltInBrowserCreateTabArgs = {}): Promise<BuiltInBrowserStatus> {
    await args.waitForProfileMigration();
    await tabRestorationPromise;
    if (tabs.length >= MAX_BROWSER_TABS) {
      throw new Error(`ADE browser is limited to ${MAX_BROWSER_TABS} tabs. Close a tab before opening another.`);
    }
    // Normalize URL up front so we don't leave an orphan tab on invalid input.
    const normalizedUrl = input.url ? normalizeBrowserUrl(input.url) : null;
    await args.agentAccessController.requireUrlAccess(
      normalizedUrl,
      input,
      "The agent requested a new tab at this browser origin.",
    );
    const willActivate = input.activate !== false || !activeTabId;
    if (willActivate) {
      await stopInspectQuietly("built_in_browser.create_tab_stop_inspect_failed");
      clearSelectionInternal();
    }
    const tab = createTabState();
    // No URL means "give me somewhere to start": the tab stays on about:blank
    // and the pane renders its launchpad. ADE never picks a home page for you,
    // and never issues a request you did not ask for.
    tab.isLaunchpad = !normalizedUrl;
    claimTabOwnerFromInput(tab, input);
    armAgentNavigationGuard(tab, input);
    tabs = [...tabs, tab];
    if (willActivate) activeTabId = tab.id;
    attachViewsToCurrentWindow();
    if (normalizedUrl) {
      await tab.webContents.loadURL(normalizedUrl);
    }
    if (input.openPanel) {
      requestOpenPanel({ url: normalizedUrl, tabId: tab.id, laneId: input.laneId, chatSessionId: input.chatSessionId });
    }
    emitStatus();
    return scopeStatusForInput(getStatus(), input);
  }

  async function switchTab(input: BuiltInBrowserTabArgs): Promise<BuiltInBrowserStatus> {
    const tabId = input.tabId?.trim();
    if (!tabId) throw new Error("Browser tab id is required.");
    const tab = tabs.find((entry) => entry.id === tabId);
    if (!tab) throw new Error(`Browser tab not found: ${tabId}`);
    await prepareAgentReadTabAsync(tab, input, "The agent requested access to switch to this browser tab.");
    const wasDifferentTab = tab.id !== activeTabId;
    if (wasDifferentTab) {
      await stopInspectQuietly("built_in_browser.switch_tab_stop_inspect_failed");
    }
    activeTabId = tab.id;
    if (wasDifferentTab) {
      clearSelectionInternal();
    }
    attachViewsToCurrentWindow();
    if (input.openPanel) {
      requestOpenPanel({ tabId: tab.id, laneId: input.laneId, chatSessionId: input.chatSessionId });
    }
    emitStatus();
    return scopeStatusForInput(getStatus(), input);
  }

  async function closeTab(input: BuiltInBrowserTabArgs): Promise<BuiltInBrowserStatus> {
    const tabId = input.tabId?.trim();
    if (!tabId) throw new Error("Browser tab id is required.");
    const index = tabs.findIndex((entry) => entry.id === tabId);
    if (index < 0) throw new Error(`Browser tab not found: ${tabId}`);
    await prepareAgentReadTabAsync(tabs[index]!, input, "The agent requested access to close this browser tab.");
    if (tabId === activeTabId) {
      await stopInspectQuietly("built_in_browser.close_tab_stop_inspect_failed");
    }
    const [removed] = tabs.splice(index, 1);
    if (removed) {
      tabCapabilities.stopPreviewStreamsForTab(removed.id);
      teardownTabCapabilities(removed);
      MANAGED_BROWSER_WEB_CONTENTS.delete(removed.webContents);
      endSessionsForTab(removed.id);
      if (removed.view && win && !win.isDestroyed()) {
        try {
          win.contentView.removeChildView(removed.view);
        } catch {
          // ignore stale view/window links
        }
      }
      if (removed.ownsWebContents) {
        try {
          removed.webContents.close();
        } catch {
          // ignore shutdown races
        }
      }
    }
    if (lastSelectedTabId === tabId) {
      clearSelectionInternal();
    }
    if (activeTabId === tabId) {
      activeTabId = tabs[Math.max(0, index - 1)]?.id ?? tabs[0]?.id ?? null;
    }
    attachViewsToCurrentWindow();
    emitStatus();
    return scopeStatusForInput(getStatus(), input);
  }

  async function reload(input: BuiltInBrowserTabTargetArgs = {}): Promise<BuiltInBrowserStatus> {
    const tab = await prepareTabCapability(input, {
      emptyMessage: "No active browser tab. Open a tab before reloading.",
      consentReason: "The agent requested access to reload this browser tab.",
    });
    reclaimTabForHumanNavigation(tab, input);
    armAgentNavigationGuard(tab, input);
    tab.webContents.reload();
    emitStatus();
    return scopeStatusForInput(getStatus(), input);
  }

  async function goBack(input: BuiltInBrowserTabTargetArgs = {}): Promise<BuiltInBrowserStatus> {
    const tab = await prepareTabCapability(input, {
      emptyMessage: "No active browser tab. Open a tab before navigating back.",
      consentReason: "The agent requested backward navigation in this browser tab.",
    });
    reclaimTabForHumanNavigation(tab, input);
    armAgentNavigationGuard(tab, input);
    const wc = tab.webContents;
    if (wc.canGoBack()) wc.goBack();
    emitStatus();
    return scopeStatusForInput(getStatus(), input);
  }

  async function goForward(input: BuiltInBrowserTabTargetArgs = {}): Promise<BuiltInBrowserStatus> {
    const tab = await prepareTabCapability(input, {
      emptyMessage: "No active browser tab. Open a tab before navigating forward.",
      consentReason: "The agent requested forward navigation in this browser tab.",
    });
    reclaimTabForHumanNavigation(tab, input);
    armAgentNavigationGuard(tab, input);
    const wc = tab.webContents;
    if (wc.canGoForward()) wc.goForward();
    emitStatus();
    return scopeStatusForInput(getStatus(), input);
  }

  async function stop(input: BuiltInBrowserTabTargetArgs = {}): Promise<BuiltInBrowserStatus> {
    const tab = await prepareTabCapability(input, {
      emptyMessage: "No active browser tab. Open a tab before stopping a load.",
      consentReason: "The agent requested access to stop this browser tab.",
    });
    const wc = tab.webContents;
    if (wc.isLoading()) wc.stop();
    emitStatus();
    return scopeStatusForInput(getStatus(), input);
  }

  async function startInspect(input: BuiltInBrowserTabTargetArgs = {}): Promise<BuiltInBrowserStatus> {
    const tab = await prepareTabCapability(input, {
      emptyMessage: "No active browser tab. Open a tab before starting inspect.",
      consentReason: "The agent requested DOM inspection for this browser tab.",
    });
    const wc = tab.webContents;
    attachViewsToCurrentWindow();
    attachDebuggerListeners(wc);
    try {
      await ensureDebuggerAttached(wc, "inspect");
      await sendDebuggerCommand(wc, "DOM.enable");
      await sendDebuggerCommand(wc, "Runtime.enable");
      await ensureInspectBinding(wc);
      await sendDebuggerCommand(wc, "Runtime.evaluate", {
        expression: inspectOverlayInstallScript(INSPECT_BINDING_NAME),
        returnByValue: true,
        awaitPromise: false,
        silent: true,
      });
      inspecting = true;
      emitStatus();
      return scopeStatusForInput(getStatus(), input);
    } catch (error) {
      inspecting = false;
      if (debuggerAttachedForInspect) {
        detachDebuggerIfOwned(wc);
      } else {
        detachDebuggerListeners(wc);
      }
      emitStatus();
      throw error;
    }
  }

  async function stopInspect(input: BuiltInBrowserTabTargetArgs = {}): Promise<BuiltInBrowserStatus> {
    const inspectWc = inspectListenerWebContents && !inspectListenerWebContents.isDestroyed()
      ? inspectListenerWebContents
      : null;
    const wc = inspectWc ?? currentWebContents();
    const tab = wc ? tabForWebContents(wc) : null;
    if (tab) await prepareAgentReadTabAsync(tab, input, "The agent requested access to stop DOM inspection.");
    inspecting = false;
    await teardownInspectWebContents(wc);
    emitStatus();
    return scopeStatusForInput(getStatus(), input);
  }

  const teardownInspectWebContents = async (wc: WebContents | null): Promise<void> => {
    const ownsInspectDebugger = Boolean(
      wc
      && inspectListenerWebContents === wc
      && debuggerAttachedForInspect,
    );
    if (wc && inspectListenerWebContents === wc) {
      detachDebuggerListeners(wc);
      if (ownsInspectDebugger) {
        debuggerAttachedForInspect = false;
      }
    }
    if (wc?.debugger.isAttached()) {
      try {
        await sendDebuggerCommand(wc, "Runtime.evaluate", {
          expression: inspectOverlayCleanupScript(),
          returnByValue: true,
          awaitPromise: false,
          silent: true,
        });
        await sendDebuggerCommand(wc, "Runtime.removeBinding", { name: INSPECT_BINDING_NAME }).catch(() => {});
      } catch (error) {
        logger()?.debug("built_in_browser.stop_inspect_cleanup_failed", {
          err: error instanceof Error ? error.message : String(error),
        });
      }
      if (ownsInspectDebugger) {
        try {
          if (wc.debugger.isAttached()) wc.debugger.detach();
        } catch {
          // ignore debugger detach races
        }
      }
    }
  };

  async function captureScreenshot(input: BuiltInBrowserTabTargetArgs = {}): Promise<BuiltInBrowserScreenshot> {
    const tab = await prepareTabCapability(input, {
      emptyMessage: "No active browser tab. Open a tab before capturing a screenshot.",
      consentReason: "The agent requested a screenshot of this browser tab.",
    });
    const wc = tab.webContents;
    try {
      return await capturePageScreenshot(wc);
    } catch (error) {
      logger()?.debug("built_in_browser.capture_page_failed", {
        err: error instanceof Error ? error.message : String(error),
      });
      return captureCdpScreenshot(wc);
    }
  }

  async function observe(input: BuiltInBrowserObservationArgs = {}): Promise<BuiltInBrowserObservation> {
    const sessionEntry = sessionFromInput(input);
    const tab = await prepareTabCapability(input, {
      emptyMessage: "No active browser tab. Open a tab before observing.",
      consentReason: "The agent requested page content from this browser tab.",
    });
    const screenshot = await captureScreenshot({ tabId: tab.id });
    const dom = input.includeDom === false
      ? null
      : await readDomSnapshot(tab.webContents, input).catch((error) => {
          logger()?.debug("built_in_browser.observe_dom_failed", {
            err: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
    const elementMapScreenshot = input.includeElementMap && dom
      ? await captureElementMapScreenshot(tab.webContents, dom).catch((error) => {
          logger()?.debug("built_in_browser.observe_element_map_failed", {
            err: error instanceof Error ? error.message : String(error),
          });
          return null;
        })
      : null;
    const diagnostics = input.includeDiagnostics === false ? null : snapshotDiagnostics(tab);
    const observation = await writeObservation(tab, screenshot, input, dom, elementMapScreenshot, diagnostics, sessionEntry?.id ?? null);
    touchSession(sessionEntry, { lastObservationId: observation.id });
    return observation;
  }

  function getTrace(input: BuiltInBrowserTraceArgs = {}): BuiltInBrowserTraceResult {
    const sessionEntry = sessionFromInput(input);
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before reading browser trace.");
    prepareAgentReadTab(tab, input);
    const limit = normalizeTraceLimit(input.limit);
    const entries = sessionEntry
      ? tab.actionTrace.filter((entry) => entry.sessionId === sessionEntry.id)
      : tab.actionTrace;
    return {
      tabId: tab.id,
      sessionId: sessionEntry?.id ?? null,
      entries: entries.slice(-limit),
    };
  }

  async function click(input: BuiltInBrowserClickArgs): Promise<BuiltInBrowserAgentActionResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before clicking.");
    return runTracedAgentAction(tab, "click", input, async () => {
      const wc = tab.webContents;
      const { x, y } = await resolveClickTarget(tab, input);
      const button = normalizeMouseButton(input.button);
      const clickCount = normalizeClickCount(input.clickCount);
      await withTemporaryDebugger(wc, async () => {
        await sendDebuggerCommand(wc, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button,
          clickCount,
        });
        await sendDebuggerCommand(wc, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button,
          clickCount,
        });
      });
      emitStatus();
      return actionResult(tab, input);
    });
  }

  async function typeText(input: BuiltInBrowserTypeTextArgs): Promise<BuiltInBrowserAgentActionResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before typing.");
    return runTracedAgentAction(tab, "typeText", input, async () => {
      const text = stringOrNull(input.text);
      if (!text) throw new Error("Text is required.");
      await withTemporaryDebugger(tab.webContents, async () => {
        await sendDebuggerCommand(tab.webContents, "Input.insertText", { text });
      });
      emitStatus();
      return actionResult(tab, input);
    });
  }

  async function dispatchKey(input: BuiltInBrowserDispatchKeyArgs): Promise<BuiltInBrowserAgentActionResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before dispatching a key.");
    return runTracedAgentAction(tab, "dispatchKey", input, async () => {
      const key = stringOrNull(input.key);
      if (!key) throw new Error("Key is required.");
      if (hasElementTarget(input)) {
        await focusElementTarget(tab, input, { select: false });
      }
      const event = keyEventForAgentInput(key);
      await withTemporaryDebugger(tab.webContents, async () => {
        await sendDebuggerCommand(tab.webContents, "Input.dispatchKeyEvent", {
          type: "keyDown",
          ...event,
        });
        await sendDebuggerCommand(tab.webContents, "Input.dispatchKeyEvent", {
          type: "keyUp",
          ...event,
          text: undefined,
          unmodifiedText: undefined,
        });
      });
      emitStatus();
      return actionResult(tab, input);
    });
  }

  async function scroll(input: BuiltInBrowserScrollArgs): Promise<BuiltInBrowserAgentActionResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before scrolling.");
    return runTracedAgentAction(tab, "scroll", input, async () => {
      const deltaX = finiteNumber(input.deltaX) ?? 0;
      const deltaY = finiteNumber(input.deltaY) ?? 0;
      if (deltaX === 0 && deltaY === 0) throw new Error("Scroll requires deltaX or deltaY.");
      await withTemporaryDebugger(tab.webContents, async () => {
        await sendDebuggerCommand(tab.webContents, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: normalizeDimension(finiteNumber(input.x)),
          y: normalizeDimension(finiteNumber(input.y)),
          deltaX,
          deltaY,
          button: "none",
        });
      });
      emitStatus();
      return actionResult(tab, input);
    });
  }

  async function fill(input: BuiltInBrowserFillArgs): Promise<BuiltInBrowserAgentActionResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before filling.");
    return runTracedAgentAction(tab, "fill", input, async () => {
      const text = typeof input.value === "string"
        ? input.value
        : (typeof input.text === "string" ? input.text : null);
      if (text == null) throw new Error("Fill text is required.");
      await focusElementTarget(tab, input, { select: true, clear: true });
      await withTemporaryDebugger(tab.webContents, async () => {
        await sendDebuggerCommand(tab.webContents, "Input.insertText", { text });
      });
      emitStatus();
      return actionResult(tab, input);
    });
  }

  async function clear(input: BuiltInBrowserClearArgs): Promise<BuiltInBrowserAgentActionResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before clearing.");
    return runTracedAgentAction(tab, "clear", input, async () => {
      await focusElementTarget(tab, input, { select: true, clear: true });
      emitStatus();
      return actionResult(tab, input);
    });
  }

  async function wait(input: BuiltInBrowserWaitArgs): Promise<BuiltInBrowserAgentActionResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before waiting.");
    return runTracedAgentAction(tab, "wait", input, async () => {
      await waitForBrowserCondition(tab, input);
      emitStatus();
      return actionResult(tab, input);
    });
  }

  /* ── Per-tab CDP holds ─────────────────────────────────────────────────── */

  // Page actions attach the debugger only for the duration of one command
  // (`withTemporaryDebugger`). Network logging and recording need it to stay
  // attached across many commands, so they take a named hold: the first hold
  // attaches and installs a per-tab message listener, the last one released
  // detaches again (unless inspect mode still owns the debugger).
  const tabCdpMessageListener = (tab: BrowserTabState): DebuggerMessageListener =>
    (_event, method, params) => {
      if (method.startsWith("Network.")) {
        tabCapabilities.handleNetworkCdpEvent(tab, method, params);
      }
    };

  const ensureTabCdpListener = (tab: BrowserTabState): void => {
    if (tab.cdpListener) return;
    const listener = tabCdpMessageListener(tab);
    tab.cdpListener = listener;
    try {
      tab.webContents.debugger.on("message", listener);
    } catch (error) {
      tab.cdpListener = null;
      throw error;
    }
  };

  const removeTabCdpListener = (tab: BrowserTabState): void => {
    const listener = tab.cdpListener;
    if (!listener) return;
    tab.cdpListener = null;
    try {
      if (!tab.webContents.isDestroyed()) tab.webContents.debugger.off("message", listener);
    } catch {
      // ignore listener detach races
    }
  };

  const acquireDebuggerHold = async (
    tab: BrowserTabState,
    owner: BrowserDebuggerHoldOwner,
  ): Promise<void> => {
    ensureTabCdpListener(tab);
    try {
      await ensureDebuggerAttached(tab.webContents, "hold");
    } catch (error) {
      if (tab.debuggerHolds.size === 0) removeTabCdpListener(tab);
      throw new Error(
        `Could not attach the ADE browser debugger to tab ${tab.id}: ${errorMessage(error)}. Close DevTools for this tab and retry.`,
      );
    }
    tab.debuggerHolds.add(owner);
  };

  const releaseDebuggerHold = (
    tab: BrowserTabState,
    owner: BrowserDebuggerHoldOwner,
  ): void => {
    tab.debuggerHolds.delete(owner);
    if (tab.debuggerHolds.size > 0) return;
    removeTabCdpListener(tab);
    // Inspect mode owns its own attach/detach lifecycle; never yank it here.
    if (inspecting && inspectListenerWebContents === tab.webContents) return;
    try {
      if (!tab.webContents.isDestroyed() && tab.webContents.debugger.isAttached()) {
        tab.webContents.debugger.detach();
      }
    } catch {
      // ignore debugger detach races
    }
  };

  const teardownTabCapabilities = (tab: BrowserTabState): void => {
    // A tab that is going away can never be handed back, so close the handoff
    // here — the single choke point for close, crash-prune and dispose — rather
    // than leaving the chat's hand raised against a tab that no longer exists.
    endHandoffForClosedTab(tab);
    // Nothing may publish a tally for a tab that is going away.
    cancelPendingTabDiagnostics(tab.id);
    if (tab.recording) {
      tab.recording.abort();
      tab.recording = null;
    }
    tab.networkLoggingEnabled = false;
    tab.networkLogPending.clear();
    tab.debuggerHolds.clear();
    removeTabCdpListener(tab);
  };

  async function selectPoint(input: BuiltInBrowserSelectPointArgs): Promise<BuiltInBrowserSelectResult> {
    const tab = await prepareTabCapability(input, {
      emptyMessage: "No active browser tab. Open a tab before selecting a point.",
      consentReason: "The agent requested element inspection in this browser tab.",
    });
    const wc = tab.webContents;
    const x = normalizeDimension(input.x);
    const y = normalizeDimension(input.y);
    const attachedHere = await ensureDebuggerAttached(wc, "screenshot");
    try {
      await sendDebuggerCommand(wc, "DOM.enable");
      await sendDebuggerCommand(wc, "Runtime.enable");
      const result = await sendDebuggerCommand<CdpGetNodeForLocationResponse>(wc, "DOM.getNodeForLocation", {
        x,
        y,
        includeUserAgentShadowDOM: true,
        ignorePointerEventsNone: true,
      });
      if (!result.backendNodeId) {
        return { item: null };
      }
      const metadata = await readNodeMetadata(wc, result.backendNodeId, { x, y });
      const screenshotDataUrl = input.includeScreenshot === false
        ? null
        : await captureElementScreenshot(wc, metadata.frame, metadata.viewport).catch((error) => {
            logger()?.debug("built_in_browser.point_element_screenshot_failed", {
              err: error instanceof Error ? error.message : String(error),
            });
            return null;
          });
      const item = createContextItem(wc, metadata, screenshotDataUrl);
      lastSelectedItem = item;
      lastSelectedTabId = tab.id;
      emit({ type: "selection", item });
      emitStatus();
      return { item };
    } finally {
      if (attachedHere && !inspecting) {
        try {
          wc.debugger.detach();
        } catch {
          // ignore debugger detach races
        }
      }
    }
  }

  async function selectCurrent(input: BuiltInBrowserTabTargetArgs = {}): Promise<BuiltInBrowserSelectResult> {
    const tab = lastSelectedItem && lastSelectedTabId ? tabById(lastSelectedTabId) : activeTab();
    if (lastSelectedItem && !tab) clearSelectionInternal();
    if (tab) await prepareAgentReadTabAsync(tab, input, "The agent requested selected page content.");
    if (lastSelectedItem) {
      emit({ type: "selection", item: lastSelectedItem });
    }
    return { item: lastSelectedItem };
  }

  async function clearSelection(input: BuiltInBrowserTabTargetArgs = {}): Promise<{ ok: true }> {
    const tab = lastSelectedItem && lastSelectedTabId ? tabById(lastSelectedTabId) : activeTab();
    if (lastSelectedItem && !tab) clearSelectionInternal();
    if (tab) await prepareAgentReadTabAsync(tab, input, "The agent requested access to clear browser selection.");
    if (lastSelectedItem) {
      clearSelectionInternal();
    } else {
      emit({ type: "selection-cleared", item: null, clearedAt: new Date().toISOString() });
    }
    emitStatus();
    return { ok: true };
  }

  function dispose(): void {
    disposed = true;
    // Clear inspecting flags up front so any in-flight debugger callbacks that fire
    // during teardown don't act on torn-down state. stopInspect() is async, but the
    // synchronous flag flip here protects the message listener (handleInspectNodeRequested
    // bails when inspecting is false) and the detach handler.
    inspecting = false;
    debuggerAttachedForInspect = false;
    if (inspectListenerWebContents && !inspectListenerWebContents.isDestroyed()) {
      detachDebuggerListeners(inspectListenerWebContents);
    } else {
      debuggerMessageListener = null;
      debuggerDetachListener = null;
      inspectListenerWebContents = null;
    }
    void stopInspect().catch(() => {});
    if (win && winClosedListener) {
      win.removeListener("closed", winClosedListener);
      winClosedListener = null;
    }
    tabCapabilities.dispose();
    removeBrowserDownloadListener();
    unsubscribeNetworkObserver?.();
    unsubscribeNetworkObserver = null;
    removeTabViewsFromWindow();
    for (const tab of tabs) {
      teardownTabCapabilities(tab);
      MANAGED_BROWSER_WEB_CONTENTS.delete(tab.webContents);
      if (tab.ownsWebContents) {
        try {
          tab.webContents.close();
        } catch {
          // ignore shutdown races
        }
      }
    }
    win = null;
    tabs = [];
    browserSessions = [];
    activeTabId = null;
    configuredBrowserSession = null;
  }

  const attachDebuggerListeners = (wc: WebContents): void => {
    if (inspectListenerWebContents && inspectListenerWebContents !== wc) {
      detachDebuggerListeners(inspectListenerWebContents);
    }
    if (debuggerMessageListener || debuggerDetachListener) return;
    debuggerMessageListener = (_event, method, params) => {
      if (method === "Runtime.bindingCalled") {
        const point = parseInspectBindingPoint(params);
        if (!point) return;
        void handleInspectPointRequested(wc, point).catch(emitError);
        return;
      }
      if (method === "Overlay.inspectNodeRequested") {
        const backendNodeId = isRecord(params) ? params.backendNodeId : null;
        if (typeof backendNodeId !== "number" || !Number.isFinite(backendNodeId)) return;
        void handleInspectNodeRequested(wc, backendNodeId).catch(emitError);
      }
    };
    debuggerDetachListener = (_event, reason) => {
      logger()?.debug("built_in_browser.debugger_detached", { reason });
      inspecting = false;
      debuggerAttachedForInspect = false;
      debuggerMessageListener = null;
      debuggerDetachListener = null;
      inspectListenerWebContents = null;
      emitStatus();
    };
    wc.debugger.on("message", debuggerMessageListener);
    wc.debugger.on("detach", debuggerDetachListener);
    inspectListenerWebContents = wc;
  };

  const detachDebuggerListeners = (wc: WebContents): void => {
    const target = !wc.isDestroyed() ? wc : null;
    if (debuggerMessageListener) {
      try {
        target?.debugger.off("message", debuggerMessageListener);
      } catch {
        // ignore listener detach races
      }
      debuggerMessageListener = null;
    }
    if (debuggerDetachListener) {
      try {
        target?.debugger.off("detach", debuggerDetachListener);
      } catch {
        // ignore listener detach races
      }
      debuggerDetachListener = null;
    }
    if (inspectListenerWebContents === wc) {
      inspectListenerWebContents = null;
    }
  };

  const ensureDebuggerAttached = async (
    wc: WebContents,
    owner: "inspect" | "screenshot" | "hold",
  ): Promise<boolean> => {
    if (wc.debugger.isAttached()) return false;
    wc.debugger.attach("1.3");
    if (owner === "inspect") debuggerAttachedForInspect = true;
    return true;
  };

  const detachDebuggerIfOwned = (wc: WebContents): void => {
    detachDebuggerListeners(wc);
    if (!debuggerAttachedForInspect) return;
    debuggerAttachedForInspect = false;
    try {
      if (wc.debugger.isAttached()) wc.debugger.detach();
    } catch {
      // ignore debugger detach races
    }
  };

  const sendDebuggerCommand = async <T = unknown>(
    wc: WebContents,
    command: string,
    params?: Record<string, unknown>,
  ): Promise<T> => {
    return withTimeout(
      wc.debugger.sendCommand(command, params),
      DEBUGGER_TIMEOUT_MS,
      `${command} timed out after ${DEBUGGER_TIMEOUT_MS}ms`,
    ) as Promise<T>;
  };

  const ensureInspectBinding = async (wc: WebContents): Promise<void> => {
    await sendDebuggerCommand(wc, "Runtime.removeBinding", { name: INSPECT_BINDING_NAME }).catch(() => {});
    await sendDebuggerCommand(wc, "Runtime.addBinding", { name: INSPECT_BINDING_NAME });
  };

  const handleInspectPointRequested = async (
    wc: WebContents,
    point: BrowserInspectPoint,
  ): Promise<void> => {
    if (handlingInspectNode) return;
    handlingInspectNode = true;
    try {
      const ownerTab = tabForWebContents(wc);
      await selectPoint({
        ...(ownerTab ? { tabId: ownerTab.id } : {}),
        x: point.x,
        y: point.y,
        includeScreenshot: true,
      });
    } finally {
      if (inspecting) {
        await stopInspect().catch((error) => {
          logger()?.debug("built_in_browser.inspect_cleanup_failed", {
            err: error instanceof Error ? error.message : String(error),
          });
        });
      }
      handlingInspectNode = false;
    }
  };

  const handleInspectNodeRequested = async (
    wc: WebContents,
    backendNodeId: number,
  ): Promise<void> => {
    if (handlingInspectNode) return;
    const ownerTab = tabForWebContents(wc);
    if (!ownerTab) return;
    handlingInspectNode = true;
    try {
      const metadata = await readNodeMetadata(wc, backendNodeId, currentCursorPointInView());
      const screenshotDataUrl = await captureElementScreenshot(wc, metadata.frame, metadata.viewport).catch((error) => {
        logger()?.debug("built_in_browser.element_screenshot_failed", {
          err: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
      const item = createContextItem(wc, metadata, screenshotDataUrl);
      lastSelectedItem = item;
      lastSelectedTabId = ownerTab.id;
      emit({ type: "selection", item });
    } finally {
      if (inspecting) {
        await stopInspect().catch((error) => {
          logger()?.debug("built_in_browser.inspect_cleanup_failed", {
            err: error instanceof Error ? error.message : String(error),
          });
        });
      }
      handlingInspectNode = false;
    }
  };

  const createContextItem = (
    wc: WebContents,
    metadata: NodeMetadata,
    screenshotDataUrl: string | null,
  ): BuiltInBrowserContextItem => {
    const ownerTab = tabForWebContents(wc);
    return {
      kind: "built_in_browser_element",
      id: `built-in-browser:${randomUUID()}`,
      provider: "cdp",
      componentId: buildComponentId(metadata),
      url: metadata.url ?? emptyToNull(wc.getURL()),
      title: metadata.title ?? emptyToNull(wc.getTitle()),
      sourceFile: null,
      sourceLine: null,
      frame: metadata.frame,
      pixelFrame: scaleFrame(metadata.frame, metadata.pixelRatio),
      metadata: {
        ...metadata.metadata,
        ownerTabId: ownerTab?.id ?? null,
        ownerLaneId: ownerTab?.ownerLaneId ?? null,
        ownerChatSessionId: ownerTab?.ownerChatSessionId ?? null,
      },
      screenshotDataUrl,
      selectedAt: new Date().toISOString(),
    };
  };

  const readNodeMetadata = async (
    wc: WebContents,
    backendNodeId: number,
    point: BrowserInspectPoint | null = null,
  ): Promise<NodeMetadata> => {
    const resolved = await sendDebuggerCommand<CdpResolveNodeResponse>(wc, "DOM.resolveNode", {
      backendNodeId,
    });
    const objectId = resolved.object?.objectId;
    if (!objectId) {
      throw new Error("Unable to resolve selected browser node.");
    }

    try {
      const response = await sendDebuggerCommand<CdpCallFunctionResponse>(wc, "Runtime.callFunctionOn", {
        objectId,
        returnByValue: true,
        silent: true,
        functionDeclaration: NODE_METADATA_FUNCTION,
        arguments: point ? [{ value: point }] : [],
      });
      if (response.exceptionDetails) {
        throw new Error("Selected browser node metadata evaluation failed.");
      }
      return normalizeNodeMetadata(response.result?.value);
    } finally {
      await sendDebuggerCommand(wc, "Runtime.releaseObject", { objectId }).catch(() => {});
    }
  };

  const capturePageScreenshot = async (
    wc: WebContents,
    rect?: Electron.Rectangle,
    timeoutMs = SCREENSHOT_TIMEOUT_MS,
  ): Promise<BuiltInBrowserScreenshot> => {
    const image = await withTimeout(
      wc.capturePage(rect, { stayHidden: true }),
      timeoutMs,
      `capturePage timed out after ${timeoutMs}ms`,
    );
    if (image.isEmpty()) {
      throw new Error("Browser screenshot capture returned an empty image.");
    }
    const dataUrl = image.toDataURL();
    const size = image.getSize();
    return {
      capturedAt: new Date().toISOString(),
      width: size.width,
      height: size.height,
      dataUrl,
    };
  };

  const captureCdpScreenshot = async (
    wc: WebContents,
  ): Promise<BuiltInBrowserScreenshot> => {
    const attachedHere = await ensureDebuggerAttached(wc, "screenshot");
    try {
      await sendDebuggerCommand(wc, "Page.enable");
      const result = await sendDebuggerCommand<CdpScreenshotResponse>(wc, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
      });
      if (!result.data) {
        throw new Error("Page.captureScreenshot returned no image data.");
      }
      const dataUrl = `data:image/png;base64,${result.data}`;
      const size = nativeImage.createFromDataURL(dataUrl).getSize();
      return {
        capturedAt: new Date().toISOString(),
        width: size.width,
        height: size.height,
        dataUrl,
      };
    } finally {
      if (attachedHere && !inspecting) {
        try {
          wc.debugger.detach();
        } catch {
          // ignore debugger detach races
        }
      }
    }
  };

  const captureElementScreenshot = async (
    wc: WebContents,
    frame: BuiltInBrowserFrame,
    viewport: BuiltInBrowserFrame,
  ): Promise<string | null> => {
    const clipped = clipFrameToViewport(frame, viewport);
    if (clipped.width <= 0 || clipped.height <= 0) return null;
    const screenshot = await capturePageScreenshot(
      wc,
      toElectronRect(clipped),
      ELEMENT_SCREENSHOT_TIMEOUT_MS,
    );
    return screenshot.dataUrl;
  };

  const captureElementMapScreenshot = async (
    wc: WebContents,
    dom: BuiltInBrowserDomSnapshot,
  ): Promise<BuiltInBrowserScreenshot | null> => {
    if (!dom.elements.length) return null;
    const payload = {
      elements: dom.elements.slice(0, MAX_ELEMENT_MAP_ELEMENTS),
    };
    await evaluateElementMapOverlay(wc, payload);
    try {
      return await capturePageScreenshot(wc);
    } finally {
      await evaluateElementMapOverlay(wc, { clear: true }).catch((error) => {
        logger()?.debug("built_in_browser.element_map_cleanup_failed", {
          err: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };

  const withTemporaryDebugger = async <T>(
    wc: WebContents,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const attachedHere = await ensureDebuggerAttached(wc, "screenshot");
    try {
      return await fn();
    } finally {
      if (attachedHere && !inspecting) {
        try {
          wc.debugger.detach();
        } catch {
          // ignore debugger detach races
        }
      }
    }
  };

  const cdpEvaluateDeps = { sendDebuggerCommand, withTemporaryDebugger };

  const evaluateBrowserDom = (wc: WebContents, payload: Record<string, unknown>): Promise<unknown> =>
    evaluateInTab(
      cdpEvaluateDeps,
      wc,
      `(${AGENT_DOM_COLLECTOR_FUNCTION})(${JSON.stringify(payload)})`,
      "Browser DOM evaluation failed.",
    );

  const evaluateElementMapOverlay = async (
    wc: WebContents,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    await evaluateInTab(
      cdpEvaluateDeps,
      wc,
      `(${AGENT_ELEMENT_MAP_OVERLAY_FUNCTION})(${JSON.stringify(payload)})`,
      "Browser element map overlay evaluation failed.",
    );
  };

  const readDomSnapshot = async (
    wc: WebContents,
    input: BuiltInBrowserObservationArgs,
  ): Promise<BuiltInBrowserDomSnapshot | null> => {
    const result = await evaluateBrowserDom(wc, {
      maxElements: normalizeObservationMaxElements(input.maxElements),
    });
    return normalizeDomSnapshot(isRecord(result) ? result.snapshot : null);
  };

  const resolveClickTarget = async (
    tab: BrowserTabState,
    input: BuiltInBrowserClickArgs,
  ): Promise<{ x: number; y: number; element: BuiltInBrowserElementSnapshot | null }> => {
    const x = optionalFiniteNumber(input.x);
    const y = optionalFiniteNumber(input.y);
    if (x != null || y != null) {
      if (x == null || y == null) {
        throw new Error("Browser click requires both x and y when using coordinates.");
      }
      return { x: normalizeDimension(x), y: normalizeDimension(y), element: null };
    }

    if (!hasElementTarget(input)) {
      throw new Error("Browser click requires x/y, selector, text, testId, elementIndex, or handle.");
    }

    const result = await evaluateBrowserDom(tab.webContents, {
      maxElements: normalizeObservationMaxElements(input.maxElements),
      locate: await elementLocatePayloadForInput(tab, input),
    });
    const record = isRecord(result) ? result : {};
    const error = stringOrNull(record.error);
    if (error) throw new Error(error);
    const target = normalizeElementSnapshot(record.target);
    if (!target) {
      throw new Error("No matching browser element was found for click.");
    }
    if (target.disabled) throw new Error("Matching browser element is disabled.");
    return {
      x: normalizeDimension(target.center.x),
      y: normalizeDimension(target.center.y),
      element: target,
    };
  };

  const focusElementTarget = async (
    tab: BrowserTabState,
    input: BuiltInBrowserElementTargetInput,
    options: { select?: boolean; clear?: boolean } = {},
  ): Promise<BuiltInBrowserElementSnapshot> => {
    if (!hasElementTarget(input)) {
      throw new Error("Browser element target requires selector, text, testId, elementIndex, or handle.");
    }
    const result = await evaluateBrowserDom(tab.webContents, {
      maxElements: normalizeObservationMaxElements(input.maxElements),
      focus: true,
      select: options.select === true,
      clear: options.clear === true,
      editableRequired: options.clear === true,
      locate: await elementLocatePayloadForInput(tab, input),
    });
    const record = isRecord(result) ? result : {};
    const error = stringOrNull(record.error);
    if (error) throw new Error(error);
    const target = normalizeElementSnapshot(record.target);
    if (!target) throw new Error("No matching browser element was found.");
    if (target.disabled) throw new Error("Matching browser element is disabled.");
    return target;
  };

  const waitForBrowserCondition = async (
    tab: BrowserTabState,
    input: BuiltInBrowserWaitArgs,
  ): Promise<void> => {
    const timeoutMs = normalizeBrowserWaitTimeoutMs(input.timeoutMs);
    const deadline = Date.now() + timeoutMs;
    let lastError: string | null = null;
    do {
      try {
        const matched = await browserWaitConditionMatched(tab, input);
        if (matched) return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await waitForTabActivity(tab, browserWaitWakeTimeoutMs(tab, input, remainingMs));
    } while (Date.now() < deadline);
    throw new Error(lastError ?? `Timed out waiting for browser condition after ${timeoutMs}ms.`);
  };

  const browserWaitWakeTimeoutMs = (
    tab: BrowserTabState,
    input: BuiltInBrowserWaitArgs,
    remainingMs: number,
  ): number => {
    const loadState = normalizeLoadState(input.loadState);
    if (loadState === "network-idle" && !tab.webContents.isLoading() && tab.pendingNetworkRequests.size === 0) {
      const idleRemainingMs = normalizeBrowserNetworkIdleMs(input.networkIdleMs) - (Date.now() - tab.lastNetworkActivityAtMs);
      if (idleRemainingMs > 0) return Math.max(1, Math.min(remainingMs, idleRemainingMs));
    }
    return Math.min(remainingMs, 1_000);
  };

  const browserWaitConditionMatched = async (
    tab: BrowserTabState,
    input: BuiltInBrowserWaitArgs,
  ): Promise<boolean> => {
    const expectedUrl = stringOrNull(input.url);
    if (expectedUrl && !tab.webContents.getURL().includes(expectedUrl)) return false;

    if (input.loadState != null && !normalizeLoadState(input.loadState)) {
      throw new Error("Browser wait loadState must be domcontentloaded, load, or network-idle.");
    }
    const loadState = normalizeLoadState(input.loadState);
    if (loadState) {
      if (loadState === "network-idle") {
        if (tab.webContents.isLoading()) return false;
        if (tab.pendingNetworkRequests.size > 0) return false;
        if (Date.now() - tab.lastNetworkActivityAtMs < normalizeBrowserNetworkIdleMs(input.networkIdleMs)) return false;
      }
      const readyState = await readDocumentReadyState(tab.webContents).catch(() => null);
      if (loadState === "domcontentloaded" && readyState !== "interactive" && readyState !== "complete") return false;
      if ((loadState === "load" || loadState === "network-idle") && readyState !== "complete") return false;
    }

    if (hasElementTarget(input)) {
      const result = await evaluateBrowserDom(tab.webContents, {
        maxElements: normalizeObservationMaxElements(input.maxElements),
        locate: await elementLocatePayloadForInput(tab, input),
      });
      const record = isRecord(result) ? result : {};
      const target = normalizeElementSnapshot(record.target);
      return Boolean(target && !target.disabled);
    }
    return true;
  };

  const readDocumentReadyState = async (wc: WebContents): Promise<string | null> => {
    const result = await evaluateBrowserDom(wc, { readyState: true, maxElements: 1 });
    const record = isRecord(result) ? result : {};
    return stringOrNull(record.readyState);
  };

  const elementLocatePayloadForInput = (
    tab: BrowserTabState,
    input: BuiltInBrowserElementTargetInput,
  ): Promise<Record<string, unknown>> =>
    resolveAgentElementLocatePayload(input, (handle) =>
      readObservationElementHandle(tab, handle));

  const readObservationElementHandle = async (
    tab: BrowserTabState,
    handle: string,
  ): Promise<BuiltInBrowserElementSnapshot> => {
    const parsed = parseObservationElementHandle(handle);
    if (!parsed) {
      throw new Error("Browser element handle must look like obs-...:e:<index>.");
    }
    const jsonPath = path.join(
      observationDirectory(tab),
      `${sanitizeObservationPathSegment(parsed.observationId)}.json`,
    );
    let parsedObservation: unknown;
    try {
      parsedObservation = JSON.parse(await fs.readFile(jsonPath, "utf8"));
    } catch {
      throw new Error("Browser element handle expired or was pruned from scratch observations.");
    }
    const observation = isRecord(parsedObservation) ? parsedObservation : {};
    if (stringOrNull(observation.tabId) !== tab.id) {
      throw new Error("Browser element handle belongs to a different browser tab.");
    }
    const dom = isRecord(observation.dom) ? observation.dom : {};
    const elements = Array.isArray(dom.elements)
      ? dom.elements
          .map(normalizeElementSnapshot)
          .filter((entry): entry is BuiltInBrowserElementSnapshot => Boolean(entry))
      : [];
    const element = elements.find((entry) => entry.index === parsed.index) ?? null;
    if (!element) {
      throw new Error("Browser element handle no longer points to a saved element.");
    }
    return element;
  };

  const actionResult = async (
    tab: BrowserTabState,
    input: BuiltInBrowserAgentActionArgs,
  ): Promise<BuiltInBrowserAgentActionResult> => {
    const sessionEntry = sessionFromInput(input);
    if (input.observe !== false) {
      const waitMs = normalizeActionObserveDelayMs(input.waitAfterMs);
      if (waitMs > 0) await delay(waitMs);
    }
    return {
      ok: true,
      observation: input.observe === false ? null : await observe({ ...input, tabId: tab.id }),
      status: scopeStatusForInput(getStatus(), input),
      trace: null,
      session: sessionEntry ? sessionSnapshot(sessionEntry) : null,
    };
  };

  const writeObservation = async (
    tab: BrowserTabState,
    screenshot: BuiltInBrowserScreenshot,
    input: BuiltInBrowserObservationArgs,
    dom: BuiltInBrowserDomSnapshot | null,
    elementMapScreenshot: BuiltInBrowserScreenshot | null,
    diagnostics: BuiltInBrowserDiagnostics | null,
    sessionId: string | null,
  ): Promise<BuiltInBrowserObservation> => {
    if (!observationRelativeBasePath) {
      throw new Error("Browser observations are unavailable because no scratch root is configured.");
    }
    const keepCount = normalizeObservationKeepCount(input.keepCount);
    const id = `obs-${Date.now()}-${randomUUID()}`;
    const dir = observationDirectory(tab);
    const filePath = path.join(dir, `${id}.png`);
    const elementMapPath = path.join(dir, `${id}.map.png`);
    const jsonPath = path.join(dir, `${id}.json`);
    const image = decodeDataUrl(screenshot.dataUrl);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, image.buffer);
    const relativePath = path.relative(observationRelativeBasePath, filePath);
    const domWithHandles = dom ? applyObservationHandles(dom, id) : null;
    let elementMap: BuiltInBrowserObservationElementMap | null = null;
    if (elementMapScreenshot) {
      const elementMapImage = decodeDataUrl(elementMapScreenshot.dataUrl);
      await fs.writeFile(elementMapPath, elementMapImage.buffer);
      elementMap = {
        filePath: elementMapPath,
        relativePath: path.relative(observationRelativeBasePath, elementMapPath),
        width: elementMapScreenshot.width,
        height: elementMapScreenshot.height,
        mimeType: elementMapImage.mimeType,
        elementCount: domWithHandles?.elements.length ?? 0,
        ...(input.includeDataUrl ? { dataUrl: elementMapScreenshot.dataUrl } : {}),
      };
    }
    const observation: BuiltInBrowserObservation = {
      id,
      tabId: tab.id,
      sessionId,
      url: tab.webContents.isDestroyed() ? null : emptyToNull(tab.webContents.getURL()),
      title: tab.webContents.isDestroyed() ? null : emptyToNull(tab.webContents.getTitle()),
      capturedAt: screenshot.capturedAt,
      width: screenshot.width,
      height: screenshot.height,
      mimeType: image.mimeType,
      filePath,
      relativePath,
      ...(input.includeDataUrl ? { dataUrl: screenshot.dataUrl } : {}),
      ...(domWithHandles ? { dom: domWithHandles } : {}),
      ...(elementMap ? { elementMap } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      ownerLaneId: tab.ownerLaneId,
      ownerChatSessionId: tab.ownerChatSessionId,
      cleanup: {
        keepCount,
        keptCount: 1,
        deletedCount: 0,
      },
    };
    await fs.writeFile(jsonPath, `${JSON.stringify({ ...observation, filePath, relativePath }, null, 2)}\n`, "utf8");
    observation.cleanup = await pruneObservationDirectory(dir, keepCount);
    void pruneObservationCacheRoot(
      path.join(observationRootPath!, sanitizeObservationPathSegment(args.collection.key)),
      DEFAULT_OBSERVATION_MAX_AGE_MS,
    ).catch((error) => {
      logger()?.debug("built_in_browser.observation_stale_prune_failed", {
        err: error instanceof Error ? error.message : String(error),
      });
    });
    await fs.writeFile(jsonPath, `${JSON.stringify(observation, null, 2)}\n`, "utf8");
    return observation;
  };

  const restorePersistedTabs = async (): Promise<void> => {
    if (disposed) return;
    const restored = args.restoredState;
    if (!restored?.tabs.length) return;
    restoringTabs = true;
    const restoredTabs = restored.tabs.slice(0, MAX_BROWSER_TABS).map(() => createTabState());
    tabs = restoredTabs;
    activeTabId = restoredTabs[restored.activeIndex]?.id ?? restoredTabs[0]?.id ?? null;
    logger()?.info("built_in_browser.tabs_restore_started", {
      collectionKey: args.collection.key,
      tabCount: restoredTabs.length,
    });
    const results = await Promise.allSettled(restoredTabs.map((tab, index) => (
      tab.webContents.loadURL(restored.tabs[index]?.url ?? "about:blank")
    )));
    restoringTabs = false;
    if (disposed) return;
    logger()?.info("built_in_browser.tabs_restore_completed", {
      collectionKey: args.collection.key,
      tabCount: restoredTabs.length,
      failedCount: results.filter((result) => result.status === "rejected").length,
    });
    emitStatus();
  };

  /**
   * Per-tab capability surface — emulation, zoom, find, DevTools, the network
   * log and HAR, the extra page actions, the preview stream and recording.
   *
   * Constructed here, at the bottom of the factory, rather than where the
   * sections used to sit: the deps below include closures declared later in
   * this function (`actionResult`, `resolveClickTarget`, `sendDebuggerCommand`
   * …), and an object literal built any earlier would read them in their
   * temporal dead zone. Everything that calls back into these does so from
   * inside a function body, so the ordering is safe.
   */
  const tabCapabilities = createBuiltInBrowserTabCapabilities({
    logger,
    emit,
    emitStatus,
    statusForInput: (input) => scopeStatusForInput(getStatus(), input),
    getActiveTabId: () => activeTabId,
    getWindow: () => win,
    getEmulationViewScale: () => emulationViewScale,
    tabById,
    targetTabFromInput,
    prepareTabCapability,
    runTracedTabCapability,
    runTracedAgentAction,
    actionResult,
    acquireDebuggerHold,
    releaseDebuggerHold,
    sendDebuggerCommand,
    withTemporaryDebugger,
    resolveClickTarget,
    focusElementTarget,
    observationDirectory,
    observationRootPath,
    observationRelativeBasePath,
    traceAutoEndedRecording,
    getCollectionProjectRoot: () => args.collection.projectRoot,
    // A tab that gains or loses its last watcher has to be re-placed: parked
    // just outside the window while somebody previews it, detached once nobody
    // does. `attachViewsToCurrentWindow` is the one place that decides that.
    onPreviewWatchersChanged: () => attachViewsToCurrentWindow(),
    createRecordingWindow: args.createRecordingWindow ?? null,
    createTabRecorder: args.createTabRecorder ?? null,
  });

  hasPreviewWatchers = (tabId) => tabCapabilities.hasPreviewWatchers(tabId);

  const tabRestorationPromise = args.waitForProfileMigration()
    .then(restorePersistedTabs)
    .catch((error) => {
      restoringTabs = false;
      if (disposed) return;
      logger()?.warn("built_in_browser.tabs_restore_failed", {
        collectionKey: args.collection.key,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return {
    attachToWindow,
    detachFromWindow,
    getStatus,
    getStatusForInput,
    requestOriginAccess,
    claim,
    startHandoff,
    endHandoff,
    waitForHandoff,
    startSession,
    listSessions,
    endSession,
    showPanel,
    setBounds,
    navigate,
    createTab,
    switchTab,
    closeTab,
    reload,
    goBack,
    goForward,
    stop,
    observe,
    getTrace,
    click,
    typeText,
    dispatchKey,
    scroll,
    fill,
    clear,
    wait,
    startInspect,
    stopInspect,
    captureScreenshot,
    selectPoint,
    selectCurrent,
    clearSelection,
    setEmulation: tabCapabilities.setEmulation,
    setZoom: tabCapabilities.setZoom,
    findInPage: tabCapabilities.findInPage,
    stopFindInPage: tabCapabilities.stopFindInPage,
    setDevTools: tabCapabilities.setDevTools,
    setNetworkLogging: tabCapabilities.setNetworkLogging,
    getNetworkLog: tabCapabilities.getNetworkLog,
    exportHar: tabCapabilities.exportHar,
    hover: tabCapabilities.hover,
    drag: tabCapabilities.drag,
    selectOption: tabCapabilities.selectOption,
    uploadFile: tabCapabilities.uploadFile,
    startRecording: tabCapabilities.startRecording,
    stopRecording: tabCapabilities.stopRecording,
    startPreviewStream: tabCapabilities.startPreviewStream,
    stopPreviewStream: tabCapabilities.stopPreviewStream,
    dispose,
  };
}

export type BuiltInBrowserService = ReturnType<typeof createBuiltInBrowserService>;

/** Origin of an http(s) URL; `null` for `about:blank` and anything unparsable. */
function originOrNull(value: string | null | undefined): string | null {
  const url = emptyToNull(value ?? "");
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Inline icons a page can hand us before any network round trip. */
const MAX_INLINE_FAVICON_CHARS = 32 * 1024;

/**
 * Picks the favicon to show for a tab.
 *
 * Prefers a real http(s) URL — the renderer points an `<img>` at it and lets
 * Chromium's cache do the work, so main never fetches anything. A `data:` icon
 * is accepted as a fallback but only under 32 KB: some pages inline a full PNG
 * sprite, and copying that into every status event would put megabytes on the
 * IPC path for a 16 px square.
 */
function pickBrowserFaviconUrl(favicons: unknown): string | null {
  if (!Array.isArray(favicons)) return null;
  let inlineFallback: string | null = null;
  for (const entry of favicons) {
    if (typeof entry !== "string") continue;
    const value = entry.trim();
    if (!value) continue;
    if (/^https?:\/\//i.test(value)) return value;
    if (inlineFallback == null && /^data:image\//i.test(value) && value.length <= MAX_INLINE_FAVICON_CHARS) {
      inlineFallback = value;
    }
  }
  return inlineFallback;
}

function urlForBrowserLog(value: string): string | null {
  const url = emptyToNull(value);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
    if (parsed.protocol === "about:") return parsed.href === "about:blank" ? parsed.href : "about:";
    return parsed.protocol;
  } catch {
    return null;
  }
}

function tabStatus(tab: BrowserTabState): BuiltInBrowserTab {
  const wc = tab.webContents;
  const url = wc.isDestroyed() ? null : emptyToNull(wc.getURL());
  // A launchpad tab stops being one the moment it points at a real page, even
  // if the flag has not been cleared yet (a redirect chain, a restored tab).
  const isLaunchpad = tab.isLaunchpad && (url == null || url === "about:blank");
  return {
    id: tab.id,
    url,
    title: isLaunchpad ? "New tab" : (wc.isDestroyed() ? null : emptyToNull(wc.getTitle())),
    isLaunchpad,
    faviconUrl: tab.faviconUrl,
    isLoading: wc.isDestroyed() ? false : wc.isLoading(),
    canGoBack: wc.isDestroyed() ? false : wc.canGoBack(),
    canGoForward: wc.isDestroyed() ? false : wc.canGoForward(),
    ownerLaneId: tab.ownerLaneId,
    ownerChatSessionId: tab.ownerChatSessionId,
    ownerClaimedAt: tab.ownerClaimedAt,
    ownerLeaseExpiresAt: tab.ownerLeaseExpiresAt,
    zoomFactor: tab.zoomFactor,
    devToolsOpen: tab.devToolsMode !== null,
    emulation: tab.emulation,
    networkLogging: tab.networkLoggingEnabled,
    recording: tab.recording
      ? { startedAt: tab.recording.startedAt, fps: tab.recording.fps }
      : null,
    handoff: handoffSnapshot(tab.handoff),
  };
}

/** Strip the runtime-only timer/waiter fields before the state crosses a wire. */
function handoffSnapshot(handoff: BrowserTabHandoffState | null): BuiltInBrowserTabHandoff | null {
  if (!handoff) return null;
  return {
    reason: handoff.reason,
    startedAt: handoff.startedAt,
    expiresAt: handoff.expiresAt,
    requestedByChatSessionId: handoff.requestedByChatSessionId,
    requestedByLaneId: handoff.requestedByLaneId,
    startedAtOrigin: handoff.startedAtOrigin,
    previousOwner: { ...handoff.previousOwner },
  };
}

function toElectronRect(frame: BuiltInBrowserFrame): Electron.Rectangle {
  return {
    x: Math.max(0, Math.round(frame.x)),
    y: Math.max(0, Math.round(frame.y)),
    width: Math.max(0, Math.round(frame.width)),
    height: Math.max(0, Math.round(frame.height)),
  };
}

function normalizeObservationKeepCount(value: unknown): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_OBSERVATION_KEEP_COUNT;
  return Math.max(1, Math.min(MAX_OBSERVATION_KEEP_COUNT, raw));
}

function normalizeObservationMaxElements(value: unknown): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_OBSERVATION_MAX_ELEMENTS;
  return Math.max(1, Math.min(MAX_OBSERVATION_MAX_ELEMENTS, raw));
}

function normalizeActionObserveDelayMs(value: unknown): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_ACTION_OBSERVE_DELAY_MS;
  return Math.max(0, Math.min(MAX_ACTION_OBSERVE_DELAY_MS, raw));
}

function normalizeBrowserWaitTimeoutMs(value: unknown): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_BROWSER_WAIT_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_BROWSER_WAIT_TIMEOUT_MS, raw));
}

function normalizeBrowserNetworkIdleMs(value: unknown): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_BROWSER_NETWORK_IDLE_MS;
  return Math.max(0, Math.min(MAX_BROWSER_NETWORK_IDLE_MS, raw));
}

function normalizeTraceLimit(value: unknown): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_BROWSER_TRACE_LIMIT;
  return Math.max(1, Math.min(MAX_BROWSER_TRACE_LIMIT, raw));
}

function normalizeLeaseTtlMs(value: unknown): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_TAB_LEASE_TTL_MS;
  return Math.max(1_000, Math.min(MAX_TAB_LEASE_TTL_MS, raw));
}

function builtInBrowserDownloadPath(filename: string, reservedPaths: ReadonlySet<string>): string {
  const downloadsDir = app.getPath("downloads");
  return uniqueDownloadPath(downloadsDir, filename, reservedPaths);
}

function sanitizeDownloadFilename(value: string | null | undefined): string {
  const base = path.basename(value?.trim() || "");
  const sanitized = base.replace(DOWNLOAD_FILENAME_UNSAFE_RE, "_").trim();
  if (sanitized && sanitized !== "." && sanitized !== "..") return sanitized;
  return `ade-browser-download-${Date.now()}`;
}

function uniqueDownloadPath(directory: string, filename: string, reservedPaths: ReadonlySet<string>): string {
  const parsed = path.parse(filename);
  let candidate = path.join(directory, filename);
  for (let index = 1; index < 1_000 && downloadPathUnavailable(candidate, reservedPaths); index += 1) {
    candidate = path.join(directory, `${parsed.name} (${index})${parsed.ext}`);
  }
  if (downloadPathUnavailable(candidate, reservedPaths)) {
    throw new Error(`Could not find an unused download filename for ${filename}`);
  }
  return candidate;
}

function downloadPathUnavailable(candidate: string, reservedPaths: ReadonlySet<string>): boolean {
  return existsSync(candidate) || reservedPaths.has(downloadPathReservationKey(candidate));
}

function downloadPathReservationKey(filePath: string): string {
  const normalized = path.normalize(path.resolve(filePath));
  if (process.platform === "darwin" || process.platform === "win32") {
    return normalized.toLocaleLowerCase("en-US");
  }
  return normalized;
}

function downloadUrlOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin === "null" ? url.protocol : url.origin;
  } catch {
    return null;
  }
}

function downloadUrlForDiagnostics(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.origin === "null") return url.protocol;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function isLeaseExpired(value: string | null): boolean {
  if (!value) return true;
  const timestamp = Date.parse(value);
  return !Number.isFinite(timestamp) || timestamp <= Date.now();
}

function normalizeLoadState(value: unknown): BuiltInBrowserWaitArgs["loadState"] | null {
  return value === "domcontentloaded" || value === "load" || value === "network-idle" ? value : null;
}

function normalizeClickCount(value: unknown): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 1;
  return Math.max(1, Math.min(3, raw));
}

function normalizeMouseButton(value: unknown): CdpInputMouseButton {
  return value === "middle" || value === "right" ? value : "left";
}

function normalizeConsoleLevel(value: unknown): BuiltInBrowserDiagnostics["console"][number]["level"] {
  if (value === "error" || value === 3) return "error";
  if (value === "warning" || value === "warn" || value === 2) return "warning";
  if (value === "debug" || value === "verbose" || value === 0) return "debug";
  return "info";
}

function tabSnapshotForTrace(tab: BrowserTabState): { url: string | null; title: string | null } {
  const wc = tab.webContents;
  return {
    url: wc.isDestroyed() ? null : emptyToNull(wc.getURL()),
    title: wc.isDestroyed() ? null : emptyToNull(wc.getTitle()),
  };
}

/**
 * Bounded, redacted description of what a browser action targeted.
 *
 * The shared helper owns the locator keys and the typed-secret rule (`typeText`
 * text becomes a length); everything below is genuinely browser-only — drag
 * destinations, emulation presets, recording settings, upload path counts, and
 * the handoff bookends.
 */
function actionTargetForTrace(action: string, input: Record<string, unknown>): Record<string, unknown> | null {
  return agentActionTargetForTrace(action, input, {
    stringKeys: ["toSelector", "toTestId", "toHandle", "label", "preset", "mode"],
    numberKeys: ["toElementIndex", "toX", "toY", "steps", "index", "factor", "fps", "width", "height"],
    booleanKeys: ["open", "enabled", "mobile", "matchCase", "forward"],
    decorate: (target, { copyString, copyNumber }) => {
      if (action === "uploadFile" && Array.isArray(input.paths)) {
        // Never copy the paths themselves into a trace an agent can read back.
        target.pathCount = input.paths.length;
      }
      if (action === "selectOption" && typeof input.value === "string") {
        target.value = input.value.slice(0, 300);
      }
      // A login handoff is the one gap in a trace where the agent did nothing at
      // all, so the entries have to explain themselves: why the human was asked,
      // and how the tab came back.
      if (action === "handoff-start" || action === "handoff-end") {
        copyString("reason");
        copyString("endedBy");
        copyNumber("durationMs");
      }
      // A recording the agent did not stop is the other self-explaining entry:
      // without `endedBy` the trace shows a `stopRecording` the agent knows it
      // never called. `frameCount`/`durationMs` say how much it actually got.
      if (action === "stopRecording") {
        copyString("endedBy");
        copyNumber("durationMs");
        copyNumber("frameCount");
      }
    },
  });
}

function requestIdFromWebRequestDetails(details: Record<string, unknown>): string | null {
  const raw = stringOrNull(details.id) ?? stringOrNull(details.requestId);
  if (raw) return raw;
  for (const key of ["id", "requestId"]) {
    const value = details[key];
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function decodeDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("Browser observation screenshot is not a base64 data URL.");
  return {
    mimeType: match[1] || "image/png",
    buffer: Buffer.from(match[2] ?? "", "base64"),
  };
}

function scaleFrame(frame: BuiltInBrowserFrame, scale: number): BuiltInBrowserFrame {
  const normalizedScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    x: frame.x * normalizedScale,
    y: frame.y * normalizedScale,
    width: frame.width * normalizedScale,
    height: frame.height * normalizedScale,
  };
}

function clipFrameToViewport(
  frame: BuiltInBrowserFrame,
  viewport: BuiltInBrowserFrame,
): BuiltInBrowserFrame {
  const x = Math.max(0, frame.x);
  const y = Math.max(0, frame.y);
  const right = Math.min(viewport.width, frame.x + frame.width);
  const bottom = Math.min(viewport.height, frame.y + frame.height);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function normalizeNodeMetadata(value: unknown): NodeMetadata {
  const record = isRecord(value) ? value : {};
  const frame = normalizeFrame(record.frame);
  const pixelRatio = finiteNumber(record.pixelRatio, 1);
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  const viewportRecord = isRecord(metadata.viewport) ? metadata.viewport : null;
  const viewport = {
    x: 0,
    y: 0,
    width: Math.max(0, finiteNumber(viewportRecord?.width, frame.width)),
    height: Math.max(0, finiteNumber(viewportRecord?.height, frame.height)),
  };
  return {
    tagName: stringOrNull(record.tagName),
    role: stringOrNull(record.role),
    label: stringOrNull(record.label),
    value: stringOrNull(record.value),
    selector: stringOrNull(record.selector),
    testId: stringOrNull(record.testId),
    text: stringOrNull(record.text),
    frame,
    viewport,
    pixelRatio: pixelRatio > 0 ? pixelRatio : 1,
    url: stringOrNull(record.url),
    title: stringOrNull(record.title),
    metadata,
  };
}

function buildComponentId(metadata: NodeMetadata): string {
  if (metadata.testId) return `testid:${metadata.testId}`;
  if (metadata.selector) return metadata.selector;
  if (metadata.tagName) return metadata.tagName;
  return "browser-element";
}

function parseInspectBindingPoint(params: unknown): BrowserInspectPoint | null {
  if (!isRecord(params)) return null;
  const bindingParams = params as CdpRuntimeBindingCalledParams;
  if (bindingParams.name !== INSPECT_BINDING_NAME || typeof bindingParams.payload !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bindingParams.payload);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "select") return null;
  const x = typeof parsed.x === "number" && Number.isFinite(parsed.x) ? Math.round(parsed.x) : null;
  const y = typeof parsed.y === "number" && Number.isFinite(parsed.y) ? Math.round(parsed.y) : null;
  if (x === null || y === null) return null;
  return { x, y };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    timeout.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function inspectOverlayCleanupScript(): string {
  return `
(() => {
  const current = window.__adeBuiltInBrowserInspector;
  if (current && typeof current.dispose === "function") {
    current.dispose();
  }
})();
`;
}

function inspectOverlayInstallScript(bindingName: string): string {
  const bindingLiteral = JSON.stringify(bindingName);
  return `
(() => {
  const bindingName = ${bindingLiteral};
  const existing = window.__adeBuiltInBrowserInspector;
  if (existing && typeof existing.dispose === "function") {
    existing.dispose();
  }

  const host = document.body || document.documentElement;
  if (!host) return;

  const overlay = document.createElement("div");
  overlay.setAttribute("data-ade-browser-inspector", "true");
  Object.assign(overlay.style, {
    position: "fixed",
    left: "0px",
    top: "0px",
    width: "0px",
    height: "0px",
    opacity: "0",
    pointerEvents: "none",
    border: "2px solid rgba(168, 85, 247, 0.98)",
    boxSizing: "border-box",
    borderRadius: "3px",
    background: "rgba(168, 85, 247, 0.08)",
    boxShadow: "0 0 0 1px rgba(168, 85, 247, 0.35), 0 10px 28px rgba(88, 28, 135, 0.22)",
    transform: "translate3d(0, 0, 0)",
    transition: "transform 90ms cubic-bezier(0.2, 0.8, 0.2, 1), width 90ms cubic-bezier(0.2, 0.8, 0.2, 1), height 90ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 70ms ease",
    zIndex: "2147483647"
  });
  host.appendChild(overlay);

  const root = document.documentElement;
  const previousCursor = root ? root.style.cursor : "";
  if (root) root.style.cursor = "crosshair";

  let disposed = false;
  let selected = false;
  const interactiveSelector = "button,a,input,select,textarea,summary,[role='button'],[role='link'],[role='menuitem'],[role='tab'],[role='checkbox'],[role='radio'],[role='switch']";
  const inlineOrDecorativeTags = new Set(["span", "strong", "em", "small", "b", "i", "svg", "path", "g", "use", "rect", "circle", "line", "polyline", "polygon"]);
  const svgChildTags = new Set(["path", "g", "use", "rect", "circle", "line", "polyline", "polygon"]);

  const rectContainsPoint = (rect, point) => (
    rect
    && rect.width > 0
    && rect.height > 0
    && point.x >= rect.left
    && point.x <= rect.right
    && point.y >= rect.top
    && point.y <= rect.bottom
  );

  const containsPoint = (node, point) => {
    if (!node || typeof node.getClientRects !== "function") return false;
    for (const rect of Array.from(node.getClientRects())) {
      if (rectContainsPoint(rect, point)) return true;
    }
    const rect = typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null;
    return rectContainsPoint(rect, point);
  };

  const visibleAtPoint = (node, point) => {
    if (!node || node === overlay || !containsPoint(node, point)) return false;
    const style = window.getComputedStyle(node);
    return style.display !== "none"
      && style.visibility !== "hidden"
      && style.pointerEvents !== "none"
      && Number(style.opacity || "1") > 0.01;
  };

  const areaFor = (node) => {
    const rect = node.getBoundingClientRect();
    return Math.max(1, rect.width * rect.height);
  };

  const depthFor = (node) => {
    let depth = 0;
    let current = node;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      depth += 1;
      current = current.parentElement;
    }
    return depth;
  };

  const normalizeCandidate = (node, point) => {
    const tagName = (node.localName || node.tagName || "").toLowerCase();
    if (inlineOrDecorativeTags.has(tagName)) {
      const control = node.closest(interactiveSelector);
      if (control && visibleAtPoint(control, point)) return control;
      if (svgChildTags.has(tagName)) {
        const svg = node.closest("svg");
        if (svg && visibleAtPoint(svg, point)) return svg;
      }
    }
    return node;
  };

  const qualityFor = (node) => {
    if (node.matches(interactiveSelector)) return 0;
    if (node.matches("[data-testid],[data-test-id],[data-cy],[aria-label],[aria-labelledby],[role]")) return 1;
    const tagName = (node.localName || node.tagName || "").toLowerCase();
    if (["img", "svg", "canvas", "video", "iframe"].includes(tagName)) return 2;
    if ((node.innerText || node.textContent || "").replace(/\\s+/g, " ").trim()) return 3;
    return 4;
  };

  const smallestElementAtPoint = (fallback, point) => {
    if (!fallback || !point) return fallback;
    const candidates = [];
    const seen = new Set();
    const addCandidate = (node) => {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
      const normalized = normalizeCandidate(node, point);
      if (!normalized || seen.has(normalized) || !visibleAtPoint(normalized, point)) return;
      seen.add(normalized);
      candidates.push({
        node: normalized,
        area: areaFor(normalized),
        depth: depthFor(normalized),
        quality: qualityFor(normalized)
      });
    };
    const visitRoot = (rootNode) => {
      const stack = [rootNode];
      let visited = 0;
      while (stack.length && visited < 1200) {
        const node = stack.pop();
        visited += 1;
        if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
        if (!visibleAtPoint(node, point)) continue;
        addCandidate(node);
        const children = Array.from(node.children || []);
        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack.push(children[index]);
        }
      }
    };
    visitRoot(fallback);
    const hits = typeof document.elementsFromPoint === "function"
      ? document.elementsFromPoint(point.x, point.y)
      : [];
    for (const hit of hits) {
      if (hit === overlay) continue;
      addCandidate(hit);
      visitRoot(hit);
      let current = hit.parentElement;
      while (current && current !== document.documentElement) {
        addCandidate(current);
        current = current.parentElement;
      }
    }
    if (!candidates.length) return fallback;
    candidates.sort((a, b) => (
      a.area - b.area
      || a.quality - b.quality
      || b.depth - a.depth
    ));
    return candidates[0].node || fallback;
  };

  const pointFromEvent = (event) => ({
    x: Math.round(event.clientX),
    y: Math.round(event.clientY)
  });

  const moveOutline = (point) => {
    if (disposed || selected) return;
    const fallback = document.elementFromPoint(point.x, point.y);
    const element = smallestElementAtPoint(fallback, point);
    if (!element || element === overlay) {
      overlay.style.opacity = "0";
      return;
    }
    const rect = element.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      overlay.style.opacity = "0";
      return;
    }
    overlay.style.opacity = "1";
    overlay.style.transform = "translate3d(" + Math.round(rect.left) + "px, " + Math.round(rect.top) + "px, 0)";
    overlay.style.width = Math.max(1, Math.round(rect.width)) + "px";
    overlay.style.height = Math.max(1, Math.round(rect.height)) + "px";
  };

  const onMove = (event) => {
    moveOutline(pointFromEvent(event));
  };

  const sendSelection = (point) => {
    const binding = window[bindingName];
    if (typeof binding !== "function") return;
    binding(JSON.stringify({ type: "select", x: point.x, y: point.y }));
  };

  const onSelect = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (selected) return;
    const point = pointFromEvent(event);
    moveOutline(point);
    selected = true;
    sendSelection(point);
  };

  const swallowAfterSelect = (event) => {
    if (!selected) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  document.addEventListener("pointermove", onMove, true);
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("pointerdown", onSelect, true);
  document.addEventListener("mousedown", onSelect, true);
  document.addEventListener("click", swallowAfterSelect, true);

  window.__adeBuiltInBrowserInspector = {
    dispose() {
      if (disposed) return;
      disposed = true;
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("pointerdown", onSelect, true);
      document.removeEventListener("mousedown", onSelect, true);
      document.removeEventListener("click", swallowAfterSelect, true);
      if (root) root.style.cursor = previousCursor;
      overlay.remove();
      if (window.__adeBuiltInBrowserInspector === this) {
        delete window.__adeBuiltInBrowserInspector;
      }
    }
  };
})();
`;
}

const NODE_METADATA_FUNCTION = String.raw`
function(pointArg) {
  const original = this;
  const originalElement = original && original.nodeType === Node.ELEMENT_NODE
    ? original
    : original && original.parentElement
      ? original.parentElement
      : null;
  const finiteNumber = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const inspectPoint = pointArg && typeof pointArg === "object"
    ? { x: finiteNumber(pointArg.x), y: finiteNumber(pointArg.y) }
    : null;
  const hasInspectPoint = inspectPoint && inspectPoint.x !== null && inspectPoint.y !== null;
  const rectContainsPoint = (rect, point) => (
    rect
    && rect.width > 0
    && rect.height > 0
    && point.x >= rect.left
    && point.x <= rect.right
    && point.y >= rect.top
    && point.y <= rect.bottom
  );
  const containsPoint = (node, point) => {
    if (!node || typeof node.getClientRects !== "function") return false;
    for (const rect of Array.from(node.getClientRects())) {
      if (rectContainsPoint(rect, point)) return true;
    }
    const rect = typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null;
    return rectContainsPoint(rect, point);
  };
  const visibleAtPoint = (node, point) => {
    if (!containsPoint(node, point)) return false;
    const style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none" && Number(style.opacity || "1") > 0.01;
  };
  const areaFor = (node) => {
    const rect = node.getBoundingClientRect();
    return Math.max(1, rect.width * rect.height);
  };
  const depthFor = (node) => {
    let depth = 0;
    let current = node;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      depth += 1;
      current = current.parentElement;
    }
    return depth;
  };
  const interactiveSelector = "button,a,input,select,textarea,summary,[role='button'],[role='link'],[role='menuitem'],[role='tab'],[role='checkbox'],[role='radio'],[role='switch']";
  const inlineOrDecorativeTags = new Set(["span", "strong", "em", "small", "b", "i", "svg", "path", "g", "use", "rect", "circle", "line", "polyline", "polygon"]);
  const normalizeCandidate = (node, point) => {
    const tagName = (node.localName || node.tagName || "").toLowerCase();
    if (inlineOrDecorativeTags.has(tagName)) {
      const control = node.closest(interactiveSelector);
      if (control && visibleAtPoint(control, point)) return control;
      if (["path", "g", "use", "rect", "circle", "line", "polyline", "polygon"].includes(tagName)) {
        const svg = node.closest("svg");
        if (svg && visibleAtPoint(svg, point)) return svg;
      }
    }
    return node;
  };
  const qualityFor = (node) => {
    if (node.matches(interactiveSelector)) return 0;
    if (node.matches("[data-testid],[data-test-id],[data-cy],[aria-label],[aria-labelledby],[role]")) return 1;
    const tagName = (node.localName || node.tagName || "").toLowerCase();
    if (["img", "svg", "canvas", "video", "iframe"].includes(tagName)) return 2;
    if ((node.innerText || node.textContent || "").replace(/\s+/g, " ").trim()) return 3;
    return 4;
  };
  const smallestElementAtPoint = (fallback, point) => {
    if (!fallback || !point) return fallback;
    const candidates = [];
    const seen = new Set();
    const addCandidate = (node) => {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
      const normalized = normalizeCandidate(node, point);
      if (!normalized || seen.has(normalized) || !visibleAtPoint(normalized, point)) return;
      seen.add(normalized);
      candidates.push({
        node: normalized,
        area: areaFor(normalized),
        depth: depthFor(normalized),
        quality: qualityFor(normalized)
      });
    };
    const visitRoot = (root) => {
      const stack = [root];
      let visited = 0;
      while (stack.length && visited < 1200) {
        const node = stack.pop();
        visited += 1;
        if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
        if (!visibleAtPoint(node, point)) continue;
        addCandidate(node);
        const children = Array.from(node.children || []);
        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack.push(children[index]);
        }
      }
    };
    visitRoot(fallback);
    const hits = typeof document.elementsFromPoint === "function"
      ? document.elementsFromPoint(point.x, point.y)
      : [];
    for (const hit of hits) {
      addCandidate(hit);
      visitRoot(hit);
      let current = hit.parentElement;
      while (current && current !== document.documentElement) {
        addCandidate(current);
        current = current.parentElement;
      }
    }
    if (!candidates.length) return fallback;
    candidates.sort((a, b) => (
      a.area - b.area
      || a.quality - b.quality
      || b.depth - a.depth
    ));
    return candidates[0].node || fallback;
  };
  const element = hasInspectPoint
    ? smallestElementAtPoint(originalElement, inspectPoint)
    : originalElement;
  if (!element) {
    return {
      tagName: null,
      role: null,
      label: null,
      value: null,
      selector: null,
      testId: null,
      text: null,
      frame: { x: 0, y: 0, width: 0, height: 0 },
      pixelRatio: window.devicePixelRatio || 1,
      url: location.href,
      title: document.title,
      metadata: { nodeType: original ? original.nodeType : null, hitTest: hasInspectPoint ? { x: inspectPoint.x, y: inspectPoint.y, strategy: "none" } : null }
    };
  }

  const escapeIdent = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  };
  const quoteAttr = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  const selectorFor = (node) => {
    const parts = [];
    let current = node;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
      let part = current.localName || current.tagName.toLowerCase();
      const testId = current.getAttribute("data-testid")
        || current.getAttribute("data-test-id")
        || current.getAttribute("data-cy");
      if (current.id) {
        part += "#" + escapeIdent(current.id);
        parts.unshift(part);
        break;
      }
      if (testId) {
        part += "[data-testid=\"" + quoteAttr(testId) + "\"]";
        parts.unshift(part);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((candidate) => candidate.localName === current.localName);
        if (siblings.length > 1) {
          part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
        }
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  };
  const attributes = {};
  for (const attr of Array.from(element.attributes || [])) {
    if (Object.keys(attributes).length >= 80) break;
    attributes[attr.name] = attr.value;
  }
  const labelledBy = element.getAttribute("aria-labelledby");
  const labelledByText = labelledBy
    ? labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    : "";
  const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500);
  const ariaLabel = element.getAttribute("aria-label") || labelledByText || "";
  const title = element.getAttribute("title") || "";
  const label = (ariaLabel || title || text || element.getAttribute("alt") || element.getAttribute("name") || "").slice(0, 300) || null;
  const rect = element.getBoundingClientRect();
  const testId = element.getAttribute("data-testid")
    || element.getAttribute("data-test-id")
    || element.getAttribute("data-cy")
    || null;
  const isPasswordInput = element.tagName === "INPUT"
    && typeof element.type === "string"
    && element.type.toLowerCase() === "password";
  const value = isPasswordInput
    ? null
    : "value" in element ? String(element.value).slice(0, 300) : null;
  return {
    tagName: element.tagName ? element.tagName.toLowerCase() : null,
    role: element.getAttribute("role"),
    label,
    value,
    selector: selectorFor(element),
    testId,
    text,
    frame: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    },
    pixelRatio: window.devicePixelRatio || 1,
    url: location.href,
    title: document.title,
    metadata: {
      tagName: element.tagName ? element.tagName.toLowerCase() : null,
      role: element.getAttribute("role"),
      label,
      value,
      selector: selectorFor(element),
      testId,
      text,
      attributes,
      href: element instanceof HTMLAnchorElement ? element.href : null,
      inputType: element instanceof HTMLInputElement ? element.type : null,
      disabled: "disabled" in element ? Boolean(element.disabled) : null,
      checked: "checked" in element ? Boolean(element.checked) : null,
      hitTest: hasInspectPoint ? {
        x: inspectPoint.x,
        y: inspectPoint.y,
        strategy: "smallest-visible-descendant",
        originalTagName: originalElement && originalElement.tagName ? originalElement.tagName.toLowerCase() : null,
        selectedTagName: element.tagName ? element.tagName.toLowerCase() : null
      } : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY }
    }
  };
}
`;
