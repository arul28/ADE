export type BuiltInBrowserProvider = "cdp";

export type BuiltInBrowserFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BuiltInBrowserBoundsArgs = BuiltInBrowserFrame & {
  visible: boolean;
};

export type BuiltInBrowserAttachWebviewArgs = {
  tabId: string;
  webContentsId: number;
};

export type BuiltInBrowserClaimArgs = {
  laneId?: string | null;
  chatSessionId?: string | null;
};

export type BuiltInBrowserNavigateArgs = BuiltInBrowserClaimArgs & {
  url: string;
  tabId?: string | null;
  newTab?: boolean;
  openPanel?: boolean;
};

export type BuiltInBrowserTab = {
  id: string;
  url: string | null;
  title: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

export type BuiltInBrowserStatus = {
  attached: boolean;
  partition: "persist:ade-browser";
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
};

export type BuiltInBrowserTabArgs = BuiltInBrowserClaimArgs & {
  tabId: string;
  openPanel?: boolean;
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

export type BuiltInBrowserSelectPointArgs = {
  x: number;
  y: number;
  includeScreenshot?: boolean;
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
