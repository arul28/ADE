import type {
  AgentActionTraceEntry,
  AgentDomSnapshot,
  AgentElementSnapshot,
  AgentFrame,
} from "./agentObservation";

export type BuiltInBrowserProvider = "cdp";

export type BuiltInBrowserFrame = AgentFrame;

export type BuiltInBrowserBoundsArgs = BuiltInBrowserFrame & {
  visible: boolean;
  /**
   * How much the pane had to shrink the emulated device to fit, in (0, 1].
   *
   * The fit factor is a fact about the pane's CURRENT size, so it changes on
   * every drag rather than only when a preset is picked — which is why it
   * rides with bounds instead of with the emulation state. Main forwards it as
   * CDP's `scale` on `Emulation.setDeviceMetricsOverride`, so the page still
   * lays out at the device's own width and is drawn smaller, instead of being
   * cropped by a narrower native view.
   */
  scale?: number;
} & BuiltInBrowserProjectScopeArgs;

export type BuiltInBrowserProjectScopeArgs = {
  projectRoot?: string | null;
  /** Keep personal-chat tabs separate without changing the global storage profile. */
  tabCollection?: "personal";
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
  /**
   * The tab was opened with no URL and has not navigated yet, so it is sitting
   * on `about:blank` as a launchpad. Surfaces render their own empty state
   * (recent origins, detected dev servers) instead of a blank page, and the
   * title reads "New tab" rather than the empty document title.
   */
  isLaunchpad: boolean;
  /**
   * Best favicon Chromium reported for the current document: the first http(s)
   * URL, or a `data:` icon under 32 KB. Cleared the moment the tab navigates to
   * a different origin so a stale icon never labels the new page. Main never
   * fetches it — the renderer points an `<img>` at whatever is here.
   */
  faviconUrl: string | null;
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
  /**
   * Present only on an identity-scoped read (`ade browser status` from an
   * agent): the tab has no owner, so it is visible but not yet drivable. The
   * agent has to `claim` it first. Tabs owned by a *different* chat stay hidden
   * entirely — this field never means "someone else's tab".
   */
  claimable?: true;
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

export type BuiltInBrowserElementSnapshot = AgentElementSnapshot;

export type BuiltInBrowserObservationElementMap = {
  filePath: string;
  relativePath: string | null;
  width: number;
  height: number;
  mimeType: string;
  elementCount: number;
  dataUrl?: string;
};

export type BuiltInBrowserDomSnapshot = AgentDomSnapshot;

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

export type BuiltInBrowserActionTraceEntry = AgentActionTraceEntry & { tabId: string };

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

/**
 * What the trusted renderer gets back from a screenshot request.
 *
 * "There is no tab" is an ordinary state of the browser pane, not a failure:
 * a card polling a browser whose last tab was just closed would otherwise turn
 * a normal race into a thrown IPC error on every tick. Agents still get the
 * throw — for them a screenshot of nothing IS a failed request.
 *
 * `"unavailable"` is the same idea one step later: the tab exists, but its view
 * has no compositor surface to photograph — it is parked, hidden, or being torn
 * down. The panel asks for exactly this frame on the way out of every popover
 * and every tool switch, so it is a race it loses routinely and recovers from
 * by keeping its last frame.
 */
export type BuiltInBrowserScreenshotResult =
  | ({ ok: true } & BuiltInBrowserScreenshot)
  | { ok: false; reason: "no_tab" | "unavailable" };

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
      /**
       * Set only when something other than the agent ended the recording: a
       * login handoff suspended capture, or the recording hit its wall-clock
       * cap. Either way the agent that armed it learns the recording stopped
       * without having called `stopRecording`.
       */
      endedBy?: BuiltInBrowserRecordingEndedBy;
      /**
       * The recording tab's title at the moment it stopped.
       *
       * Carried because a `recording` event is filtered by project but not by
       * tab: a background tab hitting the cap raises a toast on top of whatever
       * page the human is actually looking at, and "Recording stopped" with no
       * subject reads as being about that page. `null` for an untitled tab.
       */
      tabTitle?: string | null;
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
  /**
   * A dev server was sniffed out of a terminal session's output. Carries
   * `open-request`-style metadata (url + tab + status) so the corner card can
   * caption "opened localhost:5173 in the background" without polling.
   */
  | {
      type: "dev-server-detected";
      server: DevServerRecord;
      /** The background tab it was opened in, or `null` when nothing opened. */
      tabId: string | null;
      autoOpened: boolean;
      status: BuiltInBrowserStatus;
      detectedAt: string;
    }
  | { type: "error"; message: string; occurredAt: string };

/* ── Dev servers ──────────────────────────────────────────────────────────── */

/**
 * A local dev server ADE noticed in terminal output. Detection is passive: the
 * PTY output pipeline matches the ready lines frameworks already print
 * (`http://localhost:5173`, `Local:   …`, `listening on …`), so nothing probes
 * or fetches anything the user did not already start.
 */
export type DevServerRecord = {
  port: number;
  url: string;
  source: {
    sessionId: string | null;
    laneId: string | null;
    /**
     * The project the detecting terminal belongs to, stamped at detection time.
     *
     * Carried on the record because nothing downstream can recover it: a lane
     * that has never opened a browser tab gives the Browser service no way to
     * tell which project's collection the chip belongs in, and stamping it with
     * whichever window is frontmost puts one project's `localhost` URL in
     * another project's launchpad (every surface filters `dev-server-detected`
     * on `status.collectionProjectRoot`). `null` only for detections that came
     * from no project at all.
     */
    projectRoot: string | null;
  };
  detectedAt: string;
};

export type DevServersArgs = {
  laneId?: string | null;
};

export type DevServersResult = {
  servers: DevServerRecord[];
};

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

/** CDP `Emulation.UserAgentMetadata`, sent alongside a mobile UA override. */
export type BuiltInBrowserUserAgentMetadata = {
  brands: Array<{ brand: string; version: string }>;
  fullVersion: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
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

/**
 * Emulation currently applied to one tab. `null` means "no override".
 *
 * This is also the renderer's letterboxing contract: whenever `emulation` is
 * non-null, `width` / `height` are the *effective* CSS pixel size the page was
 * laid out at, `deviceScaleFactor` the DPR it renders with, `mobile` whether it
 * is in mobile viewport mode, and `label` the human name for the chrome
 * ("iPhone 17 Pro", "820×1180"). The pane sizes the native view to exactly
 * `width × height` CSS px, centers it in the pane, and letterboxes the rest —
 * never stretched, never scaled to fit, so a screenshot an agent takes matches
 * what the human sees.
 */
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
  /** Empty when there was no tab to stop a find on. */
  tabId: string;
  /**
   * False means "there was nothing to stop", not "it failed".
   *
   * The find bar's teardown races tab closure by construction — closing the
   * last tab unmounts the panel, whose cleanup then asks an empty pane to end a
   * find — so an empty pane answers rather than throwing, the same way
   * `captureScreenshot` answers `{ ok: false, reason: "no_tab" }`.
   */
  stopped: boolean;
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

/**
 * The frame rates a recording may run at, and the wall-clock cap on one.
 *
 * These live here rather than next to the recorder because both processes need
 * them and neither can import the other's: main enforces them
 * (`builtInBrowserCapabilities.ts` re-exports them for its call sites) and the
 * renderer renders them — the fps menu in the overflow panel and the
 * "5-minute limit reached" toast. They used to be a main-side pair with a
 * hand-synced renderer copy and a "change both" comment; one home is the
 * point.
 */
export const BUILT_IN_BROWSER_RECORDING_FPS_OPTIONS = [30, 60] as const;

export type BuiltInBrowserRecordingFps = (typeof BUILT_IN_BROWSER_RECORDING_FPS_OPTIONS)[number];

/**
 * Wall-clock cap on a single recording, enforced by the session's own timer.
 *
 * A recording is a `getDisplayMedia` capture of a live tab writing to the
 * project's scratch dir; an agent that forgets to call `stopRecording` (or dies
 * mid-run) would otherwise capture until the app quits. Five minutes is long
 * enough for any "show me this flow" and short enough that the forgotten case
 * costs a bounded file.
 *
 * What the caller sees when it fires: the recording is finalized exactly as a
 * `stopRecording` would have finalized it — same file, same manifest — and the
 * agent is told through two channels rather than a return value it never
 * asked for. A `recording` event carries `endedBy: "max_duration"` (so the
 * pane can say why the REC pill vanished), and a `stopRecording`-shaped entry
 * with the same `endedBy` lands in the tab's action trace, which is where the
 * skill tells an agent to look. A later `stopRecording` then throws
 * `Browser tab <id> is not recording.` A login hand-off is the other automatic
 * ending (`endedBy: "handoff"`), and unlike this one it ABORTS rather than
 * finalizes — see `suspendAgentCaptureForHandoff`. Neither resumes; an agent
 * that wants more has to start a new recording.
 */
export const BUILT_IN_BROWSER_MAX_RECORDING_MS = 5 * 60_000;

/**
 * Query parameters whose value is a credential rather than a request detail.
 *
 * Redacting only headers left the bigger hole open: an IdP callback, a
 * magic-link, and a presigned URL all carry the secret in the query string, and
 * a HAR export explodes every parameter into the file by name and value.
 *
 * Lives in `shared/` rather than beside the HAR writer because the renderer
 * needs the same list: the launchpad's "Recently used" store refuses to
 * persist a URL carrying any of these, and a second hand-maintained copy there
 * would be a list that silently stops matching this one.
 */
export const BUILT_IN_BROWSER_REDACTED_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "code",
  "access_token",
  "id_token",
  "token",
  "state",
  "session",
  "sig",
  "signature",
  "api_key",
  "refresh_token",
  "client_secret",
]);

