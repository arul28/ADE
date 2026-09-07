import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  Bug,
  Camera,
  CaretDown,
  CaretLeft,
  CaretRight,
  CursorClick,
  DeviceMobile,
  DotsThreeVertical,
  Globe,
  ImageSquare,
  LockSimple,
  LockSimpleOpen,
  MagnifyingGlass,
  Hand,
  Monitor,
  Paperclip,
  Play,
  Plus,
  Pulse,
  Robot,
  Selection,
  ShieldCheck,
  SignIn,
  SpinnerGap,
  Stop,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { machineNameForBinding } from "../../../shared/machineIdentity";
import type { AgentChatFileRef, BrowserLinkOpenMode, OpenProjectBinding } from "../../../shared/types";
import { inferAttachmentType } from "../../../shared/types";
import type {
  BuiltInBrowserDevToolsResult,
  BuiltInBrowserEmulationPreset,
  BuiltInBrowserEmulationResult,
  BuiltInBrowserExportHarResult,
  BuiltInBrowserFindInPageResult,
  BuiltInBrowserNetworkLoggingResult,
  BuiltInBrowserPermissionDecision,
  BuiltInBrowserProfileDiagnostics,
  BuiltInBrowserProjectScopeArgs,
  BuiltInBrowserRecordingStatus,
  BuiltInBrowserStartRecordingResult,
  BuiltInBrowserStopRecordingResult,
  BuiltInBrowserTab,
  BuiltInBrowserTabHandoff,
  BuiltInBrowserTabTargetArgs,
  BuiltInBrowserZoomResult,
} from "../../../shared/types/builtInBrowser";
import { BrowserLoginImportDialog } from "./BrowserLoginImportDialog";
import {
  BUILT_IN_BROWSER_RECORDING_FRAME_RATES,
  browserTabLabel,
  deviceMenuPresets,
  emulationButtonLabel,
  emulationSizeLabel,
  findMatchLabel,
  normalizeRecordingFps,
  recordingPillLabel,
  simulatorEmulationPreset,
  stepZoomFactor,
  urlLockKind,
  zoomPercentLabel,
  type BrowserFindState,
  type BuiltInBrowserRecordingFrameRate,
} from "./builtInBrowserToolbar";
import { getLinkOpenMode, refreshLinkOpenMode, setLinkOpenMode } from "../../lib/openExternal";
import { showToast } from "../app/toast/toastStore";
import { consumePendingBuiltInBrowserNavigation } from "../../lib/openExternal";
import { formatBytes } from "../../lib/format";
import { useChatRuntimeScope, useChatRuntimeScopeForPin } from "./ChatRuntimeScope";
import {
  parseLoopbackUrl,
  remoteTunnelApprovalKey,
  type RemoteLoopbackTunnel,
} from "../../../shared/remoteLoopbackUrl";
import type { BuiltInBrowserRemoteRequest } from "../../../shared/types/builtInBrowserRemote";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { useAppStore, type WorkProjectViewState } from "../../state/appStore";
import {
  reconcileTabTunnels,
  setTabTunnel,
  tunnelAwareUrl,
  type TabTunnelMap,
} from "./browserRemoteTunnels";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
  ADE_WORK_SIDEBAR_BROWSER_RESIZE_END_EVENT,
  ADE_WORK_SIDEBAR_BROWSER_RESIZE_START_EVENT,
} from "../../lib/workSidebarBrowserResize";
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
  partition?: string | null;
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
  getStatus: (args?: BuiltInBrowserProjectScopeArgs, pin?: OpenProjectBinding | null) => Promise<unknown>;
  getProfileDiagnostics?: () => Promise<BuiltInBrowserProfileDiagnostics>;
  listPermissions?: () => Promise<{ permissions: BuiltInBrowserPermissionDecision[] }>;
  clearPermissions?: (args?: {
    origin?: string | null;
    permission?: string | null;
  }) => Promise<{ removed: number; permissions: BuiltInBrowserPermissionDecision[] }>;
  setBounds: (bounds: BrowserBounds & BuiltInBrowserProjectScopeArgs, pin?: OpenProjectBinding | null) => Promise<void>;
  attachWebview?: (args: { tabId: string; webContentsId: number } & BuiltInBrowserProjectScopeArgs) => Promise<unknown>;
  navigate: (args: { url: string; tabId?: string | null; newTab?: boolean } & BuiltInBrowserProjectScopeArgs, pin?: OpenProjectBinding | null) => Promise<unknown>;
  createTab?: (args?: { url?: string | null; activate?: boolean } & BuiltInBrowserProjectScopeArgs, pin?: OpenProjectBinding | null) => Promise<unknown>;
  switchTab?: (args: { tabId: string } & BuiltInBrowserProjectScopeArgs, pin?: OpenProjectBinding | null) => Promise<unknown>;
  closeTab?: (args: { tabId: string } & BuiltInBrowserProjectScopeArgs, pin?: OpenProjectBinding | null) => Promise<unknown>;
  reload: (args?: BuiltInBrowserTabTargetArgs, pin?: OpenProjectBinding | null) => Promise<unknown>;
  goBack: (args?: BuiltInBrowserTabTargetArgs, pin?: OpenProjectBinding | null) => Promise<unknown>;
  goForward: (args?: BuiltInBrowserTabTargetArgs, pin?: OpenProjectBinding | null) => Promise<unknown>;
  stop: (args?: BuiltInBrowserTabTargetArgs, pin?: OpenProjectBinding | null) => Promise<unknown>;
  startInspect: (args?: BuiltInBrowserProjectScopeArgs, pin?: OpenProjectBinding | null) => Promise<void>;
  stopInspect: (args?: BuiltInBrowserProjectScopeArgs, pin?: OpenProjectBinding | null) => Promise<void>;
  captureScreenshot: (args?: BuiltInBrowserTabTargetArgs, pin?: OpenProjectBinding | null) => Promise<unknown>;
  selectPoint?: (args: { x: number; y: number; includeScreenshot?: boolean; tabId?: string | null } & BuiltInBrowserProjectScopeArgs, pin?: OpenProjectBinding | null) => Promise<unknown>;
  selectCurrent: (args?: BuiltInBrowserProjectScopeArgs, pin?: OpenProjectBinding | null) => Promise<unknown>;
  clearSelection: (args?: BuiltInBrowserProjectScopeArgs, pin?: OpenProjectBinding | null) => Promise<void>;
  /**
   * Human-only hand-back. Deliberately absent from the agent bridge: an agent
   * gets its tab back when the person presses Hand back, the auto-offer is
   * accepted, the tab closes, or the handoff times out — never on its own say-so.
   */
  endHandoff?: (
    args?: BuiltInBrowserTabTargetArgs & { endedBy?: "human" | "auto-offer" },
    pin?: OpenProjectBinding | null,
  ) => Promise<unknown>;
  setEmulation?: (
    args?: BuiltInBrowserTabTargetArgs & {
      preset?: string | null;
      width?: number | null;
      height?: number | null;
    },
    pin?: OpenProjectBinding | null,
  ) => Promise<BuiltInBrowserEmulationResult>;
  setZoom?: (
    args?: BuiltInBrowserTabTargetArgs & { factor?: number | null; reset?: boolean },
    pin?: OpenProjectBinding | null,
  ) => Promise<BuiltInBrowserZoomResult>;
  findInPage?: (
    args: BuiltInBrowserTabTargetArgs & { text: string; forward?: boolean; findNext?: boolean },
    pin?: OpenProjectBinding | null,
  ) => Promise<BuiltInBrowserFindInPageResult>;
  stopFindInPage?: (
    args?: BuiltInBrowserTabTargetArgs & { action?: "clearSelection" | "keepSelection" },
    pin?: OpenProjectBinding | null,
  ) => Promise<unknown>;
  setDevTools?: (
    args: BuiltInBrowserTabTargetArgs & { open: boolean },
    pin?: OpenProjectBinding | null,
  ) => Promise<BuiltInBrowserDevToolsResult>;
  setNetworkLogging?: (
    args: BuiltInBrowserTabTargetArgs & { enabled: boolean; clear?: boolean },
    pin?: OpenProjectBinding | null,
  ) => Promise<BuiltInBrowserNetworkLoggingResult>;
  exportHar?: (
    args?: BuiltInBrowserTabTargetArgs & { failedOnly?: boolean },
    pin?: OpenProjectBinding | null,
  ) => Promise<BuiltInBrowserExportHarResult>;
  startRecording?: (
    args?: BuiltInBrowserTabTargetArgs & { fps?: number | null; caption?: string | null },
    pin?: OpenProjectBinding | null,
  ) => Promise<BuiltInBrowserStartRecordingResult>;
  stopRecording?: (
    args?: BuiltInBrowserTabTargetArgs,
    pin?: OpenProjectBinding | null,
  ) => Promise<BuiltInBrowserStopRecordingResult>;
  onEvent: (
    cb: (event: BuiltInBrowserEventPayload) => void,
    pin?: OpenProjectBinding | null,
  ) => () => void;
  /** Remote-pin only: resolve a loopback URL onto a forward without navigating. */
  localizeRemoteUrl?: (
    args: { url: string },
    pin?: OpenProjectBinding | null,
  ) => Promise<{ url: string; forward: RemoteLoopbackTunnel | null }>;
  acknowledgeRemoteRequest?: (
    args: { requestId: string; desktopLabel: string; accepted: boolean; reason?: string | null },
    pin?: OpenProjectBinding | null,
  ) => Promise<{ ok: boolean }>;
  onRemoteRequest?: (
    cb: (event: BuiltInBrowserRemoteRequest) => void,
    pin?: OpenProjectBinding | null,
  ) => () => void;
};

/**
 * A tunnel the agent asked for that a human has not approved yet.
 *
 * The machine-wide `portForward` grant is consent to reach that machine's
 * loopback, not consent to whatever port an agent names — a lane approved for a
 * dev server on 3000 has not approved an admin console on 8080. Human-typed
 * URLs skip this (the human just typed it) but still open the forward.
 */
type PendingTunnelApproval = {
  key: string;
  remotePort: number;
  machineLabel: string;
  decide: (decision: "once" | "always" | "deny") => void;
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
  /** Override project tab routing. `null` selects the personal-chat tab collection. */
  projectRootOverride?: string | null;
  onAddContext?: (item: BuiltInBrowserContextItem) => void;
  onAddAttachment?: (attachment: AgentChatFileRef) => void;
  onInsertDraft?: (text: string) => void;
  runtimePin?: OpenProjectBinding | null;
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
const OVERLAY_ROLES = new Set(["alertdialog", "dialog", "listbox", "menu", "tooltip"]);
const OVERLAY_MOTION_EVENTS = ["animationend", "animationiteration", "animationstart", "transitioncancel", "transitionend", "transitionrun", "transitionstart"] as const;
const OVERLAY_CANDIDATE_SELECTOR = [
  '[role="alertdialog"]',
  '[role="dialog"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="tooltip"]',
  '[aria-modal="true"]',
  "[data-radix-popper-content-wrapper]",
  "[data-radix-dialog-content]",
  "[data-radix-menu-content]",
  "[data-radix-popover-content]",
  "[data-radix-select-content]",
  "[data-side][data-align]",
  ".fixed",
  ".absolute",
  ".sticky",
  '[style*="position"]',
].join(",");
// Renderer-owned <webview> nodes lose their backing webContents when the panel unmounts.
// Keep tabs owned by the main browser service so tab state survives Work sidebar tab switches.
const USE_RENDERER_BROWSER_WEBVIEWS = false;

const STATUS_PILL_TONE: Record<StatusTone, string> = {
  idle: "border-white/[0.08] bg-white/[0.03] text-muted-fg/65",
  active: "border-emerald-400/25 bg-emerald-500/10 text-emerald-100/85",
  warn: "border-amber-400/25 bg-amber-500/10 text-amber-100/85",
  muted: "border-white/[0.08] bg-white/[0.03] text-muted-fg/55",
  error: "border-rose-400/30 bg-rose-500/10 text-rose-200/85",
};

/** House reveal for bars that slide in under the toolbar. */
const REVEAL_TRANSITION = { duration: 0.18, ease: [0.4, 0, 0.2, 1] as const };
/** The `layoutId` spring the tools rail uses for its sliding indicator. */
const TAB_INDICATOR_SPRING = { type: "spring", stiffness: 520, damping: 38, mass: 0.7 } as const;
const TAB_INDICATOR_LAYOUT_ID = "ade-browser-tab-indicator";
/** Ports worth a one-shot probe for the empty state's "your dev server" chip. */
const DEV_SERVER_PROBE_PORTS = [3000, 5173, 4321, 8080, 8000] as const;

/** Shared control geometry, so the URL field and the menu buttons read as one row. */
const TOOLBAR_CONTROL = "h-7 rounded-[7px] border text-[11px]";
const TOOLBAR_IDLE = "border-white/[0.08] bg-white/[0.035] text-fg/72 hover:bg-white/[0.07] hover:text-fg/90";
const TOOLBAR_ON = "border-[color-mix(in_srgb,var(--color-accent)_32%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_15%,transparent)] text-fg/92";
const TOOLBAR_FOCUS = "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]";
const TOOLBAR_MOTION = "transition-colors duration-[120ms] ease-out disabled:cursor-not-allowed disabled:opacity-40";

const MENU_CONTENT_CLASS = cn(
  "z-[140] min-w-[228px] overflow-hidden rounded-[var(--radius-lg)] border border-white/[0.08]",
  "bg-[var(--color-popup-bg,var(--color-card))] p-1 font-sans text-[11.5px] text-fg/82",
  "shadow-[var(--shadow-popup,0_24px_64px_-24px_rgba(0,0,0,0.8))]",
);
const MENU_ITEM_CLASS = cn(
  "flex cursor-pointer select-none items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 outline-none",
  "transition-colors duration-[120ms] ease-out data-[highlighted]:bg-white/[0.07] data-[highlighted]:text-fg",
  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
);
const MENU_LABEL_CLASS = "px-2 pb-1 pt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-muted-fg/60";
const MENU_SEPARATOR_CLASS = "my-1 h-px bg-white/[0.06]";

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

function shouldUseRendererBrowserWebviews(
  api: BuiltInBrowserApi | null,
): api is BuiltInBrowserApi & Required<Pick<BuiltInBrowserApi, "attachWebview">> {
  return USE_RENDERER_BROWSER_WEBVIEWS && typeof api?.attachWebview === "function";
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
    ownerLaneId: stringField(value.ownerLaneId),
    ownerChatSessionId: stringField(value.ownerChatSessionId),
    ownerClaimedAt: stringField(value.ownerClaimedAt),
    ownerLeaseExpiresAt: stringField(value.ownerLeaseExpiresAt),
    zoomFactor: numberField(value.zoomFactor) || 1,
    devToolsOpen: booleanField(value.devToolsOpen, false),
    emulation: (isRecord(value.emulation) ? value.emulation : null) as BuiltInBrowserTab["emulation"],
    networkLogging: booleanField(value.networkLogging, false),
    recording: (isRecord(value.recording) ? value.recording : null) as BuiltInBrowserTab["recording"],
    handoff: normalizeTabHandoff(value.handoff),
  };
}

