import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  CursorClick,
  ImageSquare,
  Paperclip,
  Play,
  Plus,
  Selection,
  SpinnerGap,
  Stop,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type { AgentChatFileRef } from "../../../shared/types";
import { inferAttachmentType } from "../../../shared/types";
import type { BuiltInBrowserTab } from "../../../shared/types/builtInBrowser";
import { consumePendingBuiltInBrowserNavigation } from "../../lib/openExternal";
import { cn } from "../ui/cn";

type BrowserFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type BrowserBounds = BrowserFrame & {
  visible: boolean;
};

type CaptureMediaBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
};

type BrowserCaptureSelection = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  bounds: CaptureMediaBounds;
};

type BuiltInBrowserContextItem = {
  kind: "built_in_browser_element" | "built_in_browser_capture" | "built_in_browser_selection" | (string & {});
  id: string;
  sessionId?: string | null;
  url: string | null;
  title: string | null;
  selector: string | null;
  text: string | null;
  role?: string | null;
  tagName?: string | null;
  frame: BrowserFrame | null;
  metadata: Record<string, unknown>;
  screenshotDataUrl?: string | null;
  selectedAt: string;
  [key: string]: unknown;
};

type BuiltInBrowserScreenshot = {
  path?: string | null;
  filePath?: string | null;
  data?: string | null;
  dataUrl?: string | null;
  screenshotDataUrl?: string | null;
  mimeType?: string | null;
  filename?: string | null;
  width?: number | null;
  height?: number | null;
  capturedAt?: string | null;
  item?: BuiltInBrowserContextItem | null;
  contextItem?: BuiltInBrowserContextItem | null;
  [key: string]: unknown;
};

type BuiltInBrowserStatus = {
  supported: boolean;
  visible: boolean;
  activeTabId: string | null;
  tabs: BuiltInBrowserTab[];
  url: string | null;
  title: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  inspecting: boolean;
  selectedItem: BuiltInBrowserContextItem | null;
  lastError?: string | null;
  [key: string]: unknown;
};

type BuiltInBrowserEventPayload = {
  type?: string;
  status?: unknown;
  item?: unknown;
  selection?: unknown;
  selectedItem?: unknown;
  screenshot?: unknown;
  url?: unknown;
  title?: unknown;
  canGoBack?: unknown;
  canGoForward?: unknown;
  loading?: unknown;
  inspecting?: unknown;
  error?: unknown;
  message?: unknown;
  [key: string]: unknown;
};

type BuiltInBrowserApi = {
  getStatus: () => Promise<unknown>;
  setBounds: (bounds: BrowserBounds) => Promise<void>;
  attachWebview?: (args: { tabId: string; webContentsId: number }) => Promise<unknown>;
  navigate: (args: { url: string; tabId?: string | null; newTab?: boolean }) => Promise<unknown>;
  createTab?: (args?: { url?: string | null; activate?: boolean }) => Promise<unknown>;
  switchTab?: (args: { tabId: string }) => Promise<unknown>;
  closeTab?: (args: { tabId: string }) => Promise<unknown>;
  reload: () => Promise<unknown>;
  goBack: () => Promise<unknown>;
  goForward: () => Promise<unknown>;
  stop: () => Promise<unknown>;
  startInspect: () => Promise<void>;
  stopInspect: () => Promise<void>;
  captureScreenshot: () => Promise<unknown>;
  selectPoint?: (args: { x: number; y: number; includeScreenshot?: boolean }) => Promise<unknown>;
  selectCurrent: () => Promise<unknown>;
  clearSelection: () => Promise<void>;
  onEvent: (cb: (event: BuiltInBrowserEventPayload) => void) => () => void;
};

type BrowserWebviewElement = HTMLElement & {
  capturePage?: () => Promise<{
    getSize?: () => { width: number; height: number };
    isEmpty?: () => boolean;
    toDataURL?: () => string;
  }>;
  getWebContentsId?: () => number;
};

type ChatBuiltInBrowserPanelProps = {
  sessionId: string | null;
  onAddContext?: (item: BuiltInBrowserContextItem) => void;
  onAddAttachment?: (attachment: AgentChatFileRef) => void;
  onInsertDraft?: (text: string) => void;
};

type MessageTone = "info" | "error";
type Message = { tone: MessageTone; text: string };

type StatusTone = "idle" | "active" | "warn" | "muted" | "error";
type StatusInfo = { label: string; detail: string; tone: StatusTone };
type BrowserCrop = {
  dataUrl: string;
  width: number;
  height: number;
  frame: BrowserFrame;
};

const BOUNDS_SETTLE_MS = 1_200;
const BOUNDS_SETTLE_MIN_FRAME_MS = 32;
const DEFAULT_BROWSER_URL = "https://www.google.com/";

const STATUS_PILL_TONE: Record<StatusTone, string> = {
  idle: "border-white/[0.08] bg-white/[0.03] text-muted-fg/65",
  active: "border-emerald-400/25 bg-emerald-500/10 text-emerald-100/85",
  warn: "border-amber-400/25 bg-amber-500/10 text-amber-100/85",
  muted: "border-white/[0.08] bg-white/[0.03] text-muted-fg/55",
  error: "border-rose-400/30 bg-rose-500/10 text-rose-200/85",
};

const STATUS_DOT_TONE: Record<StatusTone, string> = {
  idle: "bg-muted-fg/45",
  active: "bg-emerald-300",
  warn: "bg-amber-300",
  muted: "bg-muted-fg/40",
  error: "bg-rose-300",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function booleanField(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getBrowserApi(): BuiltInBrowserApi | null {
  return (window.ade as unknown as { builtInBrowser?: BuiltInBrowserApi }).builtInBrowser ?? null;
}

function requireBrowserApi(): BuiltInBrowserApi {
  const api = getBrowserApi();
  if (!api) throw new Error("Built-in browser is not available in this renderer.");
  return api;
}

function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

const UNSUPPORTED_NAVIGATION_SCHEME_RE = /^(about|blob|data|devtools|file):/i;

type NormalizedNavigationUrl =
  | { ok: true; url: string }
  | { ok: false; reason: string };

function normalizeUrlForNavigation(value: string): NormalizedNavigationUrl {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, url: trimmed };
  if (UNSUPPORTED_NAVIGATION_SCHEME_RE.test(trimmed)) {
    return {
      ok: false,
      reason: "Unsupported URL — the built-in browser only opens http(s) URLs.",
    };
  }
  if (/^https?:/i.test(trimmed)) return { ok: true, url: trimmed };
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed)) {
    return { ok: true, url: `http://${trimmed}` };
  }
  if (/^[^\s/]+\.[^\s]+/.test(trimmed)) return { ok: true, url: `https://${trimmed}` };
  return { ok: true, url: `https://www.google.com/search?q=${encodeURIComponent(trimmed)}` };
}

function normalizeFrame(value: unknown): BrowserFrame | null {
  if (!isRecord(value)) return null;
  const x = numberField(value.x);
  const y = numberField(value.y);
  const width = numberField(value.width);
  const height = numberField(value.height);
  if (x == null || y == null || width == null || height == null) return null;
  return { x, y, width, height };
}

function normalizeContextItem(value: unknown, status?: BuiltInBrowserStatus | null): BuiltInBrowserContextItem | null {
  if (!isRecord(value)) return null;
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const label = stringField(value.label)
    ?? stringField(metadata.label)
    ?? stringField(value.accessibleName)
    ?? stringField(value.name);
  const text = stringField(value.text)
    ?? stringField(metadata.text)
    ?? stringField(value.value)
    ?? stringField(metadata.value)
    ?? label;
  const url = stringField(value.url) ?? status?.url ?? null;
  const title = stringField(value.title) ?? status?.title ?? null;
  const selector = stringField(value.selector) ?? stringField(metadata.selector) ?? stringField(value.cssSelector) ?? null;
  const frame = normalizeFrame(value.frame) ?? normalizeFrame(value.pixelFrame) ?? normalizeFrame(value.bounds);
  const selectedAt = stringField(value.selectedAt) ?? new Date().toISOString();
  return {
    ...value,
    kind: stringField(value.kind) ?? "built_in_browser_element",
    id: stringField(value.id) ?? `built-in-browser-selection-${selectedAt}`,
    sessionId: stringField(value.sessionId),
    url,
    title,
    selector,
    text,
    role: stringField(value.role) ?? stringField(metadata.role),
    tagName: stringField(value.tagName) ?? stringField(metadata.tagName),
    frame,
    metadata,
    screenshotDataUrl: stringField(value.screenshotDataUrl) ?? stringField(value.dataUrl),
    selectedAt,
  };
}

