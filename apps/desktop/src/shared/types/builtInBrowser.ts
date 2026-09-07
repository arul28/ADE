export type BuiltInBrowserProvider = "cdp";

export type BuiltInBrowserFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BuiltInBrowserBoundsArgs = BuiltInBrowserFrame & {
  visible: boolean;
} & BuiltInBrowserProjectScopeArgs;

export type BuiltInBrowserProjectScopeArgs = {
  projectRoot?: string | null;
  /** Keep personal-chat tabs separate without changing the global storage profile. */
  tabCollection?: "personal";
};

export type BuiltInBrowserAttachWebviewArgs = BuiltInBrowserProjectScopeArgs & {
  tabId: string;
  webContentsId: number;
};

export type BuiltInBrowserClaimArgs = BuiltInBrowserProjectScopeArgs & {
  tabId?: string | null;
  laneId?: string | null;
  chatSessionId?: string | null;
  force?: boolean;
  leaseTtlMs?: number | null;
};

export type BuiltInBrowserNavigateArgs = BuiltInBrowserClaimArgs & {
  url: string;
  tabId?: string | null;
  newTab?: boolean;
  activate?: boolean;
  reuseOwnedTab?: boolean;
  openPanel?: boolean;
};

export type BuiltInBrowserTab = {
  id: string;
  url: string | null;
  title: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  ownerLaneId: string | null;
  ownerChatSessionId: string | null;
  ownerClaimedAt: string | null;
  ownerLeaseExpiresAt: string | null;
  zoomFactor: number;
  devToolsOpen: boolean;
  emulation: BuiltInBrowserEmulationState | null;
  networkLogging: boolean;
  recording: BuiltInBrowserRecordingStatus | null;
  /**
   * Non-null while a human holds this tab because an agent asked them to sign
   * in (or clear a CAPTCHA / HTTP auth / client-cert prompt) for it. Surfaces
   * feature-detect this field: when it is set the tab is human-owned, every
   * agent action on it fails with `handoff_active`, and the header owner text
   * reads "you own this tab".
   */
  handoff: BuiltInBrowserTabHandoff | null;
};

/** Why a login handoff ended — carried on the `handoff-end` trace entry. */
export type BuiltInBrowserHandoffEndedBy = "human" | "auto-offer" | "tab-closed" | "timeout";

export type BuiltInBrowserTabHandoff = {
  /** Human-readable justification the agent supplied, e.g. "sign in to staging". */
  reason: string;
  startedAt: string;
  /** When the service auto-hands the tab back if the human never does. */
  expiresAt: string;
  requestedByChatSessionId: string | null;
  requestedByLaneId: string | null;
  /**
   * Origin the tab was on when the handoff started. The renderer offers
   * "Signed in? Hand back now" as soon as the tab leaves it.
   */
  startedAtOrigin: string | null;
  /** The lease to re-issue on hand-back. */
  previousOwner: {
    laneId: string | null;
    chatSessionId: string | null;
  };
};

export type BuiltInBrowserStartHandoffArgs = BuiltInBrowserTabTargetArgs & {
  /** Required. Shown in the amber bar, the push body, and the trace entry. */
  reason: string;
  /** Auto hand-back deadline. Defaults to 15 minutes; clamped to 1 min–2 h. */
  timeoutMs?: number | null;
};

export type BuiltInBrowserEndHandoffArgs = BuiltInBrowserTabTargetArgs & {
  /** Defaults to `"human"`. Only the service itself passes the other values. */
  endedBy?: BuiltInBrowserHandoffEndedBy | null;
};

export type BuiltInBrowserWaitForHandoffArgs = BuiltInBrowserTabTargetArgs & {
  /** How long to block. Defaults to the tab's remaining handoff window. */
  timeoutMs?: number | null;
};

export type BuiltInBrowserHandoffResult = {
  tabId: string;
  handoff: BuiltInBrowserTabHandoff | null;
  status: BuiltInBrowserStatus;
};