/**
 * A tab's login handoff, or null.
 *
 * Parsed defensively rather than cast: this panel also runs against an older
 * main process during a dev reload, where `handoff` is simply absent.
 */
function normalizeTabHandoff(value: unknown): BuiltInBrowserTabHandoff | null {
  if (!isRecord(value)) return null;
  const reason = stringField(value.reason);
  const startedAt = stringField(value.startedAt);
  if (!reason || !startedAt) return null;
  const previousOwner = isRecord(value.previousOwner) ? value.previousOwner : {};
  return {
    reason,
    startedAt,
    expiresAt: stringField(value.expiresAt) ?? startedAt,
    requestedByChatSessionId: stringField(value.requestedByChatSessionId),
    requestedByLaneId: stringField(value.requestedByLaneId),
    startedAtOrigin: stringField(value.startedAtOrigin),
    previousOwner: {
      laneId: stringField(previousOwner.laneId),
      chatSessionId: stringField(previousOwner.chatSessionId),
    },
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

function eventProjectRoot(value: unknown): string | null | undefined {
  if (!isRecord(value)) return undefined;
  if ("collectionProjectRoot" in value) {
    const root = value.collectionProjectRoot;
    return typeof root === "string" && root.trim().length > 0 ? root : null;
  }
  if (isRecord(value.status)) return eventProjectRoot(value.status);
  return undefined;
}

function browserEventMatchesProject(
  event: BuiltInBrowserEventPayload,
  projectRoot: string | null,
): boolean {
  const root = eventProjectRoot(event);
  if (root === undefined) return true;
  if (!projectRoot) return root === null;
  return root === projectRoot;
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

/** Origin of a page URL, or null for `about:blank` and non-http schemes. */
function browserUrlOrigin(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text === "about:blank") return null;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function shortSessionId(sessionId: string | null): string | null {
  if (!sessionId) return null;
  return sessionId.length <= 8 ? sessionId : `${sessionId.slice(0, 4)}…${sessionId.slice(-3)}`;
}

function shortOwnerId(value: string | null): string | null {
  if (!value) return null;
  return value.length <= 10 ? value : `${value.slice(0, 5)}…${value.slice(-4)}`;
}

function browserTabOwnerLabel(tab: BuiltInBrowserTab): string | null {
  // During a login handoff the tab is the human's, so the strip must not keep
  // advertising an agent owner it has just been taken away from.
  if (tab.handoff) return "you own this tab";
  const lane = shortOwnerId(tab.ownerLaneId);
  const chat = shortSessionId(tab.ownerChatSessionId);
  if (lane && chat) return `${lane} · ${chat}`;
  return lane ?? chat;
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

function rectsOverlap(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

type BrowserOverlayRect = Pick<DOMRect, "bottom" | "height" | "left" | "right" | "top" | "width">;

function rectIntersection(a: BrowserOverlayRect, b: BrowserOverlayRect): BrowserOverlayRect | null {
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.right, b.right);
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { bottom, height, left, right, top, width };
}

function isBrowserOverlayCandidate(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  if (
    style.display === "none"
    || style.visibility === "hidden"
    || style.opacity === "0"
    || style.pointerEvents === "none"
    || element.hidden
    || element.getAttribute("aria-hidden") === "true"
  ) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;
  const role = element.getAttribute("role");
  if (role && OVERLAY_ROLES.has(role)) return true;
  if (element.getAttribute("aria-modal") === "true") return true;
  if (
    element.matches(
      "[data-radix-popper-content-wrapper], [data-radix-dialog-content], [data-radix-menu-content], [data-radix-popover-content], [data-radix-select-content], [data-side][data-align]",
    )
  ) {
    return true;
  }
  return style.position === "fixed" || style.position === "absolute" || style.position === "sticky";
}

function overlayCandidateOwnsPoint(element: HTMLElement, x: number, y: number): boolean {
  if (typeof document.elementFromPoint !== "function") return true;
  const topElement = document.elementFromPoint(x, y);
  return topElement === element || (topElement != null && element.contains(topElement));
}

function overlayCandidatePaintsOverSurface(element: HTMLElement, surfaceRect: DOMRect): boolean {
  const overlap = rectIntersection(surfaceRect, element.getBoundingClientRect());
  if (!overlap) return false;
  const points = [
    [overlap.left + overlap.width / 2, overlap.top + overlap.height / 2],
    [overlap.left + 1, overlap.top + 1],
    [overlap.right - 1, overlap.top + 1],
    [overlap.left + 1, overlap.bottom - 1],
    [overlap.right - 1, overlap.bottom - 1],
  ];
  return points.some(([x, y]) => overlayCandidateOwnsPoint(element, x, y));
}

function collectBrowserOverlayCandidates(surface: HTMLElement): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>(OVERLAY_CANDIDATE_SELECTOR)).filter((element) => {
    if (element === surface || surface.contains(element) || element.contains(surface)) return false;
    return isBrowserOverlayCandidate(element);
  });
}

function browserSurfaceHasExternalOverlay(surface: HTMLElement): boolean {
  if (!surface.isConnected || !document.body) return false;
  const surfaceRect = surface.getBoundingClientRect();
  if (surfaceRect.width < 4 || surfaceRect.height < 4) return false;
  for (const element of collectBrowserOverlayCandidates(surface)) {
    const elementRect = element.getBoundingClientRect();
    if (rectsOverlap(surfaceRect, elementRect) && overlayCandidatePaintsOverSurface(element, surfaceRect)) return true;
  }
  return false;
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

/**
 * The browser window belongs to ONE computer: it is a view owned by that
 * desktop's main process, positioned over this panel's on-screen bounds. So the
 * pane always drives THIS window's browser, whatever machine the chat is on — a
 * pin naming another machine used to refuse the pane outright, which meant a
 * remote lane had no browser at all.
 *
 * What a remote pin changes is what `localhost` means. The dev server the agent
 * wants is on the pinned machine, and this desktop's loopback is a different box
 * — often nothing, sometimes a *different* project's server, which is the
 * dangerous case. So every loopback URL is rewritten onto a per-(machine, port)
 * TCP forward before it loads, the URL bar keeps showing the remote origin that
 * was asked for, and the first use of a new port needs a human grant even on a
 * machine already trusted for port-forwarding, because the agent picks the port.
 */
export function ChatBuiltInBrowserPanel(props: ChatBuiltInBrowserPanelProps) {
  return <BuiltInBrowserPanelView {...props} />;
}

function BuiltInBrowserPanelView({
  sessionId,
  projectRootOverride,
  onAddContext,
  onAddAttachment,
  onInsertDraft,
  runtimePin = null,
}: ChatBuiltInBrowserPanelProps) {
  // Also rendered from the Work sidebar and the personal-chats page, so the
  // scope is derived from the pin this panel is handed.
  const chatScope = useChatRuntimeScopeForPin(runtimePin, null);
  // The chat's lane, when this pane sits inside a chat pane. "Always for this
  // lane" tunnel grants are stored against it; outside a chat provider there is
  // no lane and the grant falls back to the project scope.
  const contextLaneId = useChatRuntimeScope().laneId;
  const projectRoot = projectRootOverride === undefined
    ? chatScope.rootPath
    : projectRootOverride;
  // Every pin-aware `builtInBrowser.*` call below reads this. `attachWebview`
  // is deliberately absent from that set: it wires a <webview> in THIS window.
  const runtimePinRef = useRef<OpenProjectBinding | null>(runtimePin);
  runtimePinRef.current = runtimePin;
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
  const browserInputSuppressedRef = useRef(false);
  const browserOverlayOccludedRef = useRef(false);
  const browserViewSuppressionCountRef = useRef(0);
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
  const [browserInputSuppressed, setBrowserInputSuppressed] = useState(false);
  const [webviewNavigationNonce, setWebviewNavigationNonce] = useState(0);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileDiagnostics, setProfileDiagnostics] = useState<BuiltInBrowserProfileDiagnostics | null>(null);
  const [permissionDecisions, setPermissionDecisions] = useState<BuiltInBrowserPermissionDecision[]>([]);
  const reduceMotion = useReducedMotion() ?? false;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [findState, setFindState] = useState<BrowserFindState | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const [responsiveWidth, setResponsiveWidth] = useState("1024");
  const [responsiveHeight, setResponsiveHeight] = useState("768");
  const [linkMode, setLinkModeState] = useState<BrowserLinkOpenMode>(() => getLinkOpenMode());
  const [recordingFps, setRecordingFps] = useState<BuiltInBrowserRecordingFrameRate>(30);
  // Re-rendered once a second while recording so the REC pill's clock ticks.
  const [recordingClock, setRecordingClock] = useState(() => Date.now());
  const [importOpen, setImportOpen] = useState(false);
  const [bootedSimulatorName, setBootedSimulatorName] = useState<string | null>(null);
  const [detectedDevServer, setDetectedDevServer] = useState<string | null>(null);
  const [tabStripFades, setTabStripFades] = useState<{ start: boolean; end: boolean }>({ start: false, end: false });
  // Which tabs are looking at the pinned machine, and through which forward.
  const [tabTunnels, setTabTunnels] = useState<TabTunnelMap>({});
  const tabTunnelsRef = useRef<TabTunnelMap>(tabTunnels);
  tabTunnelsRef.current = tabTunnels;
  const [pendingApproval, setPendingApproval] = useState<PendingTunnelApproval | null>(null);
  // Approvals answered "Allow once" live only as long as this pane does; the
  // "Always" set is persisted per lane alongside the rest of its view state.
  const sessionApprovedTunnelsRef = useRef(new Set<string>());
  const remotePin = runtimePin?.kind === "remote" ? runtimePin : null;
  const browserScope = useMemo<BuiltInBrowserProjectScopeArgs>(
    () => (projectRootOverride === null
      ? { tabCollection: "personal" }
      : projectRoot
        ? { projectRoot }
        : {}),
    [projectRoot, projectRootOverride],
  );
  const withBrowserScope = useCallback(<T extends Record<string, unknown>>(args: T): T & BuiltInBrowserProjectScopeArgs => (
    ({ ...args, ...browserScope }) as T & BuiltInBrowserProjectScopeArgs
  ), [browserScope]);
  const remotePinRef = useRef<Extract<OpenProjectBinding, { kind: "remote" }> | null>(remotePin);
  remotePinRef.current = remotePin;

  const readAlwaysTunnelKeys = useCallback((): string[] => {
    const store = useAppStore.getState();
    return contextLaneId
      ? store.getLaneWorkViewState(projectRoot, contextLaneId).browserTunnelAlwaysKeys
      : store.getWorkViewState(projectRoot).browserTunnelAlwaysKeys;
  }, [contextLaneId, projectRoot]);

  const rememberAlwaysTunnelKey = useCallback((key: string) => {
    const store = useAppStore.getState();
    const patch = (prev: WorkProjectViewState): WorkProjectViewState => (
      prev.browserTunnelAlwaysKeys.includes(key)
        ? prev
        : { ...prev, browserTunnelAlwaysKeys: [...prev.browserTunnelAlwaysKeys, key] }
    );
    if (contextLaneId) store.setLaneWorkViewState(projectRoot, contextLaneId, patch);
    else store.setWorkViewState(projectRoot, patch);
  }, [contextLaneId, projectRoot]);

  /**
   * Gate one (machine, port) pair behind a human.
   *
   * The pinned machine already carries a `portForward` grant, but that grant is
   * about the machine, and here the *agent* names the port — so the first use of
   * a port it chose needs a person to say yes. A URL the human typed does not:
   * they just said it out loud by typing it.
   */
  const ensureTunnelApproval = useCallback(async (
    remotePort: number,
    machineLabel: string,
    options: { human: boolean },
  ): Promise<boolean> => {
    const pin = remotePinRef.current;
    if (!pin) return true;
    const key = remoteTunnelApprovalKey(pin.targetId, remotePort);
    if (options.human) {
      sessionApprovedTunnelsRef.current.add(key);
      return true;
    }
    if (sessionApprovedTunnelsRef.current.has(key)) return true;
    if (readAlwaysTunnelKeys().includes(key)) return true;
    return await new Promise<boolean>((resolve) => {
      setPendingApproval((previous) => {
        // A second request for the same port while one bar is up joins it
        // rather than stacking a second bar the human has to answer twice.
        previous?.decide("deny");
        return {
          key,
          remotePort,
          machineLabel,
          decide: (decision) => {
            setPendingApproval(null);
            if (decision === "deny") {
              resolve(false);
              return;
            }
            sessionApprovedTunnelsRef.current.add(key);
            if (decision === "always") rememberAlwaysTunnelKey(key);
            resolve(true);
          },
        };
      });
    });
  }, [readAlwaysTunnelKeys, rememberAlwaysTunnelKey]);

  /**
   * Everything a loopback URL needs before it can load on a remote pin: the
   * human grant, then the forward itself. Returns the tunnel so the caller can
   * remember which tab is showing another machine. A non-loopback URL, or a
   * local pin, is a no-op.
   */
  const prepareRemoteNavigation = useCallback(async (
    url: string,
    options: { human: boolean },
  ): Promise<{ ok: boolean; tunnel: RemoteLoopbackTunnel | null; reason: string | null }> => {
    const pin = remotePinRef.current;
    if (!pin) return { ok: true, tunnel: null, reason: null };
    const parsed = parseLoopbackUrl(url);
    if (!parsed) return { ok: true, tunnel: null, reason: null };
    const machineLabel = machineNameForBinding(pin);
    const approved = await ensureTunnelApproval(parsed.port, machineLabel, options);
    if (!approved) {
      return {
        ok: false,
        tunnel: null,
        reason: `Reaching port ${parsed.port} on ${machineLabel} was not allowed.`,
      };
    }
    const api = getBrowserApi();
    if (!api?.localizeRemoteUrl) return { ok: true, tunnel: null, reason: null };
    const localized = await api.localizeRemoteUrl({ url }, pin);
    return { ok: true, tunnel: localized.forward, reason: null };
  }, [ensureTunnelApproval]);

  const syncBrowserInputSuppressedState = useCallback(() => {
    setBrowserInputSuppressed(browserInputSuppressedRef.current || browserOverlayOccludedRef.current);
  }, []);

  const statusInfo = useMemo(() => buildStatusInfo(apiAvailable, status), [apiAvailable, status]);
  const browserTabs = useMemo(() => status?.tabs ?? [], [status?.tabs]);
  const tabIdsSignature = useMemo(() => browserTabs.map((tab) => tab.id).join("|"), [browserTabs]);
  const activeTabId = status?.activeTabId ?? browserTabs[0]?.id ?? null;
  const activeTabTunnel = activeTabId ? tabTunnels[activeTabId] ?? null : null;
  // What the human asked for, not the ephemeral forward port behind it.
  const currentUrl = tunnelAwareUrl(status?.url ?? "", activeTabTunnel);
  const canGoBack = Boolean(status?.canGoBack);
  const canGoForward = Boolean(status?.canGoForward);
  const loading = Boolean(status?.loading);
  const inspecting = Boolean(status?.inspecting);
  const selectionFrame = frameLabel(selectedItem?.frame ?? null);
  const sessionLabel = shortSessionId(sessionId);
  const activeTab = useMemo(
    () => browserTabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, browserTabs],
  );
  const handoff = activeTab?.handoff ?? null;
  /**
   * Origin the auto hand-back offer is currently suppressed for.
   *
   * "Keep control" must silence the offer only until the NEXT origin change —
   * a sign-in that bounces through three identity-provider hosts would
   * otherwise re-ask on every hop, and a permanent dismissal would lose the
   * offer for the origin the human actually lands on.
   */
  const [handoffOfferSilencedOrigin, setHandoffOfferSilencedOrigin] = useState<string | null>(null);
  const currentHandoffOrigin = useMemo(() => browserUrlOrigin(currentUrl), [currentUrl]);
  const handoffLeftStartOrigin = Boolean(
    handoff?.startedAtOrigin
    && currentHandoffOrigin
    && currentHandoffOrigin !== handoff.startedAtOrigin,
  );
  const showHandoffHandBackOffer = handoffLeftStartOrigin
    && currentHandoffOrigin !== handoffOfferSilencedOrigin;
  const emulation = activeTab?.emulation ?? null;
  const zoomFactor = activeTab?.zoomFactor && activeTab.zoomFactor > 0 ? activeTab.zoomFactor : 1;
  const devToolsOpen = Boolean(activeTab?.devToolsOpen);
  const networkLogging = Boolean(activeTab?.networkLogging);
  const recording: BuiltInBrowserRecordingStatus | null = activeTab?.recording ?? null;
  const lockKind = urlLockKind(currentUrl);
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
    // Tabs that closed, or left the forwarded origin for a real site, stop
    // being described as the pinned machine's.
    if (Object.keys(tabTunnelsRef.current).length > 0) {
      setTabTunnels((prev) => reconcileTabTunnels(prev, normalized.tabs));
    }
    if (!editingUrlRef.current) {
      // Never show the ephemeral forward port: the human asked for the remote
      // origin, and that is the URL they can copy, share, or retype.
      const activeId = normalized.activeTabId;
      setUrlInput(tunnelAwareUrl(
        normalized.url,
        activeId ? tabTunnelsRef.current[activeId] ?? null : null,
      ));
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    const api = requireBrowserApi();
    const nextStatus = await api.getStatus(browserScope, runtimePinRef.current);
    applyStatus(nextStatus);
  }, [applyStatus, browserScope]);

  const attachBrowserContextItem = useCallback(async (
    item: BuiltInBrowserContextItem,
    options: { force?: boolean; auto?: boolean; label?: string } = {},
  ): Promise<BuiltInBrowserContextItem | null> => {
    if (!onAddContext) throw new Error("Context insertion is not available in this panel.");
    if (!options.force && autoAttachedContextIdsRef.current.has(item.id)) return null;

    let attachmentPath = typeof item.metadata?.attachmentPath === "string" ? item.metadata.attachmentPath : null;
    const screenshotDataUrl = item.screenshotDataUrl ?? null;
    if (screenshotDataUrl && !attachmentPath && onAddAttachment) {
      try {
        const saved = await window.ade.agentChat.saveTempAttachment({
          data: stripDataUrlPrefix(screenshotDataUrl),
          filename: item.kind === "built_in_browser_capture" ? "built-in-browser-capture.png" : "built-in-browser-selection.png",
        }, ...(runtimePin ? [runtimePin] as const : []));
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
      messageText = "Inserted browser inspect context.";
    } else if (isCapture) {
      messageText = "Inserted browser capture with page context.";
    } else {
      messageText = "Inserted the selected browser element context.";
    }
    setMessage({ tone: "info", text: messageText });
    return contextItem;
  }, [onAddAttachment, onAddContext, runtimePin, sessionId]);

  const reportBounds = useCallback((visibleOverride?: boolean) => {
    const api = getBrowserApi();
    const element = browserSurfaceRef.current;
    if (!api || !element) return;
    if (shouldUseRendererBrowserWebviews(api)) {
      const hidden: BrowserBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };
      if (boundsEqual(latestBoundsRef.current, hidden)) return;
      latestBoundsRef.current = hidden;
      api.setBounds(withBrowserScope(hidden), runtimePinRef.current).catch((error: unknown) => {
        setMessage({ tone: "error", text: `Could not hide browser fallback: ${errorMessage(error)}` });
      });
      return;
    }
    const measured = measureNativeBrowserBounds(element);
    const next: BrowserBounds = {
      ...measured,
      visible: visibleOverride ?? (
        !browserInputSuppressedRef.current
        && !browserOverlayOccludedRef.current
        && !captureModeRef.current
        && measured.visible
      ),
    };
    if (boundsEqual(latestBoundsRef.current, next)) return;
    latestBoundsRef.current = next;
    api.setBounds(withBrowserScope(next), runtimePinRef.current).catch((error: unknown) => {
      setMessage({ tone: "error", text: `Could not position browser: ${errorMessage(error)}` });
    });
  }, [withBrowserScope]);

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
    await api.stopInspect(browserScope, runtimePinRef.current).catch(() => {});
    await api.setBounds(withBrowserScope(hidden), runtimePinRef.current).catch(() => {});
  }, [browserScope, withBrowserScope]);

  useEffect(() => {
    let restoreFrame: number | null = null;
    const cancelRestoreFrame = () => {
      if (restoreFrame == null) return;
      window.cancelAnimationFrame(restoreFrame);
      restoreFrame = null;
    };
    const suppressInput = () => {
      cancelRestoreFrame();
      browserViewSuppressionCountRef.current += 1;
      browserInputSuppressedRef.current = true;
      syncBrowserInputSuppressedState();
      reportBounds(false);
    };
    const restoreInput = () => {
      browserViewSuppressionCountRef.current = Math.max(0, browserViewSuppressionCountRef.current - 1);
      if (browserViewSuppressionCountRef.current > 0) return;
      browserInputSuppressedRef.current = false;
      syncBrowserInputSuppressedState();
      cancelRestoreFrame();
      restoreFrame = window.requestAnimationFrame(() => {
        restoreFrame = null;
        reportBounds();
      });
    };
    window.addEventListener(ADE_WORK_SIDEBAR_BROWSER_RESIZE_START_EVENT, suppressInput);
    window.addEventListener(ADE_WORK_SIDEBAR_BROWSER_RESIZE_END_EVENT, restoreInput);
    window.addEventListener(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT, suppressInput);
    window.addEventListener(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT, restoreInput);
    return () => {
      window.removeEventListener(ADE_WORK_SIDEBAR_BROWSER_RESIZE_START_EVENT, suppressInput);
      window.removeEventListener(ADE_WORK_SIDEBAR_BROWSER_RESIZE_END_EVENT, restoreInput);
      window.removeEventListener(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT, suppressInput);
      window.removeEventListener(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT, restoreInput);
      cancelRestoreFrame();
    };
  }, [reportBounds, syncBrowserInputSuppressedState]);

  useEffect(() => {
    const element = browserSurfaceRef.current;
    if (!element || typeof MutationObserver === "undefined") return undefined;
    let animationFrame: number | null = null;
    const cancelFrame = () => {
      if (animationFrame == null) return;
      window.cancelAnimationFrame(animationFrame);
      animationFrame = null;
    };
    const setOverlayOccluded = (next: boolean) => {
      if (browserOverlayOccludedRef.current === next) return;
      browserOverlayOccludedRef.current = next;
      syncBrowserInputSuppressedState();
      reportBounds(next ? false : undefined);
    };
    const checkForOverlay = () => {
      animationFrame = null;
      setOverlayOccluded(browserSurfaceHasExternalOverlay(element));
      refreshObservedOverlays();
    };
    const scheduleCheck = () => {
      if (animationFrame != null) return;
      animationFrame = window.requestAnimationFrame(checkForOverlay);
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleCheck);
    const observedOverlays = new Set<HTMLElement>();
    const refreshObservedOverlays = () => {
      if (!resizeObserver || !document.body) return;
      const nextOverlays = new Set(collectBrowserOverlayCandidates(element));
      for (const overlay of observedOverlays) {
        if (nextOverlays.has(overlay)) continue;
        resizeObserver.unobserve(overlay);
        observedOverlays.delete(overlay);
      }
      for (const overlay of nextOverlays) {
        if (observedOverlays.has(overlay)) continue;
        resizeObserver.observe(overlay);
        observedOverlays.add(overlay);
      }
    };
    const observer = new MutationObserver(scheduleCheck);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["aria-hidden", "aria-modal", "class", "data-state", "hidden", "role", "style"],
      childList: true,
      subtree: true,
    });
    scheduleCheck();
    window.addEventListener("resize", scheduleCheck);
    window.addEventListener("scroll", scheduleCheck, true);
    for (const eventName of OVERLAY_MOTION_EVENTS) {
      document.addEventListener(eventName, scheduleCheck, true);
    }
    return () => {
      observer.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleCheck);
      window.removeEventListener("scroll", scheduleCheck, true);
      for (const eventName of OVERLAY_MOTION_EVENTS) {
        document.removeEventListener(eventName, scheduleCheck, true);
      }
      cancelFrame();
      browserOverlayOccludedRef.current = false;
    };
  }, [reportBounds, syncBrowserInputSuppressedState]);

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
        api.stopInspect(browserScope, runtimePinRef.current).catch(() => {});
        latestBoundsRef.current = { ...last, visible: false };
        api.setBounds(withBrowserScope({ ...last, visible: false }), runtimePinRef.current).catch(() => {});
      }
    };
  }, [browserScope, reportBounds, withBrowserScope]);

  useEffect(() => {
    const api = getBrowserApi();
    if (!api) {
      setMessage({ tone: "error", text: "Built-in browser API is not available in this renderer." });
      return undefined;
    }
    let cancelled = false;
    api.getStatus(browserScope, runtimePinRef.current)
      .then((nextStatus) => {
        if (!cancelled) applyStatus(nextStatus);
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage({ tone: "error", text: errorMessage(error) });
      });
    const unsubscribe = api.onEvent((event) => {
      if (!browserEventMatchesProject(event, projectRoot)) return;
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
      if (eventType === "found-in-page") {
        setFindState({
          activeMatchOrdinal: numberField(event.activeMatchOrdinal),
          matches: numberField(event.matches),
        });
      }
      if (eventType === "recording") {
        // The recording event carries no status, and `tab.recording` is what the
        // REC pill reads — so pull the tab state that just changed.
        api.getStatus(browserScope, runtimePinRef.current).then(applyStatus).catch(() => {});
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
    }, runtimePinRef.current);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyStatus, attachBrowserContextItem, browserScope, onAddContext, projectRoot]);

  /**
   * `ade browser open` run on the pinned machine.
   *
   * That machine has no browser of its own — only `ade serve` — so its daemon
   * publishes the URL and waits for a desktop that has the lane pinned to take
   * it. This is that desktop: the URL goes through the same approval and
   * port-forward path a human navigation does, and the ack is what lets the
   * agent's CLI print where it ended up instead of an error.
   */
  useEffect(() => {
    const api = getBrowserApi();
    const pin = remotePin;
    if (!api?.onRemoteRequest || !pin) return undefined;
    let cancelled = false;
    const unsubscribe = api.onRemoteRequest((request) => {
      void (async () => {
        let accepted = false;
        let reason: string | null = null;
        try {
          const prepared = await prepareRemoteNavigation(request.url, { human: false });
          if (cancelled) return;
          if (!prepared.ok) {
            reason = prepared.reason;
          } else {
            await api.navigate(
              withBrowserScope({
                url: request.url,
                ...(request.openPanel ? { openPanel: true } : {}),
                ...(request.laneId ? { laneId: request.laneId } : {}),
                ...(request.chatSessionId ? { chatSessionId: request.chatSessionId } : {}),
              }),
              pin,
            );
            await refreshStatus();
            if (prepared.tunnel) {
              const tunnel = prepared.tunnel;
              setTabTunnels((prev) => setTabTunnel(prev, statusRef.current?.activeTabId ?? null, tunnel));
            }
            accepted = true;
          }
        } catch (error) {
          reason = errorMessage(error);
        }
        if (cancelled) return;
        if (!accepted && reason) setMessage({ tone: "error", text: reason });
        await api.acknowledgeRemoteRequest?.(
          { requestId: request.requestId, desktopLabel: THIS_MACHINE_NAME, accepted, reason },
          pin,
        ).catch(() => {});
      })();
    }, pin);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [prepareRemoteNavigation, refreshStatus, remotePin, withBrowserScope]);

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
    if (!shouldUseRendererBrowserWebviews(api) || !host) return;

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
      void api.attachWebview?.(withBrowserScope({ tabId, webContentsId }))
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
        nextWebview.setAttribute("partition", statusRef.current?.partition || "persist:ade-browser");
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
      webview.style.pointerEvents = isActive && !captureBase && !browserInputSuppressed ? "auto" : "none";
      webview.setAttribute("aria-hidden", isActive ? "false" : "true");
    }
  }, [activeTabId, applyStatus, browserInputSuppressed, browserTabs, tabIdsSignature, captureBase, webviewNavigationNonce, withBrowserScope]);

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
    if (!shouldUseRendererBrowserWebviews(api) || !activeTabId) return false;
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
      const nextStatus = await api.attachWebview(withBrowserScope({ tabId: activeTabId, webContentsId }));
      applyStatus(nextStatus);
    }
    return true;
  }, [activeTabId, applyStatus, withBrowserScope]);

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

  const hasStatus = status != null;
  useEffect(() => {
    const api = getBrowserApi();
    if (!apiAvailable || !api || !hasStatus) return;
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
        if (shouldUseRendererBrowserWebviews(api) && api.createTab) {
          const nextStatus = normalizeStatus(await api.createTab(withBrowserScope({ activate: true }), runtimePinRef.current), statusRef.current);
          applyStatus(nextStatus);
          const tabId = nextStatus.activeTabId;
          if (!tabId) throw new Error("ADE browser could not create a tab.");
          navigateRendererWebview(tabId, DEFAULT_BROWSER_URL);
          setUrlInput(DEFAULT_BROWSER_URL);
          return;
        }
        const nextStatus = api.createTab
          ? await api.createTab(withBrowserScope({ url: DEFAULT_BROWSER_URL, activate: true }), runtimePinRef.current)
          : await api.navigate(withBrowserScope({ url: DEFAULT_BROWSER_URL, newTab: true }), runtimePinRef.current);
        applyStatus(nextStatus);
        setUrlInput(DEFAULT_BROWSER_URL);
      } catch (error) {
        defaultBrowserOpenedRef.current = false;
        setMessage({ tone: "error", text: errorMessage(error) });
      }
    })();
  }, [apiAvailable, applyStatus, browserTabs.length, navigateRendererWebview, hasStatus, withBrowserScope]);

  const navigateToUrl = useCallback(
    (raw: string) => {
      const normalized = normalizeUrlForNavigation(raw);
      if (!normalized.ok) {
        setMessage({ tone: "error", text: normalized.reason });
        return;
      }
      const nextUrl = normalized.url;
      if (!nextUrl) return;
      void runBusy("navigate", async () => {
        if (captureModeRef.current) restoreLiveBrowserView();
        const api = requireBrowserApi();
        if (shouldUseRendererBrowserWebviews(api)) {
          let tabId: string | null = activeTabId;
          if (!tabId) {
            if (!api.createTab) throw new Error("This ADE build does not support browser tab creation.");
            const nextStatus = normalizeStatus(await api.createTab(withBrowserScope({ activate: true }), runtimePinRef.current), statusRef.current);
            applyStatus(nextStatus);
            tabId = nextStatus.activeTabId;
          }
          if (!tabId) throw new Error("ADE browser could not create a tab.");
          navigateRendererWebview(tabId, nextUrl);
          setUrlInput(nextUrl);
          return;
        }
        // The human typed this, so no approval bar — but a loopback URL on a
        // remote pin still has to be tunneled before it means anything here.
        const prepared = await prepareRemoteNavigation(nextUrl, { human: true });
        if (!prepared.ok) {
          setMessage({ tone: "error", text: prepared.reason ?? "Navigation was not allowed." });
          return;
        }
        await api.navigate(withBrowserScope({ url: nextUrl }), runtimePinRef.current);
        setUrlInput(nextUrl);
        await refreshStatus();
        if (prepared.tunnel) {
          const tunnel = prepared.tunnel;
          setTabTunnels((prev) => setTabTunnel(prev, statusRef.current?.activeTabId ?? null, tunnel));
        }
      });
    },
    [activeTabId, applyStatus, navigateRendererWebview, prepareRemoteNavigation, refreshStatus, restoreLiveBrowserView, runBusy, withBrowserScope],
  );

  const handleNavigate = useCallback(
    (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      navigateToUrl(urlInput);
    },
    [navigateToUrl, urlInput],
  );

  /** Empty-state chips: fill the URL field so the bar reflects what loaded. */
  const handleSuggestion = useCallback((url: string) => {
    setUrlInput(url);
    navigateToUrl(url);
  }, [navigateToUrl]);

  const handleNewTab = useCallback(() => {
    void runBusy("new-tab", async () => {
      if (captureModeRef.current) restoreLiveBrowserView();
      const api = requireBrowserApi();
      if (shouldUseRendererBrowserWebviews(api) && api.createTab) {
        const nextStatus = normalizeStatus(await api.createTab(withBrowserScope({ activate: true }), runtimePinRef.current), statusRef.current);
        applyStatus(nextStatus);
        const tabId = nextStatus.activeTabId;
        if (!tabId) throw new Error("ADE browser could not create a tab.");
        navigateRendererWebview(tabId, DEFAULT_BROWSER_URL);
        setUrlInput(DEFAULT_BROWSER_URL);
        return;
      }
      if (api.createTab) {
        const nextStatus = await api.createTab(withBrowserScope({ url: DEFAULT_BROWSER_URL, activate: true }), runtimePinRef.current);
        applyStatus(nextStatus);
      } else {
        const nextStatus = await api.navigate(withBrowserScope({ url: DEFAULT_BROWSER_URL, newTab: true }), runtimePinRef.current);
        applyStatus(nextStatus);
      }
      setUrlInput(DEFAULT_BROWSER_URL);
    });
  }, [applyStatus, navigateRendererWebview, restoreLiveBrowserView, runBusy, withBrowserScope]);

  const handleSwitchTab = useCallback((tabId: string) => {
    void runBusy("switch-tab", async () => {
      if (captureModeRef.current) restoreLiveBrowserView();
      const api = requireBrowserApi();
      if (api.switchTab) {
        await api.switchTab(withBrowserScope({ tabId }), runtimePinRef.current);
      } else {
        throw new Error("This ADE build does not support browser tab switching.");
      }
      await refreshStatus();
    });
  }, [refreshStatus, restoreLiveBrowserView, runBusy, withBrowserScope]);

  const handleCloseTab = useCallback((tabId: string) => {
    void runBusy("close-tab", async () => {
      if (captureModeRef.current) restoreLiveBrowserView();
      const api = requireBrowserApi();
      if (api.closeTab) {
        await api.closeTab(withBrowserScope({ tabId }), runtimePinRef.current);
      } else {
        throw new Error("This ADE build does not support closing browser tabs.");
      }
      await refreshStatus();
    });
  }, [refreshStatus, restoreLiveBrowserView, runBusy, withBrowserScope]);

  const handleHandBack = useCallback((endedBy: "human" | "auto-offer") => {
    void runBusy("hand-back", async () => {
      const api = requireBrowserApi();
      if (!api.endHandoff) {
        throw new Error("This ADE build does not support handing the browser back.");
      }
      await api.endHandoff(withBrowserScope({ endedBy }), runtimePinRef.current);
      setHandoffOfferSilencedOrigin(null);
      await refreshStatus();
    });
  }, [refreshStatus, runBusy, withBrowserScope]);

  const handleKeepHandoffControl = useCallback(() => {
    setHandoffOfferSilencedOrigin(currentHandoffOrigin);
  }, [currentHandoffOrigin]);

  // A new handoff always starts with a live offer, whatever the previous one silenced.
  useEffect(() => {
    if (!handoff) setHandoffOfferSilencedOrigin(null);
  }, [handoff?.startedAt, handoff]);

  const handleBack = useCallback(() => {
    void runBusy("back", async () => {
      const api = requireBrowserApi();
      await api.goBack(browserScope, runtimePinRef.current);
      await refreshStatus();
    });
  }, [browserScope, refreshStatus, runBusy]);

  const handleForward = useCallback(() => {
    void runBusy("forward", async () => {
      const api = requireBrowserApi();
      await api.goForward(browserScope, runtimePinRef.current);
      await refreshStatus();
    });
  }, [browserScope, refreshStatus, runBusy]);

  const handleReload = useCallback(() => {
    void runBusy("reload", async () => {
      const api = requireBrowserApi();
      await api.reload(browserScope, runtimePinRef.current);
      await refreshStatus();
    });
  }, [browserScope, refreshStatus, runBusy]);

  const handleStop = useCallback(() => {
    void runBusy("stop", async () => {
      const api = requireBrowserApi();
      await api.stop(browserScope, runtimePinRef.current);
      await refreshStatus();
    });
  }, [browserScope, refreshStatus, runBusy]);

  const handleInspectToggle = useCallback(() => {
    void runBusy(inspecting ? "inspect-off" : "inspect-on", async () => {
      const api = requireBrowserApi();
      if (inspecting) {
        await api.stopInspect(browserScope, runtimePinRef.current);
      } else {
        await api.startInspect(browserScope, runtimePinRef.current);
      }
      await refreshStatus();
    });
  }, [browserScope, inspecting, refreshStatus, runBusy]);

  const handleClearSelection = useCallback(() => {
    void runBusy("clear-selection", async () => {
      const api = requireBrowserApi();
      await api.clearSelection(browserScope, runtimePinRef.current);
      selectedItemRef.current = null;
      setSelectedItem(null);
      setStatus((current) => current ? { ...current, selectedItem: null } : current);
      setAttachmentAck(null);
    });
  }, [browserScope, runBusy]);

  const handleAttachSelection = useCallback(() => {
    void runBusy("select", async () => {
      const api = requireBrowserApi();
      const result = await api.selectCurrent(browserScope, runtimePinRef.current);
      const item =
        normalizeSelectionResult(result, statusRef.current)
        ?? selectedItemRef.current
        ?? statusRef.current?.selectedItem
        ?? null;
      if (!item) throw new Error("Select an element in Inspect mode first.");
      await attachBrowserContextItem(item, { force: true, label: "Browser context attached." });
    });
  }, [attachBrowserContextItem, browserScope, runBusy]);

  const handleAttachScreenshot = useCallback(() => {
    void runBusy("screenshot", async () => {
      if (!onAddContext) throw new Error("Context insertion is not available in this panel.");
      if (captureModeRef.current) {
        restoreLiveBrowserView();
        setMessage({ tone: "info", text: "Browser screenshot capture cancelled." });
        return;
      }
      const api = requireBrowserApi();
      await attachActiveRendererWebview();
      let screenshot: BuiltInBrowserScreenshot | null = null;
      try {
        const result = await api.captureScreenshot(browserScope, runtimePinRef.current);
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
  }, [attachActiveRendererWebview, browserScope, captureActiveRendererWebview, hideNativeBrowserView, onAddContext, restoreLiveBrowserView, runBusy]);

  const addBrowserCaptureContext = useCallback(async (frame: BrowserFrame) => {
    if (!captureBase) return;
    if (!onAddContext) throw new Error("Context insertion is not available in this panel.");
    const crop = await cropBrowserScreenshot(captureBase, frame);
    if (!crop) throw new Error("Could not crop browser screenshot.");

    let attachmentPath: string | null = null;
    if (onAddAttachment) {
      const saved = await window.ade.agentChat.saveTempAttachment({
        data: stripDataUrlPrefix(crop.dataUrl),
        filename: "built-in-browser-capture.png",
      }, ...(runtimePin ? [runtimePin] as const : []));
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
        const pointResult = await api.selectPoint(withBrowserScope({ x: domPoint.x, y: domPoint.y, includeScreenshot: false }), runtimePinRef.current);
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
  }, [attachBrowserContextItem, captureBase, onAddAttachment, onAddContext, restoreLiveBrowserView, runtimePin, sessionId, withBrowserScope]);

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

  const refreshProfileSecurity = useCallback(async () => {
    const api = requireBrowserApi();
    if (!api.getProfileDiagnostics || !api.listPermissions) {
      throw new Error("This ADE build does not expose browser profile diagnostics.");
    }
    setProfileBusy(true);
    try {
      const [diagnostics, permissions] = await Promise.all([
        api.getProfileDiagnostics(),
        api.listPermissions(),
      ]);
      setProfileDiagnostics(diagnostics);
      setPermissionDecisions(permissions.permissions);
    } finally {
      setProfileBusy(false);
    }
  }, []);

  const handleToggleProfile = useCallback(() => {
    if (profileOpen) {
      setProfileOpen(false);
      return;
    }
    setProfileOpen(true);
    void refreshProfileSecurity().catch((error: unknown) => {
      setMessage({ tone: "error", text: errorMessage(error) });
    });
  }, [profileOpen, refreshProfileSecurity]);

  const clearRememberedPermission = useCallback((
    decision?: Pick<BuiltInBrowserPermissionDecision, "origin" | "permission">,
  ) => {
    if (!decision && !window.confirm("Clear all remembered ADE browser permission decisions?")) return;
    void (async () => {
      const api = requireBrowserApi();
      if (!api.clearPermissions) throw new Error("This ADE build does not support clearing browser permissions.");
      setProfileBusy(true);
      try {
        const result = await api.clearPermissions(decision
          ? { origin: decision.origin, permission: decision.permission }
          : {});
        setPermissionDecisions(result.permissions);
        if (api.getProfileDiagnostics) {
          setProfileDiagnostics(await api.getProfileDiagnostics());
        }
        setMessage({
          tone: "info",
          text: result.removed === 1
            ? "Cleared one remembered browser permission."
            : `Cleared ${result.removed} remembered browser permissions.`,
        });
      } finally {
        setProfileBusy(false);
      }
    })().catch((error: unknown) => {
      setMessage({ tone: "error", text: errorMessage(error) });
    });
  }, []);

  const handleOpenExternal = useCallback(() => {
    const url = currentUrl.trim();
    if (!url) return;
    void window.ade.app.openExternal(url).catch((error: unknown) => {
      setMessage({ tone: "error", text: `Could not open URL externally: ${errorMessage(error)}` });
    });
  }, [currentUrl]);

  /* ── Device emulation ───────────────────────────────────────────────────── */

  const applyEmulation = useCallback((
    request: { preset?: string | null; width?: number | null; height?: number | null },
    label: string,
  ) => {
    void runBusy("emulation", async () => {
      const api = requireBrowserApi();
      if (!api.setEmulation) throw new Error("This ADE build does not support browser device emulation.");
      const result = await api.setEmulation(withBrowserScope(request), runtimePinRef.current);
      applyStatus(result.status);
      setMessage({ tone: "info", text: `Browser is emulating ${label}.` });
    });
  }, [applyStatus, runBusy, withBrowserScope]);

  const handlePickPreset = useCallback((preset: BuiltInBrowserEmulationPreset) => {
    applyEmulation({ preset: preset.id }, preset.label);
  }, [applyEmulation]);

  const handleEmulationOff = useCallback(() => {
    void runBusy("emulation", async () => {
      const api = requireBrowserApi();
      if (!api.setEmulation) throw new Error("This ADE build does not support browser device emulation.");
      const result = await api.setEmulation(withBrowserScope({ preset: "off" }), runtimePinRef.current);
      applyStatus(result.status);
    });
  }, [applyStatus, runBusy, withBrowserScope]);

  const handleApplyResponsive = useCallback(() => {
    const width = Number.parseInt(responsiveWidth, 10);
    const height = Number.parseInt(responsiveHeight, 10);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      setMessage({ tone: "error", text: "Enter a width and a height to size the browser." });
      return;
    }
    setDeviceMenuOpen(false);
    applyEmulation({ width, height }, `${width}×${height}`);
  }, [applyEmulation, responsiveHeight, responsiveWidth]);

  /* ── Zoom ───────────────────────────────────────────────────────────────── */

  const applyZoom = useCallback((factor: number) => {
    void runBusy("zoom", async () => {
      const api = requireBrowserApi();
      if (!api.setZoom) throw new Error("This ADE build does not support browser zoom.");
      const result = await api.setZoom(withBrowserScope({ factor }), runtimePinRef.current);
      applyStatus(result.status);
    });
  }, [applyStatus, runBusy, withBrowserScope]);

  const handleZoomStep = useCallback((direction: 1 | -1) => {
    applyZoom(stepZoomFactor(zoomFactor, direction));
  }, [applyZoom, zoomFactor]);

  const handleZoomReset = useCallback(() => applyZoom(1), [applyZoom]);

  /* ── Find in page ───────────────────────────────────────────────────────── */

  const runFind = useCallback((text: string, options?: { findNext?: boolean; forward?: boolean }) => {
    const query = text.trim();
    if (!query) {
      setFindState(null);
      return;
    }
    const api = getBrowserApi();
    if (!api?.findInPage) {
      setMessage({ tone: "error", text: "This ADE build does not support finding text in the page." });
      return;
    }
    void api.findInPage(
      withBrowserScope({
        text: query,
        findNext: options?.findNext ?? false,
        forward: options?.forward ?? true,
      }),
      runtimePinRef.current,
    )
      .then((result) => {
        setFindState({
          activeMatchOrdinal: result.activeMatchOrdinal ?? null,
          matches: result.matches ?? null,
        });
      })
      .catch((error: unknown) => {
        setMessage({ tone: "error", text: errorMessage(error) });
      });
  }, [withBrowserScope]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindState(null);
    const api = getBrowserApi();
    if (!api?.stopFindInPage) return;
    void api.stopFindInPage(withBrowserScope({ action: "clearSelection" as const }), runtimePinRef.current)
      .catch(() => {
        // Nothing to clear is not worth a banner — the bar is already gone.
      });
  }, [withBrowserScope]);

  const openFind = useCallback(() => {
    setFindOpen(true);
    // The bar animates in, so focus on the next frame rather than into a
    // zero-height container.
    window.requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, []);

  /* ── DevTools, network log ──────────────────────────────────────────────── */

  const handleToggleDevTools = useCallback(() => {
    void runBusy("devtools", async () => {
      const api = requireBrowserApi();
      if (!api.setDevTools) throw new Error("This ADE build does not support opening browser DevTools.");
      const result = await api.setDevTools(withBrowserScope({ open: !devToolsOpen }), runtimePinRef.current);
      applyStatus(result.status);
    });
  }, [applyStatus, devToolsOpen, runBusy, withBrowserScope]);

  const handleToggleNetworkLogging = useCallback(() => {
    void runBusy("network-log", async () => {
      const api = requireBrowserApi();
      if (!api.setNetworkLogging) throw new Error("This ADE build does not support browser network logging.");
      const next = !networkLogging;
      const result = await api.setNetworkLogging(
        withBrowserScope({ enabled: next, ...(next ? { clear: true } : {}) }),
        runtimePinRef.current,
      );
      applyStatus(result.status);
      setMessage({
        tone: "info",
        text: next
          ? "Recording every request on this tab. Export a HAR when you have what you need."
          : "Stopped recording requests on this tab.",
      });
    });
  }, [applyStatus, networkLogging, runBusy, withBrowserScope]);

  const handleExportHar = useCallback(() => {
    void runBusy("export-har", async () => {
      const api = requireBrowserApi();
      if (!api.exportHar) throw new Error("This ADE build does not support HAR export.");
      const result = await api.exportHar(withBrowserScope({}), runtimePinRef.current);
      showToast({
        title: "HAR exported",
        message: `${result.entryCount} ${result.entryCount === 1 ? "request" : "requests"} · ${result.relativePath ?? result.filePath}`,
        tone: "success",
        action: {
          label: "Reveal",
          onClick: () => {
            void window.ade.app.revealPath(result.filePath).catch(() => {});
          },
        },
      });
    });
  }, [runBusy, withBrowserScope]);

  /* ── Recording ──────────────────────────────────────────────────────────── */

  const handleStopRecording = useCallback(() => {
    void runBusy("recording", async () => {
      const api = requireBrowserApi();
      if (!api.stopRecording) throw new Error("This ADE build does not support screen recording.");
      const result = await api.stopRecording(withBrowserScope({}), runtimePinRef.current);
      applyStatus(result.status);
      showToast({
        title: "Recording saved",
        // A caption is what files the clip as proof, so say so rather than
        // leaving the person to wonder whether it went anywhere.
        message: result.caption
          ? `Added to proof · ${result.relativePath ?? result.path}`
          : (result.relativePath ?? result.path),
        tone: "success",
        action: {
          label: "Reveal",
          onClick: () => {
            void window.ade.app.revealPath(result.path).catch(() => {});
          },
        },
      });
    });
  }, [applyStatus, runBusy, withBrowserScope]);

  const handleStartRecording = useCallback(() => {
    void runBusy("recording", async () => {
      const api = requireBrowserApi();
      if (!api.startRecording) throw new Error("This ADE build does not support screen recording.");
      const result = await api.startRecording(withBrowserScope({ fps: recordingFps }), runtimePinRef.current);
      applyStatus(result.status);
    });
  }, [applyStatus, recordingFps, runBusy, withBrowserScope]);

  /**
   * One camera button: click captures, Shift-click records.
   *
   * Two buttons would imply two unrelated things; they are the same intent at
   * two lengths, and the modifier is in the tooltip.
   */
  const handleCameraClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    if (event.shiftKey) {
      if (recording) handleStopRecording();
      else handleStartRecording();
      return;
    }
    handleAttachScreenshot();
  }, [handleAttachScreenshot, handleStartRecording, handleStopRecording, recording]);

  /* ── Link routing ───────────────────────────────────────────────────────── */

  const handleLinkModeChange = useCallback((next: BrowserLinkOpenMode) => {
    const previous = linkMode;
    setLinkModeState(next);
    // Push it into the router now: the next click has to obey the choice that
    // was just made, not the one the config reload eventually reports.
    setLinkOpenMode(next);
    void (async () => {
      const config = window.ade?.projectConfig;
      if (!config) throw new Error("This ADE build cannot save the link preference.");
      const snapshot = await config.get();
      await config.save({
        shared: snapshot.shared,
        local: {
          ...snapshot.local,
          browser: { ...(snapshot.local.browser ?? {}), linkOpenMode: next },
        },
      });
    })().catch((error: unknown) => {
      setLinkModeState(previous);
      setLinkOpenMode(previous);
      setMessage({ tone: "error", text: errorMessage(error) });
    });
  }, [linkMode]);

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

  /* ── URL field ──────────────────────────────────────────────────────────── */

  const handleUrlFocus = useCallback(() => {
    setEditingUrl(true);
    // Focusing the omnibox means "I am replacing this", so hand over the whole
    // string rather than a caret in the middle of a hostname.
    urlInputRef.current?.select();
  }, []);

  const handleUrlKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setUrlInput(currentUrl);
    urlInputRef.current?.blur();
  }, [currentUrl]);

  /* ── Keyboard ───────────────────────────────────────────────────────────── */

  const handlePanelKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && findOpen) {
      event.preventDefault();
      closeFind();
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === "f") {
      event.preventDefault();
      openFind();
      return;
    }
    if (key === "=" || key === "+") {
      event.preventDefault();
      handleZoomStep(1);
      return;
    }
    if (key === "-" || key === "_") {
      event.preventDefault();
      handleZoomStep(-1);
      return;
    }
    if (key === "0") {
      event.preventDefault();
      handleZoomReset();
    }
  }, [closeFind, findOpen, handleZoomReset, handleZoomStep, openFind]);

  /* ── Ambient reads ──────────────────────────────────────────────────────── */

  const recordingStartedAt = recording?.startedAt ?? null;
  useEffect(() => {
    if (!recordingStartedAt) return undefined;
    setRecordingClock(Date.now());
    // `steps(1)` in spirit: one repaint a second, not one a frame.
    const timer = window.setInterval(() => setRecordingClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [recordingStartedAt]);

  useEffect(() => {
    void refreshLinkOpenMode().then(() => setLinkModeState(getLinkOpenMode()));
  }, []);

  // Read once on mount and again whenever the device menu opens: a booted
  // simulator is a fact about right now, and polling for it would cost every
  // panel that never opens the menu.
  useEffect(() => {
    const simulator = window.ade?.iosSimulator;
    if (!simulator?.getStatus) return undefined;
    let cancelled = false;
    void simulator.getStatus(runtimePinRef.current)
      .then((simulatorStatus) => {
        if (cancelled) return;
        setBootedSimulatorName(simulatorStatus?.activeDevice?.name ?? null);
      })
      .catch(() => {
        // No simulator tooling on this machine is not an error to report here.
      });
    return () => {
      cancelled = true;
    };
  }, [deviceMenuOpen]);

  // One pass over the usual dev-server ports, only while the panel is empty and
  // only against this desktop's loopback (a remote pin's localhost is not ours).
  useEffect(() => {
    if (browserTabs.length > 0 || remotePin) return undefined;
    const probePort = window.ade?.localhost?.probePort;
    if (!probePort) return undefined;
    let cancelled = false;
    void (async () => {
      for (const port of DEV_SERVER_PROBE_PORTS) {
        if (cancelled) return;
        const listening = await probePort(port).catch(() => false);
        if (listening && !cancelled) {
          setDetectedDevServer(`http://localhost:${port}`);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [browserTabs.length, remotePin]);

  // Only offered when the booted device maps onto metrics ADE actually has.
  const simulatorPreset = useMemo(
    () => simulatorEmulationPreset(bootedSimulatorName),
    [bootedSimulatorName],
  );

  const syncTabStripFades = useCallback(() => {
    const strip = tabStripRef.current;
    if (!strip) return;
    const start = strip.scrollLeft > 2;
    const end = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2;
    setTabStripFades((previous) => (
      previous.start === start && previous.end === end ? previous : { start, end }
    ));
  }, []);

  useEffect(() => {
    syncTabStripFades();
  }, [syncTabStripFades, tabIdsSignature]);

  /**
   * The empty state's chips.
   *
   * A detected dev server is offered first because it is the page you almost
   * always wanted; `localhost:3000` stays as the honest guess when nothing was
   * detected, and "Paste a link" is the escape hatch that costs no typing.
   */
  const emptyStateSuggestions = useMemo(() => {
    const chips: Array<{ label: string; onSelect: () => void }> = [];
    if (detectedDevServer) {
      chips.push({
        label: detectedDevServer.replace(/^https?:\/\//, ""),
        onSelect: () => handleSuggestion(detectedDevServer),
      });
    }
    if (detectedDevServer !== "http://localhost:3000") {
      chips.push({
        label: "localhost:3000",
        onSelect: () => handleSuggestion("http://localhost:3000"),
      });
    }
    chips.push({
      label: "Paste a link",
      onSelect: () => {
        urlInputRef.current?.focus();
        const readClipboard = window.ade?.app?.readClipboardText;
        if (!readClipboard) return;
        void readClipboard()
          .then((text) => {
            const trimmed = (text ?? "").trim();
            if (trimmed) setUrlInput(trimmed);
          })
          .catch(() => {
            // An unreadable clipboard just leaves the focused, empty field.
          });
      },
    });
    return chips;
  }, [detectedDevServer, handleSuggestion]);

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
    <div
      ref={panelRef}
      onKeyDown={handlePanelKeyDown}
      className="flex h-full min-h-0 flex-col font-sans text-[12px] text-fg/75"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-white/[0.08] bg-[var(--color-bg)]">
        <div className="relative flex h-[28px] shrink-0 items-center bg-white/[0.02]">
          <div
            ref={tabStripRef}
            onScroll={syncTabStripFades}
            role="tablist"
            aria-label="ADE browser tabs"
            className="scrollbar-none flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1.5"
          >
            {browserTabs.map((tab) => {
              const active = tab.id === activeTabId;
              // A tunneled tab falls back to the REMOTE origin, never the forward
              // port, when the page has no title of its own.
              const tabUrl = tunnelAwareUrl(tab.url, tabTunnels[tab.id] ?? null) || null;
              const label = browserTabLabel(tab, tabUrl);
              const ownerLabel = browserTabOwnerLabel(tab);
              const ownerTitle = tab.handoff
                ? `You own this tab until you hand it back · ${tab.handoff.reason}`
                : ownerLabel
                  ? `Agent holds this tab · ${ownerLabel}`
                  : null;
              return (
                <div
                  key={tab.id}
                  className={cn(
                    "group/tab relative inline-flex h-[22px] max-w-[188px] min-w-[92px] shrink-0 items-center",
                    "gap-1.5 rounded-[7px] px-2 text-[10.5px]",
                    "transition-colors duration-[120ms] ease-out",
                    active ? "text-fg/92" : "text-muted-fg/70 hover:bg-white/[0.04] hover:text-fg/85",
                  )}
                  title={[ownerTitle, tabUrl ?? label].filter(Boolean).join(" · ")}
                >
                  {active ? (
                    reduceMotion ? (
                      <span
                        aria-hidden="true"
                        className="absolute inset-0 rounded-[7px] border border-white/[0.09] bg-white/[0.07]"
                      />
                    ) : (
                      <motion.span
                        aria-hidden="true"
                        layoutId={TAB_INDICATOR_LAYOUT_ID}
                        className="absolute inset-0 rounded-[7px] border border-white/[0.09] bg-white/[0.07]"
                        transition={TAB_INDICATOR_SPRING}
                      />
                    )
                  ) : null}
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => {
                      if (!active) handleSwitchTab(tab.id);
                    }}
                    className={cn(
                      "relative inline-flex min-w-0 flex-1 items-center gap-1.5 text-left",
                      TOOLBAR_FOCUS,
                    )}
                  >
                    {tab.isLoading ? (
                      <SpinnerGap size={11} className="shrink-0 animate-spin text-sky-300/75" />
                    ) : (
                      <Globe size={11} className={cn("shrink-0", active ? "text-fg/70" : "text-muted-fg/50")} />
                    )}
                    <span className="min-w-0 truncate leading-none">{label}</span>
                    {tab.recording ? (
                      <span
                        aria-label="Recording"
                        title="Recording this tab"
                        className="h-[5px] w-[5px] shrink-0 rounded-full bg-rose-400 shadow-[0_0_0_2.5px_rgba(251,113,133,0.18)]"
                      />
                    ) : null}
                    {ownerLabel ? (
                      <Robot
                        size={11}
                        weight="duotone"
                        aria-label={ownerTitle ?? undefined}
                        className="shrink-0 text-cyan-200/70"
                      />
                    ) : null}
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${label}`}
                    className={cn(
                      "relative -mr-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px]",
                      "text-muted-fg/45 opacity-0 transition-colors duration-[120ms] ease-out",
                      "hover:bg-white/[0.1] hover:text-fg/85 group-hover/tab:opacity-100 focus-visible:opacity-100",
                      TOOLBAR_FOCUS,
                    )}
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
          </div>
          {tabStripFades.start ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-0 h-full w-5 bg-gradient-to-r from-[var(--color-bg)] to-transparent"
            />
          ) : null}
          {tabStripFades.end ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute right-8 top-0 h-full w-5 bg-gradient-to-l from-[var(--color-bg)] to-transparent"
            />
          ) : null}
          <button
            type="button"
            disabled={Boolean(busy) || !apiAvailable}
            onClick={handleNewTab}
            className={cn(
              "mr-1.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px]",
              "text-muted-fg/55 transition-colors duration-[120ms] ease-out hover:bg-white/[0.06] hover:text-fg/85",
              "disabled:cursor-not-allowed disabled:opacity-45",
              TOOLBAR_FOCUS,
            )}
            title="New tab"
            aria-label="New tab"
          >
            {busy === "new-tab" ? <SpinnerGap size={11} className="animate-spin" /> : <Plus size={11} />}
          </button>
        </div>

        {pendingApproval ? (
          <div
            role="alert"
            className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-400/25 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-100/90"
          >
            <span className="min-w-0 flex-1">
              {`Agent wants to reach port ${pendingApproval.remotePort} on ${pendingApproval.machineLabel}`}
            </span>
            <button
              type="button"
              onClick={() => pendingApproval.decide("once")}
              className="inline-flex h-5 shrink-0 items-center rounded border border-amber-300/30 bg-amber-500/15 px-1.5 font-medium transition-colors hover:bg-amber-500/25"
            >
              Allow once
            </button>
            <button
              type="button"
              onClick={() => pendingApproval.decide("always")}
              className="inline-flex h-5 shrink-0 items-center rounded border border-amber-300/30 bg-amber-500/15 px-1.5 font-medium transition-colors hover:bg-amber-500/25"
            >
              Always for this lane
            </button>
            <button
              type="button"
              onClick={() => pendingApproval.decide("deny")}
              className="inline-flex h-5 shrink-0 items-center rounded border border-white/[0.12] px-1.5 font-medium text-fg/70 transition-colors hover:bg-white/[0.06]"
            >
              Deny
            </button>
          </div>
        ) : null}

        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-white/[0.08] bg-white/[0.02] px-1.5">
          <div className="inline-flex h-7 shrink-0 items-center overflow-hidden rounded-[7px] border border-white/[0.08] bg-black/25">
            <button
              type="button"
              disabled={Boolean(busy) || !apiAvailable || !canGoBack}
              onClick={handleBack}
              className={cn("inline-flex h-full w-7 items-center justify-center text-fg/65 hover:bg-white/[0.06] hover:text-fg/85 disabled:opacity-35", TOOLBAR_MOTION, TOOLBAR_FOCUS)}
              title="Go back"
              aria-label="Go back"
            >
              {busy === "back" ? <SpinnerGap size={13} className="animate-spin" /> : <ArrowLeft size={13} />}
            </button>
            <button
              type="button"
              disabled={Boolean(busy) || !apiAvailable || !canGoForward}
              onClick={handleForward}
              className={cn("inline-flex h-full w-7 items-center justify-center border-l border-white/[0.06] text-fg/65 hover:bg-white/[0.06] hover:text-fg/85 disabled:opacity-35", TOOLBAR_MOTION, TOOLBAR_FOCUS)}
              title="Go forward"
              aria-label="Go forward"
            >
              {busy === "forward" ? <SpinnerGap size={13} className="animate-spin" /> : <ArrowRight size={13} />}
            </button>
            <button
              type="button"
              disabled={Boolean(busy) || !apiAvailable}
              onClick={loading ? handleStop : handleReload}
              className={cn("inline-flex h-full w-7 items-center justify-center border-l border-white/[0.06] text-fg/65 hover:bg-white/[0.06] hover:text-fg/85 disabled:opacity-35", TOOLBAR_MOTION, TOOLBAR_FOCUS)}
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
            className={cn(
              "flex min-w-[160px] flex-1 items-center gap-1.5 bg-black/25 pl-2",
              TOOLBAR_CONTROL,
              "border-white/[0.08] focus-within:border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]",
            )}
          >
            {lockKind === "none" ? null : lockKind === "secure" ? (
              <LockSimple
                size={11}
                weight="fill"
                aria-label="Secure connection"
                className="shrink-0 text-emerald-300/70"
              />
            ) : (
              <LockSimpleOpen
                size={11}
                aria-label="Not a secure connection"
                className="shrink-0 text-amber-300/70"
              />
            )}
            {activeTabTunnel ? (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-[4px] border border-sky-400/25 bg-sky-500/12 px-1 text-[9.5px] font-medium text-sky-100/85"
                title={`Tunneled to port ${activeTabTunnel.tunnel.remotePort} on ${activeTabTunnel.tunnel.machineLabel}`}
              >
                {activeTabTunnel.tunnel.machineLabel}
              </span>
            ) : null}
            <input
              ref={urlInputRef}
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              onFocus={handleUrlFocus}
              onKeyDown={handleUrlKeyDown}
              onBlur={() => {
                setEditingUrl(false);
                if (!urlInput.trim()) setUrlInput(currentUrl);
              }}
              placeholder="Enter URL or search"
              aria-label="ADE browser URL"
              className="h-full min-w-0 flex-1 bg-transparent text-[11px] text-fg/85 outline-none placeholder:text-muted-fg/40"
            />
            <button
              type="submit"
              disabled={Boolean(busy) || !apiAvailable || !urlInput.trim()}
              className={cn(
                "inline-flex h-full shrink-0 items-center justify-center gap-1 rounded-r-[6px] border-l border-white/[0.06] px-1.5 text-[10px] font-medium text-fg/75 hover:bg-white/[0.06]",
                TOOLBAR_MOTION,
                TOOLBAR_FOCUS,
              )}
              title="Open URL"
              aria-label="Open URL"
            >
              {busy === "navigate" ? <SpinnerGap size={12} className="animate-spin" /> : <Play size={12} weight="fill" />}
              Open
            </button>
          </form>

          {recording ? (
            <button
              type="button"
              onClick={handleStopRecording}
              disabled={busy === "recording"}
              title="Stop recording"
              aria-label={`Stop recording · ${recordingPillLabel(recording, recordingClock) ?? ""}`}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 px-2 font-mono text-[10px] font-medium",
                TOOLBAR_CONTROL,
                "border-rose-400/30 bg-rose-500/14 text-rose-100/90 hover:bg-rose-500/22",
                TOOLBAR_MOTION,
                TOOLBAR_FOCUS,
              )}
            >
              <span
                aria-hidden="true"
                className="h-[6px] w-[6px] rounded-full bg-rose-400 [animation:ade-status-pulse_1.6s_steps(1)_infinite] motion-reduce:animate-none"
              />
              {`REC ${recordingPillLabel(recording, recordingClock) ?? ""}`}
            </button>
          ) : null}

          <DropdownMenu.Root open={deviceMenuOpen} onOpenChange={setDeviceMenuOpen}>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                disabled={!apiAvailable}
                title="Browser device preset"
                aria-label={`Browser device preset — ${emulationButtonLabel(emulation)}`}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 px-2 font-medium",
                  TOOLBAR_CONTROL,
                  emulation ? TOOLBAR_ON : TOOLBAR_IDLE,
                  TOOLBAR_MOTION,
                  TOOLBAR_FOCUS,
                )}
              >
                {emulation?.mobile ? <DeviceMobile size={12} /> : <Monitor size={12} />}
                <span className="max-w-[104px] truncate">{emulationButtonLabel(emulation)}</span>
                <CaretDown size={9} className="shrink-0 opacity-60" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={6} className={MENU_CONTENT_CLASS}>
                <DropdownMenu.Label className={MENU_LABEL_CLASS}>Device</DropdownMenu.Label>
                {deviceMenuPresets().map((preset) => (
                  <DropdownMenu.Item
                    key={preset.id}
                    className={MENU_ITEM_CLASS}
                    onSelect={() => handlePickPreset(preset)}
                  >
                    <span className="min-w-0 flex-1 truncate">{preset.label}</span>
                    <span className="shrink-0 font-mono text-[9.5px] text-muted-fg/70">
                      {emulationSizeLabel(preset)}
                    </span>
                  </DropdownMenu.Item>
                ))}
                {simulatorPreset ? (
                  <>
                    <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
                    <DropdownMenu.Item
                      className={MENU_ITEM_CLASS}
                      onSelect={() => handlePickPreset(simulatorPreset)}
                    >
                      <span className="min-w-0 flex-1 truncate">{`Booted simulator: ${bootedSimulatorName}`}</span>
                      <span className="shrink-0 font-mono text-[9.5px] text-muted-fg/70">
                        {emulationSizeLabel(simulatorPreset)}
                      </span>
                    </DropdownMenu.Item>
                  </>
                ) : null}
                <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
                <DropdownMenu.Label className={MENU_LABEL_CLASS}>Responsive</DropdownMenu.Label>
                <div
                  className="flex items-center gap-1.5 px-2 pb-1.5"
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <input
                    value={responsiveWidth}
                    onChange={(event) => setResponsiveWidth(event.target.value)}
                    inputMode="numeric"
                    aria-label="Responsive width"
                    className="h-6 w-[58px] rounded-[5px] border border-white/[0.08] bg-black/25 px-1.5 text-center font-mono text-[10.5px] text-fg/85 outline-none focus:border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]"
                  />
                  <span aria-hidden="true" className="text-[10px] text-muted-fg/60">×</span>
                  <input
                    value={responsiveHeight}
                    onChange={(event) => setResponsiveHeight(event.target.value)}
                    inputMode="numeric"
                    aria-label="Responsive height"
                    className="h-6 w-[58px] rounded-[5px] border border-white/[0.08] bg-black/25 px-1.5 text-center font-mono text-[10.5px] text-fg/85 outline-none focus:border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]"
                  />
                  <button
                    type="button"
                    onClick={handleApplyResponsive}
                    className="ade-shell-control ml-auto inline-flex h-6 items-center px-2 text-[10px] font-medium"
                  >
                    Apply
                  </button>
                </div>
                <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
                <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={handleEmulationOff}>
                  <span className="min-w-0 flex-1 truncate">Off</span>
                  {emulation ? null : <span className="shrink-0 text-[9.5px] text-muted-fg/70">Current</span>}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>

          <button
            type="button"
            disabled={Boolean(busy) || !apiAvailable}
            onClick={handleCameraClick}
            className={cn(
              "inline-flex w-7 shrink-0 items-center justify-center",
              TOOLBAR_CONTROL,
              captureBase || recording ? TOOLBAR_ON : TOOLBAR_IDLE,
              TOOLBAR_MOTION,
              TOOLBAR_FOCUS,
            )}
            title="Screenshot · Shift-click to record"
            aria-label={captureBase ? "Cancel screenshot" : "Screenshot · Shift-click to record"}
          >
            {busy === "screenshot" || busy === "recording" ? (
              <SpinnerGap size={13} className="animate-spin" />
            ) : captureBase ? (
              <ImageSquare size={13} />
            ) : (
              <Camera size={13} />
            )}
          </button>

          <button
            type="button"
            disabled={Boolean(busy) || !apiAvailable}
            onClick={handleInspectToggle}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 px-2 font-medium",
              TOOLBAR_CONTROL,
              inspecting ? TOOLBAR_ON : TOOLBAR_IDLE,
              TOOLBAR_MOTION,
              TOOLBAR_FOCUS,
            )}
            title={inspecting ? "Stop selecting elements" : "Select an element in the ADE browser"}
          >
            {busy === "inspect-on" || busy === "inspect-off" ? <SpinnerGap size={12} className="animate-spin" /> : <CursorClick size={12} />}
            {inspecting ? "Inspecting" : "Inspect"}
          </button>

          {selectedItem ? (
            <button
              type="button"
              disabled={Boolean(busy) || !apiAvailable || !onAddContext}
              onClick={handleAttachSelection}
              className={cn(
                "inline-flex shrink-0 items-center gap-1 px-2 font-medium",
                TOOLBAR_CONTROL,
                TOOLBAR_IDLE,
                TOOLBAR_MOTION,
                TOOLBAR_FOCUS,
              )}
              title="Insert the selected browser element as context"
            >
              {busy === "select" ? <SpinnerGap size={12} className="animate-spin" /> : <Selection size={12} />}
              Attach
            </button>
          ) : null}

          <DropdownMenu.Root open={overflowOpen} onOpenChange={setOverflowOpen}>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                disabled={!apiAvailable}
                title="More browser options"
                aria-label="More browser options"
                className={cn(
                  "inline-flex w-7 shrink-0 items-center justify-center",
                  TOOLBAR_CONTROL,
                  TOOLBAR_IDLE,
                  TOOLBAR_MOTION,
                  TOOLBAR_FOCUS,
                )}
              >
                <DotsThreeVertical size={14} weight="bold" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={6} className={MENU_CONTENT_CLASS}>
                <DropdownMenu.Label className={MENU_LABEL_CLASS}>Zoom</DropdownMenu.Label>
                <div className="flex items-center gap-1 px-2 pb-1.5">
                  <button
                    type="button"
                    onClick={() => handleZoomStep(-1)}
                    aria-label="Zoom out"
                    className="ade-shell-control inline-flex h-6 w-6 items-center justify-center text-[12px] font-medium"
                  >
                    −
                  </button>
                  <span className="min-w-[46px] text-center font-mono text-[10.5px] text-fg/80">
                    {zoomPercentLabel(zoomFactor)}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleZoomStep(1)}
                    aria-label="Zoom in"
                    className="ade-shell-control inline-flex h-6 w-6 items-center justify-center text-[12px] font-medium"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    onClick={handleZoomReset}
                    className="ade-shell-control ml-auto inline-flex h-6 items-center px-2 text-[10px] font-medium"
                    data-variant="ghost"
                  >
                    Reset
                  </button>
                </div>

                <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
                <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => openFind()}>
                  <MagnifyingGlass size={12} className="shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate">Find on page</span>
                  <span className="shrink-0 font-mono text-[9.5px] text-muted-fg/70">⌘F</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={handleToggleDevTools}>
                  <Bug size={12} className="shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate">DevTools</span>
                  <span className="shrink-0 text-[9.5px] text-muted-fg/70">{devToolsOpen ? "On" : "Off"}</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={handleToggleNetworkLogging}>
                  <Pulse size={12} className="shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate">Network log</span>
                  <span className="shrink-0 text-[9.5px] text-muted-fg/70">{networkLogging ? "On" : "Off"}</span>
                </DropdownMenu.Item>
                {networkLogging ? (
                  <DropdownMenu.Item className={cn(MENU_ITEM_CLASS, "pl-7")} onSelect={handleExportHar}>
                    <span className="min-w-0 flex-1 truncate">Export HAR</span>
                  </DropdownMenu.Item>
                ) : null}

                <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
                <DropdownMenu.Label className={MENU_LABEL_CLASS}>Recording</DropdownMenu.Label>
                <DropdownMenu.RadioGroup
                  value={String(recordingFps)}
                  onValueChange={(value) => setRecordingFps(normalizeRecordingFps(Number(value)))}
                >
                  {BUILT_IN_BROWSER_RECORDING_FRAME_RATES.map((fps) => (
                    <DropdownMenu.RadioItem
                      key={fps}
                      value={String(fps)}
                      className={MENU_ITEM_CLASS}
                      onSelect={(event) => event.preventDefault()}
                    >
                      <span className="min-w-0 flex-1 truncate">{`${fps} fps`}</span>
                      {recordingFps === fps ? (
                        <span className="shrink-0 text-[9.5px] text-[var(--color-accent)]">Selected</span>
                      ) : null}
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>

                <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
                <DropdownMenu.Label className={MENU_LABEL_CLASS}>Links</DropdownMenu.Label>
                <DropdownMenu.RadioGroup
                  value={linkMode}
                  onValueChange={(value) => handleLinkModeChange(value === "external" ? "external" : "in-app")}
                >
                  <DropdownMenu.RadioItem value="in-app" className={MENU_ITEM_CLASS}>
                    <span className="min-w-0 flex-1 truncate">In ADE</span>
                    {linkMode === "in-app" ? (
                      <span className="shrink-0 text-[9.5px] text-[var(--color-accent)]">Selected</span>
                    ) : null}
                  </DropdownMenu.RadioItem>
                  <DropdownMenu.RadioItem value="external" className={MENU_ITEM_CLASS}>
                    <span className="min-w-0 flex-1 truncate">System browser</span>
                    {linkMode === "external" ? (
                      <span className="shrink-0 text-[9.5px] text-[var(--color-accent)]">Selected</span>
                    ) : null}
                  </DropdownMenu.RadioItem>
                </DropdownMenu.RadioGroup>
                <p className="px-2 pb-1.5 pt-0.5 text-[9.5px] leading-[13px] text-muted-fg/70">
                  ⌘-click always opens outside.
                </p>

                <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
                <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={handleToggleProfile}>
                  <ShieldCheck size={12} className="shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate">Profile…</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={() => setImportOpen(true)}>
                  <SignIn size={12} className="shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate">Import logins…</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={MENU_ITEM_CLASS}
                  disabled={!currentUrl}
                  onSelect={handleOpenExternal}
                >
                  <ArrowSquareOut size={12} className="shrink-0 opacity-70" />
                  <span className="min-w-0 flex-1 truncate">Open in system browser</span>
                </DropdownMenu.Item>
                {selectedItem ? (
                  <>
                    <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
                    <DropdownMenu.Label className={MENU_LABEL_CLASS}>Selection</DropdownMenu.Label>
                    {onInsertDraft ? (
                      <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={handleInsertSelectionDraft}>
                        <span className="min-w-0 flex-1 truncate">Insert into the message</span>
                      </DropdownMenu.Item>
                    ) : null}
                    <DropdownMenu.Item className={MENU_ITEM_CLASS} onSelect={handleClearSelection}>
                      <span className="min-w-0 flex-1 truncate">Clear selection</span>
                      {selectionFrame ? (
                        <span className="shrink-0 font-mono text-[9px] text-muted-fg/60">{selectionFrame}</span>
                      ) : null}
                    </DropdownMenu.Item>
                  </>
                ) : null}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>

        <AnimatePresence initial={false}>
          {findOpen ? (
            <motion.div
              key="ade-browser-find"
              initial={reduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={REVEAL_TRANSITION}
              className="shrink-0 overflow-hidden border-b border-white/[0.08] bg-white/[0.015]"
            >
              <form
                role="search"
                aria-label="Find in this page"
                onSubmit={(event) => {
                  event.preventDefault();
                  runFind(findText, { findNext: true, forward: true });
                }}
                className="flex items-center gap-1.5 px-1.5 py-1.5"
              >
                <MagnifyingGlass size={12} className="shrink-0 text-muted-fg/55" />
                <input
                  ref={findInputRef}
                  value={findText}
                  onChange={(event) => {
                    setFindText(event.target.value);
                    runFind(event.target.value);
                  }}
                  placeholder="Find on page"
                  aria-label="Find on page"
                  className="h-6 min-w-0 flex-1 bg-transparent text-[11px] text-fg/85 outline-none placeholder:text-muted-fg/40"
                />
                <span
                  role="status"
                  aria-live="polite"
                  className="shrink-0 font-mono text-[10px] text-muted-fg/75"
                >
                  {findMatchLabel(findState) ?? ""}
                </span>
                <button
                  type="button"
                  onClick={() => runFind(findText, { findNext: true, forward: false })}
                  disabled={!findText.trim()}
                  title="Previous match"
                  aria-label="Previous match"
                  className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-muted-fg/70 hover:bg-white/[0.06] hover:text-fg/85 disabled:opacity-35", TOOLBAR_MOTION, TOOLBAR_FOCUS)}
                >
                  <CaretLeft size={11} />
                </button>
                <button
                  type="button"
                  onClick={() => runFind(findText, { findNext: true, forward: true })}
                  disabled={!findText.trim()}
                  title="Next match"
                  aria-label="Next match"
                  className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-muted-fg/70 hover:bg-white/[0.06] hover:text-fg/85 disabled:opacity-35", TOOLBAR_MOTION, TOOLBAR_FOCUS)}
                >
                  <CaretRight size={11} />
                </button>
                <button
                  type="button"
                  onClick={closeFind}
                  title="Close find bar"
                  aria-label="Close find bar"
                  className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-muted-fg/70 hover:bg-white/[0.06] hover:text-fg/85", TOOLBAR_MOTION, TOOLBAR_FOCUS)}
                >
                  <X size={11} />
                </button>
              </form>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/*
          Login handoff bar. The one place the pane speaks for the agent rather
          than about it: the agent said out loud that it cannot sign in, so this
          asks the person directly and hands the tab straight back when they are
          done. Amber, not red — a handoff is a request, not a failure.
        */}
        <AnimatePresence initial={false}>
          {handoff ? (
            <motion.div
              key="ade-browser-handoff"
              data-testid="browser-handoff-bar"
              initial={reduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={REVEAL_TRANSITION}
              className="shrink-0 overflow-hidden border-b border-amber-300/16 bg-amber-500/[0.075]"
            >
              <div
                role="status"
                aria-live="polite"
                className="flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-amber-100/85"
              >
                {showHandoffHandBackOffer ? (
                  <>
                    <Hand size={12} weight="duotone" className="shrink-0" aria-hidden />
                    <span className="min-w-0 break-words">Signed in?</span>
                    <button
                      type="button"
                      onClick={() => handleHandBack("auto-offer")}
                      disabled={busy === "hand-back"}
                      className="ml-auto shrink-0 rounded border border-amber-300/25 bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-medium text-amber-50/90 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      Hand back now
                    </button>
                    <button
                      type="button"
                      onClick={handleKeepHandoffControl}
                      className="shrink-0 rounded border border-white/[0.08] px-1.5 py-0.5 text-[10px] font-medium text-amber-100/70 hover:bg-white/[0.06]"
                    >
                      Keep control
                    </button>
                  </>
                ) : (
                  <>
                    <Hand size={12} weight="duotone" className="shrink-0" aria-hidden />
                    <span className="min-w-0 break-words">
                      Agent needs you to sign in · &ldquo;{handoff.reason}&rdquo;
                    </span>
                    <button
                      type="button"
                      onClick={() => handleHandBack("human")}
                      disabled={busy === "hand-back"}
                      className="ml-auto shrink-0 rounded border border-amber-300/25 bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-medium text-amber-50/90 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      Hand back
                    </button>
                  </>
                )}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

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

        {profileOpen ? (
          <div className="grid max-h-[190px] shrink-0 grid-cols-[minmax(220px,0.9fr)_minmax(280px,1.1fr)] overflow-hidden border-b border-emerald-300/12 bg-emerald-950/15 text-[10px]">
            <section className="min-w-0 border-r border-white/[0.06] px-2.5 py-2">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-100/90">
                <ShieldCheck size={13} />
                Global authenticated profile
                <button
                  type="button"
                  onClick={() => void refreshProfileSecurity().catch((error: unknown) => {
                    setMessage({ tone: "error", text: errorMessage(error) });
                  })}
                  disabled={profileBusy}
                  className="ml-auto rounded border border-white/[0.08] px-1.5 py-0.5 text-[9px] text-fg/65 hover:bg-white/[0.06] disabled:opacity-40"
                >
                  Refresh
                </button>
              </div>
              {profileDiagnostics ? (
                <div className="mt-1.5 space-y-1 text-muted-fg/70">
                  <div>
                    {profileDiagnostics.cookieCount} cookies · {profileDiagnostics.persistentCookieCount} persistent · {profileDiagnostics.sessionCookieCount} session
                  </div>
                  <div>
                    Cache {profileDiagnostics.cacheSizeBytes == null ? "unavailable" : formatBytes(profileDiagnostics.cacheSizeBytes)} · {profileDiagnostics.persistedPermissionDecisionCount} remembered permissions
                  </div>
                  <div>
                    Last safe flush {profileDiagnostics.lastStorageFlushAt
                      ? new Date(profileDiagnostics.lastStorageFlushAt).toLocaleString()
                      : "not yet recorded this run"}
                  </div>
                  <div className="truncate" title={profileDiagnostics.cookieDomains.join(", ")}>
                    Signed-in domains: {profileDiagnostics.cookieDomains.length > 0
                      ? profileDiagnostics.cookieDomains.slice(0, 8).join(", ")
                      : "none detected"}
                    {profileDiagnostics.cookieDomains.length > 8
                      ? ` +${profileDiagnostics.cookieDomains.length - 8}`
                      : ""}
                  </div>
                </div>
              ) : (
                <div className="mt-2 text-muted-fg/55">Loading profile diagnostics…</div>
              )}
            </section>
            <section className="min-w-0 overflow-y-auto px-2.5 py-2">
              <div className="flex items-center gap-2 text-[11px] font-medium text-fg/82">
                Remembered site permissions
                {permissionDecisions.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => clearRememberedPermission()}
                    disabled={profileBusy}
                    className="ml-auto rounded border border-rose-300/15 px-1.5 py-0.5 text-[9px] text-rose-100/70 hover:bg-rose-500/10 disabled:opacity-40"
                  >
                    Clear all
                  </button>
                ) : null}
              </div>
              {permissionDecisions.length > 0 ? (
                <div className="mt-1.5 space-y-1">
                  {permissionDecisions.map((decision) => (
                    <div
                      key={`${decision.origin}:${decision.embeddingOrigin ?? ""}:${decision.permission}`}
                      className="flex min-w-0 items-center gap-2 rounded border border-white/[0.05] bg-black/15 px-1.5 py-1"
                    >
                      <span className={cn(
                        "rounded px-1 py-0.5 text-[8px] font-semibold uppercase",
                        decision.decision === "allow"
                          ? "bg-emerald-400/10 text-emerald-100/70"
                          : "bg-rose-400/10 text-rose-100/70",
                      )}>
                        {decision.decision}
                      </span>
                      <span className="min-w-0 flex-1 truncate" title={`${decision.origin} · ${decision.permission}`}>
                        {decision.origin} · {decision.permission}
                      </span>
                      <button
                        type="button"
                        onClick={() => clearRememberedPermission(decision)}
                        disabled={profileBusy}
                        className="shrink-0 rounded px-1 py-0.5 text-[9px] text-muted-fg/60 hover:bg-white/[0.06] hover:text-fg/80 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-2 text-muted-fg/55">No remembered allow or block decisions.</div>
              )}
            </section>
          </div>
        ) : null}

        <div
          ref={browserSurfaceRef}
          className="relative flex min-h-[320px] min-w-0 flex-1 flex-col overflow-hidden bg-black/20"
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
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-5 text-center"
            >
              <Globe size={26} weight="duotone" className="text-[var(--color-accent)]/35" />
              <div className="text-[12.5px] font-medium text-fg/80">
                {apiAvailable ? "Open a page" : "ADE browser unavailable"}
              </div>
              {apiAvailable ? (
                <>
                  <div
                    role="group"
                    aria-label="Suggested pages"
                    className="flex flex-wrap items-center justify-center gap-1.5"
                  >
                    {emptyStateSuggestions.map((suggestion) => (
                      <button
                        key={suggestion.label}
                        type="button"
                        onClick={suggestion.onSelect}
                        className={cn(
                          "inline-flex h-6 items-center gap-1.5 rounded-full border border-white/[0.09] bg-card/60 px-2.5",
                          "text-[10.5px] font-medium text-fg/78",
                          "transition-colors duration-[120ms] ease-out hover:border-white/[0.18] hover:bg-card",
                          TOOLBAR_FOCUS,
                        )}
                      >
                        {suggestion.label}
                      </button>
                    ))}
                  </div>
                  <div className="max-w-[340px] text-[10.5px] leading-[15px] text-muted-fg/70">
                    Agents open pages here with <span className="font-mono text-fg/65">ade browser open</span>.
                  </div>
                </>
              ) : (
                <div className="max-w-[340px] text-[11px] leading-5 text-muted-fg/60">
                  This renderer does not expose window.ade.builtInBrowser.
                </div>
              )}
            </motion.div>
          ) : null}
        </div>

      </div>
      <BrowserLoginImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => {
          if (profileOpen) {
            void refreshProfileSecurity().catch(() => {
              // The dialog already reported what landed; a stale panel is not
              // worth a second error.
            });
          }
        }}
      />
    </div>
  );
}