function normalizeSelectionResult(value: unknown, status: BuiltInBrowserStatus | null): BuiltInBrowserContextItem | null {
  if (!isRecord(value)) return normalizeContextItem(value, status);
  return (
    normalizeContextItem(value.item, status)
    ?? normalizeContextItem(value.selection, status)
    ?? normalizeContextItem(value.selectedItem, status)
    ?? normalizeContextItem(value, status)
  );
}

function normalizeScreenshot(value: unknown, status: BuiltInBrowserStatus | null): BuiltInBrowserScreenshot | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.screenshot)) return normalizeScreenshot(value.screenshot, status);
  const item =
    normalizeContextItem(value.item, status)
    ?? normalizeContextItem(value.contextItem, status)
    ?? null;
  return {
    ...value,
    path: stringField(value.path),
    filePath: stringField(value.filePath),
    data: stringField(value.data) ?? stringField(value.base64),
    dataUrl: stringField(value.dataUrl),
    screenshotDataUrl: stringField(value.screenshotDataUrl),
    mimeType: stringField(value.mimeType) ?? "image/png",
    filename: stringField(value.filename) ?? "built-in-browser-screenshot.png",
    width: numberField(value.width),
    height: numberField(value.height),
    capturedAt: stringField(value.capturedAt) ?? new Date().toISOString(),
    item,
    contextItem: item,
  };
}

function normalizeTab(value: unknown): BuiltInBrowserTab | null {
  if (!isRecord(value)) return null;
  const id = stringField(value.id);
  if (!id) return null;
  return {
    id,
    url: stringField(value.url),
    title: stringField(value.title),
    isLoading: booleanField(value.isLoading, false),
    canGoBack: booleanField(value.canGoBack, false),
    canGoForward: booleanField(value.canGoForward, false),
  };
}

function normalizeStatus(value: unknown, previous: BuiltInBrowserStatus | null): BuiltInBrowserStatus {
  if (!isRecord(value)) {
    return {
      supported: previous?.supported ?? true,
      visible: previous?.visible ?? false,
      activeTabId: previous?.activeTabId ?? null,
      tabs: previous?.tabs ?? [],
      url: previous?.url ?? null,
      title: previous?.title ?? null,
      canGoBack: previous?.canGoBack ?? false,
      canGoForward: previous?.canGoForward ?? false,
      loading: previous?.loading ?? false,
      inspecting: previous?.inspecting ?? false,
      selectedItem: previous?.selectedItem ?? null,
      lastError: previous?.lastError ?? null,
    };
  }
  const rawTabs = Array.isArray(value.tabs) ? value.tabs.map(normalizeTab).filter((tab): tab is BuiltInBrowserTab => Boolean(tab)) : previous?.tabs ?? [];
  const activeTabId = stringField(value.activeTabId) ?? previous?.activeTabId ?? rawTabs[0]?.id ?? null;
  const activeTab = rawTabs.find((tab) => tab.id === activeTabId) ?? rawTabs[0] ?? null;
  return {
    ...value,
    supported: booleanField(value.supported, previous?.supported ?? true),
    visible: booleanField(value.visible, previous?.visible ?? false),
    activeTabId,
    tabs: rawTabs,
    url: stringField(value.url) ?? activeTab?.url ?? previous?.url ?? null,
    title: stringField(value.title) ?? activeTab?.title ?? previous?.title ?? null,
    canGoBack: booleanField(value.canGoBack, activeTab?.canGoBack ?? previous?.canGoBack ?? false),
    canGoForward: booleanField(value.canGoForward, activeTab?.canGoForward ?? previous?.canGoForward ?? false),
    loading: booleanField(value.loading, booleanField(value.isLoading, activeTab?.isLoading ?? previous?.loading ?? false)),
    inspecting: booleanField(value.inspecting, booleanField(value.isInspecting, previous?.inspecting ?? false)),
    selectedItem:
      normalizeContextItem(value.selectedItem, previous)
      ?? normalizeContextItem(value.selection, previous)
      ?? previous?.selectedItem
      ?? null,
    lastError: stringField(value.lastError) ?? stringField(value.error) ?? previous?.lastError ?? null,
  };
}

function buildStatusInfo(apiAvailable: boolean, status: BuiltInBrowserStatus | null): StatusInfo {
  if (!apiAvailable) {
    return { label: "Unavailable", detail: "The built-in browser API is not exposed on window.ade.", tone: "error" };
  }
  if (!status) {
    return { label: "Loading", detail: "Checking built-in browser status", tone: "warn" };
  }
  if (!status.supported) {
    return { label: "Unsupported", detail: status.lastError ?? "Built-in browser is not supported here.", tone: "error" };
  }
  if (status.lastError) {
    return { label: "Error", detail: status.lastError, tone: "error" };
  }
  if (status.inspecting) {
    return { label: "Inspecting", detail: "Click an element in the browser to select it.", tone: "active" };
  }
  if (status.loading) {
    return { label: "Loading", detail: status.url ?? "Navigating", tone: "warn" };
  }
  if (status.url) {
    return { label: "Ready", detail: status.title ?? status.url, tone: "active" };
  }
  return { label: "Idle", detail: "Open a page to start browsing.", tone: "idle" };
}

function contextItemLabel(item: BuiltInBrowserContextItem): string {
  return item.text ?? item.selector ?? item.title ?? item.url ?? "Selected element";
}

function contextItemSubLabel(item: BuiltInBrowserContextItem): string | null {
  if (item.role && item.text) return item.role;
  if (item.tagName && item.text) return item.tagName.toLowerCase();
  return item.selector;
}

function frameLabel(frame: BrowserFrame | null): string | null {
  if (!frame) return null;
  return `${Math.round(frame.x)}, ${Math.round(frame.y)} · ${Math.round(frame.width)}×${Math.round(frame.height)}`;
}

function shortSessionId(sessionId: string | null): string | null {
  if (!sessionId) return null;
  return sessionId.length <= 8 ? sessionId : `${sessionId.slice(0, 4)}…${sessionId.slice(-3)}`;
}

function boundsEqual(a: BrowserBounds | null, b: BrowserBounds): boolean {
  return Boolean(
    a
    && a.x === b.x
    && a.y === b.y
    && a.width === b.width
    && a.height === b.height
    && a.visible === b.visible,
  );
}

function measureNativeBrowserBounds(element: HTMLElement): BrowserBounds {
  const rect = element.getBoundingClientRect();
  let zoomFactor = 1;
  try {
    const factor = window.ade.zoom.getFactor();
    if (Number.isFinite(factor) && factor > 0) zoomFactor = factor;
  } catch {
    // Browser bounds still work at Electron's default zoom.
  }
  const style = window.getComputedStyle(element);
  const visible = (
    element.isConnected
    && style.display !== "none"
    && style.visibility !== "hidden"
    && rect.width >= 16
    && rect.height >= 16
  );
  return {
    x: Math.max(0, Math.round((rect.left + window.scrollX) * zoomFactor)),
    y: Math.max(0, Math.round((rect.top + window.scrollY) * zoomFactor)),
    width: Math.max(0, Math.round(rect.width * zoomFactor)),
    height: Math.max(0, Math.round(rect.height * zoomFactor)),
    visible,
  };
}

function clampBrowserFrame(frame: BrowserFrame, width: number, height: number): BrowserFrame {
  const cropWidth = Math.max(1, Math.min(width, Math.round(frame.width)));
  const cropHeight = Math.max(1, Math.min(height, Math.round(frame.height)));
  return {
    x: Math.max(0, Math.min(width - cropWidth, Math.round(frame.x))),
    y: Math.max(0, Math.min(height - cropHeight, Math.round(frame.y))),
    width: cropWidth,
    height: cropHeight,
  };
}

function browserCaptureFrame(
  selection: BrowserCaptureSelection,
  width: number,
  height: number,
): BrowserFrame {
  const rawX = Math.min(selection.startX, selection.currentX);
  const rawY = Math.min(selection.startY, selection.currentY);
  const rawWidth = Math.abs(selection.currentX - selection.startX);
  const rawHeight = Math.abs(selection.currentY - selection.startY);
  return clampBrowserFrame({ x: rawX, y: rawY, width: rawWidth, height: rawHeight }, width, height);
}

