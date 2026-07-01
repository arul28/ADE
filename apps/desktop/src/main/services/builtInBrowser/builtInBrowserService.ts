import { existsSync } from "node:fs";
import { WebContentsView, app, nativeImage, screen, session, webContents as electronWebContents } from "electron";
import type { BrowserWindow, DownloadItem, WebContents } from "electron";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  BuiltInBrowserActionTraceEntry,
  BuiltInBrowserAgentActionArgs,
  BuiltInBrowserAgentActionResult,
  BuiltInBrowserAttachWebviewArgs,
  BuiltInBrowserBoundsArgs,
  BuiltInBrowserClearArgs,
  BuiltInBrowserClaimArgs,
  BuiltInBrowserClickArgs,
  BuiltInBrowserContextItem,
  BuiltInBrowserCreateTabArgs,
  BuiltInBrowserDiagnostics,
  BuiltInBrowserDispatchKeyArgs,
  BuiltInBrowserDomSnapshot,
  BuiltInBrowserElementSnapshot,
  BuiltInBrowserElementTargetArgs,
  BuiltInBrowserEndSessionArgs,
  BuiltInBrowserEventPayload,
  BuiltInBrowserFrame,
  BuiltInBrowserListSessionsArgs,
  BuiltInBrowserNavigateArgs,
  BuiltInBrowserObservation,
  BuiltInBrowserObservationArgs,
  BuiltInBrowserObservationElementMap,
  BuiltInBrowserOpenPanelArgs,
  BuiltInBrowserProjectScopeArgs,
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
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { isRecord } from "../shared/utils";
import {
  BUILT_IN_BROWSER_PARTITION,
  BUILT_IN_BROWSER_PROFILE_PREFIX,
} from "./builtInBrowserConstants";
import { isAllowedNavigationUrl, normalizeBrowserUrl } from "./builtInBrowserNavigation";
import {
  shouldAllowGoogleAuthPermissionCheck,
  shouldAllowGoogleAuthPermissionRequest,
} from "./builtInBrowserPermissions";
import { configureBuiltInBrowserSessionWebAuthn } from "./builtInBrowserWebAuthn";

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

