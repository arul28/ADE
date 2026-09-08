import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import {
  Check,
  WarningCircle,
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
  DevServersArgs,
} from "../../../shared/types/builtInBrowser";
import { BrowserLoginImportDialog } from "./BrowserLoginImportDialog";
import { browserToolbarLayout } from "./builtInBrowserToolbar";
import {
  activeEmulationPresetId,
  deviceMenuPresets,
  emulationDisplayLabel,
  emulationSizeLabel,
  findErrorMessage,
  simulatorEmulationPreset,
  stepZoomFactor,
  type BrowserFindState,
  type BuiltInBrowserRecordingFrameRate,
} from "./browserToolbarLabels";
import {
  browserLetterboxFrame,
  type BrowserViewFrame,
} from "./browserViewGeometry";
import {
  devServerChipLabel,
  mergeDevServer,
  normalizeDevServer,
  normalizeDevServers,
  type BrowserDevServer,
} from "./browserDevServers";
import {
  browserUrlOrigin,
  clipboardUrlCandidate,
  completeBrowserUrl,
  splitBrowserUrlForDisplay,
  urlLockKind,
} from "../../lib/browserUrl";
import { claimAppZoomCommands } from "../../lib/appZoomCommands";
import { getLinkOpenMode, refreshLinkOpenMode, setLinkOpenMode } from "../../lib/openExternal";
import { showToast } from "../app/toast/toastStore";
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
  commitTunnelApproval,
  reconcileTabTunnels,
  setTabTunnel,
  tunnelApprovalDecision,
  tunnelAwareUrl,
  type TabTunnelMap,
  type TunnelApprovalAnswer,
  type TunnelApprovalState,
} from "./browserRemoteTunnels";
import { cn } from "../ui/cn";
import {
  useNativeBrowserViewBounds,
  type BrowserBounds,
} from "./browser/useNativeBrowserViewBounds";
import { BrowserFindBar } from "./browser/BrowserFindBar";
import { BrowserHandoffBar } from "./browser/BrowserHandoffBar";
import { BrowserOverflowMenu } from "./browser/BrowserOverflowMenu";
import { BrowserProfilePanel } from "./browser/BrowserProfilePanel";
import { BrowserStage } from "./browser/BrowserStage";
import { BrowserTabStrip } from "./browser/BrowserTabStrip";
import { BrowserToolbarRow } from "./browser/BrowserToolbarRow";
import { MENU_ITEM_CLASS, MENU_LABEL_CLASS, MENU_SEPARATOR_CLASS } from "./browser/browserChrome";
import type {
  BrowserCaptureSelection,
  BrowserFrame,
  BrowserTab,
  BuiltInBrowserContextItem,
  BuiltInBrowserScreenshot,
  CaptureMediaBounds,
} from "./browser/browserPanelTypes";