function measureObjectContain(element: HTMLElement, mediaWidth: number, mediaHeight: number): CaptureMediaBounds | null {
  if (!mediaWidth || !mediaHeight) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const scale = Math.min(rect.width / mediaWidth, rect.height / mediaHeight);
  const width = mediaWidth * scale;
  const height = mediaHeight * scale;
  return {
    left: (rect.width - width) / 2,
    top: (rect.height - height) / 2,
    width,
    height,
    scaleX: width / mediaWidth,
    scaleY: height / mediaHeight,
  };
}

function pointerToCapturePoint(
  event: PointerEvent<HTMLElement>,
  element: HTMLElement,
  mediaWidth: number,
  mediaHeight: number,
  clamp = false,
): ({ x: number; y: number; bounds: CaptureMediaBounds }) | null {
  const bounds = measureObjectContain(element, mediaWidth, mediaHeight);
  if (!bounds) return null;
  const rect = element.getBoundingClientRect();
  let x = (event.clientX - rect.left - bounds.left) / bounds.scaleX;
  let y = (event.clientY - rect.top - bounds.top) / bounds.scaleY;
  if (clamp) {
    x = Math.max(0, Math.min(mediaWidth, x));
    y = Math.max(0, Math.min(mediaHeight, y));
  } else if (x < 0 || y < 0 || x > mediaWidth || y > mediaHeight) {
    return null;
  }
  return { x, y, bounds };
}

async function cropBrowserScreenshot(
  screenshot: BuiltInBrowserScreenshot,
  frame: BrowserFrame,
): Promise<BrowserCrop | null> {
  const dataUrl = screenshot.dataUrl ?? screenshot.screenshotDataUrl ?? null;
  const width = screenshot.width ?? null;
  const height = screenshot.height ?? null;
  if (!dataUrl || !width || !height) return null;
  const cropFrame = clampBrowserFrame(frame, width, height);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = cropFrame.width;
      canvas.height = cropFrame.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(
        image,
        cropFrame.x,
        cropFrame.y,
        cropFrame.width,
        cropFrame.height,
        0,
        0,
        cropFrame.width,
        cropFrame.height,
      );
      resolve({
        dataUrl: canvas.toDataURL("image/png"),
        width: cropFrame.width,
        height: cropFrame.height,
        frame: cropFrame,
      });
    };
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

