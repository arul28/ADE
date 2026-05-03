import { WebContentsView, nativeImage, session } from "electron";
import type { BrowserWindow, WebContents } from "electron";
import { randomUUID } from "node:crypto";
import type {
  BuiltInBrowserBoundsArgs,
  BuiltInBrowserContextItem,
  BuiltInBrowserEventPayload,
  BuiltInBrowserFrame,
  BuiltInBrowserNavigateArgs,
  BuiltInBrowserScreenshot,
  BuiltInBrowserSelectResult,
  BuiltInBrowserStatus,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";

const BROWSER_PARTITION: BuiltInBrowserStatus["partition"] = "persist:ade-browser";
const SCREENSHOT_TIMEOUT_MS = 3_000;
const ELEMENT_SCREENSHOT_TIMEOUT_MS = 2_000;
const DEBUGGER_TIMEOUT_MS = 3_000;

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

export function createBuiltInBrowserService(args: {
  getLogger?: () => Logger;
  onEvent?: ((payload: BuiltInBrowserEventPayload) => void) | null;
}) {
  let win: BrowserWindow | null = null;
  let winClosedListener: (() => void) | null = null;
  let view: WebContentsView | null = null;
  let bounds: BuiltInBrowserFrame = { x: 0, y: 0, width: 0, height: 0 };
  let visible = false;
  let inspecting = false;
  let debuggerAttachedForInspect = false;
  let debuggerMessageListener: DebuggerMessageListener | null = null;
  let debuggerDetachListener: DebuggerDetachListener | null = null;
  let lastSelectedItem: BuiltInBrowserContextItem | null = null;
  let handlingInspectNode = false;
  let browserSessionConfigured = false;

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
    emit({ type: "status", status: getStatus() });
  };

  const emitError = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    logger()?.warn("built_in_browser.error", { err: message });
    emit({ type: "error", message, occurredAt: new Date().toISOString() });
  };

  const currentWebContents = (): WebContents | null => {
    const wc = view?.webContents ?? null;
    if (!wc || wc.isDestroyed()) return null;
    return wc;
  };

  const ensureView = (): WebContentsView => {
    if (view && !view.webContents.isDestroyed()) return view;

    inspecting = false;
    debuggerAttachedForInspect = false;
    debuggerMessageListener = null;
    debuggerDetachListener = null;
    configureBrowserSession();

    const nextView = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    nextView.setBackgroundColor("#ffffff");
    nextView.setBounds(toElectronRect(bounds));
    nextView.setVisible(visible);

    const wc = nextView.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      void navigate({ url }).catch(emitError);
      return { action: "deny" };
    });
    wc.on("will-navigate", (event, url) => {
      if (isAllowedNavigationUrl(url)) return;
      event.preventDefault();
      emitError(new Error(`Blocked unsupported browser navigation protocol: ${url}`));
    });
    wc.on("did-start-loading", emitStatus);
    wc.on("did-stop-loading", emitStatus);
    wc.on("did-navigate", emitStatus);
    wc.on("did-navigate-in-page", emitStatus);
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

    view = nextView;
    attachViewToCurrentWindow();
    return nextView;
  };

  const attachViewToCurrentWindow = (): void => {
    if (!view || !win || win.isDestroyed()) return;
    if (!win.contentView.children.includes(view)) {
      win.contentView.addChildView(view);
    }
    view.setBounds(toElectronRect(bounds));
    view.setVisible(visible);
  };

  const configureBrowserSession = (): void => {
    if (browserSessionConfigured) return;
    const browserSession = session.fromPartition(BROWSER_PARTITION);
    browserSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
      logger()?.debug("built_in_browser.permission_check_denied", {
        permission,
        requestingOrigin,
      });
      return false;
    });
    browserSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      logger()?.debug("built_in_browser.permission_request_denied", {
        permission,
        requestingOrigin: "requestingOrigin" in details ? details.requestingOrigin : null,
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
    if (view && win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(view);
      } catch {
        // ignore stale view/window links
      }
    }

    win = nextWin;
    winClosedListener = () => {
      win = null;
      winClosedListener = null;
      emitStatus();
    };
    win.once("closed", winClosedListener);
    attachViewToCurrentWindow();
    emitStatus();
  };

  function getStatus(): BuiltInBrowserStatus {
    const wc = currentWebContents();
    return {
      attached: Boolean(win && !win.isDestroyed() && view && win.contentView.children.includes(view)),
      partition: BROWSER_PARTITION,
      visible,
      bounds,
      url: wc ? emptyToNull(wc.getURL()) : null,
      title: wc ? emptyToNull(wc.getTitle()) : null,
      isLoading: wc?.isLoading() ?? false,
      canGoBack: wc?.canGoBack() ?? false,
      canGoForward: wc?.canGoForward() ?? false,
      isInspecting: inspecting,
      hasSelection: lastSelectedItem !== null,
    };
  }

  async function setBounds(nextBounds: BuiltInBrowserBoundsArgs): Promise<BuiltInBrowserStatus> {
    bounds = {
      x: normalizeDimension(nextBounds.x),
      y: normalizeDimension(nextBounds.y),
      width: normalizeDimension(nextBounds.width),
      height: normalizeDimension(nextBounds.height),
    };
    visible = nextBounds.visible && bounds.width > 0 && bounds.height > 0;
    if (visible || view) {
      const browserView = ensureView();
      browserView.setBounds(toElectronRect(bounds));
      browserView.setVisible(visible);
      attachViewToCurrentWindow();
    }
    emitStatus();
    return getStatus();
  }

  async function navigate(input: BuiltInBrowserNavigateArgs): Promise<BuiltInBrowserStatus> {
    const targetUrl = normalizeBrowserUrl(input.url);
    const wc = ensureView().webContents;
    attachViewToCurrentWindow();
    await wc.loadURL(targetUrl);
    emitStatus();
    return getStatus();
  }

  async function reload(): Promise<BuiltInBrowserStatus> {
    const wc = ensureView().webContents;
    wc.reload();
    emitStatus();
    return getStatus();
  }

  async function goBack(): Promise<BuiltInBrowserStatus> {
    const wc = ensureView().webContents;
    if (wc.canGoBack()) wc.goBack();
    emitStatus();
    return getStatus();
  }

  async function goForward(): Promise<BuiltInBrowserStatus> {
    const wc = ensureView().webContents;
    if (wc.canGoForward()) wc.goForward();
    emitStatus();
    return getStatus();
  }

  async function stop(): Promise<BuiltInBrowserStatus> {
    const wc = ensureView().webContents;
    if (wc.isLoading()) wc.stop();
    emitStatus();
    return getStatus();
  }

  async function startInspect(): Promise<BuiltInBrowserStatus> {
    const wc = ensureView().webContents;
    attachViewToCurrentWindow();
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
    const wc = ensureView().webContents;
    attachViewToCurrentWindow();
    try {
      return await capturePageScreenshot(wc);
    } catch (error) {
      logger()?.debug("built_in_browser.capture_page_failed", {
        err: error instanceof Error ? error.message : String(error),
      });
      return captureCdpScreenshot(wc);
    }
  }

  async function selectCurrent(): Promise<BuiltInBrowserSelectResult> {
    if (lastSelectedItem) {
      emit({ type: "selection", item: lastSelectedItem });
    }
    return { item: lastSelectedItem };
  }

  async function clearSelection(): Promise<{ ok: true }> {
    lastSelectedItem = null;
    emit({ type: "selection-cleared", item: null, clearedAt: new Date().toISOString() });
    emitStatus();
    return { ok: true };
  }

  function dispose(): void {
    void stopInspect().catch(() => {});
    if (win && winClosedListener) {
      win.removeListener("closed", winClosedListener);
      winClosedListener = null;
    }
    if (view && win && !win.isDestroyed()) {
      try {
        win.contentView.removeChildView(view);
      } catch {
        // ignore stale view/window links
      }
    }
    try {
      view?.webContents.close();
    } catch {
      // ignore shutdown races
    }
    win = null;
    view = null;
  }

  const attachDebuggerListeners = (wc: WebContents): void => {
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
      emitStatus();
    };
    wc.debugger.on("message", debuggerMessageListener);
    wc.debugger.on("detach", debuggerDetachListener);
  };

  const detachDebuggerListeners = (wc: WebContents): void => {
    if (debuggerMessageListener) {
      wc.debugger.off("message", debuggerMessageListener);
      debuggerMessageListener = null;
    }
    if (debuggerDetachListener) {
      wc.debugger.off("detach", debuggerDetachListener);
      debuggerDetachListener = null;
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
      const selectedAt = new Date().toISOString();
      const item: BuiltInBrowserContextItem = {
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
        selectedAt,
      };
      lastSelectedItem = item;
      emit({ type: "selection", item });
      await stopInspect();
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
    setBounds,
    navigate,
    reload,
    goBack,
    goForward,
    stop,
    startInspect,
    stopInspect,
    captureScreenshot,
    selectCurrent,
    clearSelection,
    dispose,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
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
  const candidate = localhostLike
    ? `http://${trimmed}`
    : hasScheme
      ? trimmed
      : `https://${trimmed}`;

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
  const value = "value" in element ? String(element.value).slice(0, 300) : null;
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
