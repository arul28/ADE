import { WebContentsView, nativeImage, session, webContents as electronWebContents } from "electron";
import type { BrowserWindow, WebContents } from "electron";
import { randomUUID } from "node:crypto";
import type {
  BuiltInBrowserBoundsArgs,
  BuiltInBrowserAttachWebviewArgs,
  BuiltInBrowserContextItem,
  BuiltInBrowserCreateTabArgs,
  BuiltInBrowserEventPayload,
  BuiltInBrowserFrame,
  BuiltInBrowserNavigateArgs,
  BuiltInBrowserOpenPanelArgs,
  BuiltInBrowserScreenshot,
  BuiltInBrowserSelectPointArgs,
  BuiltInBrowserSelectResult,
  BuiltInBrowserStatus,
  BuiltInBrowserTab,
  BuiltInBrowserTabArgs,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { BUILT_IN_BROWSER_PARTITION } from "./builtInBrowserConstants";

const BROWSER_PARTITION = BUILT_IN_BROWSER_PARTITION;
const SCREENSHOT_TIMEOUT_MS = 3_000;
const ELEMENT_SCREENSHOT_TIMEOUT_MS = 2_000;
const DEBUGGER_TIMEOUT_MS = 3_000;
const MAX_BROWSER_TABS = 10;
const GOOGLE_AUTH_PERMISSION_CHECK_ALLOWLIST = new Set([
  "hid",
  "serial",
  "storage-access",
  "top-level-storage-access",
  "usb",
]);
const GOOGLE_AUTH_PERMISSION_REQUEST_ALLOWLIST = new Set([
  "storage-access",
  "top-level-storage-access",
]);

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

type BrowserTabState = {
  id: string;
  view: WebContentsView | null;
  webContents: WebContents;
  ownsWebContents: boolean;
};

export function createBuiltInBrowserService(args: {
  getLogger?: () => Logger;
  onEvent?: ((payload: BuiltInBrowserEventPayload) => void) | null;
}) {
  let win: BrowserWindow | null = null;
  let winClosedListener: (() => void) | null = null;
  let tabs: BrowserTabState[] = [];
  let activeTabId: string | null = null;
  let bounds: BuiltInBrowserFrame = { x: 0, y: 0, width: 0, height: 0 };
  let visible = false;
  let inspecting = false;
  let debuggerAttachedForInspect = false;
  let debuggerMessageListener: DebuggerMessageListener | null = null;
  let debuggerDetachListener: DebuggerDetachListener | null = null;
  let inspectListenerWebContents: WebContents | null = null;
  let lastSelectedItem: BuiltInBrowserContextItem | null = null;
  let handlingInspectNode = false;
  let browserSessionConfigured = false;
  let lastEmittedStatusKey: string | null = null;
  const configuredWebContents = new WeakSet<WebContents>();

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

  const stopInspectQuietly = async (logKey: string): Promise<void> => {
    try {
      await stopInspect();
    } catch (error) {
      logger()?.debug(logKey, {
        err: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const removeTabViewsFromWindow = (): void => {
    if (!win || win.isDestroyed()) return;
    for (const tab of tabs) {
      if (!tab.view) continue;
      try {
        win.contentView.removeChildView(tab.view);
      } catch {
        // ignore stale view/window links
      }
    }
  };

  const pruneDestroyedTabs = (): void => {
    const nextTabs = tabs.filter((tab) => !tab.webContents.isDestroyed());
    if (nextTabs.length !== tabs.length) {
      tabs = nextTabs;
    }
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

  const clearSelectionInternal = (): void => {
    if (!lastSelectedItem) return;
    lastSelectedItem = null;
    emit({ type: "selection-cleared", item: null, clearedAt: new Date().toISOString() });
  };

  const configureBrowserWebContents = (wc: WebContents): void => {
    if (configuredWebContents.has(wc)) return;
    configuredWebContents.add(wc);
    wc.setWindowOpenHandler(({ url }) => {
      const tab = createPopupTabState(url);
      if (!tab) return { action: "deny" };
      return {
        action: "allow",
        createWindow: () => tab.webContents,
      };
    });
    wc.on("will-navigate", (event, url) => {
      if (isAllowedNavigationUrl(url)) return;
      event.preventDefault();
      emitError(new Error(`Blocked unsupported browser navigation protocol: ${url}`));
    });
    wc.on("did-start-loading", emitStatus);
    wc.on("did-stop-loading", emitStatus);
    wc.on("did-navigate", () => {
      clearSelectionInternal();
      emitStatus();
    });
    wc.on("did-navigate-in-page", () => {
      clearSelectionInternal();
      emitStatus();
    });
    wc.on("page-title-updated", emitStatus);
    wc.on("render-process-gone", (_event, details) => {
      logger()?.warn("built_in_browser.render_process_gone", {
        reason: details.reason,
        exitCode: details.exitCode,
      });
      emitStatus();
    });
    wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      logger()?.warn("built_in_browser.did_fail_load", {
        errorCode,
        errorDescription,
        validatedURL,
      });
      emitError(new Error(errorDescription || `Browser load failed with code ${errorCode}`));
      emitStatus();
    });
  };

  const createTabState = (): BrowserTabState => {
    configureBrowserSession();

    const nextView = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: true,
      },
    });
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
    };
  };

  const createPopupTabState = (url: string): BrowserTabState | null => {
    const popupUrl = stringOrNull(url) ?? "about:blank";
    if (!isAllowedNavigationUrl(popupUrl)) {
      emitError(new Error(`Blocked unsupported browser popup protocol: ${url}`));
      return null;
    }
    if (tabs.length >= MAX_BROWSER_TABS) {
      emitError(new Error(`ADE browser is limited to ${MAX_BROWSER_TABS} tabs. Close a tab before opening another.`));
      return null;
    }
    const tab = createTabState();
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
      if (!win.contentView.children.includes(tab.view)) {
        win.contentView.addChildView(tab.view);
      }
      const isActive = tab.id === activeTabId;
      if (isActive) tab.view.setBounds(electronRect);
      tab.view.setVisible(visible && isActive);
      applyTabLifecycle(tab, visible && isActive);
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

  const configureBrowserSession = (): void => {
    if (browserSessionConfigured) return;
    const browserSession = session.fromPartition(BROWSER_PARTITION);
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
    };
  }

  const requestOpenPanel = (input: BuiltInBrowserOpenPanelArgs = {}): BuiltInBrowserStatus => {
    const status = getStatus();
    const tabId = stringOrNull(input.tabId) ?? status.activeTabId;
    const url = stringOrNull(input.url) ?? status.url;
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
      return navigate({ url, tabId, openPanel: true });
    }
    if (tabId) {
      return switchTab({ tabId, openPanel: true });
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
    if (input.newTab && tabs.length >= MAX_BROWSER_TABS) {
      throw new Error(`ADE browser is limited to ${MAX_BROWSER_TABS} tabs. Close a tab before opening another.`);
    }
    // Validate tabId BEFORE any side effects (stopInspect/clearSelection) so an invalid id
    // doesn't leave the service with cleared inspect/selection state.
    let existingTab: BrowserTabState | null = null;
    if (!input.newTab && input.tabId) {
      existingTab = tabs.find((entry) => entry.id === input.tabId) ?? null;
      if (!existingTab) throw new Error(`Browser tab not found: ${input.tabId}`);
    }
    const switchingTabs = input.newTab || (input.tabId && input.tabId !== activeTabId);
    await stopInspectQuietly("built_in_browser.navigate_stop_inspect_failed");
    if (switchingTabs) {
      clearSelectionInternal();
    }
    let tab = input.newTab ? createTabState() : null;
    if (tab) {
      tabs = [...tabs, tab];
      activeTabId = tab.id;
    } else if (existingTab) {
      tab = existingTab;
      activeTabId = tab.id;
    } else {
      tab = ensureActiveTab();
    }
    const wc = tab.webContents;
    attachViewsToCurrentWindow();
    await wc.loadURL(targetUrl);
    if (input.openPanel) {
      requestOpenPanel({ url: targetUrl, tabId: tab.id });
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
    tabs = [...tabs, tab];
    if (willActivate) activeTabId = tab.id;
    attachViewsToCurrentWindow();
    if (normalizedUrl) {
      await tab.webContents.loadURL(normalizedUrl);
    }
    if (input.openPanel) {
      requestOpenPanel({ url: normalizedUrl, tabId: tab.id });
    }
    emitStatus();
    return getStatus();
  }

  async function switchTab(input: BuiltInBrowserTabArgs): Promise<BuiltInBrowserStatus> {
    const tabId = input.tabId?.trim();
    if (!tabId) throw new Error("Browser tab id is required.");
    const tab = tabs.find((entry) => entry.id === tabId);
    if (!tab) throw new Error(`Browser tab not found: ${tabId}`);
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
      requestOpenPanel({ tabId: tab.id });
    }
    emitStatus();
    return getStatus();
  }

  async function closeTab(input: BuiltInBrowserTabArgs): Promise<BuiltInBrowserStatus> {
    const tabId = input.tabId?.trim();
    if (!tabId) throw new Error("Browser tab id is required.");
    const index = tabs.findIndex((entry) => entry.id === tabId);
    if (index < 0) throw new Error(`Browser tab not found: ${tabId}`);
    if (tabId === activeTabId) {
      await stopInspectQuietly("built_in_browser.close_tab_stop_inspect_failed");
    }
    const [removed] = tabs.splice(index, 1);
    if (removed) {
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

  async function reload(): Promise<BuiltInBrowserStatus> {
    const wc = currentWebContents();
    if (!wc) {
      throw new Error("No active browser tab. Open a tab before reloading.");
    }
    wc.reload();
    emitStatus();
    return getStatus();
  }

  async function goBack(): Promise<BuiltInBrowserStatus> {
    const wc = currentWebContents();
    if (!wc) {
      throw new Error("No active browser tab. Open a tab before navigating back.");
    }
    if (wc.canGoBack()) wc.goBack();
    emitStatus();
    return getStatus();
  }

  async function goForward(): Promise<BuiltInBrowserStatus> {
    const wc = currentWebContents();
    if (!wc) {
      throw new Error("No active browser tab. Open a tab before navigating forward.");
    }
    if (wc.canGoForward()) wc.goForward();
    emitStatus();
    return getStatus();
  }

  async function stop(): Promise<BuiltInBrowserStatus> {
    const wc = currentWebContents();
    if (!wc) {
      throw new Error("No active browser tab. Open a tab before stopping a load.");
    }
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
      await sendDebuggerCommand(wc, "Overlay.enable");
      await sendDebuggerCommand(wc, "Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: {
          showInfo: true,
          showRulers: true,
          contentColor: { r: 72, g: 151, b: 255, a: 0.22 },
          borderColor: { r: 72, g: 151, b: 255, a: 0.92 },
          paddingColor: { r: 120, g: 199, b: 132, a: 0.24 },
          marginColor: { r: 246, g: 190, b: 93, a: 0.22 },
        },
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
    const wc = currentWebContents();
    inspecting = false;
    if (wc?.debugger.isAttached()) {
      try {
        await sendDebuggerCommand(wc, "Overlay.setInspectMode", { mode: "none" });
        await sendDebuggerCommand(wc, "Overlay.disable");
      } catch (error) {
        logger()?.debug("built_in_browser.stop_inspect_overlay_failed", {
          err: error instanceof Error ? error.message : String(error),
        });
      }
      detachDebuggerIfOwned(wc);
    }
    emitStatus();
    return getStatus();
  }

  async function captureScreenshot(): Promise<BuiltInBrowserScreenshot> {
    const wc = currentWebContents();
    if (!wc) {
      throw new Error("No active browser tab. Open a tab before capturing a screenshot.");
    }
    attachViewsToCurrentWindow();
    try {
      return await capturePageScreenshot(wc);
    } catch (error) {
      logger()?.debug("built_in_browser.capture_page_failed", {
        err: error instanceof Error ? error.message : String(error),
      });
      return captureCdpScreenshot(wc);
    }
  }

  async function selectPoint(input: BuiltInBrowserSelectPointArgs): Promise<BuiltInBrowserSelectResult> {
    const wc = currentWebContents();
    if (!wc) {
      throw new Error("No active browser tab. Open a tab before selecting a point.");
    }
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
      const metadata = await readNodeMetadata(wc, result.backendNodeId);
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
    activeTabId = null;
  }

  const attachDebuggerListeners = (wc: WebContents): void => {
    if (inspectListenerWebContents && inspectListenerWebContents !== wc) {
      detachDebuggerListeners(inspectListenerWebContents);
    }
    if (debuggerMessageListener || debuggerDetachListener) return;
    debuggerMessageListener = (_event, method, params) => {
      if (method !== "Overlay.inspectNodeRequested") return;
      const backendNodeId = isRecord(params) ? params.backendNodeId : null;
      if (typeof backendNodeId !== "number" || !Number.isFinite(backendNodeId)) return;
      void handleInspectNodeRequested(wc, backendNodeId).catch(emitError);
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

  const handleInspectNodeRequested = async (
    wc: WebContents,
    backendNodeId: number,
  ): Promise<void> => {
    if (handlingInspectNode) return;
    handlingInspectNode = true;
    try {
      const metadata = await readNodeMetadata(wc, backendNodeId);
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
  ): BuiltInBrowserContextItem => ({
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
    metadata: metadata.metadata,
    screenshotDataUrl,
    selectedAt: new Date().toISOString(),
  });

  const readNodeMetadata = async (
    wc: WebContents,
    backendNodeId: number,
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
      wc.capturePage(rect),
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

  return {
    attachToWindow,
    getStatus,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function shouldAllowGoogleAuthPermissionCheck(
  permission: string,
  requestingOrigin: string,
  details: Electron.PermissionCheckHandlerHandlerDetails,
): boolean {
  if (!GOOGLE_AUTH_PERMISSION_CHECK_ALLOWLIST.has(permission)) return false;
  return (
    isGoogleAccountsSurface(requestingOrigin)
    || isGoogleAccountsSurface(details.requestingUrl)
    || isGoogleAccountsSurface(details.embeddingOrigin)
    || isGoogleAccountsSurface(details.securityOrigin)
  );
}

function shouldAllowGoogleAuthPermissionRequest(permission: string, details: unknown): boolean {
  if (!GOOGLE_AUTH_PERMISSION_REQUEST_ALLOWLIST.has(permission)) return false;
  if (!isRecord(details)) return false;
  return (
    isGoogleAccountsSurface(details.requestingUrl)
    || isGoogleAccountsSurface(details.requestingOrigin)
  );
}

function isGoogleAccountsSurface(value: unknown): boolean {
  const text = stringOrNull(value);
  if (!text) return false;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "https:" && (
      parsed.hostname === "accounts.google.com"
      || parsed.hostname.endsWith(".accounts.google.com")
    );
  } catch {
    return false;
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
  };
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function normalizeBrowserUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error("Browser URL is required.");

  const localhostLike = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|\/|$)/i.test(trimmed);
  const hasScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed);
  let candidate: string;
  if (localhostLike) {
    candidate = `http://${trimmed}`;
  } else if (hasScheme) {
    candidate = trimmed;
  } else {
    candidate = `https://${trimmed}`;
  }

  const parsed = new URL(candidate);
  if (parsed.protocol === "about:") {
    if (parsed.href === "about:blank") return parsed.href;
    throw new Error("Only about:blank browser navigation is supported.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported browser URL protocol: ${parsed.protocol}`);
  }
  return parsed.href;
}

function isAllowedNavigationUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "about:") return parsed.href.startsWith("about:blank");
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
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

const NODE_METADATA_FUNCTION = String.raw`
function() {
  const original = this;
  const element = original && original.nodeType === Node.ELEMENT_NODE
    ? original
    : original && original.parentElement
      ? original.parentElement
      : null;
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
      metadata: { nodeType: original ? original.nodeType : null }
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
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY }
    }
  };
}
`;
