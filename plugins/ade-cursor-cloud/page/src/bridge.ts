/**
 * `window.adePlugin`, typed, plus the one fact the host puts on the URL.
 *
 * The page talks to ADE through exactly this module. Nothing else in `src/`
 * touches `window.adePlugin`, for two reasons that are not style:
 *
 * 1. The seam test scripts a fake bridge and asserts every call and its
 *    arguments. A component that reached for the global directly would be
 *    outside what that test can see.
 * 2. The bridge is versioned and additive. A v1 host answers `invoke` and
 *    `collections` and nothing else, so every later verb is called through a
 *    guard here rather than at a hundred call sites.
 *
 * See `apps/desktop/src/shared/plugins/webviewBridge.ts` for the contract.
 */

export type PluginWebviewPlacement =
  | "tab"
  | "pane"
  | "drawer"
  | "overlay"
  | "popover"
  | "settings-section"
  | "composer-picker"
  | "dialog-picker";

export type PluginWebviewProjectContext = {
  projectId: string | null;
  root: string | null;
  binding: "local" | "remote";
};

export type PluginWebviewContext = {
  subject: { kind: string; [key: string]: unknown } | null;
  pointer?: Record<string, unknown>;
  surfaceId?: string;
  placement?: PluginWebviewPlacement;
  project?: PluginWebviewProjectContext | null;
};

export type PluginWebviewThemeSnapshot = {
  scheme: "dark" | "light";
  tokens: Record<string, string>;
};

export type PluginWebviewHostKind = "lane" | "session" | "pr" | "chat";

export type PluginWebviewChatTurn = {
  sessionId: string;
  state: "started" | "completed" | "failed";
  turnId?: string;
  message?: string;
};

export type PluginWebviewHostEvent = {
  kind: PluginWebviewHostKind;
  ids: string[];
  overflow: boolean;
  turns?: PluginWebviewChatTurn[];
};

export type PluginWebviewChangeEvent = {
  kind: string;
  panelId?: string;
  collection?: string;
};

export type PluginWebviewToast = {
  level: "info" | "success" | "warning" | "error";
  message: string;
  actionLabel?: string;
  actionId?: string;
};

