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
 *    `collections` and nothing else, so every v2 verb is called through a
 *    guard here rather than at two hundred call sites.
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

export type PluginWebviewHostKind = "lane" | "session" | "pr" | "chat" | "operation" | "conflict";

/**
 * One turn's move, on a `chat` frame.
 *
 * `state` is where the turn is — `interrupted` is mapped onto `failed` by the
 * host, so a page has one error path rather than two — and `message` is the
 * host's own failure sentence, present only on `failed`.
 */
export type PluginWebviewChatTurn = {
  sessionId: string;
  state: "started" | "completed" | "failed";
  /** The host's turn id, when the producer knows it. Opaque to the page. */
  turnId?: string;
  message?: string;
};

export type PluginWebviewHostEvent = {
  kind: PluginWebviewHostKind;
  ids: string[];
  overflow: boolean;
  /**
   * Present only on a `chat` frame, and the whole reason that kind exists.
   *
   * A lane or a PR frame says "these ids moved, read them again". A chat frame
   * carries the turns themselves, because there is nothing for a page to
   * re-read: a kickoff that failed leaves a session whose only record of the
   * failure is the event, and the session exists either way.
   *
   * An ARRAY because the frame is coalesced like every other: a batch launch of
   * fifty issues settles fifty turns, and `ids` carries the same session ids
   * for a page that only wants "this session moved".
   */
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

export type PluginWebviewComposerAttach = {
  provider: string;
  issueId: string;
  identifier: string;
  title: string;
  url?: string | null;
};

/** One socket contribution the host is drawing for this page. */
export type PluginWebviewSocketEntry = {
  socketId: string;
  pluginId: string;
  socket: string;
  label?: string | null;
  icon?: string | null;
  /** Everything else the contributing manifest declared, verbatim. */
  data?: Record<string, unknown>;
};

/** Where a lane folder or a file should open. */
export type PluginWebviewEditorTarget = {
  rootPath: string;
  target?: { path?: string; line?: number } | null;
};

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
  };
  /**
   * Third-party contributions on one socket, and pressing one.
   *
   * MISSING on a host older than this wave. `host/sockets.ts` guards both, so a
   * page drawn by an older host simply draws no contributed nodes rather than
   * throwing on open.
   */
  sockets?: {
    list(socket: string): Promise<PluginWebviewSocketEntry[]>;
    invoke(socketId: string, args?: Record<string, unknown>): Promise<unknown>;
  };
  openDeeplink(url: string): Promise<void>;
  openSettings?(target: { entryId: string } | { socketId: string }): Promise<void>;
  surface?: { close(): Promise<void> };
  composer?: {
    attach(issue: PluginWebviewComposerAttach): Promise<void>;
    insert(text: string): Promise<void>;
  };
  ui?: {
    toast(toast: PluginWebviewToast): Promise<{ id: string }>;
    dismissToast(id: string): Promise<void>;
    prompt(prompt: unknown): Promise<unknown>;
    confirm(request: PluginWebviewConfirm): Promise<boolean>;
    /**
     * Report this page's own content height, so a placement sized to its
     * content can grow around it.
     *
     * Synchronous and void, and the only member here that is: it reaches the
     * element hosting the frame directly rather than going through main, so
     * there is nothing to await and a promise per layout tick would be pure
     * cost. The host clamps what it is told. See
     * `PLUGIN_WEBVIEW_RESIZE_CHANNEL` in `shared/plugins/webviewBridge.ts`.
     */
    resize(size: { height: number }): void;
    /**
     * Open a path in the user's editor, or reveal the lane folder.
     *
     * MISSING on a host older than this wave; `host/ui.ts` guards it.
     */
    openPathInEditor?(target: PluginWebviewEditorTarget): Promise<void>;
    /** Host picker popovers. Resolve to `null` when the reader dismissed one. */
    pickLane?(options?: { title?: string; excludeLaneIds?: string[] }): Promise<{ laneId: string } | null>;
  };
  clipboard?: { read(): Promise<string>; write(text: string): Promise<void> };
  theme?: { get(): Promise<PluginWebviewThemeSnapshot> };
  host?: {
    subscribe(options: { kinds: PluginWebviewHostKind[] }): Promise<() => void>;
  };
  /**
   * Present only in the `dialog-picker` placement.
   *
   * The page is drawn INSIDE one of ADE's own dialogs — Create lane, Create PR —
   * and the dialog is waiting on an answer. `submit` gives it one and the
   * dialog writes the issue into its own fields.
   *
   * There is no `cancel`: the dialog around the page has its own, and a page
   * that could dismiss a dialog it merely occupies a band of would be reaching
   * past its placement. Absent in every other placement, so it is called
   * through the guard in `host/ui.ts` rather than reached for directly.
   */
  dialog?: {
    /** `{ issue: null }` clears a previous choice, which a dialog must be able to hear. */
    submit(answer: { issue: PluginWebviewComposerAttach | null }): Promise<void>;
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
 * has to see rather than an empty list they will read as "no issues".
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
 * only as a fallback, for a host that answered a bare handshake — the values it
 * carries (surface id, placement) are the renderer's, not the page's.
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
