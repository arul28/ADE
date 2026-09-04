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

/**
 * The host frames this page may ask to follow.
 *
 * `review` is the one this plugin lives on: a coalesced frame naming the run
 * ids that moved, which is what turns the page's own poll off. It is NEW in
 * this wave and a host that predates it refuses the subscription — see
 * `host/liveRuns.ts`, which falls back to the child's poll rather than going
 * quiet.
 */
export type PluginWebviewHostKind = "lane" | "session" | "pr" | "chat" | "review";

export type PluginWebviewHostEvent = {
  kind: PluginWebviewHostKind;
  ids: string[];
  overflow: boolean;
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
 * What `ui.pickModel` answers. `null` is a reader who dismissed the picker.
 *
 * `fastMode` travels with the id because ADE's own picker sets both in one
 * gesture. `provider` is optional extra some hosts still send; the launch does
 * not require it.
 */
export type PluginWebviewModelChoice = { modelId: string; fastMode?: boolean; provider?: string };
export type PluginWebviewLaneChoice = { laneId: string; name: string };
/** `effort` is null when the reader chose "no reasoning". */
export type PluginWebviewReasoningChoice = { modelId?: string; effort: string | null };

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
    on(event: "refresh", listener: () => void): () => void;
  };
  openDeeplink(url: string): Promise<void>;
  openSettings?(target: { entryId: string } | { socketId: string }): Promise<void>;
  surface?: { close(): Promise<void> };
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
     * Open a path in the reader's configured editor.
     *
     * NEW in this wave, and optional here for exactly that reason: the compiled
     * finding card called `window.ade.app.openPathInEditor` and this is its one
     * replacement. A host that does not answer it draws the card unchanged and
     * the button does nothing, which is what the compiled card did when the
     * app bridge had no such verb. See `host/ui.ts:openPathInEditor`.
     */
    openPathInEditor?(request: {
      rootPath: string;
      relativePath?: string;
      target: string;
    }): Promise<void>;
    /**
     * ADE's own model picker, opened as a popover over the guest.
     *
     * The launch form does NOT re-implement the combobox. The compiled
     * `ModelPicker` carries recents, per-provider grouping, brand icons and a
     * fast-mode toggle that a page-local select could only approximate — so the
     * page asks the host to open the real one and takes the answer. Optional,
     * because it is new in this wave; the form falls back to a plain field.
     *
     * `value` preselects the current row. `availableModelIds` is unused here —
     * a review can launch on ADE's whole catalogue.
     */
    pickModel?(request?: {
      value?: string;
      availableModelIds?: string[];
    }): Promise<PluginWebviewModelChoice | null>;
    /** ADE's own lane picker. `value` is the current lane id. */
    pickLane?(request?: { value?: string }): Promise<PluginWebviewLaneChoice | null>;
    /**
     * ADE's own reasoning-effort picker, for one model.
     *
     * `model` is required because the ladder is per MODEL: a model with no
     * reasoning tiers resolves null rather than drawing an empty control.
     * `value` preselects the current rung; null means nothing preselected.
     */
    pickReasoningEffort?(request: {
      model: string;
      value?: string | null;
    }): Promise<PluginWebviewReasoningChoice | null>;
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
 * has to see rather than an empty list they will read as "no review runs".
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