export function isRedactedBuiltInBrowserQueryParam(name: string): boolean {
  return BUILT_IN_BROWSER_REDACTED_QUERY_PARAMS.has(name.trim().toLowerCase());
}

export type BuiltInBrowserRecordingStatus = {
  startedAt: string;
  fps: number;
};

/**
 * What ended a recording the agent did not stop itself.
 *
 * `max_duration` finalizes the file (the wall-clock cap fired —
 * `BUILT_IN_BROWSER_MAX_RECORDING_MS`); `handoff` aborts it, because a partial
 * capture taken while a human was typing a password is not proof of anything the
 * agent did. Both are surfaced twice: on the `recording` event as `endedBy`, so
 * a pane can explain why the REC pill vanished, and as a `stopRecording`-shaped
 * action-trace entry carrying the same value, so `ade browser trace` explains it
 * to the agent.
 */
export type BuiltInBrowserRecordingEndedBy = "handoff" | "max_duration";

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
/**
 * Geometry for a tab that is being previewed while the panel is showing
 * something else.
 *
 * The view has to stay attached and visible to keep a compositor surface (a
 * detached or hidden `WebContentsView` captures nothing at all), so it is parked
 * this far past the bottom-right corner of the union of every display, where no
 * window on any screen can reach it. The size floors only apply to a panel that
 * was never opened — a zero-sized view would capture an empty image.
 */