type BuiltInBrowserStatus = {
  supported: boolean;
  partition?: string | null;
  visible: boolean;
  activeTabId: string | null;
  tabs: BrowserTab[];
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
  /** Added by the browser service; absent on an older main process. */
  /**
   * Dev-server discovery reads THIS machine's PTY output, so it takes no pin —
   * a lane is the only scope it has.
   */
  getDevServers?: (args?: DevServersArgs) => Promise<unknown>;
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

type BrowserCrop = {
  dataUrl: string;
  width: number;
  height: number;
  frame: BrowserFrame;
};

/** Live find, without a request per keystroke. */
const FIND_DEBOUNCE_MS = 150;
/*
  Why the tabs are not renderer <webview> nodes.

  A renderer-owned <webview> loses its backing webContents when the panel
  unmounts, and this panel unmounts every time the Work sidebar shows a
  different tool. Tabs are owned by the main browser service instead, and this
  panel positions that service's WebContentsView over its own bounds — which is
  what lets a tab survive a tool switch, a second window, and a chat that moves
  between panes.
*/

/** How long the load bar takes to snap shut once the page finishes. */
export const PROGRESS_FINISH_MS = 360;
/** After a page settles, wait this long before taking the warm underlay frame. */
const UNDERLAY_SETTLE_SNAPSHOT_MS = 600;

/** Ports worth a one-shot probe for the empty state's "your dev server" chip. */
const DEV_SERVER_PROBE_PORTS = [3000, 5173, 4321, 8080, 8000] as const;

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
  // Anything that is not already a URL becomes a search: an omnibox that
  // silently does nothing with typed words is worse than one that guesses.
  return { ok: true, url: completeBrowserUrl(trimmed, { fallback: "search", scheme: "http" }) ?? trimmed };
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

function normalizeTab(value: unknown): BrowserTab | null {
  if (!isRecord(value)) return null;
  const id = stringField(value.id);
  if (!id) return null;
  return {
    id,
    faviconUrl: stringField(value.faviconUrl),
    isLaunchpad: booleanField(value.isLaunchpad, false),
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
  const rawTabs = Array.isArray(value.tabs) ? value.tabs.map(normalizeTab).filter((tab): tab is BrowserTab => Boolean(tab)) : previous?.tabs ?? [];
  // Only when the payload actually says "zero tabs": a partial update that
  // omits `tabs` entirely is silence, not a claim that they all closed.
  if (Array.isArray(value.tabs) && rawTabs.length === 0) {
    // No tabs is a real state, not a gap in the payload: carrying the closed
    // tab's URL forward left a green padlock and a live-looking omnibox over a
    // browser that has nothing open.
    return {
      ...value,
      supported: booleanField(value.supported, previous?.supported ?? true),
      visible: booleanField(value.visible, previous?.visible ?? false),
      activeTabId: null,
      tabs: [],
      url: null,
      title: null,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      inspecting: false,
      selectedItem: null,
      lastError: stringField(value.lastError) ?? stringField(value.error) ?? previous?.lastError ?? null,
    };
  }
  const activeTabId = stringField(value.activeTabId) ?? previous?.activeTabId ?? rawTabs[0]?.id ?? null;
  const activeTab = rawTabs.find((tab) => tab.id === activeTabId) ?? rawTabs[0] ?? null;
  return {
    ...value,
    supported: booleanField(value.supported, previous?.supported ?? true),
    visible: booleanField(value.visible, previous?.visible ?? false),
    activeTabId,
    tabs: rawTabs,
    /*
      The active tab's own URL, never the last one we happened to see.

      A new tab has no URL, and falling through to `previous` handed the empty
      launchpad the address of the tab before it — which then wore a green
      padlock over a field with nothing in it. `previous` is only a fallback for
      not knowing which tab is active at all.
    */
    url: stringField(value.url) ?? (activeTab ? activeTab.url : previous?.url ?? null),
    title: stringField(value.title) ?? (activeTab ? activeTab.title : previous?.title ?? null),
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

function frameLabel(frame: BrowserFrame | null): string | null {
  if (!frame) return null;
  return `${Math.round(frame.x)}, ${Math.round(frame.y)} · ${Math.round(frame.width)}×${Math.round(frame.height)}`;
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
export function ChatBuiltInBrowserPanel({
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
  // Every pin-aware `builtInBrowser.*` call below reads this.
  const runtimePinRef = useRef<OpenProjectBinding | null>(runtimePin);
  runtimePinRef.current = runtimePin;
  const browserSurfaceRef = useRef<HTMLDivElement | null>(null);
  /** The stage the letterboxed view is centred in (surface minus the caption). */
  const browserStageRef = useRef<HTMLDivElement | null>(null);
  /** The DOM frame the native view is positioned onto, letterbox included. */
  const browserViewportRef = useRef<HTMLDivElement | null>(null);
  const captureImageRef = useRef<HTMLImageElement | null>(null);
  const statusRef = useRef<BuiltInBrowserStatus | null>(null);
  const selectedItemRef = useRef<BuiltInBrowserContextItem | null>(null);
  const captureModeRef = useRef(false);
  /** True while the launchpad owns the surface, so no view paints over it. */
  const launchpadVisibleRef = useRef(false);
  /*
    Suppression is ref-only on purpose.

    Its one React reader was the <webview> layout effect, which was dead and is
    now deleted — every remaining reader (`reportBounds`, the underlay, the
    occlusion observer) runs outside the render closure. Mirroring it into state
    re-rendered the whole panel on every menu open for nobody's benefit.
  */
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
  const [, setLastScreenshot] = useState<BuiltInBrowserScreenshot | null>(null);
  const [captureBase, setCaptureBase] = useState<BuiltInBrowserScreenshot | null>(null);
  const [captureSelection, setCaptureSelection] = useState<BrowserCaptureSelection | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileDiagnostics, setProfileDiagnostics] = useState<BuiltInBrowserProfileDiagnostics | null>(null);
  const [permissionDecisions, setPermissionDecisions] = useState<BuiltInBrowserPermissionDecision[]>([]);
  const reduceMotion = useReducedMotion() ?? false;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  /** The row whose measured width decides what the toolbar can afford. */
  const toolbarRowRef = useRef<HTMLDivElement | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [findState, setFindState] = useState<BrowserFindState | null>(null);
  const [findError, setFindError] = useState<string | null>(null);
  const findDebounceRef = useRef<number | null>(null);
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
  const [devServers, setDevServers] = useState<BrowserDevServer[]>([]);
  /** The service answered, and had nothing — so the port probe still runs. */
  const [discoveryEmpty, setDiscoveryEmpty] = useState(false);
  const [clipboardUrl, setClipboardUrl] = useState<string | null>(null);
  const [failedFavicons, setFailedFavicons] = useState<Record<string, true>>({});
  const [tabStripFades, setTabStripFades] = useState<{ start: boolean; end: boolean }>({ start: false, end: false });
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  const [progressPhase, setProgressPhase] = useState<"idle" | "loading" | "finishing">("idle");
  const progressPhaseRef = useRef<"idle" | "loading" | "finishing">("idle");
  const [viewFrame, setViewFrame] = useState<BrowserViewFrame>({ left: 1, top: 1, width: 0, height: 0, scale: 1 });
  /** Read by `reportBounds`, which runs outside this render's closure. */
  const viewScaleRef = useRef(1);
  // Which tabs are looking at the pinned machine, and through which forward.
  const [tabTunnels, setTabTunnels] = useState<TabTunnelMap>({});
  const tabTunnelsRef = useRef<TabTunnelMap>(tabTunnels);
  tabTunnelsRef.current = tabTunnels;
  const [pendingApproval, setPendingApproval] = useState<PendingTunnelApproval | null>(null);
  // Approvals answered "Allow once" live only as long as this pane does; the
  // "Always" set is persisted per lane alongside the rest of its view state.
  const sessionApprovedTunnelsRef = useRef<ReadonlySet<string>>(new Set<string>());
  const remotePin = runtimePin?.kind === "remote" ? runtimePin : null;
  const browserScope = useMemo<BuiltInBrowserProjectScopeArgs>(
    () => (projectRootOverride === null
      ? { tabCollection: "personal" }
      : projectRoot
        ? { projectRoot }
        : {}),
    [projectRoot, projectRootOverride],
  );
  const browserScopeRef = useRef<BuiltInBrowserProjectScopeArgs>(browserScope);
  browserScopeRef.current = browserScope;
  const withBrowserScope = useCallback(<T extends Record<string, unknown>>(args: T): T & BuiltInBrowserProjectScopeArgs => (
    ({ ...args, ...browserScope }) as T & BuiltInBrowserProjectScopeArgs
  ), [browserScope]);
  const remotePinRef = useRef<Extract<OpenProjectBinding, { kind: "remote" }> | null>(remotePin);
  remotePinRef.current = remotePin;

  /** Mirrors `pendingApproval` so the bar can be replaced without a nested setState. */
  const pendingApprovalRef = useRef<PendingTunnelApproval | null>(null);

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
   * Record an answer. The rule for what each answer changes lives in
   * `browserRemoteTunnels`, tested without a DOM; this only moves the result
   * into the ref and the persisted list.
   */
  const applyTunnelAnswer = useCallback((key: string, answer: TunnelApprovalAnswer) => {
    const before: TunnelApprovalState = {
      sessionApproved: sessionApprovedTunnelsRef.current,
      alwaysKeys: readAlwaysTunnelKeys(),
    };
    const after = commitTunnelApproval(before, key, answer);
    sessionApprovedTunnelsRef.current = after.sessionApproved;
    if (after.alwaysKeys !== before.alwaysKeys) rememberAlwaysTunnelKey(key);
  }, [readAlwaysTunnelKeys, rememberAlwaysTunnelKey]);

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
    options: { human: boolean; onAsk?: () => void },
  ): Promise<boolean> => {
    const pin = remotePinRef.current;
    if (!pin) return true;
    const key = remoteTunnelApprovalKey(pin.targetId, remotePort);
    const decision = tunnelApprovalDecision({
      key,
      human: options.human,
      sessionApproved: sessionApprovedTunnelsRef.current,
      alwaysKeys: readAlwaysTunnelKeys(),
    });
    if (decision === "allow") {
      // A human-typed URL self-approves, and the port stays approved for the
      // rest of this pane's life rather than re-asking on the next hop.
      if (options.human) applyTunnelAnswer(key, "once");
      return true;
    }
    options.onAsk?.();
    return await new Promise<boolean>((resolve) => {
      /*
        Replace the open bar OUTSIDE the state updater.

        `setPendingApproval(previous => { previous?.decide("deny"); ... })` ran a
        nested `setPendingApproval(null)` from inside an updater React is free to
        invoke eagerly and again during render — which could apply the nested
        null AFTER this updater's return value and leave `pendingApproval` null
        with a promise nobody would ever resolve. A ref makes the replacement an
        ordinary statement.
      */
      const previous = pendingApprovalRef.current;
      previous?.decide("deny");
      const next: PendingTunnelApproval = {
        key,
        remotePort,
        machineLabel,
        decide: (answer) => {
          if (pendingApprovalRef.current === next) {
            pendingApprovalRef.current = null;
            setPendingApproval(null);
          }
          applyTunnelAnswer(key, answer);
          resolve(answer !== "deny");
        },
      };
      pendingApprovalRef.current = next;
      setPendingApproval(next);
    });
  }, [applyTunnelAnswer, readAlwaysTunnelKeys]);

  /*
    An unanswered bar must not outlive the pane.

    The Work sidebar unmounts this panel whenever another tool is shown, and an
    approval promise left hanging would keep the remote request's async chain
    alive forever. Unmount is a refusal, not an approval.
  */
  useEffect(() => () => {
    const pending = pendingApprovalRef.current;
    pendingApprovalRef.current = null;
    pending?.decide("deny");
  }, []);

  /**
   * Everything a loopback URL needs before it can load on a remote pin: the
   * human grant, then the forward itself. Returns the tunnel so the caller can
   * remember which tab is showing another machine. A non-loopback URL, or a
   * local pin, is a no-op.
   */
  const prepareRemoteNavigation = useCallback(async (
    url: string,
    options: { human: boolean; onAsk?: () => void },
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

  const browserTabs = useMemo(() => status?.tabs ?? [], [status?.tabs]);
  const tabIdsSignature = useMemo(() => browserTabs.map((tab) => tab.id).join("|"), [browserTabs]);
  const activeTabId = status?.activeTabId ?? browserTabs[0]?.id ?? null;
  const activeTabTunnel = activeTabId ? tabTunnels[activeTabId] ?? null : null;
  // What the human asked for, not the ephemeral forward port behind it.
  const currentUrl = tunnelAwareUrl(status?.url ?? "", activeTabTunnel);
  const canGoBack = Boolean(status?.canGoBack);
  const canGoForward = Boolean(status?.canGoForward);
  const inspecting = Boolean(status?.inspecting);
  /** Nothing open: the chrome has to stop describing a page that is gone. */
  const hasTab = browserTabs.length > 0;
  /** Read by the zoom claim, which runs outside this render's closure. */
  const hasTabRef = useRef(hasTab);
  hasTabRef.current = hasTab;
  const selectionFrame = frameLabel(selectedItem?.frame ?? null);
  const activeTab = useMemo(
    () => browserTabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, browserTabs],
  );
  /**
   * Loading, from whichever half of the payload knows.
   *
   * `status.loading` is only set by main processes that send a top-level flag;
   * the per-tab `isLoading` is what `did-start-loading` actually updates, and
   * reading only the first left the progress bar dead on every real navigation
   * while the tab pill's own spinner span.
   */
  const loading = Boolean(status?.loading || activeTab?.isLoading);
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
  // A padlock over an empty omnibox is a claim about a connection that does
  // not exist, so the lock belongs to the tab, not to the last string we saw.
  const lockKind = hasTab ? urlLockKind(currentUrl) : "none";
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

  /**
   * Record which tab is looking at another machine, ref first.
   *
   * `applyStatus` runs from an IPC callback that can land before React has
   * re-rendered, and it reads this map to build the omnibox string — so a map
   * that only existed in state showed the raw `127.0.0.1:<ephemeral>` forward
   * for a cycle after every tunneled navigation, which is the one thing the
   * display rule exists to prevent.
   */
  const rememberTabTunnel = useCallback((
    tabId: string | null,
    tunnel: RemoteLoopbackTunnel | null,
  ) => {
    const next = setTabTunnel(tabTunnelsRef.current, tabId, tunnel);
    if (next === tabTunnelsRef.current) return;
    tabTunnelsRef.current = next;
    setTabTunnels(next);
  }, []);

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
      const reconciled = reconcileTabTunnels(tabTunnelsRef.current, normalized.tabs);
      if (reconciled !== tabTunnelsRef.current) {
        tabTunnelsRef.current = reconciled;
        setTabTunnels(reconciled);
      }
    }
    if (!editingUrlRef.current) {
      // Nothing open means nothing to show: the field goes back to its
      // placeholder rather than holding the address of a tab that is gone.
      if (normalized.tabs.length === 0) {
        setUrlInput("");
        return;
      }
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

  /**
   * Capture the frame the underlay paints, without touching the UI.
   *
   * Kept warm after a page settles so the common case — open a menu on a page
   * that finished loading a moment ago — repaints instantly rather than after
   * an IPC round trip the human would see as a black flash.
   */
  const captureUnderlayFrame = useCallback(async (): Promise<string | null> => {
    const api = getBrowserApi();
    if (!api?.captureScreenshot) return null;
    const result = await api.captureScreenshot(browserScope, runtimePinRef.current);
    const shot = normalizeScreenshot(result, statusRef.current);
    return shot?.dataUrl ?? shot?.screenshotDataUrl ?? null;
  }, [browserScope]);

  const pushBrowserBounds = useCallback(async (bounds: BrowserBounds): Promise<void> => {
    const api = requireBrowserApi();
    await api.setBounds(withBrowserScope(bounds), runtimePinRef.current);
  }, [withBrowserScope]);

  const stopBrowserInspect = useCallback(async (): Promise<void> => {
    const api = requireBrowserApi();
    await api.stopInspect(browserScope, runtimePinRef.current);
  }, [browserScope]);

  const reportBoundsError = useCallback((text: string) => {
    setMessage({ tone: "error", text: `Could not position browser: ${text}` });
  }, []);

  /*
    Bounds, occlusion and the frozen-frame underlay.

    Three ref-driven machines with no JSX of their own: they measure this
    panel's DOM frame, decide when the composited view is allowed to be seen,
    and freeze a frame under every popover that has to hide it.
  */
  const {
    reportBounds,
    hideNativeBrowserView,
    refreshUnderlaySnapshot,
    underlay,
  } = useNativeBrowserViewBounds({
    surfaceRef: browserSurfaceRef,
    stageRef: browserStageRef,
    viewportRef: browserViewportRef,
    panelRef,
    viewScaleRef,
    captureModeRef,
    launchpadVisibleRef,
    enabled: apiAvailable,
    setBounds: pushBrowserBounds,
    stopInspect: stopBrowserInspect,
    captureFrame: captureUnderlayFrame,
    onError: reportBoundsError,
  });

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
        // Counts come from the page itself, so the bar updates on the event
        // rather than waiting for the request that started the search.
        setFindError(null);
        setFindState({
          activeMatchOrdinal: numberField(event.activeMatchOrdinal),
          matches: numberField(event.matches),
        });
      }
      if (eventType === "dev-server-detected") {
        setDevServers((previous) => mergeDevServer(
          previous,
          normalizeDevServer(event.server ?? event.devServer ?? event),
        ));
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
        const acknowledge = async (payload: {
          accepted: boolean;
          awaitingApproval?: boolean;
          reason: string | null;
        }) => {
          await api.acknowledgeRemoteRequest?.(
            { requestId: request.requestId, desktopLabel: THIS_MACHINE_NAME, ...payload },
            pin,
          ).catch(() => {});
        };
        /*
          The requester gives up after 5 seconds, and nobody answers an approval
          bar in 5 seconds. So the moment a bar goes up the desktop says "I took
          this, a person is deciding" — the CLI prints that and exits 0 — and
          the page loads whenever the person gets to it. The real outcome is
          still acked afterwards: by then it usually lands on a requestId nobody
          is waiting on, which the daemon drops, but when the human WAS fast it
          is the answer the CLI gets.
        */
        let awaitingAcked = false;
        try {
          const prepared = await prepareRemoteNavigation(request.url, {
            human: false,
            onAsk: () => {
              awaitingAcked = true;
              void acknowledge({ accepted: true, awaitingApproval: true, reason: null });
            },
          });
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
            // Before the refresh, not after: the refresh applies a status the
            // omnibox is rendered from, and it has to already know this tab is
            // showing the pinned machine.
            if (prepared.tunnel) {
              rememberTabTunnel(statusRef.current?.activeTabId ?? null, prepared.tunnel);
            }
            await refreshStatus();
            accepted = true;
          }
        } catch (error) {
          reason = errorMessage(error);
        }
        if (cancelled) return;
        if (!accepted && reason) setMessage({ tone: "error", text: reason });
        // Nothing new to say when the request needed no prompt and succeeded —
        // that is exactly what the pre-ack already claimed.
        if (!awaitingAcked || !accepted) await acknowledge({ accepted, reason });
      })();
    }, pin);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [prepareRemoteNavigation, refreshStatus, rememberTabTunnel, remotePin, withBrowserScope]);

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

  /*
   * There is deliberately no "open Google when the pane is empty" effect.
   *
   * An empty browser is not a broken browser — it is a browser waiting to be
   * told where to go, and the launchpad below is that question. Loading a
   * search engine nobody asked for also made "close the last tab" mean "open a
   * new one", which is the opposite of what closing a tab means anywhere else.
   */

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
        // The human typed this, so no approval bar — but a loopback URL on a
        // remote pin still has to be tunneled before it means anything here.
        const prepared = await prepareRemoteNavigation(nextUrl, { human: true });
        if (!prepared.ok) {
          setMessage({ tone: "error", text: prepared.reason ?? "Navigation was not allowed." });
          return;
        }
        await api.navigate(withBrowserScope({ url: nextUrl }), runtimePinRef.current);
        setUrlInput(nextUrl);
        // Before the refresh: see `rememberTabTunnel`.
        if (prepared.tunnel) {
          rememberTabTunnel(statusRef.current?.activeTabId ?? null, prepared.tunnel);
        }
        await refreshStatus();
      });
    },
    [prepareRemoteNavigation, refreshStatus, rememberTabTunnel, restoreLiveBrowserView, runBusy, withBrowserScope],
  );

  const handleNavigate = useCallback(
    (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      navigateToUrl(urlInput);
    },
    [navigateToUrl, urlInput],
  );

  /** Launchpad chips: fill the URL field so the bar reflects what loaded. */
  const handleSuggestion = useCallback((url: string) => {
    setUrlInput(url);
    navigateToUrl(url);
  }, [navigateToUrl]);

  /**
   * `+` opens an empty tab, not a page.
   *
   * A new tab is a question ("where to?"), so it lands on the launchpad with
   * the URL field focused rather than on somebody's search engine.
   */
  const handleNewTab = useCallback(() => {
    void runBusy("new-tab", async () => {
      if (captureModeRef.current) restoreLiveBrowserView();
      const api = requireBrowserApi();
      if (!api.createTab) throw new Error("This ADE build does not support browser tabs.");
      const nextStatus = await api.createTab(withBrowserScope({ activate: true }), runtimePinRef.current);
      applyStatus(nextStatus);
      setUrlInput("");
    });
  }, [applyStatus, restoreLiveBrowserView, runBusy, withBrowserScope]);

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
      // Deliberately un-pinned. The handed-off tab is THIS Electron process's
      // own WebContentsView; the daemon round trip cannot reach it, and the
      // bridge refuses a user client for having no chat capability. Preload
      // routes this one call straight to local IPC.
      await api.endHandoff(withBrowserScope({ endedBy }));
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
      const result = await api.captureScreenshot(browserScope, runtimePinRef.current);
      const screenshot = normalizeScreenshot(result, statusRef.current);
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
  }, [browserScope, hideNativeBrowserView, onAddContext, restoreLiveBrowserView, runBusy]);

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

  /**
   * Hand the OS the URL that is really loaded, not the one on display.
   *
   * On a tunneled tab those differ: the omnibox shows the remote origin the
   * human asked for (`http://localhost:3000` on machine B) while the page is
   * actually the local forward. Handing the display URL to this machine's
   * opener loads THIS box's port 3000 — a different project's dev server, or an
   * admin console — under the belief that it is the same page.
   */
  const handleOpenExternal = useCallback(() => {
    const url = (statusRef.current?.url ?? currentUrl).trim();
    if (!url) return;
    void window.ade.app.openExternal(url).catch((error: unknown) => {
      setMessage({ tone: "error", text: `Could not open URL externally: ${errorMessage(error)}` });
    });
  }, [currentUrl]);

  /* ── Device emulation ───────────────────────────────────────────────────── */

  const applyEmulation = useCallback((
    request: {
      preset?: string | null;
      width?: number | null;
      height?: number | null;
      mobile?: boolean | null;
      deviceScaleFactor?: number | null;
    },
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

  /**
   * Portrait ↔ landscape: the same device, turned over.
   *
   * The preset id rides along with the swapped size so the service keeps the
   * device's DPR, touch and mobile user agent — rotating used to fall back to
   * the desktop "responsive" base, which quietly turned an iPhone into a
   * 852-wide desktop and served the wrong breakpoint.
   */
  const handleRotateEmulation = useCallback(() => {
    const current = statusRef.current?.tabs.find((tab) => tab.id === statusRef.current?.activeTabId)?.emulation;
    if (!current?.width || !current.height) return;
    const rotated = { width: current.height, height: current.width };
    const presetId = activeEmulationPresetId(current);
    applyEmulation(
      {
        ...rotated,
        preset: presetId === "responsive" || presetId === "desktop" ? null : presetId,
        mobile: current.mobile,
        deviceScaleFactor: current.deviceScaleFactor || null,
      },
      emulationDisplayLabel({ ...current, ...rotated, presetId: "responsive" }),
    );
  }, [applyEmulation]);

  /** One value for the whole device menu, so exactly one row is ever checked. */
  const activePresetId = useMemo(() => activeEmulationPresetId(emulation), [emulation]);

  const handleDeviceMenuValue = useCallback((value: string) => {
    if (value === "desktop") {
      handleEmulationOff();
      return;
    }
    const preset = deviceMenuPresets().find((candidate) => candidate.id === value);
    if (preset) handlePickPreset(preset);
  }, [handleEmulationOff, handlePickPreset]);

  const handleApplyResponsive = useCallback(() => {
    const width = Number.parseInt(responsiveWidth, 10);
    const height = Number.parseInt(responsiveHeight, 10);
    // `> 0`, not just finite: `0 × 768` used to banner "Browser is emulating
    // 0×768" while the device pill showed the size main had clamped it to.
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
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
      setFindError("Find is not available on this page.");
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
        setFindError(null);
        setFindState({
          activeMatchOrdinal: result.activeMatchOrdinal ?? null,
          matches: result.matches ?? null,
        });
      })
      .catch((error: unknown) => {
        // A find failure is a fact about this page, not an incident: it belongs
        // in the bar as a sentence, never as a raw IPC error in the banner.
        setFindError(findErrorMessage(error));
        setFindState(null);
      });
  }, [withBrowserScope]);

  /** Typing searches as you type; 150ms is about half a word of typing. */
  const queueFind = useCallback((text: string) => {
    if (findDebounceRef.current != null) window.clearTimeout(findDebounceRef.current);
    if (!text.trim()) {
      findDebounceRef.current = null;
      setFindState(null);
      setFindError(null);
      return;
    }
    findDebounceRef.current = window.setTimeout(() => {
      findDebounceRef.current = null;
      runFind(text);
    }, FIND_DEBOUNCE_MS);
  }, [runFind]);

  /** Enter / Shift-Enter jump immediately — no one waits out a debounce. */
  const findStep = useCallback((text: string, forward: boolean) => {
    if (findDebounceRef.current != null) {
      window.clearTimeout(findDebounceRef.current);
      findDebounceRef.current = null;
    }
    runFind(text, { findNext: true, forward });
  }, [runFind]);

  useEffect(() => () => {
    if (findDebounceRef.current != null) window.clearTimeout(findDebounceRef.current);
  }, []);

  const closeFind = useCallback(() => {
    if (findDebounceRef.current != null) {
      window.clearTimeout(findDebounceRef.current);
      findDebounceRef.current = null;
    }
    setFindOpen(false);
    setFindState(null);
    setFindError(null);
    // Hand the keyboard back to the page: the bar is gone, so a caret still
    // sitting in a removed input would swallow the next keystroke.
    findInputRef.current?.blur();
    const api = getBrowserApi();
    if (!api?.stopFindInPage) return;
    void api.stopFindInPage(withBrowserScope({ action: "clearSelection" as const }), runtimePinRef.current)
      .catch(() => {
        // Nothing to clear is not worth a banner — the bar is already gone.
      });
  }, [withBrowserScope]);

  /**
   * ⌘F on an open bar re-focuses and selects, the way every other find bar
   * behaves: the second press is "search for something else", not a no-op.
   */
  const findFocusFrameRef = useRef<number | null>(null);
  const openFind = useCallback(() => {
    setFindOpen(true);
    const focusInput = () => {
      findFocusFrameRef.current = null;
      const input = findInputRef.current;
      if (!input) return;
      input.focus();
      if (input.value) input.select();
    };
    if (findInputRef.current) focusInput();
    // The bar animates in, so a first open focuses on the next frame rather
    // than into a zero-height container.
    if (findFocusFrameRef.current != null) window.cancelAnimationFrame(findFocusFrameRef.current);
    findFocusFrameRef.current = window.requestAnimationFrame(focusInput);
  }, []);

  /*
    Match counts belong to one page.

    Nothing cleared them on a navigation or a tab switch, so the bar went on
    claiming "3 of 12" over a page with no matches at all — and a switch away
    from the Browser tool unmounted the panel without ever ending the find
    session, leaving Chromium's highlight burnt into the tab.
  */
  useEffect(() => {
    setFindState(null);
    setFindError(null);
  }, [activeTabId, status?.url]);

  useEffect(() => () => {
    if (findFocusFrameRef.current != null) window.cancelAnimationFrame(findFocusFrameRef.current);
    const api = getBrowserApi();
    void api?.stopFindInPage?.(
      { ...browserScopeRef.current, action: "clearSelection" as const },
      runtimePinRef.current,
    ).catch(() => {
      // The tab may already be gone; there is nothing left to clear.
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
    }
    /*
      Page zoom is deliberately NOT bound here. CmdOrCtrl +=/−/0 are registered
      as native View-menu accelerators, and Electron consumes an accelerator in
      the browser process before this keydown ever fires — so a binding here
      would pass every jsdom test and do nothing in the packaged app. The menu's
      zoom command is claimed below instead.
    */
  }, [closeFind, findOpen, openFind]);

  /**
   * Take the app's zoom chords while this pane owns the keyboard.
   *
   * "Owns" includes focus being nowhere in the DOM: clicking into the page
   * moves focus to the native view, which is a different WebContents entirely,
   * so `document.activeElement` falls back to the body. Focus sitting in the
   * chat composer, or any other pane, declines and the whole ADE UI zooms as
   * before.
   */
  useEffect(() => {
    if (!apiAvailable) return undefined;
    return claimAppZoomCommands((command) => {
      const panel = panelRef.current;
      if (!panel || !panel.isConnected || !hasTabRef.current) return false;
      /*
        A mounted panel is not necessarily a visible one.

        `ProjectSurface` keeps inactive project tabs mounted behind `inert` +
        `opacity: 0`, and `ProjectRouteContent` keeps the Work page mounted
        after you navigate away from it. Today the `active &&` guard in
        `WorkSidebar` unmounts this panel in both cases — but "focus is nowhere
        in the DOM" is true of a hidden pane too, so relying on that alone would
        make a hidden browser steal the app's zoom the day that guard changes.
      */
      if (panel.closest("[inert]")) return false;
      const active = document.activeElement;
      const ownsKeyboard = active == null || active === document.body || panel.contains(active);
      if (!ownsKeyboard) return false;
      if (command === "in") handleZoomStep(1);
      else if (command === "out") handleZoomStep(-1);
      else handleZoomReset();
      return true;
    });
  }, [apiAvailable, handleZoomReset, handleZoomStep]);

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

  /**
   * The real dev servers, asked for rather than guessed at.
   *
   * The service knows which ports are listening and which command opened them,
   * so the launchpad can say "npm run dev · :5173" instead of offering a
   * hardcoded `localhost:3000` that is usually nothing. An older main process
   * has no such list, so the port probe below stays as the fallback.
   */
  useEffect(() => {
    const api = getBrowserApi();
    if (!api?.getDevServers || remotePin) return undefined;
    let cancelled = false;
    void Promise.resolve(api.getDevServers({ laneId: contextLaneId }))
      .then((value) => {
        if (cancelled) return;
        const discovered = normalizeDevServers(value);
        setDevServers(discovered);
        setDiscoveryEmpty(discovered.length === 0);
      })
      .catch(() => {
        // No detector is not an error; the port probe below covers it.
        if (!cancelled) setDiscoveryEmpty(true);
      });
    return () => {
      cancelled = true;
    };
  }, [contextLaneId, remotePin]);

  /*
    The port probe, as a fallback rather than an alternative.

    `getDevServers` only knows the servers ADE's own PTYs started, so a `npm run
    dev` the human launched in iTerm before opening ADE made the launchpad claim
    there was nothing to open while :5173 was serving. An empty answer is now
    treated the same as no answer at all: probe the usual ports, and label what
    comes back "localhost:5173" — the honest thing to say about a port nobody
    can name a command for.
  */
  useEffect(() => {
    const api = getBrowserApi();
    if (api?.getDevServers && !discoveryEmpty) return undefined;
    if (remotePin) return undefined;
    const probePort = window.ade?.localhost?.probePort;
    if (!probePort) return undefined;
    let cancelled = false;
    void (async () => {
      for (const port of DEV_SERVER_PROBE_PORTS) {
        if (cancelled) return;
        const listening = await probePort(port).catch(() => false);
        if (listening && !cancelled) {
          setDevServers((previous) => mergeDevServer(previous, {
            url: `http://localhost:${port}`,
            port,
            source: null,
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [discoveryEmpty, remotePin]);

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
   * The launchpad's chips.
   *
   * Real dev servers first, because that is the page you almost always wanted,
   * then "Paste a link" — but only when the clipboard actually holds a URL, so
   * the chip never promises something it cannot deliver.
   */
  const launchpadChips = useMemo(() => {
    const chips: Array<{ key: string; label: string; hint: string | null; icon: "server" | "clipboard"; onSelect: () => void }> = [];
    for (const server of devServers) {
      chips.push({
        key: server.url,
        label: devServerChipLabel(server),
        hint: null,
        icon: "server",
        onSelect: () => handleSuggestion(server.url),
      });
    }
    if (clipboardUrl) {
      chips.push({
        key: "clipboard",
        label: "Paste a link",
        hint: splitBrowserUrlForDisplay(clipboardUrl)?.host ?? null,
        icon: "clipboard",
        onSelect: () => handleSuggestion(clipboardUrl),
      });
    }
    return chips;
  }, [clipboardUrl, devServers, handleSuggestion]);

  /* ── Layout ─────────────────────────────────────────────────────────────── */

  /*
    Toolbar density follows the row's own measured width, not a media query and
    not a pair of hardcoded pane widths: this panel is a pane inside a window,
    the window is not what got narrow, and the thresholds that used to decide
    this were wrong by ~80px in the middle of the range — the omnibox collapsed
    to nothing at ~420 while every button stayed.

    Observing the row is safe from feedback: its width comes from the pane, and
    nothing the layout removes can change it.
  */
  useLayoutEffect(() => {
    const element = toolbarRowRef.current ?? panelRef.current;
    if (!element) return undefined;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      setPaneWidth((previous) => (previous != null && Math.abs(previous - width) < 1 ? previous : width));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const deviceLabel = useMemo(() => emulationDisplayLabel(emulation), [emulation]);
  // `recording` and `selectedItem` are fresh objects on every browser event, so
  // depending on them made this memo recompute constantly while looking like it
  // did not. The layout only ever reads them as booleans.
  const isRecording = Boolean(recording);
  const hasSelection = Boolean(selectedItem);
  const toolbar = useMemo(() => browserToolbarLayout(paneWidth, {
    hasSelection,
    recording: isRecording,
    deviceLabel,
    urlFocused: editingUrl,
  }), [deviceLabel, editingUrl, hasSelection, isRecording, paneWidth]);
  const urlDisplay = useMemo(() => splitBrowserUrlForDisplay(currentUrl), [currentUrl]);
  // Only while the field shows exactly what is loaded: mid-edit the person's
  // own text is the truth, and dimming half of it would be a lie.
  const showUrlOverlay = !editingUrl && urlDisplay != null && urlInput === currentUrl;
  const emulationWidth = emulation?.width && emulation.width > 0 ? emulation.width : null;
  const emulationHeight = emulation?.height && emulation.height > 0 ? emulation.height : null;
  const emulationSize = useMemo(
    () => (emulationWidth && emulationHeight ? { width: emulationWidth, height: emulationHeight } : null),
    [emulationHeight, emulationWidth],
  );
  const letterboxed = emulationSize != null;

  // The native view is rectangular, so the DOM frame it is positioned onto is
  // what gives it rounded corners and a hairline — inset by that hairline.
  useLayoutEffect(() => {
    const stage = browserStageRef.current;
    if (!stage) return undefined;
    const measure = () => {
      const rect = stage.getBoundingClientRect();
      const next = browserLetterboxFrame(rect, emulationSize);
      if (viewScaleRef.current !== next.scale) {
        viewScaleRef.current = next.scale;
        // A fit factor that changed mid-drag has to reach main in the same
        // gesture, or the page is drawn at the previous pane's scale.
        reportBounds(undefined, { force: true });
      }
      setViewFrame((previous) => (
        previous.left === next.left
        && previous.top === next.top
        && previous.width === next.width
        && previous.height === next.height
        && previous.scale === next.scale
          ? previous
          : next
      ));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [emulationSize, reportBounds]);

  /* ── Launchpad ──────────────────────────────────────────────────────────── */

  /**
   * `status != null` matters: before the first status lands the panel knows
   * nothing, and flashing the launchpad there would both blink the surface and
   * steal focus into the URL field — which then holds an empty string against
   * the page that turns out to be loaded.
   */
  const showLaunchpad = Boolean(
    apiAvailable
    && status != null
    && !captureBase
    && (browserTabs.length === 0 || activeTab?.isLaunchpad || !currentUrl),
  );

  useEffect(() => {
    launchpadVisibleRef.current = showLaunchpad;
    reportBounds(undefined, { force: true });
    // A page arrived under a focused, still-empty launchpad field: the omnibox
    // has to say where we are, not sit blank over a loaded page.
    if (!showLaunchpad) setUrlInput((current) => (current.trim() ? current : currentUrl));
  }, [currentUrl, reportBounds, showLaunchpad]);

  useEffect(() => {
    if (!showLaunchpad) return undefined;
    const read = window.ade?.app?.readClipboardText;
    if (!read) return undefined;
    let cancelled = false;
    void read()
      .then((text) => {
        if (!cancelled) setClipboardUrl(clipboardUrlCandidate(text));
      })
      .catch(() => {
        // An unreadable clipboard just means no chip.
      });
    return () => {
      cancelled = true;
    };
  }, [showLaunchpad]);

  // A new tab is a question, so the caret starts where the answer goes.
  useEffect(() => {
    if (!showLaunchpad) return undefined;
    const frame = window.requestAnimationFrame(() => urlInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [showLaunchpad, activeTabId]);

  /* ── Load progress ──────────────────────────────────────────────────────── */

  useEffect(() => {
    if (loading) {
      progressPhaseRef.current = "loading";
      setProgressPhase("loading");
      return undefined;
    }
    if (progressPhaseRef.current === "idle") return undefined;
    progressPhaseRef.current = "finishing";
    setProgressPhase("finishing");
    const timer = window.setTimeout(() => {
      progressPhaseRef.current = "idle";
      setProgressPhase("idle");
    }, PROGRESS_FINISH_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);

  // A page that just settled is the frame a menu will want to freeze, so take
  // it once now rather than round-tripping the moment the menu opens.
  useEffect(() => {
    if (loading || !currentUrl || !apiAvailable) return undefined;
    const timer = window.setTimeout(() => {
      void refreshUnderlaySnapshot();
    }, UNDERLAY_SETTLE_SNAPSHOT_MS);
    return () => window.clearTimeout(timer);
  }, [apiAvailable, currentUrl, loading, refreshUnderlaySnapshot]);

  /**
   * The device list, shared by the toolbar button and the narrow-pane overflow.
   *
   * One definition, two hosts: a device chosen from the ⋮ menu at 300px has to
   * be the same list — and the same "Off" row — as the one at 900px.
   */
  const deviceMenuItems = (
    <DropdownMenu.RadioGroup value={activePresetId} onValueChange={handleDeviceMenuValue}>
      <DropdownMenu.Label className={MENU_LABEL_CLASS}>Device</DropdownMenu.Label>
      {deviceMenuPresets().map((preset) => {
        const current = activePresetId === preset.id;
        return (
          <DropdownMenu.RadioItem
            key={preset.id}
            value={preset.id}
            className={MENU_ITEM_CLASS}
          >
            <Check
              size={11}
              weight="bold"
              aria-hidden="true"
              className={cn("shrink-0 text-[var(--color-accent)]", current ? "opacity-100" : "opacity-0")}
            />
            <span className="min-w-0 flex-1 truncate">{preset.label}</span>
            <span className="shrink-0 font-mono text-[9.5px] text-muted-fg/70">
              {emulationSizeLabel(preset)}
            </span>
          </DropdownMenu.RadioItem>
        );
      })}
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
      {/*
        Responsive is a row of this list too, so a custom size — and a rotated
        preset, which the service also calls responsive — has something checked
        rather than a menu that claims nothing is on.
      */}
      <DropdownMenu.Label className={cn(MENU_LABEL_CLASS, "flex items-center gap-1.5")}>
        <Check
          size={11}
          weight="bold"
          aria-hidden="true"
          data-testid="browser-device-responsive-check"
          className={cn(
            "shrink-0 text-[var(--color-accent)]",
            activePresetId === "responsive" ? "opacity-100" : "opacity-0",
          )}
        />
        Responsive
      </DropdownMenu.Label>
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
      {/* "Off" is a choice in the same list, so it carries the same check mark. */}
      <DropdownMenu.RadioItem value="desktop" className={MENU_ITEM_CLASS}>
        <Check
          size={11}
          weight="bold"
          aria-hidden="true"
          className={cn("shrink-0 text-[var(--color-accent)]", emulation ? "opacity-0" : "opacity-100")}
        />
        <span className="min-w-0 flex-1 truncate">Off</span>
        <span className="shrink-0 text-[9.5px] text-muted-fg/70">Full width</span>
      </DropdownMenu.RadioItem>
    </DropdownMenu.RadioGroup>
  );

  return (
    <div
      ref={panelRef}
      data-testid="browser-panel"
      onKeyDown={handlePanelKeyDown}
      className="flex h-full min-h-0 min-w-0 flex-col font-sans text-[12px] text-fg/75"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-white/[0.08] bg-[var(--color-bg)]">
        <BrowserTabStrip
          stripRef={tabStripRef}
          tabs={browserTabs}
          activeTabId={activeTabId}
          tabTunnels={tabTunnels}
          failedFavicons={failedFavicons}
          setFailedFavicons={setFailedFavicons}
          fades={tabStripFades}
          reduceMotion={reduceMotion}
          busy={busy}
          apiAvailable={apiAvailable}
          onScroll={syncTabStripFades}
          onSwitchTab={handleSwitchTab}
          onCloseTab={handleCloseTab}
          onNewTab={handleNewTab}
        />

        {pendingApproval ? (
          <div
            role="alert"
            className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 overflow-hidden border-b border-amber-400/25 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-100/90"
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

        <BrowserToolbarRow
          rowRef={toolbarRowRef}
          toolbar={toolbar}
          busy={busy}
          apiAvailable={apiAvailable}
          hasTab={hasTab}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          loading={loading}
          onBack={handleBack}
          onForward={handleForward}
          onReload={handleReload}
          onStop={handleStop}
          onNavigate={handleNavigate}
          lockKind={lockKind}
          activeTabTunnel={activeTabTunnel}
          urlInputRef={urlInputRef}
          urlInput={urlInput}
          setUrlInput={setUrlInput}
          setEditingUrl={setEditingUrl}
          onUrlFocus={handleUrlFocus}
          onUrlKeyDown={handleUrlKeyDown}
          currentUrl={currentUrl}
          showUrlOverlay={showUrlOverlay}
          urlDisplay={urlDisplay}
          recording={recording}
          recordingClock={recordingClock}
          onStopRecording={handleStopRecording}
          deviceMenuOpen={deviceMenuOpen}
          setDeviceMenuOpen={setDeviceMenuOpen}
          deviceLabel={deviceLabel}
          emulation={emulation}
          deviceMenuItems={deviceMenuItems}
          hasCaptureBase={Boolean(captureBase)}
          onCameraClick={handleCameraClick}
          inspecting={inspecting}
          onInspectToggle={handleInspectToggle}
          hasSelection={hasSelection}
          canAddContext={Boolean(onAddContext)}
          onAttachSelection={handleAttachSelection}
          overflow={(
            <BrowserOverflowMenu
              open={overflowOpen}
              onOpenChange={setOverflowOpen}
              apiAvailable={apiAvailable}
              toolbar={toolbar}
              busy={busy}
              zoomFactor={zoomFactor}
              onZoomStep={handleZoomStep}
              onZoomReset={handleZoomReset}
              inspecting={inspecting}
              onInspectToggle={handleInspectToggle}
              onAttachScreenshot={handleAttachScreenshot}
              emulation={emulation}
              deviceLabel={deviceLabel}
              deviceMenuItems={deviceMenuItems}
              onOpenFind={openFind}
              devToolsOpen={devToolsOpen}
              onToggleDevTools={handleToggleDevTools}
              networkLogging={networkLogging}
              onToggleNetworkLogging={handleToggleNetworkLogging}
              onExportHar={handleExportHar}
              recordingFps={recordingFps}
              setRecordingFps={setRecordingFps}
              linkMode={linkMode}
              onLinkModeChange={handleLinkModeChange}
              onToggleProfile={handleToggleProfile}
              onOpenLoginImport={() => setImportOpen(true)}
              currentUrl={currentUrl}
              onOpenExternal={handleOpenExternal}
              hasSelection={hasSelection}
              canAddContext={Boolean(onAddContext)}
              onAttachSelection={handleAttachSelection}
              canInsertDraft={Boolean(onInsertDraft)}
              onInsertSelectionDraft={handleInsertSelectionDraft}
              onClearSelection={handleClearSelection}
              selectionFrame={selectionFrame}
            />
          )}
        />

        {/*
          Determinate-feeling progress: it races out, waits at 90%, then snaps
          shut on did-finish-load. A page that is still loading should look like
          progress, not like a spinner that might mean anything.
        */}
        <div className="relative h-[2px] shrink-0 overflow-hidden" aria-hidden="true">
          <AnimatePresence initial={false}>
            {progressPhase === "idle" ? null : (
              <motion.div
                key="ade-browser-progress"
                data-testid="browser-load-progress"
                className="h-full w-full origin-left bg-[var(--color-accent)] shadow-[0_0_6px_1px_color-mix(in_srgb,var(--color-accent)_45%,transparent)]"
                initial={reduceMotion ? { scaleX: 1, opacity: 1 } : { scaleX: 0.04, opacity: 1 }}
                animate={progressPhase === "loading"
                  ? { scaleX: reduceMotion ? 1 : 0.9, opacity: 1 }
                  : { scaleX: 1, opacity: 0 }}
                exit={{ opacity: 0 }}
                transition={progressPhase === "loading"
                  ? { duration: reduceMotion ? 0 : 5.3, ease: [0.1, 0.5, 0.2, 1] }
                  : { scaleX: { duration: 0.15 }, opacity: { duration: 0.2, delay: 0.15 } }}
              />
            )}
          </AnimatePresence>
        </div>

        <BrowserFindBar
          open={findOpen}
          reduceMotion={reduceMotion}
          inputRef={findInputRef}
          findText={findText}
          setFindText={setFindText}
          queueFind={queueFind}
          findStep={findStep}
          closeFind={closeFind}
          findError={findError}
          findState={findState}
        />

        <BrowserHandoffBar
          handoff={handoff}
          reduceMotion={reduceMotion}
          showHandBackOffer={showHandoffHandBackOffer}
          busy={busy}
          onHandBack={handleHandBack}
          onKeepControl={handleKeepHandoffControl}
        />

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
          <BrowserProfilePanel
            diagnostics={profileDiagnostics}
            permissionDecisions={permissionDecisions}
            busy={profileBusy}
            onRefresh={() => void refreshProfileSecurity().catch((error: unknown) => {
              setMessage({ tone: "error", text: errorMessage(error) });
            })}
            onClearPermission={clearRememberedPermission}
          />
        ) : null}

        <BrowserStage
          surfaceRef={browserSurfaceRef}
          stageRef={browserStageRef}
          viewportRef={browserViewportRef}
          captureImageRef={captureImageRef}
          viewFrame={viewFrame}
          reduceMotion={reduceMotion}
          onViewportAnimationComplete={() => reportBounds(undefined, { force: true })}
          underlay={underlay}
          captureImageDataUrl={captureImageDataUrl}
          captureBase={captureBase}
          captureSelection={captureSelection}
          activeCaptureFrame={activeCaptureFrame}
          onCapturePointerDown={handleBrowserCapturePointerDown}
          onCapturePointerMove={handleBrowserCapturePointerMove}
          onCapturePointerUp={finishBrowserCapture}
          onCapturePointerCancel={cancelBrowserCapture}
          showLaunchpad={showLaunchpad}
          apiAvailable={apiAvailable}
          launchpadChips={launchpadChips}
          letterboxed={letterboxed}
          emulation={emulation}
          busy={busy}
          onRotateEmulation={handleRotateEmulation}
        />

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
