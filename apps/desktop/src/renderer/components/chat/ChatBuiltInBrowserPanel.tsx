import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  CursorClick,
  ImageSquare,
  Paperclip,
  Play,
  Selection,
  SpinnerGap,
  Stop,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type { AgentChatFileRef } from "../../../shared/types";
import { inferAttachmentType } from "../../../shared/types";
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

type BuiltInBrowserContextItem = {
  kind: "built_in_browser_element" | "built_in_browser_selection" | (string & {});
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
  navigate: (args: { url: string }) => Promise<void>;
  reload: () => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  stop: () => Promise<void>;
  startInspect: () => Promise<void>;
  stopInspect: () => Promise<void>;
  captureScreenshot: () => Promise<unknown>;
  selectCurrent: () => Promise<unknown>;
  clearSelection: () => Promise<void>;
  onEvent: (cb: (event: BuiltInBrowserEventPayload) => void) => () => void;
};

type ChatBuiltInBrowserPanelProps = {
  sessionId: string | null;
  onAddContext: (item: BuiltInBrowserContextItem) => void;
  onAddAttachment?: (attachment: AgentChatFileRef) => void;
  onInsertDraft?: (text: string) => void;
};

type MessageTone = "info" | "error";
type Message = { tone: MessageTone; text: string };

type StatusTone = "idle" | "active" | "warn" | "muted" | "error";
type StatusInfo = { label: string; detail: string; tone: StatusTone };

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

function normalizeUrlForNavigation(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (/^(about|blob|data|devtools|file|https?):/i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed)) return `http://${trimmed}`;
  if (/^[^\s/]+\.[^\s]+/.test(trimmed)) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
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

