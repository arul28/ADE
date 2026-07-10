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
  /** Use the machine-level browser profile even when the sender window has an active project. */
  profileScope?: "global";
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
};

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
  profileKey: string;
  profileProjectRoot: string | null;
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
};

export type BuiltInBrowserStartSessionArgs = BuiltInBrowserClaimArgs;

export type BuiltInBrowserEndSessionArgs = BuiltInBrowserProjectScopeArgs & {
  sessionId: string;
};

export type BuiltInBrowserListSessionsArgs = BuiltInBrowserProjectScopeArgs & {
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
  | { type: "error"; message: string; occurredAt: string };
