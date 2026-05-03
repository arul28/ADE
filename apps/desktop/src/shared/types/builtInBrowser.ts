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

export type BuiltInBrowserNavigateArgs = {
  url: string;
};

export type BuiltInBrowserStatus = {
  attached: boolean;
  partition: "persist:ade-browser";
  visible: boolean;
  bounds: BuiltInBrowserFrame;
  url: string | null;
  title: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isInspecting: boolean;
  hasSelection: boolean;
};

export type BuiltInBrowserScreenshot = {
  capturedAt: string;
  width: number;
  height: number;
  dataUrl: string;
};

export type BuiltInBrowserContextItem = {
  kind: "built_in_browser_element";
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
  | { type: "selection"; item: BuiltInBrowserContextItem }
  | { type: "selection-cleared"; item: null; clearedAt: string }
  | { type: "error"; message: string; occurredAt: string };
