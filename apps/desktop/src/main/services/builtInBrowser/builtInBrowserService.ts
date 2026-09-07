import { existsSync } from "node:fs";
import * as electronModule from "electron";
import { WebContentsView, app, nativeImage, screen, session, webContents as electronWebContents } from "electron";
import type { BrowserWindow, DownloadItem, WebContents } from "electron";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  BuiltInBrowserActionTraceEntry,
  BuiltInBrowserAgentActionArgs,
  BuiltInBrowserAgentActionResult,
  BuiltInBrowserAttachWebviewArgs,
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
  BuiltInBrowserExportHarArgs,
  BuiltInBrowserExportHarResult,
  BuiltInBrowserFindInPageArgs,
  BuiltInBrowserFindInPageResult,
  BuiltInBrowserHoverArgs,
  BuiltInBrowserNetworkLogArgs,
  BuiltInBrowserNetworkLogEntry,
  BuiltInBrowserNetworkLoggingResult,
  BuiltInBrowserNetworkLogResult,
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
import { BUILT_IN_BROWSER_PREVIEW_JPEG_QUALITY } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { isRecord } from "../shared/utils";
import {
  BUILT_IN_BROWSER_PARTITION,
} from "./builtInBrowserConstants";
import { isAllowedNavigationUrl, normalizeBrowserUrl } from "./builtInBrowserNavigation";
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
  buildBuiltInBrowserHar,
  builtInBrowserUploadRoots,
  clampBuiltInBrowserZoomFactor,
  createBuiltInBrowserNetworkLog,
  filterBuiltInBrowserNetworkLog,
  normalizeBuiltInBrowserRecordingFps,
  normalizeBuiltInBrowserHeaders,
  normalizeNetworkLogLimit,
  resolveBuiltInBrowserUploadPaths,
  type BuiltInBrowserNetworkLogStore,
} from "./builtInBrowserCapabilities";
import {
  BUILT_IN_BROWSER_EMULATION_PRESETS,
  builtInBrowserEmulationMetrics,
  resolveBuiltInBrowserEmulation,
} from "../../../shared/builtInBrowserEmulation";
import { createBuiltInBrowserPreviewStreams } from "./builtInBrowserPreviewStream";
import {
  createBuiltInBrowserRecordingSession,
  createDisplayMediaRecorderFactory,
  type BuiltInBrowserRecorderFactory,
  type BuiltInBrowserRecordingSession,
  type CaptureWindowLike,
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
const DEFAULT_FIND_IN_PAGE_TIMEOUT_MS = 5_000;
const MAX_FIND_IN_PAGE_TIMEOUT_MS = 30_000;
const MAX_DRAG_STEPS = 50;
const DEFAULT_DRAG_STEPS = 8;
const MAX_UPLOAD_FILE_COUNT = 20;
const RECORDING_CACHE_DIR = "recordings";
const BROWSER_RECORDER_PARTITION = "ade-browser-recorder";
const DISPLAY_MEDIA_ARM_TTL_MS = 10_000;
const OBSERVATION_CACHE_DIR = path.join(".ade", "cache", "browser-observations");
const INSPECT_BINDING_NAME = "__adeBuiltInBrowserInspectSelect";
const DOWNLOAD_FILENAME_UNSAFE_RE = /[<>:"/\\|?*\x00-\x1F]/g;
const RESERVED_BROWSER_DOWNLOAD_PATH_KEYS = new Set<string>();
const MANAGED_BROWSER_WEB_CONTENTS = new WeakSet<WebContents>();
// Resolved lazily (and defensively) rather than as a named import: unit-test
// `electron` mocks omit BrowserWindow, and only the recording path needs it.
function electronBrowserWindowCtor(): (new (options: Record<string, unknown>) => unknown) | null {
  try {
    return (electronModule as unknown as {
      BrowserWindow?: new (options: Record<string, unknown>) => unknown;
    }).BrowserWindow ?? null;
  } catch {
    return null;
  }
}

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

type CdpRuntimeEvaluateResponse = CdpCallFunctionResponse;

type CdpRuntimeEvaluateObjectResponse = {
  result?: {
    objectId?: string;
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

type BrowserTabState = {
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
  debuggerHolds: Set<"network">;
  cdpListener: DebuggerMessageListener | null;
  findRequestId: number | null;
};

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

type BuiltInBrowserElementTargetInput = BuiltInBrowserObservationArgs & BuiltInBrowserElementTargetArgs;
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
  const key = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return {
    key: `project-${key}`,
    projectRoot: normalized,
  };
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
    const normalizedLeft = normalizedProjectRoot(left);
    const normalizedRight = normalizedProjectRoot(right);
    return Boolean(normalizedLeft && normalizedLeft === normalizedRight);
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
    attachWebview(input: BuiltInBrowserAttachWebviewArgs, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserStatus> {
      return serviceForInput(input, sourceWindow).attachWebview(input);
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
  let tabs: BrowserTabState[] = [];
  let browserSessions: BrowserSessionState[] = [];
  let activeTabId: string | null = null;
  let bounds: BuiltInBrowserFrame = { x: 0, y: 0, width: 0, height: 0 };
  let visible = false;
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
  const configuredDisplayMediaSessions = new WeakSet<Electron.Session>();
  const armedDisplayMediaFrames = new Map<number, { target: WebContents; expiresAt: number }>();
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
      sanitizePathSegment(args.collection.key),
      sanitizePathSegment(tab.id),
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
    if (!tab) throw new Error(emptyMessage);
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
  const emitTabDiagnostics = (tab: BrowserTabState): void => {
    emit({
      type: "diagnostics",
      tabId: tab.id,
      consoleErrorCount: tab.consoleErrorCount,
      failedRequestCount: tab.failedRequestCount,
      updatedAt: new Date().toISOString(),
    });
  };

  /** A navigation is a fresh page, so its predecessor's errors stop counting. */
  const resetTabDiagnosticCounts = (tab: BrowserTabState): void => {
    if (tab.consoleErrorCount === 0 && tab.failedRequestCount === 0) return;
    tab.consoleErrorCount = 0;
    tab.failedRequestCount = 0;
    emitTabDiagnostics(tab);
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
    wc.on("did-navigate", () => {
      const tab = tabForWebContents(wc);
      notifyTabActivity(tab);
      if (tab) resetTabDiagnosticCounts(tab);
      if (tab?.id === lastSelectedTabId) {
        clearSelectionInternal();
      }
      // Chromium tracks zoom per origin, so a cross-origin navigation drops the
      // tab's zoom. Re-apply the tab's own factor so the setting is per tab.
      if (tab && tab.zoomFactor !== BUILT_IN_BROWSER_DEFAULT_ZOOM_FACTOR) applyTabZoom(tab, tab.zoomFactor);
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
    const visibleTabIds = new Set(
      tabs
        .filter((tab) => !tab.webContents.isDestroyed() && tabMatchesOwnerInput(tab, identity))
        .map((tab) => tab.id),
    );
    const scopedTabs = status.tabs.filter((tab) => visibleTabIds.has(tab.id));
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
    const unchanged = (
      normalized.x === bounds.x
      && normalized.y === bounds.y
      && normalized.width === bounds.width
      && normalized.height === bounds.height
      && nextVisible === visible
    );
    if (unchanged) return scopeStatusForInput(getStatus(), nextBounds);
    bounds = normalized;
    visible = nextVisible;
    if (visible || tabs.length) {
      if (visible) ensureActiveTab();
      attachViewsToCurrentWindow();
    }
    emitStatus();
    return scopeStatusForInput(getStatus(), nextBounds);
  }

  async function attachWebview(input: BuiltInBrowserAttachWebviewArgs): Promise<BuiltInBrowserStatus> {
    const tabId = input.tabId?.trim();
    if (!tabId) throw new Error("Browser tab id is required.");
    const tab = tabs.find((entry) => entry.id === tabId);
    if (!tab) throw new Error(`Browser tab not found: ${tabId}`);

    const nextWebContents = electronWebContents.fromId(input.webContentsId);
    if (!nextWebContents || nextWebContents.isDestroyed()) {
      throw new Error("Browser webview is not available.");
    }
    if (nextWebContents.session !== browserSessionForProfile()) {
      throw new Error("Browser webview partition does not match the global ADE browser profile.");
    }

    configureBrowserSession();
    configureBrowserWebContents(nextWebContents);

    if (tab.webContents.id === nextWebContents.id && !tab.ownsWebContents && !tab.view) {
      attachViewsToCurrentWindow();
      emitStatus();
      return scopeStatusForInput(getStatus(), input);
    }

    if (tab.id === activeTabId) {
      await stopInspectQuietly("built_in_browser.attach_webview_stop_inspect_failed");
    }

    const previousView = tab.view;
    const previousWebContents = tab.webContents;
    const previousOwned = tab.ownsWebContents;

    if (previousView && win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(previousView);
      } catch {
        // ignore stale view/window links
      }
    }

    tab.view = null;
    tab.webContents = nextWebContents;
    tab.ownsWebContents = false;
    if (previousWebContents.id !== nextWebContents.id) {
      MANAGED_BROWSER_WEB_CONTENTS.delete(previousWebContents);
    }
    if (!activeTabId) activeTabId = tab.id;

    if (previousOwned && previousWebContents.id !== nextWebContents.id && !previousWebContents.isDestroyed()) {
      try {
        previousWebContents.close();
      } catch {
        // ignore shutdown races
      }
    }

    clearSelectionInternal();
    attachViewsToCurrentWindow();
    emitStatus();
    return scopeStatusForInput(getStatus(), input);
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
      previewStreams.stopTab(removed.id);
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
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before reloading.");
    await prepareAgentReadTabAsync(tab, input, "The agent requested access to reload this browser tab.");
    reclaimTabForHumanNavigation(tab, input);
    armAgentNavigationGuard(tab, input);
    tab.webContents.reload();
    emitStatus();
    return scopeStatusForInput(getStatus(), input);
  }

  async function goBack(input: BuiltInBrowserTabTargetArgs = {}): Promise<BuiltInBrowserStatus> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before navigating back.");
    await prepareAgentReadTabAsync(tab, input, "The agent requested backward navigation in this browser tab.");
    reclaimTabForHumanNavigation(tab, input);
    armAgentNavigationGuard(tab, input);
    const wc = tab.webContents;
    if (wc.canGoBack()) wc.goBack();
    emitStatus();
    return scopeStatusForInput(getStatus(), input);
  }

  async function goForward(input: BuiltInBrowserTabTargetArgs = {}): Promise<BuiltInBrowserStatus> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before navigating forward.");
    await prepareAgentReadTabAsync(tab, input, "The agent requested forward navigation in this browser tab.");
    reclaimTabForHumanNavigation(tab, input);
    armAgentNavigationGuard(tab, input);
    const wc = tab.webContents;
    if (wc.canGoForward()) wc.goForward();
    emitStatus();
    return scopeStatusForInput(getStatus(), input);
  }

  async function stop(input: BuiltInBrowserTabTargetArgs = {}): Promise<BuiltInBrowserStatus> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before stopping a load.");
    await prepareAgentReadTabAsync(tab, input, "The agent requested access to stop this browser tab.");
    const wc = tab.webContents;
    if (wc.isLoading()) wc.stop();
    emitStatus();
    return scopeStatusForInput(getStatus(), input);
  }

  async function startInspect(input: BuiltInBrowserTabTargetArgs = {}): Promise<BuiltInBrowserStatus> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before starting inspect.");
    await prepareAgentReadTabAsync(tab, input, "The agent requested DOM inspection for this browser tab.");
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
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before capturing a screenshot.");
    await prepareAgentReadTabAsync(tab, input, "The agent requested a screenshot of this browser tab.");
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
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before observing.");
    await prepareAgentReadTabAsync(tab, input, "The agent requested page content from this browser tab.");
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
      const event = keyEventForInput(key);
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
        handleNetworkCdpEvent(tab, method, params);
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
    owner: "network",
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
    owner: "network",
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
    if (tab.recording) {
      tab.recording.abort();
      tab.recording = null;
    }
    tab.networkLoggingEnabled = false;
    tab.networkLogPending.clear();
    tab.debuggerHolds.clear();
    removeTabCdpListener(tab);
  };

  /* ── Device emulation ──────────────────────────────────────────────────── */

  async function setEmulation(
    input: BuiltInBrowserSetEmulationArgs,
  ): Promise<BuiltInBrowserEmulationResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before setting device emulation.");
    await prepareAgentReadTabAsync(tab, input, "The agent requested device emulation for this browser tab.");
    const next = resolveBuiltInBrowserEmulation(input);
    const wc = tab.webContents;
    const traceDraft = beginActionTrace(tab, "setEmulation", input as Record<string, unknown>);
    try {
      await withTemporaryDebugger(wc, async () => {
        await sendDebuggerCommand(wc, "Emulation.setTouchEmulationEnabled", {
          enabled: next?.hasTouch ?? false,
          maxTouchPoints: next?.hasTouch ? 5 : 1,
        }).catch(() => {});
        if (!next) {
          await sendDebuggerCommand(wc, "Emulation.clearDeviceMetricsOverride");
          // CDP has no "clear UA override"; an empty string is Chromium's reset.
          await sendDebuggerCommand(wc, "Emulation.setUserAgentOverride", { userAgent: "" }).catch(() => {});
          return;
        }
        const metrics = builtInBrowserEmulationMetrics(next);
        await sendDebuggerCommand(wc, "Emulation.setDeviceMetricsOverride", {
          width: metrics.width,
          height: metrics.height,
          deviceScaleFactor: metrics.deviceScaleFactor,
          mobile: metrics.mobile,
        });
        if (next.userAgent) {
          await sendDebuggerCommand(wc, "Emulation.setUserAgentOverride", {
            userAgent: next.userAgent,
          }).catch(() => {});
        }
      });
      tab.emulation = next;
      finishActionTrace(tab, traceDraft, "ok");
    } catch (error) {
      finishActionTrace(tab, traceDraft, "error", { error });
      throw error;
    }
    emitStatus();
    return {
      tabId: tab.id,
      emulation: next,
      presets: [...BUILT_IN_BROWSER_EMULATION_PRESETS],
      status: scopeStatusForInput(getStatus(), input),
    };
  }

  /* ── Zoom ──────────────────────────────────────────────────────────────── */

  async function setZoom(input: BuiltInBrowserSetZoomArgs): Promise<BuiltInBrowserZoomResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before zooming.");
    await prepareAgentReadTabAsync(tab, input, "The agent requested a zoom change for this browser tab.");
    const factor = input.reset === true
      ? BUILT_IN_BROWSER_DEFAULT_ZOOM_FACTOR
      : clampBuiltInBrowserZoomFactor(input.factor);
    applyTabZoom(tab, factor);
    tab.zoomFactor = factor;
    emitStatus();
    return {
      tabId: tab.id,
      zoomFactor: factor,
      status: scopeStatusForInput(getStatus(), input),
    };
  }

  const applyTabZoom = (tab: BrowserTabState, factor: number): void => {
    const wc = tab.webContents;
    if (wc.isDestroyed()) return;
    try {
      wc.setZoomFactor(factor);
    } catch (error) {
      logger()?.debug("built_in_browser.set_zoom_failed", {
        tabId: tab.id,
        err: errorMessage(error),
      });
    }
  };

  /* ── Find in page ──────────────────────────────────────────────────────── */

  async function findInPage(
    input: BuiltInBrowserFindInPageArgs,
  ): Promise<BuiltInBrowserFindInPageResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before searching it.");
    await prepareAgentReadTabAsync(tab, input, "The agent requested an in-page text search.");
    const text = stringOrNull(input.text);
    if (!text) throw new Error("Find text is required.");
    const wc = tab.webContents;
    const timeoutMs = Math.min(
      MAX_FIND_IN_PAGE_TIMEOUT_MS,
      Math.max(250, optionalFiniteNumber(input.timeoutMs) ?? DEFAULT_FIND_IN_PAGE_TIMEOUT_MS),
    );
    const traceDraft = beginActionTrace(tab, "findInPage", input as Record<string, unknown>);
    try {
      const result = await new Promise<Electron.Result>((resolve, reject) => {
        let requestId: number | null = null;
        let settled = false;
        const timer = setTimeout(() => {
          finish();
          reject(new Error(`Timed out waiting for browser find results after ${timeoutMs}ms.`));
        }, timeoutMs);
        const listener = (_event: unknown, found: Electron.Result): void => {
          if (requestId != null && found.requestId !== requestId) return;
          if (!found.finalUpdate) return;
          finish();
          resolve(found);
        };
        function finish(): void {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            (wc as unknown as { off: (event: string, fn: unknown) => void }).off?.("found-in-page", listener);
          } catch {
            // ignore listener detach races
          }
        }
        try {
          wc.on("found-in-page", listener as never);
          requestId = wc.findInPage(text, {
            forward: input.forward !== false,
            findNext: input.findNext === true,
            matchCase: input.matchCase === true,
          });
          tab.findRequestId = requestId;
        } catch (error) {
          finish();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      finishActionTrace(tab, traceDraft, "ok");
      return {
        tabId: tab.id,
        text,
        requestId: result.requestId,
        activeMatchOrdinal: result.activeMatchOrdinal ?? null,
        matches: result.matches ?? null,
        finalUpdate: Boolean(result.finalUpdate),
        status: scopeStatusForInput(getStatus(), input),
      };
    } catch (error) {
      finishActionTrace(tab, traceDraft, "error", { error });
      throw error;
    }
  }

  async function stopFindInPage(
    input: BuiltInBrowserStopFindInPageArgs = {},
  ): Promise<BuiltInBrowserStopFindInPageResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before stopping a find.");
    await prepareAgentReadTabAsync(tab, input, "The agent requested to stop an in-page text search.");
    const action = input.action === "keepSelection" || input.action === "activateSelection"
      ? input.action
      : "clearSelection";
    try {
      tab.webContents.stopFindInPage(action);
    } catch (error) {
      logger()?.debug("built_in_browser.stop_find_failed", { err: errorMessage(error) });
    }
    tab.findRequestId = null;
    return {
      tabId: tab.id,
      stopped: true,
      status: scopeStatusForInput(getStatus(), input),
    };
  }

  /* ── DevTools ──────────────────────────────────────────────────────────── */

  async function setDevTools(
    input: BuiltInBrowserSetDevToolsArgs,
  ): Promise<BuiltInBrowserDevToolsResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before toggling DevTools.");
    await prepareAgentReadTabAsync(tab, input, "The agent requested DevTools for this browser tab.");
    const wc = tab.webContents;
    const mode: BuiltInBrowserDevToolsMode = input.mode === "bottom" || input.mode === "detach"
      ? input.mode
      : "right";
    const traceDraft = beginActionTrace(tab, "setDevTools", input as Record<string, unknown>);
    try {
      if (input.open) {
        // DevTools and the CDP debugger cannot own the same target, so opening
        // DevTools would silently kill an in-flight network log. Recording is
        // unaffected: it captures through getDisplayMedia, not the debugger.
        if (tab.debuggerHolds.size > 0) {
          throw new Error(
            `Browser tab ${tab.id} is network logging, which owns the debugger. Run \`setNetworkLogging { enabled: false }\` before opening DevTools.`,
          );
        }
        wc.openDevTools({ mode });
        tab.devToolsMode = mode;
      } else {
        wc.closeDevTools();
        tab.devToolsMode = null;
      }
      finishActionTrace(tab, traceDraft, "ok");
    } catch (error) {
      finishActionTrace(tab, traceDraft, "error", { error });
      throw error;
    }
    // DevTools is a human affordance; leave a breadcrumb whenever it is driven
    // from an agent-bound call so the audit trail shows who opened it.
    logger()?.info("built_in_browser.devtools_toggled", {
      tabId: tab.id,
      open: Boolean(input.open),
      mode: input.open ? mode : null,
      laneId: stringOrNull((input as { laneId?: string | null }).laneId),
      chatSessionId: stringOrNull((input as { chatSessionId?: string | null }).chatSessionId),
    });
    emitStatus();
    return {
      tabId: tab.id,
      devToolsOpen: tab.devToolsMode !== null,
      mode: tab.devToolsMode,
      status: scopeStatusForInput(getStatus(), input),
    };
  }

  /* ── Full network log ──────────────────────────────────────────────────── */

  // CDP `Network.*` is used rather than Electron's `webRequest` API because it
  // is the only source that carries request/response headers, protocol,
  // per-phase timings, mime type, cache hits and encoded sizes — everything HAR
  // 1.2 needs. `webRequest` is also session-global (it already backs the
  // always-on failure list), so building the opt-in per-tab log on top of it
  // would mean filtering a shared firehose and still missing headers/timings.
  const handleNetworkCdpEvent = (
    tab: BrowserTabState,
    method: string,
    params: unknown,
  ): void => {
    if (!tab.networkLoggingEnabled || !isRecord(params)) return;
    const requestId = stringOrNull(params.requestId);
    if (!requestId) return;
    const nowMs = Date.now();
    if (method === "Network.requestWillBeSent") {
      const request = isRecord(params.request) ? params.request : {};
      const entry: BuiltInBrowserNetworkLogEntry = {
        id: requestId,
        method: stringOrNull(request.method),
        url: stringOrNull(request.url) ?? "about:blank",
        status: null,
        statusText: null,
        mimeType: null,
        resourceType: stringOrNull(params.type),
        protocol: null,
        fromCache: false,
        requestHeaders: normalizeBuiltInBrowserHeaders(request.headers),
        responseHeaders: [],
        requestBodySize: typeof request.postData === "string" ? request.postData.length : null,
        responseBodySize: null,
        responseHeaderSize: null,
        timings: {
          startedAt: new Date(nowMs).toISOString(),
          endedAt: null,
          durationMs: null,
          waitMs: null,
          receiveMs: null,
        },
        error: null,
      };
      tab.networkLogPending.set(requestId, entry);
      tab.networkLog.upsert(entry);
      return;
    }
    const existing = tab.networkLogPending.get(requestId) ?? tab.networkLog.find(requestId);
    if (!existing) return;
    if (method === "Network.responseReceived") {
      const response = isRecord(params.response) ? params.response : {};
      const startedAtMs = Date.parse(existing.timings.startedAt);
      const next: BuiltInBrowserNetworkLogEntry = {
        ...existing,
        status: optionalFiniteNumber(response.status),
        statusText: stringOrNull(response.statusText),
        mimeType: stringOrNull(response.mimeType),
        protocol: stringOrNull(response.protocol),
        fromCache: response.fromDiskCache === true || response.fromPrefetchCache === true,
        responseHeaders: normalizeBuiltInBrowserHeaders(response.headers),
        responseHeaderSize: optionalFiniteNumber(response.encodedDataLength),
        resourceType: stringOrNull(params.type) ?? existing.resourceType,
        timings: {
          ...existing.timings,
          waitMs: Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : null,
        },
      };
      tab.networkLogPending.set(requestId, next);
      tab.networkLog.upsert(next);
      return;
    }
    if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      const startedAtMs = Date.parse(existing.timings.startedAt);
      const durationMs = Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : null;
      const waitMs = existing.timings.waitMs;
      const next: BuiltInBrowserNetworkLogEntry = {
        ...existing,
        responseBodySize: method === "Network.loadingFinished"
          ? optionalFiniteNumber(params.encodedDataLength) ?? existing.responseBodySize
          : existing.responseBodySize,
        error: method === "Network.loadingFailed"
          ? stringOrNull(params.errorText) ?? "request failed"
          : existing.error,
        timings: {
          ...existing.timings,
          endedAt: new Date(nowMs).toISOString(),
          durationMs,
          receiveMs: durationMs != null && waitMs != null ? Math.max(0, durationMs - waitMs) : null,
        },
      };
      tab.networkLogPending.delete(requestId);
      tab.networkLog.upsert(next);
    }
  };

  async function setNetworkLogging(
    input: BuiltInBrowserSetNetworkLoggingArgs,
  ): Promise<BuiltInBrowserNetworkLoggingResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before changing network logging.");
    await prepareAgentReadTabAsync(tab, input, "The agent requested network logging for this browser tab.");
    const wc = tab.webContents;
    if (input.enabled) {
      if (input.clear !== false) {
        tab.networkLog.clear();
        tab.networkLogPending.clear();
      }
      await acquireDebuggerHold(tab, "network");
      try {
        await sendDebuggerCommand(wc, "Network.enable", {
          maxTotalBufferSize: 1_000_000,
          maxResourceBufferSize: 500_000,
        });
      } catch (error) {
        releaseDebuggerHold(tab, "network");
        throw error;
      }
      tab.networkLoggingEnabled = true;
    } else {
      if (tab.networkLoggingEnabled) {
        await sendDebuggerCommand(wc, "Network.disable").catch((error) => {
          logger()?.debug("built_in_browser.network_disable_failed", { err: errorMessage(error) });
        });
      }
      tab.networkLoggingEnabled = false;
      tab.networkLogPending.clear();
      releaseDebuggerHold(tab, "network");
    }
    emitStatus();
    return {
      tabId: tab.id,
      enabled: tab.networkLoggingEnabled,
      entryCount: tab.networkLog.size,
      status: scopeStatusForInput(getStatus(), input),
    };
  }

  async function getNetworkLog(
    input: BuiltInBrowserNetworkLogArgs = {},
  ): Promise<BuiltInBrowserNetworkLogResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before reading its network log.");
    await prepareAgentReadTabAsync(tab, input, "The agent requested the network log for this browser tab.");
    const all = tab.networkLog.list();
    const matched = filterBuiltInBrowserNetworkLog(all, input);
    const limit = normalizeNetworkLogLimit(input.limit);
    return {
      tabId: tab.id,
      enabled: tab.networkLoggingEnabled,
      recordedCount: all.length,
      droppedCount: tab.networkLog.droppedCount,
      matchedCount: matched.length,
      entries: matched.slice(-limit),
    };
  }

  async function exportHar(
    input: BuiltInBrowserExportHarArgs = {},
  ): Promise<BuiltInBrowserExportHarResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before exporting a HAR.");
    await prepareAgentReadTabAsync(tab, input, "The agent requested a HAR export for this browser tab.");
    if (!observationRelativeBasePath) {
      throw new Error("Browser HAR export is unavailable because no scratch root is configured.");
    }
    const entries = filterBuiltInBrowserNetworkLog(tab.networkLog.list(), input);
    if (entries.length === 0 && !tab.networkLoggingEnabled) {
      throw new Error(
        `Browser tab ${tab.id} has no recorded requests. Run network logging first (\`setNetworkLogging { enabled: true }\`).`,
      );
    }
    const exportedAt = new Date().toISOString();
    const har = buildBuiltInBrowserHar({
      entries,
      pageUrl: tab.webContents.isDestroyed() ? null : emptyToNull(tab.webContents.getURL()),
      pageTitle: tab.webContents.isDestroyed() ? null : emptyToNull(tab.webContents.getTitle()),
      creatorVersion: app.getVersion?.() ?? "0.0.0",
      exportedAt,
    });
    const dir = observationDirectory(tab);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `network-${Date.now()}.har`);
    await fs.writeFile(filePath, `${JSON.stringify(har, null, 2)}\n`, "utf8");
    return {
      tabId: tab.id,
      filePath,
      relativePath: path.relative(observationRelativeBasePath, filePath),
      entryCount: entries.length,
      exportedAt,
    };
  }

  /* ── Extra page actions ────────────────────────────────────────────────── */

  async function hover(input: BuiltInBrowserHoverArgs): Promise<BuiltInBrowserAgentActionResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before hovering.");
    return runTracedAgentAction(tab, "hover", input, async () => {
      const wc = tab.webContents;
      const { x, y } = await resolveClickTarget(tab, input as BuiltInBrowserClickArgs);
      await withTemporaryDebugger(wc, async () => {
        await sendDebuggerCommand(wc, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y,
          button: "none",
        });
      });
      emitStatus();
      return actionResult(tab, input);
    });
  }

  async function drag(input: BuiltInBrowserDragArgs): Promise<BuiltInBrowserAgentActionResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before dragging.");
    return runTracedAgentAction(tab, "drag", input, async () => {
      const wc = tab.webContents;
      const from = await resolveClickTarget(tab, input as BuiltInBrowserClickArgs);
      const to = await resolveDragDestination(tab, input);
      const steps = Math.min(
        MAX_DRAG_STEPS,
        Math.max(1, Math.floor(optionalFiniteNumber(input.steps) ?? DEFAULT_DRAG_STEPS)),
      );
      await withTemporaryDebugger(wc, async () => {
        await sendDebuggerCommand(wc, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: from.x,
          y: from.y,
          button: "none",
        });
        await sendDebuggerCommand(wc, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: from.x,
          y: from.y,
          button: "left",
          clickCount: 1,
        });
        for (let step = 1; step <= steps; step += 1) {
          const ratio = step / steps;
          await sendDebuggerCommand(wc, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: Math.round(from.x + (to.x - from.x) * ratio),
            y: Math.round(from.y + (to.y - from.y) * ratio),
            button: "left",
            buttons: 1,
          });
        }
        await sendDebuggerCommand(wc, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: to.x,
          y: to.y,
          button: "left",
          clickCount: 1,
        });
      });
      emitStatus();
      return actionResult(tab, input);
    });
  }

  const resolveDragDestination = async (
    tab: BrowserTabState,
    input: BuiltInBrowserDragArgs,
  ): Promise<{ x: number; y: number }> => {
    const toX = optionalFiniteNumber(input.toX);
    const toY = optionalFiniteNumber(input.toY);
    if (toX != null || toY != null) {
      if (toX == null || toY == null) {
        throw new Error("Browser drag requires both --to-x and --to-y when using coordinates.");
      }
      return { x: normalizeDimension(toX), y: normalizeDimension(toY) };
    }
    const destinationTarget: BuiltInBrowserClickArgs = {
      ...input,
      x: null,
      y: null,
      selector: input.toSelector ?? null,
      text: input.toText ?? null,
      testId: input.toTestId ?? null,
      elementIndex: input.toElementIndex ?? null,
      handle: input.toHandle ?? null,
    };
    if (!hasElementTarget(destinationTarget)) {
      throw new Error(
        "Browser drag requires a destination: --to-x/--to-y, --to-selector, --to-text-match, --to-test-id, --to-element, or --to-handle.",
      );
    }
    const resolved = await resolveClickTarget(tab, destinationTarget);
    return { x: resolved.x, y: resolved.y };
  };

  async function selectOption(
    input: BuiltInBrowserSelectOptionArgs,
  ): Promise<BuiltInBrowserAgentActionResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before selecting an option.");
    return runTracedAgentAction(tab, "selectOption", input, async () => {
      const value = typeof input.value === "string" ? input.value : null;
      const label = typeof input.label === "string" ? input.label : null;
      const index = optionalFiniteNumber(input.index);
      if (value == null && label == null && index == null) {
        throw new Error("Browser selectOption requires --value, --label, or --index.");
      }
      await focusElementTarget(tab, input, { select: false });
      const result = await evaluateFocusedElementScript(tab.webContents, SELECT_OPTION_FUNCTION, {
        value,
        label,
        index,
      });
      const record = isRecord(result) ? result : {};
      const error = stringOrNull(record.error);
      if (error) throw new Error(error);
      emitStatus();
      return actionResult(tab, input);
    });
  }

  async function uploadFile(
    input: BuiltInBrowserUploadFileArgs,
  ): Promise<BuiltInBrowserAgentActionResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before uploading a file.");
    return runTracedAgentAction(tab, "uploadFile", input, async () => {
      const roots = builtInBrowserUploadRoots({
        projectRoot: args.collection.projectRoot,
        observationRoot: observationRootPath,
        adeHome: null,
        tmpDir: os.tmpdir(),
      });
      const paths = resolveBuiltInBrowserUploadPaths(input.paths as readonly unknown[], roots);
      if (paths.length > MAX_UPLOAD_FILE_COUNT) {
        throw new Error(`Browser upload accepts at most ${MAX_UPLOAD_FILE_COUNT} files.`);
      }
      for (const filePath of paths) {
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat?.isFile()) throw new Error(`Browser upload path is not a readable file: ${filePath}`);
      }
      await focusElementTarget(tab, input, { select: false });
      const wc = tab.webContents;
      await withTemporaryDebugger(wc, async () => {
        await sendDebuggerCommand(wc, "DOM.enable");
        await sendDebuggerCommand(wc, "Runtime.enable");
        const objectId = await focusedElementObjectId(wc);
        try {
          await sendDebuggerCommand(wc, "DOM.setFileInputFiles", { files: paths, objectId });
        } finally {
          await sendDebuggerCommand(wc, "Runtime.releaseObject", { objectId }).catch(() => {});
        }
      });
      emitStatus();
      return actionResult(tab, input);
    });
  }

  const focusedElementObjectId = async (wc: WebContents): Promise<string> => {
    const response = await sendDebuggerCommand<CdpRuntimeEvaluateObjectResponse>(wc, "Runtime.evaluate", {
      expression: `(${DEEP_ACTIVE_ELEMENT_FUNCTION})()`,
      returnByValue: false,
      silent: true,
    });
    const objectId = response.result?.objectId;
    if (!objectId) throw new Error("Could not resolve the focused browser element.");
    return objectId;
  };

  const evaluateFocusedElementScript = async (
    wc: WebContents,
    functionSource: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> => {
    const expression = `(${functionSource})((${DEEP_ACTIVE_ELEMENT_FUNCTION})(), ${JSON.stringify(payload)})`;
    const response = await withTemporaryDebugger(wc, async () => {
      await sendDebuggerCommand(wc, "Runtime.enable");
      return sendDebuggerCommand<CdpRuntimeEvaluateResponse>(wc, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        silent: true,
      });
    });
    if (response.exceptionDetails) {
      throw new Error("Browser element script evaluation failed.");
    }
    return response.result?.value;
  };

  /* ── Live preview stream ───────────────────────────────────────────────── */

  /**
   * Refcounted `capturePage()` loops, one per watched tab.
   *
   * Only ever running while a surface has asked for it — the Work tab's corner
   * card is the one caller today — and paused whenever the hosting window is
   * hidden or minimised, so an ADE in the background pays nothing for a page it
   * cannot show anybody.
   */
  const previewStreams = createBuiltInBrowserPreviewStreams({
    capture: async (tabId, maxWidth) => {
      const tab = tabById(tabId);
      if (!tab || tab.webContents.isDestroyed()) return null;
      const image = await tab.webContents.capturePage(undefined, { stayHidden: true });
      if (image.isEmpty()) return null;
      const size = image.getSize();
      // Downscale in main, not in the renderer: shipping a full-resolution
      // bitmap over IPC 12 times a second is the expensive part, and the card
      // is ~260px wide.
      const scaled = size.width > maxWidth ? image.resize({ width: maxWidth, quality: "good" }) : image;
      const scaledSize = scaled.getSize();
      return {
        dataUrl: `data:image/jpeg;base64,${scaled.toJPEG(BUILT_IN_BROWSER_PREVIEW_JPEG_QUALITY).toString("base64")}`,
        width: scaledSize.width,
        height: scaledSize.height,
      };
    },
    emit: (frame) => {
      emit({
        type: "preview-frame",
        tabId: frame.tabId,
        dataUrl: frame.dataUrl,
        width: frame.width,
        height: frame.height,
        capturedAt: frame.capturedAt,
      });
    },
    isTabAlive: (tabId) => {
      const tab = tabById(tabId);
      return Boolean(tab && !tab.webContents.isDestroyed());
    },
    // Not `visible` (the panel's own bounds flag): the card wants frames from a
    // tab the panel is NOT showing. What matters is whether this ADE window is
    // on screen at all.
    isVisible: () => Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()),
    onError: (tabId, error) => {
      logger()?.debug("built_in_browser.preview_frame_failed", {
        tabId,
        err: error instanceof Error ? error.message : String(error),
      });
    },
  });

  function startPreviewStream(
    input: BuiltInBrowserStartPreviewStreamArgs = {},
  ): BuiltInBrowserPreviewStreamResult {
    const tab = targetTabFromInput(input, "No active browser tab to preview.");
    return previewStreams.start(tab.id, { fps: input.fps, maxWidth: input.maxWidth });
  }

  function stopPreviewStream(
    input: BuiltInBrowserStopPreviewStreamArgs = {},
  ): BuiltInBrowserPreviewStreamResult {
    // Deliberately tolerant: a card unmounting after its tab closed must not
    // throw on the way out, so an unknown tab id just reports zero subscribers.
    const tabId = stringOrNull(input.tabId) ?? activeTabId;
    if (!tabId) {
      return { tabId: "", fps: 0, maxWidth: 0, subscribers: 0 };
    }
    return previewStreams.stop(tabId);
  }

  /* ── Recording ─────────────────────────────────────────────────────────── */

  const recordingDirectory = (tab: BrowserTabState, recordingId: string): string =>
    path.join(observationDirectory(tab), RECORDING_CACHE_DIR, sanitizePathSegment(recordingId));

  async function startRecording(
    input: BuiltInBrowserStartRecordingArgs,
  ): Promise<BuiltInBrowserStartRecordingResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before recording.");
    await prepareAgentReadTabAsync(tab, input, "The agent requested a screen recording of this browser tab.");
    if (tab.recording) {
      throw new Error(`Browser tab ${tab.id} is already recording. Stop the current recording first.`);
    }
    const fps = normalizeBuiltInBrowserRecordingFps(input.fps);
    const caption = stringOrNull(input.caption);
    const recordingId = `rec-${Date.now()}-${randomUUID()}`;
    const directory = recordingDirectory(tab, recordingId);
    const session: BuiltInBrowserRecordingSession = await createBuiltInBrowserRecordingSession({
      id: recordingId,
      directory,
      fps,
      caption,
      createRecorder: tabRecorderFactory(tab),
      logger: logger(),
    });
    tab.recording = session;
    const status: { startedAt: string; fps: number } = { startedAt: session.startedAt, fps };
    emit({
      type: "recording",
      tabId: tab.id,
      recording: status,
      frameCount: 0,
      updatedAt: new Date().toISOString(),
    });
    emitStatus();
    return {
      tabId: tab.id,
      recording: status,
      status: scopeStatusForInput(getStatus(), input),
    };
  }

  async function stopRecording(
    input: BuiltInBrowserStopRecordingArgs = {},
  ): Promise<BuiltInBrowserStopRecordingResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before stopping a recording.");
    await prepareAgentReadTabAsync(tab, input, "The agent requested to stop a browser screen recording.");
    const session = tab.recording;
    if (!session) throw new Error(`Browser tab ${tab.id} is not recording.`);
    tab.recording = null;
    const result = await session.stop();
    emit({
      type: "recording",
      tabId: tab.id,
      recording: null,
      frameCount: result.frameCount,
      updatedAt: new Date().toISOString(),
    });
    emitStatus();
    return {
      tabId: tab.id,
      path: result.filePath,
      relativePath: observationRelativeBasePath
        ? path.relative(observationRelativeBasePath, result.filePath)
        : null,
      durationMs: result.durationMs,
      fps: session.fps,
      frameCount: result.frameCount,
      format: result.format,
      mimeType: result.mimeType,
      caption: session.caption,
      manifestPath: result.manifestPath,
      status: scopeStatusForInput(getStatus(), input),
    };
  }

  const tabRecorderFactory = (tab: BrowserTabState): BuiltInBrowserRecorderFactory => {
    if (args.createTabRecorder) return args.createTabRecorder;
    const createCaptureWindow = args.createRecordingWindow ?? defaultCaptureWindowFactory;
    return createDisplayMediaRecorderFactory({
      createCaptureWindow: () => {
        const captureWindow = createCaptureWindow();
        if (!captureWindow) {
          throw new Error("ADE browser recording needs a desktop window; none is available.");
        }
        return captureWindow;
      },
      armDisplayMedia: (frameTreeNodeId) => armDisplayMediaCapture(frameTreeNodeId, tab.webContents),
      logger: logger(),
    });
  };

  /**
   * Grants exactly one `getDisplayMedia` answer, for one capture frame, for a
   * short window. Everything else — including a site in the browser partition
   * trying to capture its own tab — is denied.
   */
  const armDisplayMediaCapture = (
    frameTreeNodeId: number,
    target: WebContents,
    ttlMs = DISPLAY_MEDIA_ARM_TTL_MS,
  ): (() => void) => {
    const captureSession = session.fromPartition(BROWSER_RECORDER_PARTITION);
    if (!configuredDisplayMediaSessions.has(captureSession)) {
      configuredDisplayMediaSessions.add(captureSession);
      captureSession.setDisplayMediaRequestHandler?.((request, callback) => {
        const nodeId = (request as { frame?: { frameTreeNodeId?: number } }).frame?.frameTreeNodeId;
        const armed = typeof nodeId === "number" ? armedDisplayMediaFrames.get(nodeId) ?? null : null;
        if (!armed || armed.expiresAt < Date.now() || armed.target.isDestroyed()) {
          callback({});
          return;
        }
        callback({ video: armed.target.mainFrame });
      });
    }
    armedDisplayMediaFrames.set(frameTreeNodeId, {
      target,
      expiresAt: Date.now() + ttlMs,
    });
    return () => {
      armedDisplayMediaFrames.delete(frameTreeNodeId);
    };
  };

  const defaultCaptureWindowFactory = (): CaptureWindowLike => {
    const BrowserWindowCtor = electronBrowserWindowCtor();
    if (typeof BrowserWindowCtor !== "function") {
      throw new Error("ADE browser recording is unavailable without an Electron window.");
    }
    return new BrowserWindowCtor({
      show: false,
      width: 16,
      height: 16,
      webPreferences: {
        // Throwaway in-memory partition: the capture page never touches the
        // authenticated global browser profile.
        partition: BROWSER_RECORDER_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
      },
    }) as unknown as CaptureWindowLike;
  };

  async function selectPoint(input: BuiltInBrowserSelectPointArgs): Promise<BuiltInBrowserSelectResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before selecting a point.");
    await prepareAgentReadTabAsync(tab, input, "The agent requested element inspection in this browser tab.");
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
    previewStreams.dispose();
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

  const evaluateBrowserDom = async (
    wc: WebContents,
    payload: Record<string, unknown>,
  ): Promise<unknown> => {
    const expression = `(${BROWSER_DOM_FUNCTION})(${JSON.stringify(payload)})`;
    const response = await withTemporaryDebugger(wc, async () => {
      await sendDebuggerCommand(wc, "Runtime.enable");
      return sendDebuggerCommand<CdpRuntimeEvaluateResponse>(wc, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        silent: true,
      });
    });
    if (response.exceptionDetails) {
      throw new Error("Browser DOM evaluation failed.");
    }
    return response.result?.value;
  };

  const evaluateElementMapOverlay = async (
    wc: WebContents,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    const expression = `(${ELEMENT_MAP_OVERLAY_FUNCTION})(${JSON.stringify(payload)})`;
    const response = await withTemporaryDebugger(wc, async () => {
      await sendDebuggerCommand(wc, "Runtime.enable");
      return sendDebuggerCommand<CdpRuntimeEvaluateResponse>(wc, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        silent: true,
      });
    });
    if (response.exceptionDetails) {
      throw new Error("Browser element map overlay evaluation failed.");
    }
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

  const elementLocatePayloadForInput = async (
    tab: BrowserTabState,
    input: BuiltInBrowserElementTargetInput,
  ): Promise<Record<string, unknown>> => {
    const direct = elementLocatePayload(input);
    if (Object.keys(direct).length > 0) return direct;

    const handle = stringOrNull(input.handle);
    if (!handle) return direct;
    const element = await readObservationElementHandle(tab, handle);
    const text = element.label ?? element.text ?? element.value ?? element.placeholder;
    const context = {
      ...(element.framePath ? { framePath: element.framePath } : {}),
      ...(element.shadowPath ? { shadowPath: element.shadowPath } : {}),
    };
    if (element.selector) return { ...context, selector: element.selector };
    if (element.testId) return { ...context, testId: element.testId };
    if (text) return { ...context, text };
    return { ...context, elementIndex: element.index };
  };

  const readObservationElementHandle = async (
    tab: BrowserTabState,
    handle: string,
  ): Promise<BuiltInBrowserElementSnapshot> => {
    const parsed = parseElementHandle(handle);
    if (!parsed) {
      throw new Error("Browser element handle must look like obs-...:e:<index>.");
    }
    const jsonPath = path.join(
      observationDirectory(tab),
      `${sanitizePathSegment(parsed.observationId)}.json`,
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
      path.join(observationRootPath!, sanitizePathSegment(args.collection.key)),
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
    attachWebview,
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
    setEmulation,
    setZoom,
    findInPage,
    stopFindInPage,
    setDevTools,
    setNetworkLogging,
    getNetworkLog,
    exportHar,
    hover,
    drag,
    selectOption,
    uploadFile,
    startRecording,
    stopRecording,
    startPreviewStream,
    stopPreviewStream,
    dispose,
  };
}