export type PluginWebviewConfirm = {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

/**
 * What the five host pickers answer.
 *
 * These shapes are ADE's, copied from `shared/plugins/webviewBridge.ts`. A
 * page that flattened them to `{ id, label }` would drop `fastMode` off a
 * model choice and then look for `id` on an answer that only has `modelId` —
 * which is a successful pick the form would treat as a dismissal.
 */
export type PluginWebviewModelChoice = { modelId: string; fastMode: boolean };
export type PluginWebviewLaneChoice = { laneId: string; name: string };
export type PluginWebviewPermissionModeChoice = {
  provider: string;
  field: string;
  value: string;
};
export type PluginWebviewReasoningEffortChoice = {
  modelId: string;
  effort: string | null;
};
export type PluginWebviewProviderChoice = { provider: string };

export type AdePluginBridge = {
  readonly version: number;
  readonly pluginId: string;
  readonly context: PluginWebviewContext | null;
  collections: {
    get(collection: string, key: string): Promise<unknown>;
    put(collection: string, key: string, value: unknown): Promise<void>;
    list(
      collection: string,
      options?: { keyPrefix?: string; limit?: number; after?: string },
    ): Promise<{ key: string; value: unknown }[]>;
  };
  invoke(action: string, args?: Record<string, unknown>): Promise<unknown>;
  config: {
    get(): Promise<Record<string, string | number | boolean | null>>;
    set(
      key: string | Record<string, string | number | boolean | null>,
      value?: string | number | boolean | null,
    ): Promise<Record<string, string | number | boolean | null>>;
  };
  events: {
    on(event: "changed", listener: (payload: PluginWebviewChangeEvent) => void): () => void;
    on(event: "theme", listener: (payload: PluginWebviewThemeSnapshot) => void): () => void;
    on(event: "host", listener: (payload: PluginWebviewHostEvent) => void): () => void;
    /**
     * The reader pulled the page down on a phone.
     *
     * A gesture, not a data frame: it carries nothing, and the only correct
     * answer is to re-read whatever this surface reads. Called through
     * `host/refresh.ts` because a host too old to know the name may throw.
     */
    on(event: "refresh", listener: () => void): () => void;
  };
  openDeeplink(url: string): Promise<void>;
  openSettings?(target: { entryId: string } | { socketId: string }): Promise<void>;
  surface?: { close(): Promise<void> };
  composer?: {
    insert(text: string): Promise<void>;
  };
  ui?: {
    toast(toast: PluginWebviewToast): Promise<{ id: string }>;
    dismissToast(id: string): Promise<void>;
    prompt(prompt: unknown): Promise<unknown>;
    confirm(request: PluginWebviewConfirm): Promise<boolean>;
    /**
     * Report this page's own content height, so a placement sized to its
     * content can grow around it. Synchronous and void: it reaches the element
     * hosting the frame directly, and the host clamps what it is told.
     */
    resize(size: { height: number }): void;
    /**
     * ADE's own pickers, opened as a popover over the guest.
     *
     * Argument and answer shapes match `webviewBridge.ts`. Every verb is
     * optional: a host that answers none leaves the page on its own inline
     * lists, which is why the fallbacks in `host/pickers.ts` are not dead code.
     */
    pickModel?(
      request?: { value?: string; availableModelIds?: string[] },
    ): Promise<PluginWebviewModelChoice | null>;
    pickLane?(request?: { value?: string }): Promise<PluginWebviewLaneChoice | null>;
    pickPermissionMode?(
      request: { provider: string; value?: string },
    ): Promise<PluginWebviewPermissionModeChoice | null>;
    pickReasoningEffort?(
      request: { model: string; value?: string | null },
    ): Promise<PluginWebviewReasoningEffortChoice | null>;
    pickProvider?(request?: { value?: string }): Promise<PluginWebviewProviderChoice | null>;
  };
  clipboard?: { read(): Promise<string>; write(text: string): Promise<void> };
  theme?: { get(): Promise<PluginWebviewThemeSnapshot> };
  host?: {
    subscribe(options: { kinds: PluginWebviewHostKind[] }): Promise<() => void>;
  };
};

declare global {
  interface Window {
    adePlugin?: AdePluginBridge;
  }
}

/** The bridge, or null when the page is opened outside a guest. */
export function bridge(): AdePluginBridge | null {
  return typeof window === "undefined" ? null : window.adePlugin ?? null;
}

/**
 * The bridge, or a throw.
 *
 * Used by the data verbs, where "there is no host" is a load failure the reader
 * has to see rather than an empty list they will read as "no cloud agents".
 */
export function requireBridge(): AdePluginBridge {
  const api = bridge();
  if (!api) throw new Error("This page is not running inside ADE.");
  return api;
}

/** Whether the host is new enough to answer a v2 verb. */
export function hasBridgeV2(): boolean {
  return (bridge()?.version ?? 1) >= 2;
}

/**
 * The host's injected context.
 *
 * `adePlugin.context` is the host's own word, captured at attach and
 * unforgeable. The `__adeCtx` query parameter is the SAME envelope and is read
 * only as a fallback, for a host that answered a bare handshake.
 */
export function pageContext(): PluginWebviewContext {
  const fromHost = bridge()?.context ?? null;
  if (fromHost) return fromHost;
  if (typeof window === "undefined") return { subject: null };
  try {
    const raw = new URL(window.location.href).searchParams.get("__adeCtx");
    if (!raw) return { subject: null };
    const parsed = JSON.parse(raw) as PluginWebviewContext;
    return parsed && typeof parsed === "object" ? parsed : { subject: null };
  } catch {
    return { subject: null };
  }
}
