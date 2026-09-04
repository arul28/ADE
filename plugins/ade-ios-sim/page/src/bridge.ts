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
 *    guard here rather than at fifty call sites.
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
 * A rectangle in the GUEST's own CSS pixels, with its origin at the guest
 * viewport's top-left.
 *
 * Never device pixels and never screen coordinates: the host owns the frame
 * this page is drawn in, so it is the only half that knows where the guest
 * viewport sits on the display, and a page that tried to answer that question
 * would be guessing at a number the host already has.
 */
export type HostEngineRect = {
  x: number;
  y: number;
  width: number;
  height: number;
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
    on(event: "refresh", listener: () => void): () => void;
  };
  openDeeplink(url: string): Promise<void>;
  openSettings?(target: { entryId: string } | { socketId: string }): Promise<void>;
  surface?: { close(): Promise<void> };
  ui?: {
    toast(toast: PluginWebviewToast): Promise<{ id: string }>;
    dismissToast(id: string): Promise<void>;
    confirm(request: PluginWebviewConfirm): Promise<boolean>;
    /**
     * Report this page's own content height, so a placement sized to its
     * content can grow around it.
     *
     * Synchronous and void, and the only member here that is: it reaches the
     * element hosting the frame directly rather than going through main, so
     * there is nothing to await and a promise per layout tick would be pure
     * cost. The host clamps what it is told.
     */
    resize(size: { height: number }): void;
    /**
     * Open a path in the reader's editor.
     *
     * STUBBED CONTRACT — another agent is landing the host half in parallel, so
     * it is optional here and reached only through the guard in `host/ui.ts`.
     * A `#Preview` and a selected element both name a Swift file, and "Open
     * Xcode" in the compiled Preview Lab is the host's own open, not the
     * page's: a guest cannot spawn an editor and must not be able to.
     */
    openPathInEditor?(request: {
      rootPath: string;
      relativePath?: string;
      target: string;
    }): Promise<void>;
  };
  clipboard?: { read(): Promise<string>; write(text: string): Promise<void> };
  theme?: { get(): Promise<PluginWebviewThemeSnapshot> };
  /**
   * The host-owned engine this page reserves a rect for.
   *
   * STUBBED CONTRACT — another agent is landing the host half in parallel.
   *
   * The live simulator screen is a `Simulator.app` window capture: a
   * `MediaStream` from `desktopCapture`, painted into a `<video>`, at 60fps,
   * with a window-parking claim behind it. None of that can cross into a guest
   * — a plugin page has no `getUserMedia` for a desktop source, no window
   * handle and no claim to park — so the stream STAYS in the host and this page
   * only tells it where to draw.
   *
   * `place` is idempotent and coalescing: the page calls it whenever the
   * reserved rect changes and the host redraws at the newest rect it was given.
   * `release` takes the painter away, and must be called on unmount and
   * whenever the reserved element stops being visible, or the host would keep
   * painting over chrome that has moved.
   *
   * Absent on a host that has no engine to place. Every call goes through
   * `host/engine.ts`, which degrades to a message rather than throwing.
   */
  hostEngine?: {
    place(placement: { engineId: string; rect: HostEngineRect }): Promise<void>;
    release(): Promise<void>;
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
 * has to see rather than an empty device list they will read as "this Mac has
 * no simulators".
 */
export function requireBridge(): AdePluginBridge {
  const api = bridge();
  if (!api) throw new Error("This page is not running inside ADE.");
  return api;
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
