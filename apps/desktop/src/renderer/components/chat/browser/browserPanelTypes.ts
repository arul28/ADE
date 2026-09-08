/**
 * The shapes the panel and its presentational pieces both name.
 *
 * These used to be private to `ChatBuiltInBrowserPanel`, which was fine while
 * every consumer lived in that one file. The tab strip and the stage take them
 * as props now, so they sit here rather than being imported back out of the
 * component that renders them.
 */
import type { BuiltInBrowserTab } from "../../../../shared/types/builtInBrowser";

export type BrowserFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CaptureMediaBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
};

export type BrowserCaptureSelection = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  bounds: CaptureMediaBounds;
};

export type BuiltInBrowserContextItem = {
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

export type BuiltInBrowserScreenshot = {
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

/**
 * The tab fields the main process is growing, read defensively.
 *
 * `faviconUrl` and `isLaunchpad` are owned by the browser service and land
 * separately from this panel; against a main process that predates them the
 * strip simply falls back to the globe and the launchpad keys off "no URL".
 */
export type BrowserTab = BuiltInBrowserTab & {
  faviconUrl?: string | null;
  isLaunchpad?: boolean;
};

/**
 * The status and event shapes the PANEL reads, which are not the ones the
 * preload declares.
 *
 * `shared/types/builtInBrowser.ts` describes what a CURRENT main process sends.
 * These describe what the panel is willing to render: the fields the UI needs,
 * plus an index signature, because the panel may be talking to an older main
 * process that has not grown a field yet — or to the web-client stub, which
 * sends almost none of them. `normalizeStatus` is what turns the first into the
 * second; nothing in the panel reads a raw payload.
 */
export type BuiltInBrowserStatus = {
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

export type BuiltInBrowserEventPayload = {
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