export const BUILT_IN_BROWSER_PARKED_PREVIEW_MARGIN = 64;
export const BUILT_IN_BROWSER_PARKED_PREVIEW_MIN_WIDTH = 960;
export const BUILT_IN_BROWSER_PARKED_PREVIEW_MIN_HEIGHT = 600;
/**
 * How long a watched view is held overlapping the window before it is parked.
 *
 * Two frames at 60Hz plus slack: long enough for Chromium to allocate the
 * compositor surface the capture needs, short enough that the single pixel of
 * the page showing at the window's corner is never something anybody sees.
 */
export const BUILT_IN_BROWSER_PREVIEW_WARM_MS = 120;

/**
 * The radius the loaded page itself is rounded to, in the panel's inset frame.
 *
 * A `WebContentsView` is composited ABOVE the renderer, so the frame's CSS
 * `overflow-hidden` cannot mask it: the page stayed a hard rectangle inside a
 * rounded container, and the four corners were the one place the panel visibly
 * stopped being a browser and started being an iframe. Electron's
 * `View.setBorderRadius` is the only thing that can round the native layer.
 *
 * 9, not 10: the view sits one hairline inside the frame's 10px radius, which
 * is the same arithmetic `BrowserStage`'s masking element does — both read this
 * constant so they cannot drift apart.
 */
export const BUILT_IN_BROWSER_VIEW_CORNER_RADIUS = 9;

/**
 * How long window/display geometry has to settle before parked views are
 * repositioned. A live resize drag fires continuously; recomputing on every
 * frame would `setBounds` a dozen views per tick for no visible benefit.
 */
export const BUILT_IN_BROWSER_PARKED_PREVIEW_REPARK_DEBOUNCE_MS = 50;

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
