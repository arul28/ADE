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
 * A rectangle in CSS pixels, relative to the GUEST's own viewport.
 *
 * The guest's viewport, not the window's: the page has no way to know where the
 * host put the frame, and a page that guessed would move the live view every
 * time the reader resized a pane. The host adds its own frame origin — the same
 * arithmetic it already does to position a `<webview>` — so the only number the
 * page is responsible for is the one it can actually measure.
 */
export type PluginWebviewEngineRect = {
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
     * cost. The host clamps what it is told. See
     * `PLUGIN_WEBVIEW_RESIZE_CHANNEL` in `shared/plugins/webviewBridge.ts`.
     */
    resize(size: { height: number }): void;
    /**
     * Open a path in ADE's own editor.
     *
     * STUBBED — the platform half is landing in parallel, so this is declared
     * optional and reached only through the guard in `host/ui.ts`. Electron
     * Control's inspect result carries a `sourceFile` and a `sourceLine`, and
     * this is the verb that would take the reader there. `rootPath` is the
     * project the path is relative to, because a plugin page knows a repo-
     * relative path and never an absolute one.
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
   * A host-owned engine, painted into a rect this page reserves.
   *
   * STUBBED — the platform half is landing in parallel, so the whole member is
   * optional and every call goes through the guard in `host/engine.ts`. A host
   * that lacks it draws a sentence in the reserved element instead, and NEVER
   * throws: the rest of the pane — launch, connect, click, type, inspect — is
   * still a working product without a picture in it.
   *
   * `engineId` names a builtin the HOST owns. This page passes exactly one:
   * `"electron-control"`, the CDP screencast the compiled pane drew inline.
   * The live view stays in the host because the frames are 30fps base64 data
   * URLs off a CDP session, and a guest that had to relay them through the
   * bridge would pay a structured clone per frame.
   */
  hostEngine?: {
    /** Paint `engineId` here. Called again with a new rect whenever it moves. */
    place(request: { engineId: string; rect: PluginWebviewEngineRect }): Promise<void>;
    /** Stop painting. Called on unmount and whenever the placement hides. */
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
 * has to see rather than an idle status they will read as "nothing is running".
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