export type BuiltInBrowserHandoffWaitResult = {
  tabId: string;
  /** False when the wait itself timed out while the handoff was still open. */
  ended: boolean;
  endedBy: BuiltInBrowserHandoffEndedBy | null;
  durationMs: number | null;
  handoff: BuiltInBrowserTabHandoff | null;
};

/**
 * Error code every agent-facing browser action returns while a login handoff is
 * open on the target tab. Typed rather than a bare message so an agent can
 * branch on it instead of pattern-matching prose.
 */
export const BUILT_IN_BROWSER_HANDOFF_ACTIVE_CODE = "handoff_active";

export type BuiltInBrowserSession = {
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

export type BuiltInBrowserStatus = {
  attached: boolean;
  partition: string;
  storageProfileKey: "global";
  collectionKey: string;
  collectionProjectRoot: string | null;
  persistentProfile: true;
  visible: boolean;
  bounds: BuiltInBrowserFrame;
  activeTabId: string | null;
  tabs: BuiltInBrowserTab[];
  url: string | null;
  title: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isInspecting: boolean;
  hasSelection: boolean;
  ownerLaneId: string | null;
  ownerChatSessionId: string | null;
  ownerClaimedAt: string | null;
  ownerLeaseExpiresAt: string | null;
};

export type BuiltInBrowserPermissionDecision = {
  permission: string;
  origin: string;
  embeddingOrigin: string | null;
  decision: "allow" | "block";
  updatedAt: string;
};

export type BuiltInBrowserPermissionsResult = {
  permissions: BuiltInBrowserPermissionDecision[];
};

export type BuiltInBrowserClearPermissionsArgs = {
  origin?: string | null;
  permission?: string | null;
};

export type BuiltInBrowserClearPermissionsResult = BuiltInBrowserPermissionsResult & {
  removed: number;
};

export type BuiltInBrowserProfileDiagnostics = {
  partition: string;
  storageProfileKey: "global";
  persistentProfile: true;
  cookieCount: number;
  persistentCookieCount: number;
  sessionCookieCount: number;
  cookieDomains: string[];
  cacheSizeBytes: number | null;
  persistedPermissionDecisionCount: number;
  tabRestorationEnabled: boolean;
  lastStorageFlushAt: string | null;
};

export type BuiltInBrowserElementTargetArgs = {
  selector?: string | null;
  text?: string | null;
  testId?: string | null;
  elementIndex?: number | null;
  handle?: string | null;
};

export type BuiltInBrowserTabArgs = BuiltInBrowserClaimArgs & {
  tabId: string;
  openPanel?: boolean;
};

export type BuiltInBrowserTabTargetArgs = BuiltInBrowserProjectScopeArgs & {
  tabId?: string | null;
  sessionId?: string | null;
  laneId?: string | null;
  chatSessionId?: string | null;
  force?: boolean;
  leaseTtlMs?: number | null;
};

export type BuiltInBrowserStartSessionArgs = BuiltInBrowserClaimArgs;

export type BuiltInBrowserRequestOriginAccessArgs = BuiltInBrowserTabTargetArgs;

export type BuiltInBrowserOriginAccessResult = {
  origin: string | null;
  required: boolean;
  granted: boolean;
  status: BuiltInBrowserStatus;
};

export type BuiltInBrowserEndSessionArgs = BuiltInBrowserClaimArgs & {
  sessionId: string;
};

export type BuiltInBrowserListSessionsArgs = BuiltInBrowserTabTargetArgs & {
  tabId?: string | null;
  includeEnded?: boolean;
};

export type BuiltInBrowserSessionResult = {
  session: BuiltInBrowserSession;
  status: BuiltInBrowserStatus;
};

export type BuiltInBrowserSessionsResult = {
  sessions: BuiltInBrowserSession[];
};

export type BuiltInBrowserCreateTabArgs = BuiltInBrowserClaimArgs & {
  url?: string | null;
  activate?: boolean;
  openPanel?: boolean;
};

export type BuiltInBrowserOpenPanelArgs = BuiltInBrowserClaimArgs & {
  url?: string | null;
  tabId?: string | null;
};

export type BuiltInBrowserSelectPointArgs = BuiltInBrowserTabTargetArgs & {
  x: number;
  y: number;
  includeScreenshot?: boolean;
};

export type BuiltInBrowserObservationArgs = BuiltInBrowserTabTargetArgs & {
  keepCount?: number | null;
  includeDataUrl?: boolean;
  includeDom?: boolean;
  includeElementMap?: boolean;
  includeDiagnostics?: boolean;
  maxElements?: number | null;
};

export type BuiltInBrowserObservationCleanup = {
  keepCount: number;
  keptCount: number;
  deletedCount: number;
};

export type BuiltInBrowserObservation = {
  id: string;
  tabId: string;
  sessionId: string | null;
  url: string | null;
  title: string | null;
  capturedAt: string;
  width: number;
  height: number;
  mimeType: string;
  filePath: string;
  relativePath: string | null;
  dataUrl?: string;
  dom?: BuiltInBrowserDomSnapshot | null;
  elementMap?: BuiltInBrowserObservationElementMap | null;
  diagnostics?: BuiltInBrowserDiagnostics | null;
  ownerLaneId: string | null;
  ownerChatSessionId: string | null;
  cleanup: BuiltInBrowserObservationCleanup;
};

export type BuiltInBrowserAgentActionArgs = BuiltInBrowserObservationArgs & {
  observe?: boolean;
  waitAfterMs?: number | null;
  laneId?: string | null;
  chatSessionId?: string | null;
  force?: boolean;
  leaseTtlMs?: number | null;
};

export type BuiltInBrowserClickArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs & {
  x?: number | null;
  y?: number | null;
  button?: "left" | "middle" | "right";
  clickCount?: number | null;
};

export type BuiltInBrowserTypeTextArgs = BuiltInBrowserAgentActionArgs & {
  text: string;
};

export type BuiltInBrowserDispatchKeyArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs & {
  key: string;
};

export type BuiltInBrowserScrollArgs = BuiltInBrowserAgentActionArgs & {
  x?: number | null;
  y?: number | null;
  deltaX?: number | null;
  deltaY?: number | null;
};

export type BuiltInBrowserFillArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs & {
  /**
   * Value to insert. Kept optional because older callers used `text` for the
   * fill payload when the element target was selected by selector/test id/handle.
   */
  value?: string | null;
};

export type BuiltInBrowserClearArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs;

export type BuiltInBrowserWaitArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs & {
  url?: string | null;
  loadState?: "domcontentloaded" | "load" | "network-idle";
  timeoutMs?: number | null;
  networkIdleMs?: number | null;
};

export type BuiltInBrowserTraceArgs = BuiltInBrowserTabTargetArgs & {
  limit?: number | null;
};

export type BuiltInBrowserAgentActionResult = {
  ok: true;
  observation: BuiltInBrowserObservation | null;
  status: BuiltInBrowserStatus;
  trace: BuiltInBrowserActionTraceEntry | null;
  session: BuiltInBrowserSession | null;
};

export type BuiltInBrowserElementSnapshot = {
  index: number;
  handle?: string | null;
  framePath?: number[];
  shadowPath?: string[];
  tagName: string | null;
  role: string | null;
  label: string | null;
  text: string | null;
  value: string | null;
  placeholder: string | null;
  selector: string | null;
  testId: string | null;
  href: string | null;
  disabled: boolean | null;
  frame: BuiltInBrowserFrame;
  center: { x: number; y: number };
};

export type BuiltInBrowserObservationElementMap = {
  filePath: string;
  relativePath: string | null;
  width: number;
  height: number;
  mimeType: string;
  elementCount: number;
  dataUrl?: string;
};

export type BuiltInBrowserDomSnapshot = {
  url: string | null;
  title: string | null;
  capturedAt: string;
  viewport: BuiltInBrowserFrame;
  scroll: { x: number; y: number };
  elementCount: number;
  elements: BuiltInBrowserElementSnapshot[];
};

export type BuiltInBrowserConsoleDiagnostic = {
  level: "debug" | "info" | "warning" | "error";
  message: string;
  sourceId: string | null;
  line: number | null;
  column: number | null;
  timestamp: string;
};

export type BuiltInBrowserNetworkDiagnostic = {
  url: string;
  method: string | null;
  resourceType: string | null;
  statusCode: number | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string;
  durationMs: number | null;
};

export type BuiltInBrowserDiagnostics = {
  capturedAt: string;
  pendingRequestCount: number;
  console: BuiltInBrowserConsoleDiagnostic[];
  network: BuiltInBrowserNetworkDiagnostic[];
  /** Present only while full network logging is enabled for the tab. */
  networkLog?: BuiltInBrowserObservationNetworkLog | null;
};

export type BuiltInBrowserObservationNetworkLog = {
  enabled: true;
  recordedCount: number;
  droppedCount: number;
  recent: BuiltInBrowserNetworkLogEntry[];
};

export type BuiltInBrowserActionTraceEntry = {
  id: string;
  tabId: string;
  sessionId: string | null;
  action: string;
  status: "ok" | "error";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  before: { url: string | null; title: string | null };
  after: { url: string | null; title: string | null };
  target: Record<string, unknown> | null;
  observationId: string | null;
  error: string | null;
};

export type BuiltInBrowserTraceResult = {
  tabId: string;
  sessionId: string | null;
  entries: BuiltInBrowserActionTraceEntry[];
};

export type BuiltInBrowserScreenshot = {
  capturedAt: string;
  width: number;
  height: number;
  dataUrl: string;
};

export type BuiltInBrowserContextItem = {
  kind: "built_in_browser_element" | "built_in_browser_capture";
  id: string;
  provider: BuiltInBrowserProvider;
  componentId: string;
  url: string | null;
  title: string | null;
  sourceFile: string | null;
  sourceLine: number | null;
  frame: BuiltInBrowserFrame;
  pixelFrame: BuiltInBrowserFrame;
  metadata: Record<string, unknown>;
  screenshotDataUrl: string | null;
  selectedAt: string;
};

export type BuiltInBrowserSelectResult = {
  item: BuiltInBrowserContextItem | null;
};

export type BuiltInBrowserEventPayload =
  | { type: "status"; status: BuiltInBrowserStatus }
  | {
      type: "open-request";
      status: BuiltInBrowserStatus;
      url: string | null;
      tabId: string | null;
      requestedAt: string;
    }
  | { type: "selection"; item: BuiltInBrowserContextItem }
  | { type: "selection-cleared"; item: null; clearedAt: string }
  | {
      type: "found-in-page";
      tabId: string;
      requestId: number;
      activeMatchOrdinal: number | null;
      matches: number | null;
      finalUpdate: boolean;
      foundAt: string;
    }
  | {
      type: "recording";
      tabId: string;
      recording: BuiltInBrowserRecordingStatus | null;
      frameCount: number;
      updatedAt: string;
    }
  /**
   * A human-run login import finished. Carries only counts and domain names —
   * never a cookie name or value — so the renderer can toast the result without
   * the event stream becoming a credential channel.
   */
  | {
      type: "login-import-completed";
      importedCount: number;
      domains: string[];
      completedAt: string;
    }
  /**
   * One frame of a tab's live preview stream, emitted only while something has
   * called `startPreviewStream` for that tab. JPEG data URL, already downscaled
   * in main so the renderer never resizes on the paint path.
   */
  | {
      type: "preview-frame";
      tabId: string;
      dataUrl: string;
      width: number;
      height: number;
      capturedAt: string;
    }
  /**
   * An agent action finished. Carries the trace entry that was just appended so
   * surfaces can caption "what just happened" without polling `getTrace`.
   */
  | { type: "trace"; tabId: string; entry: BuiltInBrowserActionTraceEntry }
  /**
   * A login handoff opened: the agent asked the human to take this tab. The
   * pane reveals an amber bar and the tab is human-owned until `handoff-ended`.
   */
  | {
      type: "handoff-started";
      tabId: string;
      handoff: BuiltInBrowserTabHandoff;
      startedAt: string;
    }
  | {
      type: "handoff-ended";
      tabId: string;
      /** The handoff that just closed, for surfaces that missed the start. */
      handoff: BuiltInBrowserTabHandoff;
      endedBy: BuiltInBrowserHandoffEndedBy;
      durationMs: number;
      endedAt: string;
    }
  /**
   * The tab's error tally changed — a console error, or a request that failed
   * or came back 4xx/5xx. Counts are since the tab's last main-frame
   * navigation, so a reload clears the badge without a second event.
   */
  | {
      type: "diagnostics";
      tabId: string;
      consoleErrorCount: number;
      failedRequestCount: number;
      updatedAt: string;
    }
  | { type: "error"; message: string; occurredAt: string };

/* ── Device emulation ─────────────────────────────────────────────────────── */

export type BuiltInBrowserEmulationPresetId =
  | "desktop"
  | "iphone-17"
  | "iphone-17-pro"
  | "iphone-17-pro-max"
  | "ipad"
  | "pixel"
  | "responsive";

export type BuiltInBrowserEmulationMetrics = {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  userAgent?: string | null;
};

export type BuiltInBrowserEmulationPreset = {
  id: BuiltInBrowserEmulationPresetId;
  label: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  hasTouch: boolean;
  userAgent: string | null;
};

/** Emulation currently applied to one tab. `null` means "no override". */
export type BuiltInBrowserEmulationState = {
  presetId: BuiltInBrowserEmulationPresetId | null;
  label: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  hasTouch: boolean;
  userAgent: string | null;
};

export type BuiltInBrowserSetEmulationArgs = BuiltInBrowserTabTargetArgs & {
  /** Preset id/label, or `off`/`none`/`null` to clear the override. */
  preset?: string | null;
  width?: number | null;
  height?: number | null;
  deviceScaleFactor?: number | null;
  mobile?: boolean | null;
  userAgent?: string | null;
};

export type BuiltInBrowserEmulationResult = {
  tabId: string;
  emulation: BuiltInBrowserEmulationState | null;
  presets: BuiltInBrowserEmulationPreset[];
  status: BuiltInBrowserStatus;
};

/* ── Zoom ─────────────────────────────────────────────────────────────────── */

export type BuiltInBrowserSetZoomArgs = BuiltInBrowserTabTargetArgs & {
  factor?: number | null;
  /** Convenience for `factor: 1`. */
  reset?: boolean;
};

export type BuiltInBrowserZoomResult = {
  tabId: string;
  zoomFactor: number;
  status: BuiltInBrowserStatus;
};

/* ── Find in page ─────────────────────────────────────────────────────────── */

export type BuiltInBrowserFindInPageArgs = BuiltInBrowserTabTargetArgs & {
  text: string;
  forward?: boolean;
  matchCase?: boolean;
  /** Advance to the next match of an already-running find instead of restarting. */
  findNext?: boolean;
  timeoutMs?: number | null;
};

export type BuiltInBrowserFindInPageResult = {
  tabId: string;
  text: string;
  requestId: number;
  activeMatchOrdinal: number | null;
  matches: number | null;
  finalUpdate: boolean;
  status: BuiltInBrowserStatus;
};

export type BuiltInBrowserStopFindInPageArgs = BuiltInBrowserTabTargetArgs & {
  action?: "clearSelection" | "keepSelection" | "activateSelection";
};

export type BuiltInBrowserStopFindInPageResult = {
  tabId: string;
  stopped: true;
  status: BuiltInBrowserStatus;
};

/* ── DevTools ─────────────────────────────────────────────────────────────── */

export type BuiltInBrowserDevToolsMode = "right" | "bottom" | "detach";

export type BuiltInBrowserSetDevToolsArgs = BuiltInBrowserTabTargetArgs & {
  open: boolean;
  mode?: BuiltInBrowserDevToolsMode | null;
};

export type BuiltInBrowserDevToolsResult = {
  tabId: string;
  devToolsOpen: boolean;
  mode: BuiltInBrowserDevToolsMode | null;
  status: BuiltInBrowserStatus;
};

/* ── Full network log ─────────────────────────────────────────────────────── */

export type BuiltInBrowserNetworkHeader = {
  name: string;
  value: string;
  /** True when the value was replaced with a redaction marker. */
  redacted: boolean;
};

export type BuiltInBrowserNetworkTimings = {
  /** Wall-clock start of the request, ISO 8601. */
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  /** Time to first response byte, when the response phase was observed. */
  waitMs: number | null;
  receiveMs: number | null;
};

export type BuiltInBrowserNetworkLogEntry = {
  id: string;
  method: string | null;
  url: string;
  status: number | null;
  statusText: string | null;
  mimeType: string | null;
  resourceType: string | null;
  protocol: string | null;
  fromCache: boolean;
  requestHeaders: BuiltInBrowserNetworkHeader[];
  responseHeaders: BuiltInBrowserNetworkHeader[];
  requestBodySize: number | null;
  responseBodySize: number | null;
  responseHeaderSize: number | null;
  timings: BuiltInBrowserNetworkTimings;
  error: string | null;
};

export type BuiltInBrowserSetNetworkLoggingArgs = BuiltInBrowserTabTargetArgs & {
  enabled: boolean;
  /** Drop anything already recorded when turning logging on. */
  clear?: boolean;
};

export type BuiltInBrowserNetworkLoggingResult = {
  tabId: string;
  enabled: boolean;
  entryCount: number;
  status: BuiltInBrowserStatus;
};

export type BuiltInBrowserNetworkLogArgs = BuiltInBrowserTabTargetArgs & {
  limit?: number | null;
  /** Case-insensitive substring matched against method, URL, status and mime. */
  filter?: string | null;
  failedOnly?: boolean;
};

export type BuiltInBrowserNetworkLogResult = {
  tabId: string;
  enabled: boolean;
  recordedCount: number;
  droppedCount: number;
  matchedCount: number;
  entries: BuiltInBrowserNetworkLogEntry[];
};

export type BuiltInBrowserExportHarArgs = BuiltInBrowserTabTargetArgs & {
  filter?: string | null;
  failedOnly?: boolean;
};

export type BuiltInBrowserExportHarResult = {
  tabId: string;
  filePath: string;
  relativePath: string | null;
  entryCount: number;
  exportedAt: string;
};

/* ── Extra page actions ───────────────────────────────────────────────────── */

export type BuiltInBrowserHoverArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs & {
  x?: number | null;
  y?: number | null;
};

export type BuiltInBrowserDragArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs & {
  /** Source coordinates when no source element target is given. */
  x?: number | null;
  y?: number | null;
  toSelector?: string | null;
  toText?: string | null;
  toTestId?: string | null;
  toElementIndex?: number | null;
  toHandle?: string | null;
  toX?: number | null;
  toY?: number | null;
  /** Intermediate mouseMoved events between press and release (1–50). */
  steps?: number | null;
};

export type BuiltInBrowserSelectOptionArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs & {
  value?: string | null;
  label?: string | null;
  index?: number | null;
};

export type BuiltInBrowserUploadFileArgs = BuiltInBrowserAgentActionArgs & BuiltInBrowserElementTargetArgs & {
  paths: string[];
};

/* ── Screen recording ─────────────────────────────────────────────────────── */

export type BuiltInBrowserRecordingFormat = "webm" | "mp4";

export type BuiltInBrowserRecordingStatus = {
  startedAt: string;
  fps: number;
};

export type BuiltInBrowserStartRecordingArgs = BuiltInBrowserTabTargetArgs & {
  /** 30 or 60; anything else is rejected. */
  fps?: number | null;
  /** Supplying a caption is what makes `stopRecording` file a proof entry. */
  caption?: string | null;
};

export type BuiltInBrowserStartRecordingResult = {
  tabId: string;
  recording: BuiltInBrowserRecordingStatus;
  status: BuiltInBrowserStatus;
};

export type BuiltInBrowserStopRecordingArgs = BuiltInBrowserTabTargetArgs;

export type BuiltInBrowserStopRecordingResult = {
  tabId: string;
  path: string;
  relativePath: string | null;
  durationMs: number;
  fps: number;
  frameCount: number;
  format: BuiltInBrowserRecordingFormat;
  mimeType: string;
  caption: string | null;
  /** Reserved for encoders that emit a sidecar manifest; `null` today. */
  manifestPath: string | null;
  status: BuiltInBrowserStatus;
};

/* ── Live preview stream ──────────────────────────────────────────────────── */

/**
 * A cheap "what does this tab look like right now" feed for surfaces that are
 * not the browser panel — the Work tab's floating corner card, mainly.
 *
 * Deliberately NOT the recording pipeline: that negotiates a `getDisplayMedia`
 * grant and an encoder to produce a file. A preview only ever needs a small
 * JPEG at a low frame rate, and `capturePage()` gives us that with no grant, no
 * encoder, and no artefact on disk. It is also refcounted and never started for
 * a tab nobody is watching, so an idle Work tab pays nothing.
 */
export const BUILT_IN_BROWSER_PREVIEW_DEFAULT_FPS = 12;
export const BUILT_IN_BROWSER_PREVIEW_MAX_FPS = 24;
export const BUILT_IN_BROWSER_PREVIEW_DEFAULT_MAX_WIDTH = 480;
export const BUILT_IN_BROWSER_PREVIEW_MAX_WIDTH_LIMIT = 1_280;
/** JPEG quality for preview frames — small enough to shuttle at 12fps. */
export const BUILT_IN_BROWSER_PREVIEW_JPEG_QUALITY = 80;

export type BuiltInBrowserStartPreviewStreamArgs = BuiltInBrowserProjectScopeArgs & {
  /** Defaults to the collection's active tab. */
  tabId?: string | null;
  /** Clamped to `BUILT_IN_BROWSER_PREVIEW_MAX_FPS`. */
  fps?: number | null;
  /** Longest edge of the emitted frame, clamped to the limit above. */
  maxWidth?: number | null;
};

export type BuiltInBrowserStopPreviewStreamArgs = BuiltInBrowserProjectScopeArgs & {
  tabId?: string | null;
};

export type BuiltInBrowserPreviewStreamResult = {
  tabId: string;
  /** Effective loop rate, which is the fastest rate any subscriber asked for. */
  fps: number;
  maxWidth: number;
  /** How many subscribers the loop is now serving; 0 means it stopped. */
  subscribers: number;
};

export function normalizeBuiltInBrowserPreviewFps(value: number | null | undefined): number {
  const fps = typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : BUILT_IN_BROWSER_PREVIEW_DEFAULT_FPS;
  return Math.max(1, Math.min(BUILT_IN_BROWSER_PREVIEW_MAX_FPS, fps));
}

export function normalizeBuiltInBrowserPreviewMaxWidth(value: number | null | undefined): number {
  const width = typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : BUILT_IN_BROWSER_PREVIEW_DEFAULT_MAX_WIDTH;
  return Math.max(80, Math.min(BUILT_IN_BROWSER_PREVIEW_MAX_WIDTH_LIMIT, width));
}
