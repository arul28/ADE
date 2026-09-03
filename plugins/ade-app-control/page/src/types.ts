/**
 * The Electron Control shapes, copied down from the app's own.
 *
 * `apps/desktop/src/shared/types/appControl.ts` is the original and stays the
 * source of truth — these are the SUBSET the page draws, restated here because
 * a plugin page is built separately from the app and cannot import across that
 * boundary. Fields the page never reads are dropped rather than mirrored: a
 * copy that claimed to be complete would go stale silently, and a copy that
 * declares only what it uses fails loudly the day a field it draws disappears.
 *
 * Two things are deliberately absent:
 *
 * - `AppControlScreenshot` / `AppControlScreencastFrame`. The picture is the
 *   HOST engine's, painted into the rect this page reserves, so no frame ever
 *   crosses the bridge and the page has nothing to type for one.
 * - `NodeJS.Platform`. The status's `platform` is a plain string here, because
 *   the page prints it and never branches on it.
 */

export type AppControlProvider = "cdp" | "os-accessibility" | "computer-use" | "external";

export type AppControlCoordinateSpace = "screenshot" | "viewport";

export type AppControlFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AppControlSessionStatus =
  | "starting"
  | "running"
  | "connected"
  | "stopping"
  | "exited"
  | "stopped"
  | "failed";

export type AppControlSession = {
  id: string;
  appKind: "electron";
  label: string;
  projectRoot: string | null;
  laneId: string | null;
  cwd: string | null;
  command: string | null;
  pid: number | null;
  terminalSessionId: string | null;
  terminalPtyId: string | null;
  cdpPort: number | null;
  cdpEndpoint: string | null;
  cdpTargetId: string | null;
  provider: AppControlProvider;
  chatSessionId: string | null;
  startedAt: string;
  connectedAt: string | null;
  status: AppControlSessionStatus;
  lastError: string | null;
};

export type AppControlStatus = {
  platform: string;
  supported: boolean;
  activeSession: AppControlSession | null;
  providers: { provider: AppControlProvider; available: boolean; detail?: string | null }[];
  /**
   * Why this host refuses to drive, when it does.
   *
   * The compiled pane took this as a PROP (`controlDisabledReason`) from
   * whichever chat or rail mounted it. A page has no props: it is opened by the
   * host with a context and nothing else, so the reason has to arrive with the
   * status. `null` means nothing is blocking.
   */
  disabledReason?: string | null;
};

export type AppControlTarget = {
  id: string;
  title: string | null;
  url: string | null;
  type: string;
  active: boolean;
};

export type AppControlElement = {
  id: string;
  ref: string;
  provider: AppControlProvider;
  tagName: string | null;
  role: string | null;
  label: string | null;
  value: string | null;
  selector: string | null;
  testId: string | null;
  frame: AppControlFrame;
  pixelFrame: AppControlFrame;
  metadata: Record<string, unknown>;
};

export type AppControlContextItem = {
  kind: "app_control_element";
  id: string;
  appKind: "electron";
  sessionId: string | null;
  provider: AppControlProvider | "coordinate-fallback";
  componentId: string;
  sourceFile: string | null;
  sourceLine: number | null;
  frame: AppControlFrame | null;
  metadata: Record<string, unknown>;
  screenshotDataUrl?: string | null;
  selectedAt: string;
};

/**
 * What a snapshot read answers the page.
 *
 * The compiled pane's `AppControlSnapshot` carried the screenshot bytes too.
 * This one does not: the host engine paints the picture, so a page that also
 * received it would be paying a megabyte per refresh for an image it cannot
 * draw. `screen` stays, because the reader is told the viewport size and the
 * click coordinates are in it.
 */
export type AppControlSnapshot = {
  session: AppControlSession | null;
  capturedAt: string;
  screen: {
    width: number;
    height: number;
    scale: number;
    viewportWidth?: number;
    viewportHeight?: number;
    scaleX?: number;
    scaleY?: number;
  };
  elements: AppControlElement[];
  hitElement: AppControlElement | null;
  providers: { provider: AppControlProvider | "screenshot"; available: boolean; elementCount?: number; error?: string | null }[];
  url: string | null;
  title: string | null;
};

export type AppControlInspectResult = {
  item: AppControlContextItem | null;
  source: AppControlProvider | "coordinate-fallback" | "none";
  snapshot: AppControlSnapshot;
};

export type AppControlSelectResult = {
  item: AppControlContextItem;
  source: AppControlProvider | "coordinate-fallback";
  snapshot?: AppControlSnapshot;
};

/** The reader's launch form, remembered per project in the `ui-state` collection. */
export type ControlPanelUiState = {
  launchCommand: string;
  launchCwd: string;
  cdpPort: string;
  mode: "control" | "inspect";
};