export type BuiltInBrowserService = ReturnType<typeof createBuiltInBrowserService>;

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
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
  return {
    id: tab.id,
    url: wc.isDestroyed() ? null : emptyToNull(wc.getURL()),
    title: wc.isDestroyed() ? null : emptyToNull(wc.getTitle()),
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

function normalizeDimension(value: unknown): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value as number));
}

function toElectronRect(frame: BuiltInBrowserFrame): Electron.Rectangle {
  return {
    x: Math.max(0, Math.round(frame.x)),
    y: Math.max(0, Math.round(frame.y)),
    width: Math.max(0, Math.round(frame.width)),
    height: Math.max(0, Math.round(frame.height)),
  };
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizePositiveInteger(value: unknown): number | null {
  const raw = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
  return raw != null && raw > 0 ? raw : null;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tabSnapshotForTrace(tab: BrowserTabState): { url: string | null; title: string | null } {
  const wc = tab.webContents;
  return {
    url: wc.isDestroyed() ? null : emptyToNull(wc.getURL()),
    title: wc.isDestroyed() ? null : emptyToNull(wc.getTitle()),
  };
}

function actionTargetForTrace(action: string, input: Record<string, unknown>): Record<string, unknown> | null {
  const target: Record<string, unknown> = {};
  const copyString = (key: string): void => {
    const value = stringOrNull(input[key]);
    if (value) target[key] = value;
  };
  const copyNumber = (key: string): void => {
    const value = optionalFiniteNumber(input[key]);
    if (value != null) target[key] = value;
  };
  for (const key of [
    "selector", "testId", "handle", "button", "key", "url", "loadState",
    "toSelector", "toTestId", "toHandle", "label", "preset", "mode",
  ]) copyString(key);
  for (const key of [
    "elementIndex", "x", "y", "deltaX", "deltaY", "clickCount", "timeoutMs", "networkIdleMs",
    "toElementIndex", "toX", "toY", "steps", "index", "factor", "fps", "width", "height",
  ]) copyNumber(key);
  for (const key of ["open", "enabled", "mobile", "matchCase", "forward"]) {
    if (typeof input[key] === "boolean") target[key] = input[key];
  }
  if (action === "uploadFile" && Array.isArray(input.paths)) {
    // Never copy the paths themselves into a trace an agent can read back.
    target.pathCount = input.paths.length;
  }
  if (action === "selectOption" && typeof input.value === "string") {
    target.value = input.value.slice(0, 300);
  }
  if (typeof input.text === "string") {
    if (action === "typeText") {
      target.textLength = input.text.length;
    } else if (action === "fill") {
      target.text = input.text.slice(0, 300);
    } else {
      target.text = input.text.slice(0, 300);
    }
  }
  if (action === "fill") {
    const fillValue = typeof input.value === "string" ? input.value : (typeof input.text === "string" ? input.text : null);
    if (fillValue != null) target.valueLength = fillValue.length;
  }
  // A login handoff is the one gap in a trace where the agent did nothing at
  // all, so the entries have to explain themselves: why the human was asked,
  // and how the tab came back.
  if (action === "handoff-start" || action === "handoff-end") {
    copyString("reason");
    copyString("endedBy");
    copyNumber("durationMs");
  }
  return Object.keys(target).length ? target : null;
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

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || "unknown";
}

function decodeDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("Browser observation screenshot is not a base64 data URL.");
  return {
    mimeType: match[1] || "image/png",
    buffer: Buffer.from(match[2] ?? "", "base64"),
  };
}

function parseElementHandle(handle: string): { observationId: string; index: number } | null {
  const match = /^(obs-[^:]+):e:(\d+)$/.exec(handle.trim());
  if (!match) return null;
  const observationId = match[1] ?? "";
  if (sanitizePathSegment(observationId) !== observationId) return null;
  const index = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(index) || index < 1) return null;
  return { observationId, index };
}

