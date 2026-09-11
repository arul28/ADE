/**
 * Every "trust nothing from the wire" reader the browser panel makes.
 *
 * The panel talks to a main process that may be OLDER than it is — a pinned
 * machine on a previous release, a partially updated install — and to the hosted
 * web client, whose browser namespace is a stub. So each payload is read field
 * by field rather than cast: a missing `tabs` array has to degrade to an empty
 * strip, not throw inside a render.
 *
 * These are pure functions of their arguments, touching no React and no DOM
 * (the DOM-measuring half lives in `browserCapture.ts`), which is what makes
 * them testable without a browser view — the reason they no longer live inside
 * the component that renders one.
 */
import type { BuiltInBrowserTab, BuiltInBrowserTabHandoff } from "../../../../shared/types/builtInBrowser";
import { completeBrowserUrl } from "../../../lib/browserUrl";
import type {
  BrowserFrame,
  BrowserTab,
  BuiltInBrowserContextItem,
  BuiltInBrowserEventPayload,
  BuiltInBrowserScreenshot,
  BuiltInBrowserStatus,
} from "./browserPanelTypes";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function booleanField(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

const UNSUPPORTED_NAVIGATION_SCHEME_RE = /^(about|blob|data|devtools|file):/i;

export type NormalizedNavigationUrl =
  | { ok: true; url: string }
  | { ok: false; reason: string };

export function normalizeUrlForNavigation(value: string): NormalizedNavigationUrl {
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

export function normalizeFrame(value: unknown): BrowserFrame | null {
  if (!isRecord(value)) return null;
  const x = numberField(value.x);
  const y = numberField(value.y);
  const width = numberField(value.width);
  const height = numberField(value.height);
  if (x == null || y == null || width == null || height == null) return null;
  return { x, y, width, height };
}

export function normalizeContextItem(value: unknown, status?: BuiltInBrowserStatus | null): BuiltInBrowserContextItem | null {
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

export function normalizeSelectionResult(value: unknown, status: BuiltInBrowserStatus | null): BuiltInBrowserContextItem | null {
  if (!isRecord(value)) return normalizeContextItem(value, status);
  return (
    normalizeContextItem(value.item, status)
    ?? normalizeContextItem(value.selection, status)
    ?? normalizeContextItem(value.selectedItem, status)
    ?? normalizeContextItem(value, status)
  );
}

export function normalizeScreenshot(value: unknown, status: BuiltInBrowserStatus | null): BuiltInBrowserScreenshot | null {
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

export function normalizeTab(value: unknown): BrowserTab | null {
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
export function normalizeTabHandoff(value: unknown): BuiltInBrowserTabHandoff | null {
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

export function normalizeStatus(value: unknown, previous: BuiltInBrowserStatus | null): BuiltInBrowserStatus {
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

export function browserEventMatchesProject(
  event: BuiltInBrowserEventPayload,
  projectRoot: string | null,
): boolean {
  const root = eventProjectRoot(event);
  if (root === undefined) return true;
  if (!projectRoot) return root === null;
  return root === projectRoot;
}

export function frameLabel(frame: BrowserFrame | null): string | null {
  if (!frame) return null;
  return `${Math.round(frame.x)}, ${Math.round(frame.y)} · ${Math.round(frame.width)}×${Math.round(frame.height)}`;
}