function normalizeStatus(value: unknown, previous: BuiltInBrowserStatus | null): BuiltInBrowserStatus {
  if (!isRecord(value)) {
    return {
      supported: previous?.supported ?? true,
      visible: previous?.visible ?? false,
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
  return {
    ...value,
    supported: booleanField(value.supported, previous?.supported ?? true),
    visible: booleanField(value.visible, previous?.visible ?? false),
    url: stringField(value.url) ?? previous?.url ?? null,
    title: stringField(value.title) ?? previous?.title ?? null,
    canGoBack: booleanField(value.canGoBack, previous?.canGoBack ?? false),
    canGoForward: booleanField(value.canGoForward, previous?.canGoForward ?? false),
    loading: booleanField(value.loading, booleanField(value.isLoading, previous?.loading ?? false)),
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

export function ChatBuiltInBrowserPanel({
  sessionId,
  onAddContext,
  onAddAttachment,
  onInsertDraft,
}: ChatBuiltInBrowserPanelProps) {
  const browserSurfaceRef = useRef<HTMLDivElement | null>(null);
  const latestBoundsRef = useRef<BrowserBounds | null>(null);
  const statusRef = useRef<BuiltInBrowserStatus | null>(null);
  const selectedItemRef = useRef<BuiltInBrowserContextItem | null>(null);
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

  const statusInfo = useMemo(() => buildStatusInfo(apiAvailable, status), [apiAvailable, status]);
  const currentUrl = status?.url ?? "";
  const canGoBack = Boolean(status?.canGoBack);
  const canGoForward = Boolean(status?.canGoForward);
  const loading = Boolean(status?.loading);
  const inspecting = Boolean(status?.inspecting);
  const selectionFrame = frameLabel(selectedItem?.frame ?? null);
  const sessionLabel = shortSessionId(sessionId);

  useEffect(() => {
    editingUrlRef.current = editingUrl;
  }, [editingUrl]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

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

  const reportBounds = useCallback((visibleOverride?: boolean) => {
    const api = getBrowserApi();
    const element = browserSurfaceRef.current;
    if (!api || !element) return;
    const rect = element.getBoundingClientRect();
    const next: BrowserBounds = {
      x: Math.max(0, Math.round(rect.left)),
      y: Math.max(0, Math.round(rect.top)),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
      visible: visibleOverride ?? (rect.width >= 16 && rect.height >= 16),
    };
    if (boundsEqual(latestBoundsRef.current, next)) return;
    latestBoundsRef.current = next;
    api.setBounds(next).catch((error: unknown) => {
      setMessage({ tone: "error", text: `Could not position browser: ${errorMessage(error)}` });
    });
  }, []);

  useLayoutEffect(() => {
    const element = browserSurfaceRef.current;
    if (!element) return undefined;
    let animationFrame: number | null = null;
    const scheduleReport = () => {
      if (animationFrame != null) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        reportBounds();
      });
    };
    scheduleReport();
    const observer = new ResizeObserver(scheduleReport);
    observer.observe(element);
    window.addEventListener("resize", scheduleReport);
    window.addEventListener("scroll", scheduleReport, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleReport);
      window.removeEventListener("scroll", scheduleReport, true);
      if (animationFrame != null) window.cancelAnimationFrame(animationFrame);
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
    const frame = window.requestAnimationFrame(() => reportBounds());
    return () => window.cancelAnimationFrame(frame);
  });

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
      } else if (eventType === "selection-cleared" || eventType === "clear-selection") {
        selectedItemRef.current = null;
        setSelectedItem(null);
        setStatus((current) => current ? { ...current, selectedItem: null } : current);
      }
      const nextScreenshot = normalizeScreenshot(event.screenshot, statusRef.current);
      if (nextScreenshot) setLastScreenshot(nextScreenshot);
      const nextError = stringField(event.error) ?? stringField(event.message);
      if (nextError && /error|failed/i.test(eventType || "error")) {
        setMessage({ tone: "error", text: nextError });
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyStatus]);

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

  const handleNavigate = useCallback(
    (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      const nextUrl = normalizeUrlForNavigation(urlInput);
      if (!nextUrl) return;
      void runBusy("navigate", async () => {
        const api = requireBrowserApi();
        await api.navigate({ url: nextUrl });
        setUrlInput(nextUrl);
        await refreshStatus();
      });
    },
    [refreshStatus, runBusy, urlInput],
  );

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
      const contextItem: BuiltInBrowserContextItem = {
        ...item,
        sessionId: item.sessionId ?? sessionId,
        metadata: {
          ...item.metadata,
          ...(sessionId ? { chatSessionId: sessionId } : {}),
        },
      };
      onAddContext(contextItem);
      selectedItemRef.current = contextItem;
      setSelectedItem(contextItem);
      setStatus((current) => current ? { ...current, selectedItem: contextItem } : current);
      setAttachmentAck("Selected element attached to chat.");
      setMessage({ tone: "info", text: "Attached the selected browser element to chat." });
    });
  }, [onAddContext, runBusy, sessionId]);

  const handleAttachScreenshot = useCallback(() => {
    void runBusy("screenshot", async () => {
      if (!onAddAttachment) throw new Error("Chat attachments are not available in this panel.");
      const api = requireBrowserApi();
      const result = await api.captureScreenshot();
      const screenshot = normalizeScreenshot(result, statusRef.current);
      if (!screenshot) throw new Error("Browser screenshot capture did not return an image.");
      let path = screenshot.path ?? screenshot.filePath ?? null;
      const mimeType = screenshot.mimeType ?? "image/png";
      if (!path) {
        const dataUrl = screenshot.dataUrl ?? screenshot.screenshotDataUrl ?? null;
        const data = dataUrl ? stripDataUrlPrefix(dataUrl) : screenshot.data ?? null;
        if (!data) throw new Error("Browser screenshot capture did not include attachment data.");
        const saved = await window.ade.agentChat.saveTempAttachment({
          data,
          filename: screenshot.filename ?? "built-in-browser-screenshot.png",
        });
        path = saved.path;
      }
      onAddAttachment({ path, type: inferAttachmentType(path, mimeType) });
      setLastScreenshot(screenshot);
      setMessage({ tone: "info", text: "Attached browser screenshot to chat." });
    });
  }, [onAddAttachment, runBusy]);

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
    <div className="flex h-full min-h-0 flex-col gap-2 font-sans text-[12px] text-fg/75">
      <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-white/[0.07] bg-white/[0.025] px-2.5 py-1.5">
        <span
          className={cn(
            "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[10px] font-medium uppercase",
            STATUS_PILL_TONE[statusInfo.tone],
          )}
          title={statusInfo.detail}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              STATUS_DOT_TONE[statusInfo.tone],
              statusInfo.tone === "warn" || statusInfo.tone === "active" ? "animate-pulse" : null,
            )}
          />
          {statusInfo.label}
        </span>
        <div className="min-w-0 flex-1 truncate text-[11px] text-fg/72" title={statusInfo.detail}>
          {status?.title ?? status?.url ?? statusInfo.detail}
        </div>
        {sessionLabel ? (
          <span className="shrink-0 rounded border border-white/[0.07] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-fg/55">
            {sessionLabel}
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="inline-flex h-8 shrink-0 items-center overflow-hidden rounded-md border border-white/[0.07] bg-white/[0.03]">
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
          className="flex min-w-[220px] flex-1 items-center gap-1 rounded-md border border-white/[0.07] bg-black/20 pl-2 focus-within:border-sky-300/30"
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
            aria-label="Built-in browser URL"
            className="h-8 min-w-0 flex-1 bg-transparent text-[11px] text-fg/80 outline-none placeholder:text-muted-fg/40"
          />
          <button
            type="submit"
            disabled={Boolean(busy) || !apiAvailable || !urlInput.trim()}
            className="inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-r-md border-l border-white/[0.06] px-2 text-[11px] font-medium text-fg/75 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
            title="Open URL"
            aria-label="Open URL"
          >
            {busy === "navigate" ? <SpinnerGap size={12} className="animate-spin" /> : <Play size={12} weight="fill" />}
            Open
          </button>
        </form>

        <button
          type="button"
          disabled={!currentUrl}
          onClick={handleOpenExternal}
          className="inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-md border border-white/[0.07] bg-white/[0.03] px-2.5 text-[11px] font-medium text-fg/72 transition-colors hover:bg-white/[0.06] hover:text-fg/85 disabled:cursor-not-allowed disabled:opacity-40"
          title="Open current page in the system browser"
        >
          <ArrowSquareOut size={12} />
          External
        </button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={Boolean(busy) || !apiAvailable}
          onClick={handleInspectToggle}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
            inspecting
              ? "border-sky-300/25 bg-sky-500/15 text-sky-50/90 hover:bg-sky-500/22"
              : "border-white/[0.07] bg-white/[0.03] text-fg/72 hover:bg-white/[0.06] hover:text-fg/85",
          )}
          title={inspecting ? "Stop selecting elements" : "Select an element in the built-in browser"}
        >
          {busy === "inspect-on" || busy === "inspect-off" ? (
            <SpinnerGap size={12} className="animate-spin" />
          ) : (
            <CursorClick size={12} />
          )}
          {inspecting ? "Inspecting" : "Inspect"}
        </button>
        <button
          type="button"
          disabled={Boolean(busy) || !apiAvailable || !selectedItem}
          onClick={handleAttachSelection}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.03] px-2.5 text-[11px] font-medium text-fg/72 transition-colors hover:bg-white/[0.06] hover:text-fg/85 disabled:cursor-not-allowed disabled:opacity-45"
          title="Attach the selected browser element as chat context"
        >
          {busy === "select" ? <SpinnerGap size={12} className="animate-spin" /> : <Selection size={12} />}
          Attach selection
        </button>
        <button
          type="button"
          disabled={Boolean(busy) || !apiAvailable || !onAddAttachment}
          onClick={handleAttachScreenshot}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.03] px-2.5 text-[11px] font-medium text-fg/72 transition-colors hover:bg-white/[0.06] hover:text-fg/85 disabled:cursor-not-allowed disabled:opacity-45"
          title={onAddAttachment ? "Capture and attach a browser screenshot" : "Chat attachments are unavailable here"}
        >
          {busy === "screenshot" ? <SpinnerGap size={12} className="animate-spin" /> : <ImageSquare size={12} />}
          Screenshot
        </button>
        {selectedItem ? (
          <button
            type="button"
            disabled={Boolean(busy) || !apiAvailable}
            onClick={handleClearSelection}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.03] px-2.5 text-[11px] font-medium text-muted-fg/65 transition-colors hover:bg-white/[0.06] hover:text-fg/85 disabled:cursor-not-allowed disabled:opacity-45"
            title="Clear the selected browser element"
          >
            {busy === "clear-selection" ? <SpinnerGap size={12} className="animate-spin" /> : <X size={12} />}
            Clear
          </button>
        ) : null}
      </div>

      {message ? (
        <div
          className={cn(
            "flex shrink-0 items-start gap-2 rounded-md border px-2.5 py-1.5 text-[11px]",
            message.tone === "error"
              ? "border-rose-400/22 bg-rose-500/10 text-rose-100/85"
              : "border-sky-400/18 bg-sky-500/8 text-sky-100/80",
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
        className="relative flex min-h-[300px] min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-white/[0.08] bg-black/35"
      >
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center text-muted-fg/55">
          <ArrowSquareOut size={28} className="text-muted-fg/28" />
          <div className="text-[12px] font-medium text-fg/70">
            {apiAvailable ? "Built-in browser surface" : "Built-in browser unavailable"}
          </div>
          <div className="max-w-[380px] text-[11px] leading-5 text-muted-fg/55">
            {apiAvailable
              ? "ADE positions the native browser view inside this area."
              : "This renderer does not expose window.ade.builtInBrowser."}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-1.5">
        <div className="min-w-0 rounded-md border border-white/[0.07] bg-white/[0.025] px-2.5 py-1.5">
          {selectedItem ? (
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[11px] font-medium text-fg/85" title={contextItemLabel(selectedItem)}>
                  {contextItemLabel(selectedItem)}
                </span>
                {contextItemSubLabel(selectedItem) ? (
                  <span className="shrink-0 rounded border border-white/[0.07] bg-white/[0.03] px-1 py-0 font-mono text-[9px] uppercase text-muted-fg/60">
                    {contextItemSubLabel(selectedItem)}
                  </span>
                ) : null}
                {attachmentAck ? (
                  <span className="ml-auto shrink-0 rounded-full border border-emerald-300/25 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-100/85">
                    Attached
                  </span>
                ) : (
                  <span className="ml-auto shrink-0 text-[10px] text-sky-200/70">selected</span>
                )}
              </div>
              {selectedItem.selector ? (
                <div className="truncate font-mono text-[10px] text-muted-fg/55" title={selectedItem.selector}>
                  {selectedItem.selector}
                </div>
              ) : null}
              {selectedItem.url ? (
                <div className="truncate text-[10px] text-muted-fg/55" title={selectedItem.url}>
                  {selectedItem.title ? `${selectedItem.title} · ` : ""}{selectedItem.url}
                </div>
              ) : null}
              {selectionFrame ? (
                <div className="text-[10px] text-muted-fg/45">
                  {selectionFrame}
                  {selectedItem.role ? <span className="ml-2">role={selectedItem.role}</span> : null}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="text-[11px] text-muted-fg/55">
              {inspecting
                ? "Click an element in the browser, then attach it as chat context."
                : "Turn on Inspect to select browser elements for chat context."}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[10px] font-medium",
              attachmentAck
                ? "border-emerald-300/25 bg-emerald-500/10 text-emerald-100/85"
                : "border-white/[0.07] bg-white/[0.03] text-muted-fg/60",
            )}
          >
            <Paperclip size={11} />
            {attachmentAck ?? (screenshotMeta ? `Last screenshot ${screenshotMeta}` : "No browser context attached yet")}
          </div>
          {onInsertDraft ? (
            <button
              type="button"
              disabled={!selectedItem}
              onClick={handleInsertSelectionDraft}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-white/[0.07] bg-white/[0.03] px-2.5 text-[11px] font-medium text-fg/72 transition-colors hover:bg-white/[0.06] hover:text-fg/85 disabled:cursor-not-allowed disabled:opacity-45"
              title="Insert selected browser details into the draft"
            >
              <Paperclip size={12} />
              Insert draft
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