function applyObservationHandles(
  dom: BuiltInBrowserDomSnapshot,
  observationId: string,
): BuiltInBrowserDomSnapshot {
  return {
    ...dom,
    elements: dom.elements.map((element) => ({
      ...element,
      handle: `${observationId}:e:${element.index}`,
    })),
  };
}

async function pruneObservationDirectory(
  dir: string,
  keepCount: number,
): Promise<{ keepCount: number; keptCount: number; deletedCount: number }> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { keepCount, keptCount: 0, deletedCount: 0 };
  }
  const observations = entries
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .reverse();
  const stale = observations.slice(keepCount);
  let deletedCount = 0;
  for (const jsonName of stale) {
    const base = jsonName.slice(0, -".json".length);
    let deletedObservation = false;
    for (const filename of [`${base}.json`, `${base}.png`, `${base}.map.png`]) {
      try {
        await fs.rm(path.join(dir, filename), { force: true });
        deletedObservation = true;
      } catch {
        // best effort cleanup
      }
    }
    if (deletedObservation) deletedCount += 1;
  }
  return {
    keepCount,
    keptCount: Math.min(observations.length, keepCount),
    deletedCount,
  };
}

async function pruneObservationCacheRoot(
  profileDir: string,
  maxAgeMs: number,
): Promise<void> {
  let tabDirs: string[];
  try {
    tabDirs = await fs.readdir(profileDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const tabDir of tabDirs) {
    const dir = path.join(profileDir, tabDir);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat) continue;
    if (!stat.isDirectory()) continue;
    const entries = await fs.readdir(dir).catch(() => []);
    for (const entry of entries) {
      if (!entry.endsWith(".json") && !entry.endsWith(".png")) continue;
      const filePath = path.join(dir, entry);
      const fileStat = await fs.stat(filePath).catch(() => null);
      if (!fileStat || fileStat.mtimeMs >= cutoff) continue;
      await fs.rm(filePath, { force: true }).catch(() => {});
    }
    const remaining = await fs.readdir(dir).catch(() => []);
    if (remaining.length === 0) {
      await fs.rmdir(dir).catch(() => {});
    }
  }
}