type BrowserProfile = {
  key: string;
  partition: string;
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

function normalizedProjectRoot(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function profileForProjectRoot(projectRoot: string | null | undefined): BrowserProfile {
  const normalized = normalizedProjectRoot(projectRoot);
  if (!normalized) {
    return {
      key: "global",
      partition: BROWSER_PARTITION,
      projectRoot: null,
    };
  }
  const key = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return {
    key,
    partition: `${BUILT_IN_BROWSER_PROFILE_PREFIX}${key}`,
    projectRoot: normalized,
  };
}

export function createBuiltInBrowserService(args: {
  getLogger?: () => Logger;
  getProjectRootForWindow?: (win: BrowserWindow) => string | null | undefined;
  getWindowForProjectRoot?: (projectRoot: string) => BrowserWindow | null | undefined;
  onEvent?: ((payload: BuiltInBrowserEventPayload, targetWindow?: BrowserWindow | null) => void) | null;
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
  let fallbackService: WindowBrowserService | null = null;

  const createServiceForWindow = (win: BrowserWindow, profile: BrowserProfile): WindowBrowserService =>
    createBuiltInBrowserWindowService({
      getLogger: args.getLogger,
      onEvent: (payload) => args.onEvent?.(payload, win),
      profile,
    });

  const serviceKey = (windowId: number, profile: BrowserProfile): string =>
    `${windowId}:${profile.partition}`;

  const profileForWindow = (win: BrowserWindow): BrowserProfile =>
    profileForProjectRoot(args.getProjectRootForWindow?.(win));

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

  const serviceForWindowProfile = (
    win: BrowserWindow,
    profile: BrowserProfile,
    options: { markActive?: boolean } = {},
  ): WindowBrowserService => {
    const key = serviceKey(win.id, profile);
    const existing = windowServices.get(key);
    if (options.markActive) {
      activeServiceKeyByWindow.set(win.id, key);
      detachInactiveWindowServices(win, key);
    }
    if (existing) return existing.service;

    fallbackService?.dispose();
    fallbackService = null;
    ensureWindowClosedListener(win);
    const service = createServiceForWindow(win, profile);
    windowServices.set(key, { win, service });
    return service;
  };

  const serviceForWindow = (win: BrowserWindow): WindowBrowserService =>
    serviceForWindowProfile(win, profileForWindow(win), { markActive: true });

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
    if (!fallbackService) {
      fallbackService = createBuiltInBrowserWindowService({
        getLogger: args.getLogger,
        onEvent: (payload) => args.onEvent?.(payload, null),
        profile: profileForProjectRoot(null),
      });
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
    const service = serviceForWindowProfile(win, profileForProjectRoot(normalized), {
      markActive: projectRootsMatch(projectRootForWindow(win), normalized),
    });
    service.attachToWindow(win);
    return service;
  };

  const serviceForInput = (
    input?: BuiltInBrowserProjectScopeArgs | null,
    sourceWindow?: BrowserWindow | null,
  ): WindowBrowserService => {
    const projectRoot = projectRootFromInput(input);
    if (projectRoot) return serviceForProjectRoot(projectRoot);
    if (isLiveWindow(sourceWindow)) return serviceForWindow(sourceWindow);
    return activeService();
  };

  return {
    attachToWindow(nextWin: BrowserWindow): void {
      activeWindowId = nextWin.id;
      serviceForWindow(nextWin).attachToWindow(nextWin);
    },
    getStatus(
      inputOrSourceWindow?: BuiltInBrowserProjectScopeArgs | BrowserWindow | null,
      sourceWindow?: BrowserWindow | null,
    ): BuiltInBrowserStatus {
      const input = isLiveWindow(inputOrSourceWindow) ? null : inputOrSourceWindow ?? null;
      const win = sourceWindow ?? (isLiveWindow(inputOrSourceWindow) ? inputOrSourceWindow : null);
      return serviceForInput(input, win).getStatus();
    },
    claim(input: BuiltInBrowserClaimArgs = {}, sourceWindow?: BrowserWindow | null): BuiltInBrowserStatus {
      return serviceForInput(input, sourceWindow).claim(input);
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
      inputOrSourceWindow?: BuiltInBrowserProjectScopeArgs | BrowserWindow | null,
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserStatus> {
      const input = isLiveWindow(inputOrSourceWindow) ? null : inputOrSourceWindow ?? null;
      const win = sourceWindow ?? (isLiveWindow(inputOrSourceWindow) ? inputOrSourceWindow : null);
      return serviceForInput(input, win).startInspect();
    },
    stopInspect(
      inputOrSourceWindow?: BuiltInBrowserProjectScopeArgs | BrowserWindow | null,
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserStatus> {
      const input = isLiveWindow(inputOrSourceWindow) ? null : inputOrSourceWindow ?? null;
      const win = sourceWindow ?? (isLiveWindow(inputOrSourceWindow) ? inputOrSourceWindow : null);
      return serviceForInput(input, win).stopInspect();
    },
    captureScreenshot(inputOrSourceWindow?: BuiltInBrowserTabTargetArgs | BrowserWindow | null, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserScreenshot> {
      const input = isLiveWindow(inputOrSourceWindow) ? {} : inputOrSourceWindow ?? {};
      return serviceForInput(input, sourceWindow ?? (isLiveWindow(inputOrSourceWindow) ? inputOrSourceWindow : null)).captureScreenshot(input);
    },
    selectPoint(input: BuiltInBrowserSelectPointArgs, sourceWindow?: BrowserWindow | null): Promise<BuiltInBrowserSelectResult> {
      return serviceForInput(input, sourceWindow).selectPoint(input);
    },
    selectCurrent(
      inputOrSourceWindow?: BuiltInBrowserProjectScopeArgs | BrowserWindow | null,
      sourceWindow?: BrowserWindow | null,
    ): Promise<BuiltInBrowserSelectResult> {
      const input = isLiveWindow(inputOrSourceWindow) ? null : inputOrSourceWindow ?? null;
      const win = sourceWindow ?? (isLiveWindow(inputOrSourceWindow) ? inputOrSourceWindow : null);
      return serviceForInput(input, win).selectCurrent();
    },
    clearSelection(
      inputOrSourceWindow?: BuiltInBrowserProjectScopeArgs | BrowserWindow | null,
      sourceWindow?: BrowserWindow | null,
    ): Promise<{ ok: true }> {
      const input = isLiveWindow(inputOrSourceWindow) ? null : inputOrSourceWindow ?? null;
      const win = sourceWindow ?? (isLiveWindow(inputOrSourceWindow) ? inputOrSourceWindow : null);
      return serviceForInput(input, win).clearSelection();
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
      fallbackService?.dispose();
      fallbackService = null;
      activeWindowId = null;
    },
  };
}

function createBuiltInBrowserWindowService(args: {
  getLogger?: () => Logger;
  onEvent?: ((payload: BuiltInBrowserEventPayload) => void) | null;
  profile: BrowserProfile;
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
  let lastSelectedItem: BuiltInBrowserContextItem | null = null;
  let handlingInspectNode = false;
  let browserSessionConfigured = false;
  let lastEmittedStatusKey: string | null = null;
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
      tabs = nextTabs;
    }
    endSessionsForMissingTabs(new Set(tabs.map((tab) => tab.id)));
    pruneBrowserSessions();
    if (activeTabId && !tabs.some((tab) => tab.id === activeTabId)) {
      activeTabId = tabs[0]?.id ?? null;
      clearSelectionInternal();
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

  const prepareAgentActionTab = <T extends BuiltInBrowserAgentActionArgs>(
    tab: BrowserTabState,
    input: T,
  ): void => {
    claimTabOwnerFromInput(tab, input);
  };

  const claimTargetOwnerFromInput = (input: BuiltInBrowserClaimArgs = {}): boolean => {
    const tabId = stringOrNull(input.tabId);
    const tab = tabId ? tabById(tabId) : activeTab();
    if (tabId && !tab) throw new Error(`Browser tab not found: ${tabId}`);
    return claimTabOwnerFromInput(tab, input);
  };

  const copyTabOwner = (from: BrowserTabState | null, to: BrowserTabState): void => {
    if (!from) return;
    to.ownerLaneId = from.ownerLaneId;
    to.ownerChatSessionId = from.ownerChatSessionId;
    to.ownerClaimedAt = from.ownerClaimedAt;
    to.ownerLeaseExpiresAt = from.ownerLeaseExpiresAt;
  };

  const tabMatchesOwnerInput = (
    tab: BrowserTabState,
    input: Pick<BuiltInBrowserClaimArgs, "laneId" | "chatSessionId"> = {},
  ): boolean => {
    const laneId = stringOrNull(input.laneId);
    const chatSessionId = stringOrNull(input.chatSessionId);
    if (chatSessionId) {
      return tab.ownerChatSessionId === chatSessionId && (!laneId || !tab.ownerLaneId || tab.ownerLaneId === laneId);
    }
    if (laneId) return tab.ownerLaneId === laneId && !tab.ownerChatSessionId;
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
    if (!lastSelectedItem) return;
    lastSelectedItem = null;
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

  const pushConsoleDiagnostic = (
    tab: BrowserTabState,
    diagnostic: BuiltInBrowserDiagnostics["console"][number],
  ): void => {
    tab.consoleDiagnostics = [...tab.consoleDiagnostics, diagnostic].slice(-MAX_BROWSER_CONSOLE_DIAGNOSTICS);
    notifyTabActivity(tab);
  };

  const pushNetworkDiagnostic = (
    tab: BrowserTabState,
    diagnostic: BuiltInBrowserDiagnostics["network"][number],
  ): void => {
    tab.networkDiagnostics = [...tab.networkDiagnostics, diagnostic].slice(-MAX_BROWSER_NETWORK_DIAGNOSTICS);
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
      return {
        action: "allow",
        createWindow: () => {
          const tab = createPopupTabStateFromView(popupUrl, opener, new WebContentsView({
            webPreferences: browserWebPreferences(),
          }));
          return tab.webContents;
        },
      };
    });
    wc.on("will-navigate", (event, url) => {
      if (isAllowedNavigationUrl(url)) return;
      event.preventDefault();
      emitError(new Error(`Blocked unsupported browser navigation protocol: ${url}`));
    });
    wc.on("did-start-loading", () => {
      noteNetworkActivity(tabForWebContents(wc));
      emitStatus();
    });
    wc.on("did-stop-loading", () => {
      noteNetworkActivity(tabForWebContents(wc));
      emitStatus();
    });
    wc.on("did-navigate", () => {
      notifyTabActivity(tabForWebContents(wc));
      clearSelectionInternal();
      emitStatus();
    });
    wc.on("did-navigate-in-page", () => {
      notifyTabActivity(tabForWebContents(wc));
      clearSelectionInternal();
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
    partition: args.profile.partition,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    backgroundThrottling: false,
  });

  const createTabStateForView = (nextView: WebContentsView): BrowserTabState => {
    nextView.setBackgroundColor("#111827");
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
  ): BrowserTabState => {
    configureBrowserSession();
    const tab = createTabStateForView(nextView);
    copyTabOwner(opener, tab);
    tabs = [...tabs, tab];
    activeTabId = tab.id;
    clearSelectionInternal();
    attachViewsToCurrentWindow();
    requestOpenPanel({ url: popupUrl, tabId: tab.id });
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

  const browserSessionForProfile = () => session.fromPartition(args.profile.partition);

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
    const webRequest = browserSession.webRequest as unknown as {
      onBeforeRequest?: (listener: (details: Record<string, unknown>, callback?: (response: { cancel?: boolean }) => void) => void) => void;
      onCompleted?: (listener: (details: Record<string, unknown>) => void) => void;
      onErrorOccurred?: (listener: (details: Record<string, unknown>) => void) => void;
    };
    webRequest.onBeforeRequest?.((details, callback) => {
      trackNetworkRequestStart(details);
      callback?.({});
    });
    webRequest.onCompleted?.((details) => {
      trackNetworkRequestEnd(details, null);
    });
    webRequest.onErrorOccurred?.((details) => {
      trackNetworkRequestEnd(details, stringOrNull(details.error) ?? "request failed");
    });
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
    browserSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
      if (shouldAllowGoogleAuthPermissionCheck(permission, requestingOrigin, details)) {
        logger()?.debug("built_in_browser.permission_check_allowed", {
          permission,
          requestingOrigin,
          requestingUrl: details.requestingUrl ?? null,
        });
        return true;
      }
      logger()?.debug("built_in_browser.permission_check_denied", {
        permission,
        requestingOrigin,
        requestingUrl: details.requestingUrl ?? null,
      });
      return false;
    });
    browserSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      if (shouldAllowGoogleAuthPermissionRequest(permission, details)) {
        logger()?.debug("built_in_browser.permission_request_allowed", {
          permission,
          requestingUrl: stringOrNull(details.requestingUrl),
        });
        callback(true);
        return;
      }
      logger()?.debug("built_in_browser.permission_request_denied", {
        permission,
        requestingOrigin: "requestingOrigin" in details ? details.requestingOrigin : null,
        requestingUrl: stringOrNull(details.requestingUrl),
      });
      callback(false);
    });
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
      partition: args.profile.partition,
      profileKey: args.profile.key,
      profileProjectRoot: args.profile.projectRoot,
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

  function claim(input: BuiltInBrowserClaimArgs = {}): BuiltInBrowserStatus {
    claimTargetOwnerFromInput(input);
    emitStatus();
    return getStatus();
  }

  function startSession(input: BuiltInBrowserStartSessionArgs = {}): BuiltInBrowserSessionResult {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before starting a browser session.");
    claimTabOwnerFromInput(tab, input);
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
    return { session: sessionSnapshot(sessionEntry), status: getStatus() };
  }

  function listSessions(input: BuiltInBrowserListSessionsArgs = {}): BuiltInBrowserSessionsResult {
    pruneDestroyedTabs();
    const tabId = stringOrNull(input.tabId);
    const sessions = browserSessions
      .filter((entry) => (input.includeEnded ? true : !entry.endedAt))
      .filter((entry) => (tabId ? entry.tabId === tabId : true))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(sessionSnapshot);
    return { sessions };
  }

  function endSession(input: BuiltInBrowserEndSessionArgs): BuiltInBrowserSessionResult {
    const sessionId = stringOrNull(input.sessionId);
    if (!sessionId) throw new Error("Browser session id is required.");
    const entry = browserSessions.find((sessionEntry) => sessionEntry.id === sessionId) ?? null;
    if (!entry) throw new Error(`Browser session not found: ${sessionId}`);
    if (!entry.endedAt) {
      const now = new Date().toISOString();
      entry.endedAt = now;
      entry.updatedAt = now;
    }
    pruneBrowserSessions();
    emitStatus();
    return { session: sessionSnapshot(entry), status: getStatus() };
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
    return status;
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
      });
    }
    if (tabId) {
      return switchTab({
        projectRoot: input.projectRoot,
        tabId,
        openPanel: true,
        laneId: input.laneId,
        chatSessionId: input.chatSessionId,
      });
    }
    return requestOpenPanel(input);
  }

  async function setBounds(nextBounds: BuiltInBrowserBoundsArgs): Promise<BuiltInBrowserStatus> {
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
    if (unchanged) return getStatus();
    bounds = normalized;
    visible = nextVisible;
    if (visible || tabs.length) {
      if (visible) ensureActiveTab();
      attachViewsToCurrentWindow();
    }
    emitStatus();
    return getStatus();
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
      throw new Error("Browser webview partition does not match the current project browser profile.");
    }

    configureBrowserSession();
    configureBrowserWebContents(nextWebContents);

    if (tab.webContents.id === nextWebContents.id && !tab.ownsWebContents && !tab.view) {
      attachViewsToCurrentWindow();
      emitStatus();
      return getStatus();
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
    return getStatus();
  }

  async function navigate(input: BuiltInBrowserNavigateArgs): Promise<BuiltInBrowserStatus> {
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
    if (leaseTarget) assertTabLeaseAvailable(leaseTarget, input);
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
    claimTabOwnerFromInput(tab, input);
    const wc = tab.webContents;
    attachViewsToCurrentWindow();
    await wc.loadURL(targetUrl);
    if (input.openPanel) {
      requestOpenPanel({ url: targetUrl, tabId: tab.id, laneId: input.laneId, chatSessionId: input.chatSessionId });
    }
    emitStatus();
    return getStatus();
  }

  async function createTab(input: BuiltInBrowserCreateTabArgs = {}): Promise<BuiltInBrowserStatus> {
    if (tabs.length >= MAX_BROWSER_TABS) {
      throw new Error(`ADE browser is limited to ${MAX_BROWSER_TABS} tabs. Close a tab before opening another.`);
    }
    // Normalize URL up front so we don't leave an orphan tab on invalid input.
    const normalizedUrl = input.url ? normalizeBrowserUrl(input.url) : null;
    const willActivate = input.activate !== false || !activeTabId;
    if (willActivate) {
      await stopInspectQuietly("built_in_browser.create_tab_stop_inspect_failed");
      clearSelectionInternal();
    }
    const tab = createTabState();
    claimTabOwnerFromInput(tab, input);
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
    return getStatus();
  }

  async function switchTab(input: BuiltInBrowserTabArgs): Promise<BuiltInBrowserStatus> {
    const tabId = input.tabId?.trim();
    if (!tabId) throw new Error("Browser tab id is required.");
    const tab = tabs.find((entry) => entry.id === tabId);
    if (!tab) throw new Error(`Browser tab not found: ${tabId}`);
    assertTabLeaseAvailable(tab, input);
    const wasDifferentTab = tab.id !== activeTabId;
    if (wasDifferentTab) {
      await stopInspectQuietly("built_in_browser.switch_tab_stop_inspect_failed");
    }
    activeTabId = tab.id;
    claimTabOwnerFromInput(tab, input);
    if (wasDifferentTab) {
      clearSelectionInternal();
    }
    attachViewsToCurrentWindow();
    if (input.openPanel) {
      requestOpenPanel({ tabId: tab.id, laneId: input.laneId, chatSessionId: input.chatSessionId });
    }
    emitStatus();
    return getStatus();
  }

  async function closeTab(input: BuiltInBrowserTabArgs): Promise<BuiltInBrowserStatus> {
    const tabId = input.tabId?.trim();
    if (!tabId) throw new Error("Browser tab id is required.");
    const index = tabs.findIndex((entry) => entry.id === tabId);
    if (index < 0) throw new Error(`Browser tab not found: ${tabId}`);
    assertTabLeaseAvailable(tabs[index]!, input);
    if (tabId === activeTabId) {
      await stopInspectQuietly("built_in_browser.close_tab_stop_inspect_failed");
    }
    const [removed] = tabs.splice(index, 1);
    if (removed) {
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
    if (activeTabId === tabId) {
      activeTabId = tabs[Math.max(0, index - 1)]?.id ?? tabs[0]?.id ?? null;
      clearSelectionInternal();
    }
    attachViewsToCurrentWindow();
    emitStatus();
    return getStatus();
  }

  async function reload(input: BuiltInBrowserTabTargetArgs = {}): Promise<BuiltInBrowserStatus> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before reloading.");
    tab.webContents.reload();
    emitStatus();
    return getStatus();
  }

  async function goBack(input: BuiltInBrowserTabTargetArgs = {}): Promise<BuiltInBrowserStatus> {
    const wc = targetTabFromInput(input, "No active browser tab. Open a tab before navigating back.").webContents;
    if (wc.canGoBack()) wc.goBack();
    emitStatus();
    return getStatus();
  }

  async function goForward(input: BuiltInBrowserTabTargetArgs = {}): Promise<BuiltInBrowserStatus> {
    const wc = targetTabFromInput(input, "No active browser tab. Open a tab before navigating forward.").webContents;
    if (wc.canGoForward()) wc.goForward();
    emitStatus();
    return getStatus();
  }

  async function stop(input: BuiltInBrowserTabTargetArgs = {}): Promise<BuiltInBrowserStatus> {
    const wc = targetTabFromInput(input, "No active browser tab. Open a tab before stopping a load.").webContents;
    if (wc.isLoading()) wc.stop();
    emitStatus();
    return getStatus();
  }

  async function startInspect(): Promise<BuiltInBrowserStatus> {
    const wc = currentWebContents();
    if (!wc) {
      throw new Error("No active browser tab. Open a tab before starting inspect.");
    }
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
      return getStatus();
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

  async function stopInspect(): Promise<BuiltInBrowserStatus> {
    const inspectWc = inspectListenerWebContents && !inspectListenerWebContents.isDestroyed()
      ? inspectListenerWebContents
      : null;
    const wc = inspectWc ?? currentWebContents();
    inspecting = false;
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
      detachDebuggerIfOwned(wc);
    }
    emitStatus();
    return getStatus();
  }

  async function captureScreenshot(input: BuiltInBrowserTabTargetArgs = {}): Promise<BuiltInBrowserScreenshot> {
    const wc = targetTabFromInput(input, "No active browser tab. Open a tab before capturing a screenshot.").webContents;
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
      prepareAgentActionTab(tab, input);
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
      prepareAgentActionTab(tab, input);
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
      prepareAgentActionTab(tab, input);
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
      prepareAgentActionTab(tab, input);
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
      prepareAgentActionTab(tab, input);
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
      prepareAgentActionTab(tab, input);
      await focusElementTarget(tab, input, { select: true, clear: true });
      emitStatus();
      return actionResult(tab, input);
    });
  }

  async function wait(input: BuiltInBrowserWaitArgs): Promise<BuiltInBrowserAgentActionResult> {
    const tab = targetTabFromInput(input, "No active browser tab. Open a tab before waiting.");
    return runTracedAgentAction(tab, "wait", input, async () => {
      prepareAgentActionTab(tab, input);
      await waitForBrowserCondition(tab, input);
      emitStatus();
      return actionResult(tab, input);
    });
  }

  async function selectPoint(input: BuiltInBrowserSelectPointArgs): Promise<BuiltInBrowserSelectResult> {
    const wc = targetTabFromInput(input, "No active browser tab. Open a tab before selecting a point.").webContents;
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

  async function selectCurrent(): Promise<BuiltInBrowserSelectResult> {
    if (lastSelectedItem) {
      emit({ type: "selection", item: lastSelectedItem });
    }
    return { item: lastSelectedItem };
  }

  async function clearSelection(): Promise<{ ok: true }> {
    if (lastSelectedItem) {
      clearSelectionInternal();
    } else {
      emit({ type: "selection-cleared", item: null, clearedAt: new Date().toISOString() });
    }
    emitStatus();
    return { ok: true };
  }

  function dispose(): void {
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
    removeBrowserDownloadListener();
    removeTabViewsFromWindow();
    for (const tab of tabs) {
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
    owner: "inspect" | "screenshot",
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
    const projectRoot = args.profile.projectRoot;
    if (!projectRoot) {
      throw new Error("Browser element handles require a project-scoped ADE browser profile.");
    }
    const jsonPath = path.join(
      projectRoot,
      OBSERVATION_CACHE_DIR,
      sanitizePathSegment(args.profile.key),
      sanitizePathSegment(tab.id),
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
      status: getStatus(),
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
    const projectRoot = args.profile.projectRoot;
    if (!projectRoot) {
      throw new Error("Browser observations require a project-scoped ADE browser profile.");
    }
    const keepCount = normalizeObservationKeepCount(input.keepCount);
    const id = `obs-${Date.now()}-${randomUUID()}`;
    const dir = path.join(projectRoot, OBSERVATION_CACHE_DIR, sanitizePathSegment(args.profile.key), sanitizePathSegment(tab.id));
    const filePath = path.join(dir, `${id}.png`);
    const elementMapPath = path.join(dir, `${id}.map.png`);
    const jsonPath = path.join(dir, `${id}.json`);
    const image = decodeDataUrl(screenshot.dataUrl);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, image.buffer);
    const relativePath = path.relative(projectRoot, filePath);
    const domWithHandles = dom ? applyObservationHandles(dom, id) : null;
    let elementMap: BuiltInBrowserObservationElementMap | null = null;
    if (elementMapScreenshot) {
      const elementMapImage = decodeDataUrl(elementMapScreenshot.dataUrl);
      await fs.writeFile(elementMapPath, elementMapImage.buffer);
      elementMap = {
        filePath: elementMapPath,
        relativePath: path.relative(projectRoot, elementMapPath),
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
      path.join(projectRoot, OBSERVATION_CACHE_DIR, sanitizePathSegment(args.profile.key)),
      DEFAULT_OBSERVATION_MAX_AGE_MS,
    ).catch((error) => {
      logger()?.debug("built_in_browser.observation_stale_prune_failed", {
        err: error instanceof Error ? error.message : String(error),
      });
    });
    await fs.writeFile(jsonPath, `${JSON.stringify(observation, null, 2)}\n`, "utf8");
    return observation;
  };

  return {
    attachToWindow,
    detachFromWindow,
    getStatus,
    claim,
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
  for (const key of ["selector", "testId", "handle", "button", "key", "url", "loadState"]) copyString(key);
  for (const key of ["elementIndex", "x", "y", "deltaX", "deltaY", "clickCount", "timeoutMs", "networkIdleMs"]) copyNumber(key);
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