export function ChatBuiltInBrowserPanel({
  sessionId,
  onAddContext,
  onAddAttachment,
  onInsertDraft,
}: ChatBuiltInBrowserPanelProps) {
  const browserSurfaceRef = useRef<HTMLDivElement | null>(null);
  const browserWebviewsRef = useRef<Map<string, BrowserWebviewElement>>(new Map());
  const browserWebviewAttachCleanupRef = useRef<Map<string, () => void>>(new Map());
  const browserWebviewAttachKeysRef = useRef<Map<string, string>>(new Map());
  const pendingWebviewNavigationsRef = useRef<Map<string, string>>(new Map());
  const defaultBrowserOpenedRef = useRef(false);
  const captureImageRef = useRef<HTMLImageElement | null>(null);
  const latestBoundsRef = useRef<BrowserBounds | null>(null);
  const statusRef = useRef<BuiltInBrowserStatus | null>(null);
  const selectedItemRef = useRef<BuiltInBrowserContextItem | null>(null);
  const captureModeRef = useRef(false);
  const autoAttachedContextIdsRef = useRef(new Set<string>());
  const editingUrlRef = useRef(false);
  const apiAvailable = Boolean(getBrowserApi());
  const [status, setStatus] = useState<BuiltInBrowserStatus | null>(null);
  const [selectedItem, setSelectedItem] = useState<BuiltInBrowserContextItem | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [editingUrl, setEditingUrl] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [attachmentAck, setAttachmentAck] = useState<string | null>(null);
  const [lastScreenshot, setLastScreenshot] = useState<BuiltInBrowserScreenshot | null>(null);
  const [captureBase, setCaptureBase] = useState<BuiltInBrowserScreenshot | null>(null);
  const [captureSelection, setCaptureSelection] = useState<BrowserCaptureSelection | null>(null);
  const [webviewNavigationNonce, setWebviewNavigationNonce] = useState(0);

  const statusInfo = useMemo(() => buildStatusInfo(apiAvailable, status), [apiAvailable, status]);
  const browserTabs = useMemo(() => status?.tabs ?? [], [status?.tabs]);
  const tabIdsSignature = useMemo(() => browserTabs.map((tab) => tab.id).join("|"), [browserTabs]);
  const activeTabId = status?.activeTabId ?? browserTabs[0]?.id ?? null;
  const currentUrl = status?.url ?? "";
  const canGoBack = Boolean(status?.canGoBack);
  const canGoForward = Boolean(status?.canGoForward);
  const loading = Boolean(status?.loading);
  const inspecting = Boolean(status?.inspecting);
  const selectionFrame = frameLabel(selectedItem?.frame ?? null);
  const sessionLabel = shortSessionId(sessionId);
  const captureImageDataUrl = captureBase?.dataUrl ?? captureBase?.screenshotDataUrl ?? null;
  const activeCaptureFrame = useMemo(() => (
    captureBase?.width && captureBase?.height && captureSelection
      ? browserCaptureFrame(captureSelection, captureBase.width, captureBase.height)
      : null
  ), [captureBase?.height, captureBase?.width, captureSelection]);

  useEffect(() => {
    editingUrlRef.current = editingUrl;
  }, [editingUrl]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    autoAttachedContextIdsRef.current = new Set();
  }, [status?.url, status?.activeTabId]);

  useEffect(() => {
    selectedItemRef.current = selectedItem;
  }, [selectedItem]);

  useEffect(() => {
    if (!attachmentAck) return undefined;
    const timer = window.setTimeout(() => setAttachmentAck(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [attachmentAck]);

  const applyStatus = useCallback((value: unknown) => {
    const normalized = normalizeStatus(value, statusRef.current);
    statusRef.current = normalized;
    const nextSelection = normalized.selectedItem;
    selectedItemRef.current = nextSelection;
    setStatus(normalized);
    setSelectedItem(nextSelection);
    if (!editingUrlRef.current) setUrlInput(normalized.url ?? "");
  }, []);

  const refreshStatus = useCallback(async () => {
    const api = requireBrowserApi();
    const nextStatus = await api.getStatus();
    applyStatus(nextStatus);
  }, [applyStatus]);

  const attachBrowserContextItem = useCallback(async (
    item: BuiltInBrowserContextItem,
    options: { force?: boolean; auto?: boolean; label?: string } = {},
  ): Promise<BuiltInBrowserContextItem | null> => {
    if (!onAddContext) throw new Error("Chat context is not available in this panel.");
    if (!options.force && autoAttachedContextIdsRef.current.has(item.id)) return null;

    let attachmentPath = typeof item.metadata?.attachmentPath === "string" ? item.metadata.attachmentPath : null;
    const screenshotDataUrl = item.screenshotDataUrl ?? null;
    if (screenshotDataUrl && !attachmentPath && onAddAttachment) {
      try {
        const saved = await window.ade.agentChat.saveTempAttachment({
          data: stripDataUrlPrefix(screenshotDataUrl),
          filename: item.kind === "built_in_browser_capture" ? "built-in-browser-capture.png" : "built-in-browser-selection.png",
        });
        attachmentPath = saved.path;
        onAddAttachment({ path: saved.path, type: inferAttachmentType(saved.path, "image/png") });
      } catch (error) {
        setMessage({ tone: "error", text: `Could not save browser context screenshot: ${errorMessage(error)}` });
      }
    }

    const contextItem: BuiltInBrowserContextItem = {
      ...item,
      sessionId: item.sessionId ?? sessionId,
      metadata: {
        ...item.metadata,
        browserContextPacketVersion: item.metadata.browserContextPacketVersion ?? 1,
        contextSurface: item.metadata.contextSurface ?? "built_in_browser",
        ...(sessionId ? { chatSessionId: sessionId } : {}),
        ...(attachmentPath ? { attachmentPath } : {}),
      },
    };
    onAddContext(contextItem);
    autoAttachedContextIdsRef.current.add(item.id);
    selectedItemRef.current = contextItem;
    setSelectedItem(contextItem);
    setStatus((current) => current ? { ...current, selectedItem: contextItem } : current);
    const isCapture = item.kind === "built_in_browser_capture";
    setAttachmentAck(options.label ?? (isCapture ? "Browser capture attached." : "Browser context attached."));
    let messageText: string;
    if (options.auto) {
      messageText = "Attached browser inspect context to chat.";
    } else if (isCapture) {
      messageText = "Attached browser capture to chat with page context.";
    } else {
      messageText = "Attached the selected browser element to chat.";
    }
    setMessage({ tone: "info", text: messageText });
    return contextItem;
  }, [onAddAttachment, onAddContext, sessionId]);

  const reportBounds = useCallback((visibleOverride?: boolean) => {
    const api = getBrowserApi();
    const element = browserSurfaceRef.current;
    if (!api || !element) return;
    if (typeof api.attachWebview === "function") {
      const hidden: BrowserBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };
      if (boundsEqual(latestBoundsRef.current, hidden)) return;
      latestBoundsRef.current = hidden;
      api.setBounds(hidden).catch((error: unknown) => {
        setMessage({ tone: "error", text: `Could not hide browser fallback: ${errorMessage(error)}` });
      });
      return;
    }
    const measured = measureNativeBrowserBounds(element);
    const next: BrowserBounds = {
      ...measured,
      visible: visibleOverride ?? (!captureModeRef.current && measured.visible),
    };
    if (boundsEqual(latestBoundsRef.current, next)) return;
    latestBoundsRef.current = next;
    api.setBounds(next).catch((error: unknown) => {
      setMessage({ tone: "error", text: `Could not position browser: ${errorMessage(error)}` });
    });
  }, []);

  const hideNativeBrowserView = useCallback(async () => {
    const api = getBrowserApi();
    if (!api) return;
    const last = latestBoundsRef.current;
    const hidden = {
      x: last?.x ?? 0,
      y: last?.y ?? 0,
      width: last?.width ?? 0,
      height: last?.height ?? 0,
      visible: false,
    };
    latestBoundsRef.current = hidden;
    await api.stopInspect().catch(() => {});
    await api.setBounds(hidden).catch(() => {});
  }, []);

  useLayoutEffect(() => {
    const element = browserSurfaceRef.current;
    if (!element) return undefined;
    let animationFrame: number | null = null;
    let settleFrame: number | null = null;
    let settleUntil = 0;
    let lastSettleReportAt = 0;
    const scheduleReport = () => {
      if (animationFrame != null) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        reportBounds();
      });
    };
    const scheduleSettledReport = () => {
      scheduleReport();
      settleUntil = window.performance.now() + BOUNDS_SETTLE_MS;
      if (settleFrame != null) return;
      const tick = (now: number) => {
        settleFrame = null;
        if (now - lastSettleReportAt >= BOUNDS_SETTLE_MIN_FRAME_MS) {
          lastSettleReportAt = now;
          reportBounds();
        }
        if (now < settleUntil) {
          settleFrame = window.requestAnimationFrame(tick);
        }
      };
      settleFrame = window.requestAnimationFrame(tick);
    };
    const handleSubtreeTransition = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && element.contains(target)) scheduleSettledReport();
    };
    scheduleSettledReport();
    const observer = new ResizeObserver(scheduleSettledReport);
    observer.observe(element);
    window.addEventListener("resize", scheduleSettledReport);
    element.addEventListener("transitionend", handleSubtreeTransition);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleSettledReport);
      element.removeEventListener("transitionend", handleSubtreeTransition);
      if (animationFrame != null) window.cancelAnimationFrame(animationFrame);
      if (settleFrame != null) window.cancelAnimationFrame(settleFrame);
      const last = latestBoundsRef.current;
      const api = getBrowserApi();
      if (api && last) {
        api.stopInspect().catch(() => {});
        latestBoundsRef.current = { ...last, visible: false };
        api.setBounds({ ...last, visible: false }).catch(() => {});
      }
    };
  }, [reportBounds]);

  useEffect(() => {
    const api = getBrowserApi();
    if (!api) {
      setMessage({ tone: "error", text: "Built-in browser API is not available in this renderer." });
      return undefined;
    }
    let cancelled = false;
    api.getStatus()
      .then((nextStatus) => {
        if (!cancelled) applyStatus(nextStatus);
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage({ tone: "error", text: errorMessage(error) });
      });
    const unsubscribe = api.onEvent((event) => {
      const eventType = typeof event.type === "string" ? event.type : "";
      if (event.status) {
        applyStatus(event.status);
      } else if (
        eventType === "status"
        || eventType === "status-changed"
        || eventType === "updated"
        || eventType === "navigation"
      ) {
        applyStatus(event);
      }
      const nextSelection =
        normalizeContextItem(event.item, statusRef.current)
        ?? normalizeContextItem(event.selection, statusRef.current)
        ?? normalizeContextItem(event.selectedItem, statusRef.current);
      if (nextSelection) {
        selectedItemRef.current = nextSelection;
        setSelectedItem(nextSelection);
        setStatus((current) => current ? { ...current, selectedItem: nextSelection } : current);
        if (!captureModeRef.current && onAddContext) {
          void attachBrowserContextItem(nextSelection, {
            auto: true,
            label: "Browser context attached.",
          }).catch((error: unknown) => {
            setMessage({ tone: "error", text: errorMessage(error) });
          });
        }
      } else if (eventType === "selection-cleared" || eventType === "clear-selection") {
        selectedItemRef.current = null;
        setSelectedItem(null);
        setStatus((current) => current ? { ...current, selectedItem: null } : current);
      }
      const nextScreenshot = normalizeScreenshot(event.screenshot, statusRef.current);
      if (nextScreenshot) {
        // Drop the data URL; only width/height/capturedAt are surfaced in the UI.
        // Retaining multi-MB base64 strings across the panel's lifetime bloats the renderer heap.
        setLastScreenshot({
          width: nextScreenshot.width ?? null,
          height: nextScreenshot.height ?? null,
          capturedAt: nextScreenshot.capturedAt ?? null,
        });
      }
      const nextError = stringField(event.error) ?? stringField(event.message);
      if (nextError && /error|failed/i.test(eventType || "error")) {
        setMessage({ tone: "error", text: nextError });
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyStatus, attachBrowserContextItem, onAddContext]);

  useEffect(() => () => {
    for (const cleanup of browserWebviewAttachCleanupRef.current.values()) cleanup();
    for (const webview of browserWebviewsRef.current.values()) webview.remove();
    browserWebviewAttachCleanupRef.current.clear();
    browserWebviewsRef.current.clear();
    browserWebviewAttachKeysRef.current.clear();
  }, []);

  useLayoutEffect(() => {
    const api = getBrowserApi();
    const host = browserSurfaceRef.current;
    if (!api?.attachWebview || !host) return;

    const tabIds = new Set(browserTabs.map((tab) => tab.id));
    for (const [tabId, cleanup] of browserWebviewAttachCleanupRef.current) {
      if (tabIds.has(tabId)) continue;
      cleanup();
      browserWebviewAttachCleanupRef.current.delete(tabId);
      browserWebviewAttachKeysRef.current.delete(tabId);
      const webview = browserWebviewsRef.current.get(tabId);
      if (webview) {
        webview.remove();
        browserWebviewsRef.current.delete(tabId);
      }
    }

    const attachVisibleWebview = (tabId: string, webview: BrowserWebviewElement) => {
      let webContentsId: number | undefined;
      try {
        webContentsId = webview.getWebContentsId?.();
      } catch {
        return;
      }
      if (!webContentsId || webContentsId <= 0) return;
      const attachKey = `${tabId}:${webContentsId}`;
      if (browserWebviewAttachKeysRef.current.get(tabId) === attachKey) return;
      browserWebviewAttachKeysRef.current.set(tabId, attachKey);
      void api.attachWebview?.({ tabId, webContentsId })
        .then((nextStatus) => applyStatus(nextStatus))
        .catch((error: unknown) => {
          browserWebviewAttachKeysRef.current.delete(tabId);
          setMessage({ tone: "error", text: `Could not attach ADE browser webview: ${errorMessage(error)}` });
        });
    };

    for (const tab of browserTabs) {
      let webview = browserWebviewsRef.current.get(tab.id);
      if (!webview) {
        const nextWebview = document.createElement("webview") as BrowserWebviewElement;
        nextWebview.className = "absolute inset-0 h-full w-full";
        nextWebview.style.backgroundColor = "#05070b";
        nextWebview.style.border = "0";
        nextWebview.style.display = "none";
        nextWebview.style.height = "100%";
        nextWebview.style.width = "100%";
        nextWebview.setAttribute("partition", "persist:ade-browser");
        nextWebview.setAttribute("webpreferences", "contextIsolation=yes,nodeIntegration=no,sandbox=yes");
        browserWebviewsRef.current.set(tab.id, nextWebview);
        webview = nextWebview;

        const attach = () => attachVisibleWebview(tab.id, nextWebview);
        nextWebview.addEventListener("dom-ready", attach);
        browserWebviewAttachCleanupRef.current.set(tab.id, () => {
          nextWebview.removeEventListener("dom-ready", attach);
        });
      }

      if (webview.parentElement !== host) {
        host.appendChild(webview);
      }

      const pendingUrl = pendingWebviewNavigationsRef.current.get(tab.id) ?? null;
      const fallbackUrl = tab.id === activeTabId ? statusRef.current?.url ?? "" : "";
      const initialUrl = pendingUrl ?? tab.url ?? fallbackUrl ?? "about:blank";
      if ((pendingUrl || !browserWebviewAttachKeysRef.current.has(tab.id)) && webview.getAttribute("src") !== initialUrl) {
        webview.setAttribute("src", initialUrl.length > 0 ? initialUrl : "about:blank");
      }
      if (pendingUrl) {
        pendingWebviewNavigationsRef.current.delete(tab.id);
      }

      const isActive = tab.id === activeTabId;
      webview.style.display = isActive ? "flex" : "none";
      webview.style.visibility = isActive && captureBase ? "hidden" : "visible";
      webview.style.pointerEvents = isActive && !captureBase ? "auto" : "none";
      webview.setAttribute("aria-hidden", isActive ? "false" : "true");
    }
  }, [activeTabId, applyStatus, tabIdsSignature, captureBase, webviewNavigationNonce]);

  const runBusy = useCallback(async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }, []);

  const restoreLiveBrowserView = useCallback(() => {
    captureModeRef.current = false;
    setCaptureBase(null);
    setCaptureSelection(null);
    window.requestAnimationFrame(() => reportBounds());
  }, [reportBounds]);

  const navigateRendererWebview = useCallback((tabId: string, url: string): boolean => {
    const webview = browserWebviewsRef.current.get(tabId);
    if (!webview) {
      pendingWebviewNavigationsRef.current.set(tabId, url);
      setWebviewNavigationNonce((value) => value + 1);
      return true;
    }
    if (webview.getAttribute("src") !== url) {
      webview.setAttribute("src", url);
    }
    setWebviewNavigationNonce((value) => value + 1);
    return true;
  }, []);

  const attachActiveRendererWebview = useCallback(async (): Promise<boolean> => {
    const api = getBrowserApi();
    if (!api?.attachWebview || !activeTabId) return false;
    const webview = browserWebviewsRef.current.get(activeTabId);
    if (!webview) return false;
    let webContentsId: number | undefined;
    try {
      webContentsId = webview.getWebContentsId?.();
    } catch {
      return false;
    }
    if (!webContentsId || webContentsId <= 0) return false;
    const attachKey = `${activeTabId}:${webContentsId}`;
    if (browserWebviewAttachKeysRef.current.get(activeTabId) !== attachKey) {
      browserWebviewAttachKeysRef.current.set(activeTabId, attachKey);
      const nextStatus = await api.attachWebview({ tabId: activeTabId, webContentsId });
      applyStatus(nextStatus);
    }
    return true;
  }, [activeTabId, applyStatus]);

  const captureActiveRendererWebview = useCallback(async (): Promise<BuiltInBrowserScreenshot | null> => {
    if (!activeTabId) return null;
    const webview = browserWebviewsRef.current.get(activeTabId);
    if (!webview?.capturePage) return null;
    const image = await webview.capturePage();
    if (!image?.toDataURL || image.isEmpty?.()) return null;
    const dataUrl = image.toDataURL();
    const size = image.getSize?.() ?? { width: 0, height: 0 };
    if (!dataUrl || size.width <= 0 || size.height <= 0) return null;
    return {
      capturedAt: new Date().toISOString(),
      width: size.width,
      height: size.height,
      dataUrl,
      mimeType: "image/png",
      filename: "built-in-browser-screenshot.png",
    };
  }, [activeTabId]);

  useEffect(() => {
    if (browserTabs.length > 0) {
      defaultBrowserOpenedRef.current = false;
    }
  }, [browserTabs.length]);

  useEffect(() => {
    const api = getBrowserApi();
    if (!apiAvailable || !api || !status) return;
    // Consume the pending-navigation flag as soon as the panel has an API and
    // status, regardless of whether the default-tab branch ends up running.
    // Otherwise a fast status update with browserTabs.length > 0 on first
    // render strands a stale `true` flag, which suppresses the default tab on
    // a later panel reopen with no tabs.
    const hadPendingNavigation = consumePendingBuiltInBrowserNavigation();
    if (browserTabs.length > 0 || defaultBrowserOpenedRef.current) return;
    // If a link-click in the renderer kicked off an openInAdeBrowser navigation
    // that's still in flight (panel mounted via the open-built-in-browser event,
    // but the navigate IPC has not landed in status yet), suppress the default
    // Google tab so we don't end up with two tabs.
    if (hadPendingNavigation) {
      defaultBrowserOpenedRef.current = true;
      return;
    }
    defaultBrowserOpenedRef.current = true;
    void (async () => {
      try {
        if (api.attachWebview && api.createTab) {
          const nextStatus = normalizeStatus(await api.createTab({ activate: true }), statusRef.current);
          applyStatus(nextStatus);
          const tabId = nextStatus.activeTabId;
          if (!tabId) throw new Error("ADE browser could not create a tab.");
          navigateRendererWebview(tabId, DEFAULT_BROWSER_URL);
          setUrlInput(DEFAULT_BROWSER_URL);
          return;
        }
        const nextStatus = api.createTab
          ? await api.createTab({ url: DEFAULT_BROWSER_URL, activate: true })
          : await api.navigate({ url: DEFAULT_BROWSER_URL, newTab: true });
        applyStatus(nextStatus);
        setUrlInput(DEFAULT_BROWSER_URL);
      } catch (error) {
        defaultBrowserOpenedRef.current = false;
        setMessage({ tone: "error", text: errorMessage(error) });
      }
    })();
  }, [apiAvailable, applyStatus, browserTabs.length, navigateRendererWebview, status]);

  const handleNavigate = useCallback(
    (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      const normalized = normalizeUrlForNavigation(urlInput);
      if (!normalized.ok) {
        setMessage({ tone: "error", text: normalized.reason });
        return;
      }
      const nextUrl = normalized.url;
      if (!nextUrl) return;
      void runBusy("navigate", async () => {
        if (captureModeRef.current) restoreLiveBrowserView();
        const api = requireBrowserApi();
        if (api.attachWebview) {
          let tabId: string | null = activeTabId;
          if (!tabId) {
            if (!api.createTab) throw new Error("This ADE build does not support browser tab creation.");
            const nextStatus = normalizeStatus(await api.createTab({ activate: true }), statusRef.current);
            applyStatus(nextStatus);
            tabId = nextStatus.activeTabId;
          }
          if (!tabId) throw new Error("ADE browser could not create a tab.");
          navigateRendererWebview(tabId, nextUrl);
          setUrlInput(nextUrl);
          return;
        }
        await api.navigate({ url: nextUrl });
        setUrlInput(nextUrl);
        await refreshStatus();
      });
    },
    [activeTabId, applyStatus, navigateRendererWebview, refreshStatus, restoreLiveBrowserView, runBusy, urlInput],
  );

  const handleNewTab = useCallback(() => {
    void runBusy("new-tab", async () => {
      if (captureModeRef.current) restoreLiveBrowserView();
      const api = requireBrowserApi();
      if (api.attachWebview && api.createTab) {
        const nextStatus = normalizeStatus(await api.createTab({ activate: true }), statusRef.current);
        applyStatus(nextStatus);
        const tabId = nextStatus.activeTabId;
        if (!tabId) throw new Error("ADE browser could not create a tab.");
        navigateRendererWebview(tabId, DEFAULT_BROWSER_URL);
        setUrlInput(DEFAULT_BROWSER_URL);
        return;
      }
      if (api.createTab) {
        const nextStatus = await api.createTab({ url: DEFAULT_BROWSER_URL, activate: true });
        applyStatus(nextStatus);
      } else {
        const nextStatus = await api.navigate({ url: DEFAULT_BROWSER_URL, newTab: true });
        applyStatus(nextStatus);
      }
      setUrlInput(DEFAULT_BROWSER_URL);
    });
  }, [applyStatus, navigateRendererWebview, restoreLiveBrowserView, runBusy]);

  const handleSwitchTab = useCallback((tabId: string) => {
    void runBusy("switch-tab", async () => {
      if (captureModeRef.current) restoreLiveBrowserView();
      const api = requireBrowserApi();
      if (api.switchTab) {
        await api.switchTab({ tabId });
      } else {
        throw new Error("This ADE build does not support browser tab switching.");
      }
      await refreshStatus();
    });
  }, [refreshStatus, restoreLiveBrowserView, runBusy]);

  const handleCloseTab = useCallback((tabId: string) => {
    void runBusy("close-tab", async () => {
      if (captureModeRef.current) restoreLiveBrowserView();
      const api = requireBrowserApi();
      if (api.closeTab) {
        await api.closeTab({ tabId });
      } else {
        throw new Error("This ADE build does not support closing browser tabs.");
      }
      await refreshStatus();
    });
  }, [refreshStatus, restoreLiveBrowserView, runBusy]);

  const handleBack = useCallback(() => {
    void runBusy("back", async () => {
      const api = requireBrowserApi();
      await api.goBack();
      await refreshStatus();
    });
  }, [refreshStatus, runBusy]);

  const handleForward = useCallback(() => {
    void runBusy("forward", async () => {
      const api = requireBrowserApi();
      await api.goForward();
      await refreshStatus();
    });
  }, [refreshStatus, runBusy]);

  const handleReload = useCallback(() => {
    void runBusy("reload", async () => {
      const api = requireBrowserApi();
      await api.reload();
      await refreshStatus();
    });
  }, [refreshStatus, runBusy]);

  const handleStop = useCallback(() => {
    void runBusy("stop", async () => {
      const api = requireBrowserApi();
      await api.stop();
      await refreshStatus();
    });
  }, [refreshStatus, runBusy]);

  const handleInspectToggle = useCallback(() => {
    void runBusy(inspecting ? "inspect-off" : "inspect-on", async () => {
      const api = requireBrowserApi();
      if (inspecting) {
        await api.stopInspect();
      } else {
        await api.startInspect();
      }
      await refreshStatus();
    });
  }, [inspecting, refreshStatus, runBusy]);

  const handleClearSelection = useCallback(() => {
    void runBusy("clear-selection", async () => {
      const api = requireBrowserApi();
      await api.clearSelection();
      selectedItemRef.current = null;
      setSelectedItem(null);
      setStatus((current) => current ? { ...current, selectedItem: null } : current);
      setAttachmentAck(null);
    });
  }, [runBusy]);

  const handleAttachSelection = useCallback(() => {
    void runBusy("select", async () => {
      const api = requireBrowserApi();
      const result = await api.selectCurrent();
      const item =
        normalizeSelectionResult(result, statusRef.current)
        ?? selectedItemRef.current
        ?? statusRef.current?.selectedItem
        ?? null;
      if (!item) throw new Error("Select an element in Inspect mode first.");
      await attachBrowserContextItem(item, { force: true, label: "Browser context attached." });
    });
  }, [attachBrowserContextItem, runBusy]);

  const handleAttachScreenshot = useCallback(() => {
    void runBusy("screenshot", async () => {
      if (!onAddContext) throw new Error("Chat context is not available in this panel.");
      if (captureModeRef.current) {
        restoreLiveBrowserView();
        setMessage({ tone: "info", text: "Browser screenshot capture cancelled." });
        return;
      }
      const api = requireBrowserApi();
      await attachActiveRendererWebview();
      let screenshot: BuiltInBrowserScreenshot | null = null;
      try {
        const result = await api.captureScreenshot();
        screenshot = normalizeScreenshot(result, statusRef.current);
      } catch (error) {
        screenshot = await captureActiveRendererWebview();
        if (!screenshot) throw error;
      }
      if (!screenshot) throw new Error("Browser screenshot capture did not return an image.");
      if (!(screenshot.dataUrl ?? screenshot.screenshotDataUrl) || !screenshot.width || !screenshot.height) {
        throw new Error("Browser screenshot capture did not include crop-ready image data.");
      }
      setLastScreenshot(screenshot);
      captureModeRef.current = true;
      setCaptureBase(screenshot);
      setCaptureSelection(null);
      await hideNativeBrowserView();
      setMessage({ tone: "info", text: "Drag a browser region to attach the screenshot crop and nearby page context." });
    });
  }, [attachActiveRendererWebview, captureActiveRendererWebview, hideNativeBrowserView, onAddContext, restoreLiveBrowserView, runBusy]);

  const addBrowserCaptureContext = useCallback(async (frame: BrowserFrame) => {
    if (!captureBase) return;
    if (!onAddContext) throw new Error("Chat context is not available in this panel.");
    const crop = await cropBrowserScreenshot(captureBase, frame);
    if (!crop) throw new Error("Could not crop browser screenshot.");

    let attachmentPath: string | null = null;
    if (onAddAttachment) {
      const saved = await window.ade.agentChat.saveTempAttachment({
        data: stripDataUrlPrefix(crop.dataUrl),
        filename: "built-in-browser-capture.png",
      });
      attachmentPath = saved.path;
      onAddAttachment({ path: saved.path, type: inferAttachmentType(saved.path, "image/png") });
    }

    const centerX = frame.x + frame.width / 2;
    const centerY = frame.y + frame.height / 2;
    const viewportRect = browserSurfaceRef.current?.getBoundingClientRect() ?? null;
    const domPoint = viewportRect && captureBase.width && captureBase.height
      ? {
          x: centerX * (viewportRect.width / captureBase.width),
          y: centerY * (viewportRect.height / captureBase.height),
        }
      : { x: centerX, y: centerY };
    const api = getBrowserApi();
    let domItem: BuiltInBrowserContextItem | null = null;
    if (api?.selectPoint) {
      try {
        const pointResult = await api.selectPoint({ x: domPoint.x, y: domPoint.y, includeScreenshot: false });
        domItem = normalizeSelectionResult(pointResult, statusRef.current);
      } catch (error) {
        setMessage({ tone: "error", text: `Captured region, but DOM point context failed: ${errorMessage(error)}` });
      }
    }

    const metadata = domItem?.metadata ?? {};
    const contextItem: BuiltInBrowserContextItem = {
      ...(domItem ?? {}),
      kind: "built_in_browser_capture",
      id: `built-in-browser-capture:${Date.now().toString(36)}`,
      sessionId,
      url: domItem?.url ?? statusRef.current?.url ?? null,
      title: domItem?.title ?? statusRef.current?.title ?? null,
      selector: domItem?.selector ?? stringField(metadata.selector),
      text: domItem?.text ?? "Dragged browser screenshot region",
      role: domItem?.role ?? stringField(metadata.role),
      tagName: domItem?.tagName ?? stringField(metadata.tagName),
      frame: crop.frame,
      metadata: {
        ...metadata,
        browserContextPacketVersion: 1,
        contextSurface: "built_in_browser",
        source: domItem ? "browser-region-capture-with-dom-center" : "browser-region-capture",
        sourceConfidence: domItem ? "point-center" : "visual-only",
        captureFrame: crop.frame,
        crop: { width: crop.width, height: crop.height },
        viewport: {
          width: captureBase.width,
          height: captureBase.height,
        },
        capturedAt: captureBase.capturedAt,
        centerPoint: {
          x: Math.round(centerX),
          y: Math.round(centerY),
        },
        domPoint: {
          x: Math.round(domPoint.x),
          y: Math.round(domPoint.y),
        },
        ...(attachmentPath ? { attachmentPath } : {}),
        ...(domItem?.frame ? { domFrame: domItem.frame } : {}),
        selectedElement: domItem ? {
          componentId: stringField(domItem.componentId) ?? domItem.selector ?? stringField(metadata.selector) ?? "browser-element",
          label: domItem.text ?? stringField(metadata.label),
          value: stringField(metadata.value),
          role: domItem.role ?? stringField(metadata.role),
          tagName: domItem.tagName ?? stringField(metadata.tagName),
          selector: domItem.selector ?? stringField(metadata.selector),
          testId: stringField(metadata.testId),
          screenshotFrame: domItem.frame,
        } : {
          source: "browser-region-capture",
          label: "Dragged browser screenshot region",
          screenshotFrame: crop.frame,
        },
        selectionExplanation: domItem
          ? "The user dragged a browser screenshot region. ADE attached the crop as visual evidence and resolved DOM context from the element at the crop center."
          : "The user dragged a browser screenshot region. ADE could not resolve a DOM element at the crop center, so this packet is visual context only.",
      },
      screenshotDataUrl: crop.dataUrl,
      selectedAt: new Date().toISOString(),
    };

    await attachBrowserContextItem(contextItem, {
      force: true,
      label: domItem ? "Browser capture + DOM attached." : "Browser capture attached.",
    });
    restoreLiveBrowserView();
  }, [attachBrowserContextItem, captureBase, onAddAttachment, onAddContext, restoreLiveBrowserView, sessionId]);

  const handleBrowserCapturePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!captureImageDataUrl || !captureBase?.width || !captureBase.height) return;
    const image = captureImageRef.current;
    if (!image) return;
    const point = pointerToCapturePoint(event, image, captureBase.width, captureBase.height);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setCaptureSelection({
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
      bounds: point.bounds,
    });
  }, [captureBase?.height, captureBase?.width, captureImageDataUrl]);

  const handleBrowserCapturePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!captureImageDataUrl || !captureBase?.width || !captureBase.height || !captureSelection) return;
    const image = captureImageRef.current;
    if (!image) return;
    const point = pointerToCapturePoint(event, image, captureBase.width, captureBase.height, true);
    if (!point) return;
    setCaptureSelection((current) => current
      ? { ...current, currentX: point.x, currentY: point.y, bounds: point.bounds }
      : current);
  }, [captureBase?.height, captureBase?.width, captureImageDataUrl, captureSelection]);

  const finishBrowserCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!captureSelection || !activeCaptureFrame) return;
    event.preventDefault();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setCaptureSelection(null);
    if (activeCaptureFrame.width < 12 || activeCaptureFrame.height < 12) {
      setMessage({ tone: "info", text: "Drag a larger browser region to capture." });
      return;
    }
    void runBusy("screenshot", async () => {
      await addBrowserCaptureContext(activeCaptureFrame);
    });
  }, [activeCaptureFrame, addBrowserCaptureContext, captureSelection, runBusy]);

  const cancelBrowserCapture = useCallback((event?: PointerEvent<HTMLDivElement>) => {
    if (event?.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setCaptureSelection(null);
  }, []);

  const handleOpenExternal = useCallback(() => {
    const url = currentUrl.trim();
    if (!url) return;
    void window.ade.app.openExternal(url).catch((error: unknown) => {
      setMessage({ tone: "error", text: `Could not open URL externally: ${errorMessage(error)}` });
    });
  }, [currentUrl]);

  const handleInsertSelectionDraft = useCallback(() => {
    if (!onInsertDraft || !selectedItem) return;
    const lines = [
      "Use this browser selection:",
      selectedItem.title ? `Title: ${selectedItem.title}` : null,
      selectedItem.url ? `URL: ${selectedItem.url}` : null,
      selectedItem.selector ? `Selector: ${selectedItem.selector}` : null,
      selectedItem.text ? `Text: ${selectedItem.text}` : null,
    ].filter((line): line is string => Boolean(line));
    onInsertDraft(lines.join("\n"));
  }, [onInsertDraft, selectedItem]);

  const screenshotMeta = useMemo(() => {
    if (!lastScreenshot) return null;
    const size = lastScreenshot.width && lastScreenshot.height
      ? `${Math.round(lastScreenshot.width)}×${Math.round(lastScreenshot.height)}`
      : null;
    return [size, lastScreenshot.capturedAt ? new Date(lastScreenshot.capturedAt).toLocaleTimeString() : null]
      .filter(Boolean)
      .join(" · ");
  }, [lastScreenshot]);

  return (
    <div className="flex h-full min-h-0 flex-col font-sans text-[12px] text-fg/75">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-sky-300/10 bg-[#080b11] shadow-[0_18px_48px_rgba(0,0,0,0.32)]">
        <div className="flex min-h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-white/[0.07] bg-[#10131d] px-2 py-1">
          <span className="mr-1 inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-sky-300/18 bg-sky-500/10 px-2 text-[10px] font-semibold text-sky-50/80">
            <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT_TONE[statusInfo.tone], statusInfo.tone === "warn" || statusInfo.tone === "active" ? "animate-pulse" : null)} />
            ADE
          </span>
          {browserTabs.map((tab) => {
            const active = tab.id === activeTabId;
            const label = tab.title ?? tab.url ?? "New tab";
            return (
              <div
                key={tab.id}
                className={cn(
                  "group inline-flex h-7 max-w-[190px] shrink-0 items-center gap-1 rounded-t-md border border-b-0 px-2 text-[11px] transition-colors",
                  active
                    ? "border-sky-300/20 bg-[#080b11] text-sky-50/90"
                    : "border-transparent bg-white/[0.025] text-muted-fg/65 hover:bg-white/[0.06] hover:text-fg/80",
                )}
                title={tab.url ?? label}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (!active) handleSwitchTab(tab.id);
                  }}
                  className="inline-flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  aria-current={active ? "page" : undefined}
                >
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tab.isLoading ? "animate-pulse bg-amber-300" : active ? "bg-sky-300" : "bg-muted-fg/35")} />
                  <span className="min-w-0 truncate">{label}</span>
                </button>
                <button
                  type="button"
                  aria-label="Close tab"
                  className="ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-fg/45 opacity-70 transition-colors hover:bg-white/[0.09] hover:text-fg/80 group-hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleCloseTab(tab.id);
                  }}
                >
                  <X size={9} />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            disabled={Boolean(busy) || !apiAvailable}
            onClick={handleNewTab}
            className="inline-flex h-7 w-8 shrink-0 items-center justify-center rounded-md border border-white/[0.07] bg-white/[0.035] text-fg/72 transition-colors hover:bg-white/[0.07] hover:text-fg/85 disabled:cursor-not-allowed disabled:opacity-45"
            title="New tab"
            aria-label="New tab"
          >
            {busy === "new-tab" ? <SpinnerGap size={12} className="animate-spin" /> : <Plus size={12} />}
          </button>
          <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
            <span className={cn("inline-flex h-5 items-center rounded-full border px-2 text-[9px] font-medium uppercase", STATUS_PILL_TONE[statusInfo.tone])} title={statusInfo.detail}>
              {statusInfo.label}
            </span>
            {sessionLabel ? (
              <span className="rounded border border-white/[0.07] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-fg/55">
                {sessionLabel}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/[0.07] bg-[#0d1018] px-2 py-2">
          <div className="inline-flex h-8 shrink-0 items-center overflow-hidden rounded-md border border-white/[0.08] bg-black/25">
            <button
              type="button"
              disabled={Boolean(busy) || !apiAvailable || !canGoBack}
              onClick={handleBack}
              className="inline-flex h-full w-8 items-center justify-center text-fg/65 transition-colors hover:bg-white/[0.06] hover:text-fg/85 disabled:cursor-not-allowed disabled:opacity-35"
              title="Go back"
              aria-label="Go back"
            >
              {busy === "back" ? <SpinnerGap size={13} className="animate-spin" /> : <ArrowLeft size={13} />}
            </button>
            <button
              type="button"
              disabled={Boolean(busy) || !apiAvailable || !canGoForward}
              onClick={handleForward}
              className="inline-flex h-full w-8 items-center justify-center border-l border-white/[0.06] text-fg/65 transition-colors hover:bg-white/[0.06] hover:text-fg/85 disabled:cursor-not-allowed disabled:opacity-35"
              title="Go forward"
              aria-label="Go forward"
            >
              {busy === "forward" ? <SpinnerGap size={13} className="animate-spin" /> : <ArrowRight size={13} />}
            </button>
            <button
              type="button"
              disabled={Boolean(busy) || !apiAvailable}
              onClick={loading ? handleStop : handleReload}
              className="inline-flex h-full w-8 items-center justify-center border-l border-white/[0.06] text-fg/65 transition-colors hover:bg-white/[0.06] hover:text-fg/85 disabled:cursor-not-allowed disabled:opacity-35"
              title={loading ? "Stop loading" : "Reload"}
              aria-label={loading ? "Stop loading" : "Reload"}
            >
              {busy === "reload" || busy === "stop" ? (
                <SpinnerGap size={13} className="animate-spin" />
              ) : loading ? (
                <Stop size={13} weight="fill" />
              ) : (
                <ArrowClockwise size={13} />
              )}
            </button>
          </div>

          <form
            onSubmit={handleNavigate}
            className="flex h-8 min-w-[220px] flex-1 items-center gap-1 rounded-md border border-white/[0.08] bg-black/24 pl-2 focus-within:border-sky-300/30"
          >
            <input
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              onFocus={() => setEditingUrl(true)}
              onBlur={() => {
                setEditingUrl(false);
                if (!urlInput.trim()) setUrlInput(currentUrl);
              }}
              placeholder="Enter URL or search"
              aria-label="ADE browser URL"
              className="h-full min-w-0 flex-1 bg-transparent text-[11px] text-fg/82 outline-none placeholder:text-muted-fg/40"
            />
            <button
              type="submit"
              disabled={Boolean(busy) || !apiAvailable || !urlInput.trim()}
              className="inline-flex h-full shrink-0 items-center justify-center gap-1 rounded-r-md border-l border-white/[0.06] px-2 text-[11px] font-medium text-fg/75 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
              title="Open URL"
              aria-label="Open URL"
            >
              {busy === "navigate" ? <SpinnerGap size={12} className="animate-spin" /> : <Play size={12} weight="fill" />}
              Open
            </button>
          </form>

          <button
            type="button"
            disabled={Boolean(busy) || !apiAvailable}
            onClick={handleInspectToggle}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
              inspecting
                ? "border-sky-300/25 bg-sky-500/15 text-sky-50/90 hover:bg-sky-500/22"
                : "border-white/[0.08] bg-white/[0.035] text-fg/72 hover:bg-white/[0.07] hover:text-fg/85",
            )}
            title={inspecting ? "Stop selecting elements" : "Select an element in the ADE browser"}
          >
            {busy === "inspect-on" || busy === "inspect-off" ? <SpinnerGap size={12} className="animate-spin" /> : <CursorClick size={12} />}
            {inspecting ? "Inspecting" : "Inspect"}
          </button>
          <button
            type="button"
            disabled={Boolean(busy) || !apiAvailable || !onAddContext}
            onClick={handleAttachScreenshot}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
              captureBase
                ? "border-amber-300/25 bg-amber-500/12 text-amber-100/85 hover:bg-amber-500/18"
                : "border-white/[0.08] bg-white/[0.035] text-fg/72 hover:bg-white/[0.07] hover:text-fg/85",
            )}
            title={onAddContext ? "Drag a browser region into chat context" : "Chat context is unavailable here"}
          >
            {busy === "screenshot" ? <SpinnerGap size={12} className="animate-spin" /> : <ImageSquare size={12} />}
            {captureBase ? "Cancel screenshot" : "Screenshot"}
          </button>
          {selectedItem ? (
            <button
              type="button"
              disabled={Boolean(busy) || !apiAvailable || !onAddContext}
              onClick={handleAttachSelection}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.035] px-2.5 text-[11px] font-medium text-fg/72 transition-colors hover:bg-white/[0.07] hover:text-fg/85 disabled:cursor-not-allowed disabled:opacity-45"
              title="Attach the selected browser element as chat context"
            >
              {busy === "select" ? <SpinnerGap size={12} className="animate-spin" /> : <Selection size={12} />}
              Attach
            </button>
          ) : null}
          <button
            type="button"
            disabled={!currentUrl}
            onClick={handleOpenExternal}
            className="inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.035] px-2.5 text-[11px] font-medium text-fg/72 transition-colors hover:bg-white/[0.07] hover:text-fg/85 disabled:cursor-not-allowed disabled:opacity-40"
            title="Open current page in the system browser"
          >
            <ArrowSquareOut size={12} />
            External
          </button>
        </div>

        {message ? (
          <div
            className={cn(
              "flex shrink-0 items-start gap-2 border-b px-2.5 py-1.5 text-[11px]",
              message.tone === "error"
                ? "border-rose-400/18 bg-rose-500/10 text-rose-100/85"
                : "border-sky-400/14 bg-sky-500/8 text-sky-100/80",
            )}
            role={message.tone === "error" ? "alert" : "status"}
          >
            <WarningCircle size={12} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{message.text}</span>
            <button
              type="button"
              onClick={() => setMessage(null)}
              className="ml-auto shrink-0 rounded p-0.5 text-current opacity-50 transition-opacity hover:opacity-100"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        ) : null}

        <div
          ref={browserSurfaceRef}
          className="relative flex min-h-[320px] min-w-0 flex-1 flex-col overflow-hidden bg-[#05070b]"
        >
          {captureImageDataUrl && captureBase?.width && captureBase.height ? (
            <div
              className="absolute inset-0 cursor-crosshair select-none bg-black"
              onPointerDown={handleBrowserCapturePointerDown}
              onPointerMove={handleBrowserCapturePointerMove}
              onPointerUp={finishBrowserCapture}
              onPointerCancel={cancelBrowserCapture}
            >
              <img
                ref={captureImageRef}
                src={captureImageDataUrl}
                alt=""
                draggable={false}
                className="h-full w-full object-contain"
              />
              <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-sky-300/18 bg-black/65 px-2 py-1 text-[11px] font-medium text-sky-50/85">
                Drag to attach a browser crop with page context
              </div>
              {captureSelection && activeCaptureFrame ? (
                <div
                  className="pointer-events-none absolute border border-sky-200 bg-sky-400/14 shadow-[0_0_0_9999px_rgba(0,0,0,0.42)]"
                  style={{
                    left: captureSelection.bounds.left + (activeCaptureFrame.x * captureSelection.bounds.scaleX),
                    top: captureSelection.bounds.top + (activeCaptureFrame.y * captureSelection.bounds.scaleY),
                    width: Math.max(1, activeCaptureFrame.width * captureSelection.bounds.scaleX),
                    height: Math.max(1, activeCaptureFrame.height * captureSelection.bounds.scaleY),
                  }}
                />
              ) : null}
            </div>
          ) : !currentUrl ? (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center text-muted-fg/55">
              <ArrowSquareOut size={24} className="text-sky-100/25" />
              <div className="text-[12px] font-medium text-fg/70">
                {apiAvailable ? "Open a page in ADE browser" : "ADE browser unavailable"}
              </div>
              <div className="max-w-[360px] text-[11px] leading-5 text-muted-fg/55">
                {apiAvailable
                  ? "Links from chat and terminal output open here as tabs."
                  : "This renderer does not expose window.ade.builtInBrowser."}
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-white/[0.07] bg-[#0b0e15] px-2.5 py-2">
          <div className="min-w-0 flex-1">
            {selectedItem ? (
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[11px] font-medium text-fg/85" title={contextItemLabel(selectedItem)}>
                    {contextItemLabel(selectedItem)}
                  </span>
                  {contextItemSubLabel(selectedItem) ? (
                    <span className="shrink-0 rounded border border-white/[0.07] bg-white/[0.03] px-1 py-0 font-mono text-[9px] uppercase text-muted-fg/60">
                      {contextItemSubLabel(selectedItem)}
                    </span>
                  ) : null}
                  {attachmentAck ? (
                    <span className="shrink-0 rounded-full border border-emerald-300/25 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-100/85">
                      Attached
                    </span>
                  ) : null}
                </div>
                <div className="truncate text-[10px] text-muted-fg/50" title={selectedItem.selector ?? selectedItem.url ?? undefined}>
                  {selectedItem.selector ?? selectedItem.url ?? selectionFrame ?? "Browser context"}
                </div>
              </div>
            ) : (
              <div className="truncate text-[11px] text-muted-fg/55" title={statusInfo.detail}>
                {captureBase ? "Drag on the page image to capture a precise region." : statusInfo.detail}
              </div>
            )}
          </div>

          <div
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[10px] font-medium",
              attachmentAck
                ? "border-emerald-300/25 bg-emerald-500/10 text-emerald-100/85"
                : "border-white/[0.07] bg-white/[0.03] text-muted-fg/60",
            )}
          >
            <Paperclip size={11} />
            {attachmentAck ?? (screenshotMeta ? `Last screenshot ${screenshotMeta}` : "Context ready")}
          </div>
          {selectedItem ? (
            <button
              type="button"
              disabled={Boolean(busy) || !apiAvailable}
              onClick={handleClearSelection}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.03] px-2 text-[10px] font-medium text-muted-fg/65 transition-colors hover:bg-white/[0.06] hover:text-fg/85 disabled:cursor-not-allowed disabled:opacity-45"
              title="Clear browser context"
            >
              {busy === "clear-selection" ? <SpinnerGap size={11} className="animate-spin" /> : <X size={11} />}
              Clear
            </button>
          ) : null}
          {onInsertDraft ? (
            <button
              type="button"
              disabled={!selectedItem}
              onClick={handleInsertSelectionDraft}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.03] px-2 text-[10px] font-medium text-fg/72 transition-colors hover:bg-white/[0.06] hover:text-fg/85 disabled:cursor-not-allowed disabled:opacity-45"
              title="Insert selected browser details into the draft"
            >
              <Paperclip size={11} />
              Insert draft
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