function keyEventForInput(input: string): Record<string, unknown> {
  const normalized = input.length === 1 ? input : input.trim();
  const named: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    Return: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    Esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  };
  const special = named[normalized];
  if (special) return special;
  const char = normalized.slice(0, 1);
  const upper = char.toUpperCase();
  return {
    key: char,
    code: /^[a-z]$/i.test(char) ? `Key${upper}` : char,
    windowsVirtualKeyCode: upper.charCodeAt(0),
    text: char,
    unmodifiedText: char,
  };
}

function normalizeFrame(value: unknown): BuiltInBrowserFrame {
  const record = isRecord(value) ? value : {};
  return {
    x: finiteNumber(record.x),
    y: finiteNumber(record.y),
    width: Math.max(0, finiteNumber(record.width)),
    height: Math.max(0, finiteNumber(record.height)),
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

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function hasElementTarget(input: BuiltInBrowserElementTargetArgs): boolean {
  return Boolean(
    stringOrNull(input.selector)
    || stringOrNull(input.text)
    || stringOrNull(input.testId)
    || normalizePositiveInteger(input.elementIndex) != null
    || stringOrNull(input.handle)
  );
}

function elementLocatePayload(input: BuiltInBrowserElementTargetArgs): Record<string, unknown> {
  const selector = stringOrNull(input.selector);
  const text = stringOrNull(input.text);
  const testId = stringOrNull(input.testId);
  const elementIndex = normalizePositiveInteger(input.elementIndex);
  return {
    ...(selector ? { selector } : {}),
    ...(text ? { text } : {}),
    ...(testId ? { testId } : {}),
    ...(elementIndex == null ? {} : { elementIndex }),
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

function normalizeElementSnapshot(value: unknown): BuiltInBrowserElementSnapshot | null {
  if (!isRecord(value)) return null;
  const frame = normalizeFrame(value.frame);
  const centerRecord = isRecord(value.center) ? value.center : {};
  const index = normalizePositiveInteger(value.index) ?? 0;
  const framePath = normalizeNumberArray(value.framePath);
  const shadowPath = normalizeStringArray(value.shadowPath);
  if (frame.width <= 0 || frame.height <= 0) return null;
  return {
    index,
    handle: stringOrNull(value.handle),
    ...(framePath ? { framePath } : {}),
    ...(shadowPath ? { shadowPath } : {}),
    tagName: stringOrNull(value.tagName),
    role: stringOrNull(value.role),
    label: stringOrNull(value.label),
    text: stringOrNull(value.text),
    value: stringOrNull(value.value),
    placeholder: stringOrNull(value.placeholder),
    selector: stringOrNull(value.selector),
    testId: stringOrNull(value.testId),
    href: stringOrNull(value.href),
    disabled: typeof value.disabled === "boolean" ? value.disabled : null,
    frame,
    center: {
      x: finiteNumber(centerRecord.x, frame.x + frame.width / 2),
      y: finiteNumber(centerRecord.y, frame.y + frame.height / 2),
    },
  };
}

function normalizeNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map((entry) => typeof entry === "number" && Number.isFinite(entry) ? Math.floor(entry) : null)
    .filter((entry): entry is number => entry != null && entry >= 0);
  return entries.length ? entries : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map((entry) => stringOrNull(entry))
    .filter((entry): entry is string => Boolean(entry));
  return entries.length ? entries : undefined;
}

function normalizeDomSnapshot(value: unknown): BuiltInBrowserDomSnapshot | null {
  if (!isRecord(value)) return null;
  const viewport = normalizeFrame(value.viewport);
  const scrollRecord = isRecord(value.scroll) ? value.scroll : {};
  const elements = Array.isArray(value.elements)
    ? value.elements
        .map(normalizeElementSnapshot)
        .filter((entry): entry is BuiltInBrowserElementSnapshot => Boolean(entry))
    : [];
  return {
    url: stringOrNull(value.url),
    title: stringOrNull(value.title),
    capturedAt: stringOrNull(value.capturedAt) ?? new Date().toISOString(),
    viewport,
    scroll: {
      x: finiteNumber(scrollRecord.x),
      y: finiteNumber(scrollRecord.y),
    },
    elementCount: normalizePositiveInteger(value.elementCount) ?? elements.length,
    elements,
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

const BROWSER_DOM_FUNCTION = String.raw`
function(inputArg) {
  const input = inputArg && typeof inputArg === "object" ? inputArg : {};
  const maxElements = Math.max(1, Math.min(200, Number(input.maxElements) || 80));
  const locate = input.locate && typeof input.locate === "object" ? input.locate : null;
  const shouldFocus = input.focus === true;
  const shouldSelect = input.select === true;
  const shouldClear = input.clear === true;
  const editableRequired = input.editableRequired === true;
  const interactiveSelector = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "summary",
    "[contenteditable='true']",
    "[role='button']",
    "[role='link']",
    "[role='menuitem']",
    "[role='tab']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='switch']",
    "[tabindex]:not([tabindex='-1'])",
    "[onclick]"
  ].join(",");
  const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const lowerText = (value) => normalizeText(value).toLowerCase();
  const arrayEquals = (left, right) => {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => entry === right[index]);
  };
  const numberPath = (value) => Array.isArray(value)
    ? value.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry) && entry >= 0).map((entry) => Math.floor(entry))
    : null;
  const stringPath = (value) => Array.isArray(value)
    ? value.map((entry) => normalizeText(entry)).filter(Boolean)
    : null;
  const escapeIdent = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value));
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
  const rectFor = (node, ctx) => {
    const rect = node && typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null;
    if (!rect) return null;
    return {
      x: rect.x + ctx.offsetX,
      y: rect.y + ctx.offsetY,
      left: rect.left + ctx.offsetX,
      top: rect.top + ctx.offsetY,
      right: rect.right + ctx.offsetX,
      bottom: rect.bottom + ctx.offsetY,
      width: rect.width,
      height: rect.height
    };
  };
  const isDisplayed = (node, ctx) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE || typeof node.getBoundingClientRect !== "function") return false;
    const rect = rectFor(node, ctx);
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = (ctx.win || window).getComputedStyle(node);
    if (!style || style.display === "none" || style.visibility === "hidden") return false;
    if (style.pointerEvents === "none") return false;
    return Number(style.opacity || "1") > 0.01;
  };
  const intersectsViewport = (node, ctx) => {
    const rect = rectFor(node, ctx);
    if (!rect) return false;
    return rect.right >= 0 && rect.bottom >= 0 && rect.left <= window.innerWidth && rect.top <= window.innerHeight;
  };
  const labelledByText = (node) => {
    const ids = normalizeText(node.getAttribute("aria-labelledby"));
    if (!ids) return "";
    const doc = node.ownerDocument || document;
    return ids
      .split(/\s+/)
      .map((id) => normalizeText(doc.getElementById(id)?.textContent))
      .filter(Boolean)
      .join(" ");
  };
  const labelFor = (node) => {
    const id = node.getAttribute("id");
    const doc = node.ownerDocument || document;
    const explicitLabel = id
      ? normalizeText(doc.querySelector("label[for=\"" + quoteAttr(id) + "\"]")?.textContent)
      : "";
    const implicitLabel = normalizeText(node.closest("label")?.textContent);
    return normalizeText(
      node.getAttribute("aria-label")
      || labelledByText(node)
      || explicitLabel
      || implicitLabel
      || node.getAttribute("placeholder")
      || node.getAttribute("title")
      || node.getAttribute("alt")
      || node.getAttribute("name")
      || node.innerText
      || node.textContent
    ).slice(0, 300) || null;
  };
  const testIdFor = (node) => node.getAttribute("data-testid")
    || node.getAttribute("data-test-id")
    || node.getAttribute("data-cy")
    || null;
  const valueFor = (node) => {
    const tag = node && node.tagName ? node.tagName.toLowerCase() : "";
    if (tag !== "input" && tag !== "textarea" && tag !== "select") return null;
    if (tag === "input" && String(node.type || "").toLowerCase() === "password") return null;
    return String(node.value || "").slice(0, 300) || null;
  };
  const disabledFor = (node) => "disabled" in node ? Boolean(node.disabled) : null;
  const describe = (node, index, ctx) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
    const rect = rectFor(node, ctx);
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const text = normalizeText(node.innerText || node.textContent).slice(0, 300) || null;
    const label = labelFor(node);
    const tagName = node.tagName ? node.tagName.toLowerCase() : null;
    return {
      index,
      framePath: ctx.framePath.length ? ctx.framePath : undefined,
      shadowPath: ctx.shadowPath.length ? ctx.shadowPath : undefined,
      tagName,
      role: node.getAttribute("role"),
      label,
      text,
      value: valueFor(node),
      placeholder: normalizeText(node.getAttribute("placeholder")).slice(0, 300) || null,
      selector: selectorFor(node),
      testId: testIdFor(node),
      href: tagName === "a" ? node.href : null,
      disabled: disabledFor(node),
      frame: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    };
  };
  const actionableElement = (node) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
    return node.matches(interactiveSelector) ? node : node.closest(interactiveSelector) || node;
  };
  const contexts = [];
  const collectContexts = (root, doc, win, offsetX, offsetY, framePath, shadowPath, depth) => {
    if (!root || typeof root.querySelectorAll !== "function" || depth > 4) return;
    const ctx = { root, doc, win, offsetX, offsetY, framePath, shadowPath };
    contexts.push(ctx);
    for (const host of Array.from(root.querySelectorAll("*"))) {
      if (host.shadowRoot) {
        collectContexts(host.shadowRoot, host.ownerDocument || doc, win, offsetX, offsetY, framePath, shadowPath.concat(selectorFor(host)), depth + 1);
      }
    }
    const frames = Array.from(root.querySelectorAll("iframe,frame"));
    frames.forEach((frameElement, index) => {
      let childDocument = null;
      try {
        childDocument = frameElement.contentDocument;
      } catch {
        childDocument = null;
      }
      if (!childDocument || !childDocument.documentElement) return;
      if (!isDisplayed(frameElement, ctx) || !intersectsViewport(frameElement, ctx)) return;
      const frameRect = rectFor(frameElement, ctx);
      if (!frameRect) return;
      collectContexts(
        childDocument,
        childDocument,
        childDocument.defaultView || win,
        frameRect.x,
        frameRect.y,
        framePath.concat(index),
        shadowPath,
        depth + 1
      );
    });
  };
  collectContexts(document, document, window, 0, 0, [], [], 0);
  const locateFramePath = locate ? numberPath(locate.framePath) : null;
  const locateShadowPath = locate ? stringPath(locate.shadowPath) : null;
  const contextMatches = (ctx) => {
    if (locateFramePath && !arrayEquals(ctx.framePath, locateFramePath)) return false;
    if (locateShadowPath && !arrayEquals(ctx.shadowPath, locateShadowPath)) return false;
    return true;
  };
  const stableElements = () => {
    const seen = new Set();
    const elements = [];
    for (const ctx of contexts) {
      for (const raw of Array.from(ctx.root.querySelectorAll(interactiveSelector))) {
        const node = actionableElement(raw);
        if (!node || seen.has(node) || !isDisplayed(node, ctx) || !intersectsViewport(node, ctx)) continue;
        seen.add(node);
        elements.push({ node, ctx });
      }
    }
    elements.sort((a, b) => {
      const ar = rectFor(a.node, a.ctx);
      const br = rectFor(b.node, b.ctx);
      if (!ar || !br) return 0;
      return ar.top - br.top || ar.left - br.left || ar.width * ar.height - br.width * br.height;
    });
    return elements;
  };
  const stable = stableElements();
  const elements = stable
    .slice(0, maxElements)
    .map((entry, index) => describe(entry.node, index + 1, entry.ctx))
    .filter(Boolean);
  const snapshot = {
    url: location.href,
    title: document.title,
    capturedAt: new Date().toISOString(),
    viewport: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
    scroll: { x: window.scrollX, y: window.scrollY },
    elementCount: stable.length,
    elements
  };

  const findBySelector = (selector) => {
    let invalidSelector = false;
    for (const ctx of contexts) {
      if (!contextMatches(ctx)) continue;
      try {
        const found = ctx.root.querySelector(selector);
        if (found) return { node: actionableElement(found), ctx };
      } catch (error) {
        invalidSelector = true;
      }
    }
    return invalidSelector ? { error: "Invalid browser click selector: " + String(selector) } : null;
  };
  const findByTestId = (testId) => {
    const quoted = quoteAttr(testId);
    const selector = "[data-testid=\"" + quoted + "\"],[data-test-id=\"" + quoted + "\"],[data-cy=\"" + quoted + "\"]";
    for (const ctx of contexts) {
      if (!contextMatches(ctx)) continue;
      const found = ctx.root.querySelector(selector);
      if (found) return { node: actionableElement(found), ctx };
    }
    return null;
  };
  const searchableText = (node) => lowerText([
    labelFor(node),
    node.getAttribute("placeholder"),
    node.getAttribute("title"),
    node.getAttribute("alt"),
    node.getAttribute("name"),
    node.innerText,
    node.textContent,
    valueFor(node)
  ].filter(Boolean).join(" "));
  const findByText = (text) => {
    const needle = lowerText(text);
    if (!needle) return null;
    const candidates = [];
    const seen = new Set();
    for (const ctx of contexts) {
      if (!contextMatches(ctx)) continue;
      for (const raw of Array.from(ctx.root.querySelectorAll(interactiveSelector))) {
        const node = actionableElement(raw);
        if (!node || seen.has(node) || !isDisplayed(node, ctx)) continue;
        seen.add(node);
        candidates.push({ node, ctx });
      }
    }
    const exact = candidates.find((entry) => searchableText(entry.node) === needle);
    return exact || candidates.find((entry) => searchableText(entry.node).includes(needle)) || null;
  };
  const targetFromLocate = () => {
    if (!locate) return null;
    if (typeof locate.selector === "string" && locate.selector.trim()) return findBySelector(locate.selector.trim());
    if (typeof locate.testId === "string" && locate.testId.trim()) return findByTestId(locate.testId.trim());
    if (typeof locate.text === "string" && locate.text.trim()) return findByText(locate.text.trim());
    if (Number.isFinite(Number(locate.elementIndex))) {
      const index = Math.max(1, Math.floor(Number(locate.elementIndex)));
      const entry = stable[index - 1];
      if (!entry) return { error: "No browser element exists at index " + index + "." };
      return entry;
    }
    return null;
  };
  const rawTarget = targetFromLocate();
  if (rawTarget && rawTarget.error) return { snapshot, target: null, error: rawTarget.error };
  let target = rawTarget && rawTarget.node && rawTarget.node.nodeType === Node.ELEMENT_NODE ? rawTarget.node : null;
  const targetContext = rawTarget && rawTarget.ctx ? rawTarget.ctx : contexts[0];
  if (target && typeof target.scrollIntoView === "function" && !intersectsViewport(target, targetContext)) {
    target.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
  }
  if (target && !isDisplayed(target, targetContext)) target = null;
  if (target && shouldFocus) {
    const tagName = target.tagName ? target.tagName.toLowerCase() : "";
    const editable = target.isContentEditable
      || tagName === "input"
      || tagName === "textarea"
      || tagName === "select";
    const readOnly = "readOnly" in target ? Boolean(target.readOnly) : false;
    const disabled = "disabled" in target ? Boolean(target.disabled) : false;
    if (editableRequired && (!editable || readOnly || disabled)) {
      return { snapshot, target: null, error: "Matching browser element is not editable." };
    }
    if (typeof target.focus === "function") target.focus({ preventScroll: true });
    if (shouldSelect && typeof target.select === "function") target.select();
    if (shouldClear) {
      if ("value" in target) {
        target.value = "";
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (target.isContentEditable) {
        target.textContent = "";
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      }
    }
  }
  const describedTarget = target ? describe(target, 0, targetContext) : null;
  return {
    readyState: document.readyState,
    snapshot,
    target: describedTarget,
    error: locate && !describedTarget ? "No matching browser element was found." : null
  };
}
`;

/**
 * Resolves the element the page actually has focused, descending through open
 * shadow roots and same-origin iframes so `focusElementTarget` results inside
 * a frame or web component still resolve to the real control.
 */
const DEEP_ACTIVE_ELEMENT_FUNCTION = String.raw`
function deepActiveElement() {
  let element = document.activeElement;
  for (let depth = 0; depth < 20 && element; depth += 1) {
    if (element.shadowRoot && element.shadowRoot.activeElement) {
      element = element.shadowRoot.activeElement;
      continue;
    }
    if (element.tagName === "IFRAME" || element.tagName === "FRAME") {
      let inner = null;
      try {
        inner = element.contentDocument ? element.contentDocument.activeElement : null;
      } catch (error) {
        inner = null;
      }
      if (!inner || inner === element) break;
      element = inner;
      continue;
    }
    break;
  }
  return element;
}
`;

const SELECT_OPTION_FUNCTION = String.raw`
function selectBrowserOption(element, payload) {
  if (!element) return { error: "No focused browser element to select an option on." };
  if (element.tagName !== "SELECT") {
    return { error: "Browser selectOption target is not a <select> element." };
  }
  if (element.disabled) return { error: "Matching browser element is disabled." };
  const options = Array.prototype.slice.call(element.options || []);
  let match = null;
  if (payload.value != null) {
    match = options.find(function (option) { return option.value === payload.value; }) || null;
  }
  if (!match && payload.label != null) {
    const wanted = String(payload.label).trim().toLowerCase();
    match = options.find(function (option) {
      return (option.label || option.textContent || "").trim().toLowerCase() === wanted;
    }) || null;
  }
  if (!match && payload.index != null) {
    match = options[payload.index] || null;
  }
  if (!match) return { error: "No matching <option> was found for the requested value/label/index." };
  if (match.disabled) return { error: "Matching <option> is disabled." };
  element.value = match.value;
  match.selected = true;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return {
    ok: true,
    value: match.value,
    label: (match.label || match.textContent || "").trim(),
    index: match.index,
  };
}
`;

const ELEMENT_MAP_OVERLAY_FUNCTION = String.raw`
function(inputArg) {
  const input = inputArg && typeof inputArg === "object" ? inputArg : {};
  const overlayId = "__ade_browser_element_map_overlay__";
  const existing = document.getElementById(overlayId);
  if (existing) existing.remove();
  if (input.clear === true) return { ok: true, cleared: true };
  const elements = Array.isArray(input.elements) ? input.elements : [];
  if (!elements.length || !document.body) return { ok: true, count: 0 };
  const root = document.createElement("div");
  root.id = overlayId;
  root.setAttribute("aria-hidden", "true");
  Object.assign(root.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    pointerEvents: "none",
    font: "12px/1.2 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    color: "#f8fafc",
  });
  const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
  const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  let count = 0;
  for (const element of elements) {
    if (!element || typeof element !== "object") continue;
    const frame = element.frame && typeof element.frame === "object" ? element.frame : {};
    const x = clamp(number(frame.x), 0, viewportWidth);
    const y = clamp(number(frame.y), 0, viewportHeight);
    const right = clamp(number(frame.x) + number(frame.width), 0, viewportWidth);
    const bottom = clamp(number(frame.y) + number(frame.height), 0, viewportHeight);
    const width = Math.max(1, right - x);
    const height = Math.max(1, bottom - y);
    if (width <= 1 || height <= 1) continue;
    const index = String(element.index || count + 1);
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed",
      left: x + "px",
      top: y + "px",
      width: width + "px",
      height: height + "px",
      zIndex: "1",
      boxSizing: "border-box",
      border: "2px solid #0ea5e9",
      background: "rgba(14, 165, 233, 0.12)",
      boxShadow: "0 0 0 1px rgba(15, 23, 42, 0.88), 0 0 0 4px rgba(14, 165, 233, 0.18)",
      borderRadius: "4px",
    });
    const label = document.createElement("div");
    label.textContent = index;
    Object.assign(label.style, {
      position: "fixed",
      left: clamp(x, 0, viewportWidth - 28) + "px",
      top: clamp(y - 18, 0, viewportHeight - 18) + "px",
      zIndex: "2",
      minWidth: "18px",
      height: "18px",
      padding: "0 5px",
      boxSizing: "border-box",
      borderRadius: "9px",
      background: "#0284c7",
      color: "white",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontWeight: "700",
      letterSpacing: "0",
      boxShadow: "0 1px 5px rgba(15, 23, 42, 0.5)",
    });
    root.appendChild(box);
    root.appendChild(label);
    count += 1;
  }
  document.body.appendChild(root);
  return { ok: true, count };
}
`;

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
