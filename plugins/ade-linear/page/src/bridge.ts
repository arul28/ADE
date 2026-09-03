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

export type PluginWebviewHostKind = "lane" | "session" | "pr" | "chat";

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

/**
 * One answer from a host picker: the value a launch carries, and its own word
 * for it.
 *
 * `id` is what goes in the launch argument and `label` is what the chip prints.
 * They are separate because a launch argument is a provider's own spelling
 * (`acceptEdits`, `gpt-5.6-sol`) and a chip that printed those would be reading
 * the reader an identifier.
 */
export type PluginWebviewChoice = {
  id: string;
  label: string;
  /** Present on a model or a permission answer: which provider it belongs to. */
  provider?: string | null;
};

export type PluginWebviewLaneChoice = PluginWebviewChoice & {
  /** The lane's branch, for the chip's second line. Null for a lane with none. */
  branchRef?: string | null;
  /** The lane's worktree on this machine, or null for a remote binding. */
  path?: string | null;
};

export type PluginWebviewModelPickRequest = {
  /** Narrow the list to one provider. Omitted means every provider ADE has. */
  provider?: string | null;
  /** The id to open on, so the popover starts at the reader's current choice. */
  selected?: string | null;
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
  openDeeplink(url: string): Promise<void>;
  openSettings?(target: { entryId: string } | { socketId: string }): Promise<void>;
  surface?: { close(): Promise<void> };
  composer?: {
    attach(issue: PluginWebviewComposerAttach): Promise<void>;
    insert(text: string): Promise<void>;
  };
  ui?: {
    toast(toast: PluginWebviewToast): Promise<{ id: string }>;
    /**
     * The host's own pickers, opened as a popover over the page.
     *
     * Five verbs, and the reason they are the host's rather than the page's is
     * the reason the page tier exists at all: a model list, a lane list, a
     * provider's permission vocabulary and a model's reasoning ladder are ADE's
     * facts, and every plugin that redrew them drew a control that looked
     * almost like the app's and drifted from it on the next release. The page
     * asks for a choice and renders what comes back.
     *
     * `null` is the reader dismissing the popover, which is not the same as
     * choosing nothing: a dismissal leaves the current value alone, and
     * "whatever the provider defaults to" is an option inside the picker.
     *
     * Every one is optional, because a host older than this contract answers
     * none of them — the page draws the chip disabled there rather than falling
     * back to a control of its own.
     */
    pickModel?(request?: PluginWebviewModelPickRequest): Promise<PluginWebviewChoice | null>;
    pickProvider?(request?: { selected?: string | null }): Promise<PluginWebviewChoice | null>;
    pickLane?(request?: { selected?: string | null }): Promise<PluginWebviewLaneChoice | null>;
    pickPermissionMode?(request: { provider: string; selected?: string | null }): Promise<PluginWebviewChoice | null>;
    pickReasoningEffort?(
      request: { provider: string; model: string; selected?: string | null },
    ): Promise<PluginWebviewChoice | null>;
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
