/**
 * The host half of `window.adePlugin` — see `shared/plugins/webviewBridge.ts`
 * for the contract this implements.
 *
 * ## The one rule
 *
 * **The plugin id comes from the sender, never from the payload.** Every call
 * is answered against the id derived from the guest's own frame URL
 * (`ade-plugin://<pluginId>/…`), cross-checked against what the window layer
 * recorded when it approved the attach. A page cannot change either: the origin
 * is fixed by the URL the host loaded, and the registry entry was written
 * before the page ran a line of script. `PluginWebviewRequest` carries no
 * `pluginId` field at all, so a payload that invents one is not "overridden" —
 * it is simply never read.
 *
 * ## Why the write path is not the action domain
 *
 * Reads go through the ordinary `plugin` action domain, the same one the
 * renderer and the CLI use. Writing a collection has no domain action and does
 * not get one here: `PLUGIN_DOMAIN_ACTIONS` is a closed list mirrored by the
 * RPC schema and iOS's compile-time allowlist, and a write action on it would
 * let any client write any plugin's rows. The bridge instead reaches the host
 * service's own writer, which applies the SAME manifest-declared-collection
 * rule `pluginSdkServer.ts` applies to a plugin's own child process — an
 * undeclared collection is refused rather than created, so `plugin.json` stays
 * an honest description of what a plugin stores.
 *
 * Electron-free by construction: the sender arrives as an id plus a URL, and
 * every effect (navigate, open externally, push) is an injected function.
 */

import { IPC } from "../../../shared/ipc";
import { isRecord } from "../../../shared/plugins/parse";
import {
  assertPluginCollectionKey,
  assertPluginCollectionName,
  budgetExceeded,
  buildPluginActionPromptAnswer,
  PLUGIN_CLIPBOARD_TEXT_MAX_BYTES,
  PLUGIN_COMPOSER_TEXT_MAX_BYTES,
  PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN,
  PluginSdkError,
  pluginUtf8ByteLength,
  readPluginActionAuthSession,
  readPluginActionComposerEdit,
  readPluginActionMessage,
  readPluginActionNavigation,
  readPluginActionOpenSettings,
  readPluginActionOpenUrl,
  readPluginActionPrompt,
  type PluginActionPrompt,
  type PluginActionPromptAnswer,
  type PluginCollectionRow,
  type PluginDomainService,
} from "../../../shared/plugins/sdk";
import {
  isPluginWebviewHostKind,
  isPluginWebviewMethod,
  isPluginWebviewToastLevel,
  parsePluginWebviewUrl,
  pluginWebviewUiTimeoutMs,
  PLUGIN_WEBVIEW_BRIDGE_VERSION,
  PLUGIN_WEBVIEW_CONFIRM_BODY_MAX_CHARS,
  PLUGIN_WEBVIEW_CONFIRM_TITLE_MAX_CHARS,
  PLUGIN_WEBVIEW_CHAT_TURNS_MAX,
  PLUGIN_WEBVIEW_HOST_COALESCE_MS,
  PLUGIN_WEBVIEW_HOST_IDS_MAX,
  PLUGIN_WEBVIEW_LIST_MAX_ROWS,
  PLUGIN_WEBVIEW_TOAST_LABEL_MAX_CHARS,
  PLUGIN_WEBVIEW_TOAST_MESSAGE_MAX_CHARS,
  sanitizePluginWebviewChatTurn,
  sanitizePluginWebviewTheme,
  type PluginWebviewChangeEvent,
  type PluginWebviewChatTurn,
  type PluginWebviewComposerAttach,
  type PluginWebviewConfirm,
  type PluginWebviewDialogSubmit,
  type PluginWebviewEventFrame,
  type PluginWebviewEventName,
  type PluginWebviewHandshake,
  type PluginWebviewHostEvent,
  type PluginWebviewHostKind,
  type PluginWebviewMethod,
  type PluginWebviewProjectContext,
  type PluginWebviewReloadEvent,
  type PluginWebviewThemeSnapshot,
  type PluginWebviewToast,
  type PluginWebviewUiRequest,
  type PluginWebviewUiVerb,
} from "../../../shared/plugins/webviewBridge";
import { subscribeToPluginEntityChanges } from "./pluginEntityChanges";
import { subscribeToPluginChanges } from "./pluginEvents";
import {
  getPluginWebviewGuest,
  guestKeyOf,
  listAllPluginWebviewGuests,
  guestPlacement,
  guestSurfaceId,
  listPluginWebviewGuests,
  type PluginWebviewGuest,
} from "./pluginWebviewGuests";

/**
 * The slice of the plugin domain a page can reach.
 *
 * A `Pick` rather than the whole service because this is also the shape of what
 * a routed caller has to be able to answer, and naming four methods keeps that
 * obligation small and visible.
 */
export type PluginWebviewDomain = Pick<
  PluginDomainService,
  "get" | "getCollection" | "getManifest" | "invoke"
>;

export type PluginWebviewSender = {
  /** `event.sender.id`. The only identity an IPC message carries. */
  webContentsId: number;
  /** `event.senderFrame?.url ?? event.sender.getURL()`. */
  frameUrl: string;
};

export type PluginWebviewBridgeDeps = {
  /** The plugin domain, scoped the way the guest's host window is scoped. */
  domainFor: (guest: PluginWebviewGuest) => PluginWebviewDomain | Promise<PluginWebviewDomain>;
  /** The collections writer. See the module header for why it is separate. */
  putCollection: (args: {
    guest: PluginWebviewGuest;
    collection: string;
    key: string;
    value: unknown;
  }) => void | Promise<void>;
  /**
   * The settings writer. Separate from the domain for the same reason
   * `putCollection` is: `plugin.setConfig` restarts the plugin, which is right
   * for ADE's own form and fatal for a page that is part of the plugin.
   */
  setConfig: (args: {
    guest: PluginWebviewGuest;
    values: Record<string, unknown>;
  }) => Record<string, string | number | boolean | null>
    | Promise<Record<string, string | number | boolean | null>>;
  /** Dispatch an `ade://` deeplink into the app. */
  openDeeplink: (args: { guest: PluginWebviewGuest; url: string }) => void | Promise<void>;
  /** Send an `https:`/`http:` URL to the user's real browser. */
  openExternalUrl: (url: string) => void | Promise<void>;
  /**
   * Hand one relayed request to the window that owns the guest.
   *
   * Returns false when there is no such window, which the page hears as a
   * refusal rather than a ten-second wait for a reply nobody will send. The
   * window answers on `IPC.pluginWebviewUiResponse`, which the host pumps back
   * in through {@link PluginWebviewBridgeServer.handleUiResponse}.
   */
  sendUiRequest: (args: {
    guest: PluginWebviewGuest;
    request: PluginWebviewUiRequest;
  }) => boolean;
  /** The machine clipboard. Main owns it, so main answers it. */
  readClipboard: () => string | Promise<string>;
  writeClipboard: (text: string) => void | Promise<void>;
  /**
   * The project the guest's window is bound to, or null.
   *
   * Read at handshake for `context.project` and again for the host-entity
   * subscription, which delivers only changes from this guest's own checkout.
   */
  projectFor: (guest: PluginWebviewGuest) => PluginWebviewProjectContext | null;
  /** Tell every window a plugin's installed bytes moved. See item 5 of the spec. */
  sendReload: (event: PluginWebviewReloadEvent) => void;
  /**
   * Present a sign-in a plugin action asked for. Defaults to opening the
   * host-stamped URL in the user's real browser, which is what desktop does for
   * both transports.
   */
  openAuthSession?: (args: {
    guest: PluginWebviewGuest;
    session: { sessionId: string; url: string; transport: string };
  }) => void | Promise<void>;
  /**
   * Schedule work, returning its canceller. Injected so a test drives the
   * coalescing window and the relay timeout without a real clock.
   */
  setTimer?: (run: () => void, ms: number) => () => void;
  log?: (event: string, fields: Record<string, unknown>) => void;
};

export type PluginWebviewBridgeServer = {
  handle(sender: PluginWebviewSender, payload: unknown): Promise<unknown>;
  /** The pinned plugin id for a sender, or null. Exposed for the handshake. */
  resolvePluginId(sender: PluginWebviewSender): string | null;
  /**
   * The whole attach-time handshake for a sender: the pinned plugin id and the
   * subject the host attached the guest to. Null when the sender is not a plugin
   * surface — the same grounds every method call would be refused on.
   */
  resolveHandshake(sender: PluginWebviewSender): PluginWebviewHandshake | null;
  /**
   * The owning window's answer to one relayed request. Unknown or duplicate
   * request ids are dropped: a second answer must not resolve a promise that a
   * later request has since taken the same slot for.
   */
  handleUiResponse(payload: unknown): void;
  /**
   * The renderer's current theme, for one window. Cached and pushed to that
   * window's guests as the `theme` event.
   */
  publishTheme(hostWindowId: number | null, payload: unknown): void;
  /**
   * One chat turn's move, published by the renderer of the window it happened
   * in, for that window's guests subscribed to the `chat` kind.
   *
   * It arrives the way the theme does rather than off `subscribeToPluginEntityChanges`
   * for a reason worth stating: that bus is a module-level emitter only the
   * `ade-cli` daemon publishes on, so in the Electron main process — where this
   * server actually runs — it is silent in a shipping build. A `chat` frame fed
   * from it would work in a test and never fire for a user. The renderer that
   * owns the conversation is the one party that knows a turn started or died,
   * so it is the publisher.
   */
  publishChatTurn(hostWindowId: number | null, payload: unknown): void;
  dispose(): void;
};

function requireString(params: Record<string, unknown>, field: string): string {
  const value = params[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new PluginSdkError("invalid_args", `"${field}" must be a non-empty string.`);
  }
  return value;
}

/** A bounded, trimmed string, or undefined. Used for every relayed label. */
function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

/**
 * Read a toast a page asked for, or refuse.
 *
 * Bounded here rather than in the renderer because a toast is ADE's own chrome:
 * a plugin that could write a 50,000-character message would be drawing over
 * the app, and the renderer would have to re-derive the same ceiling to stop it.
 */
export function readPluginWebviewToast(params: Record<string, unknown>): PluginWebviewToast {
  const raw = isRecord(params.toast) ? params.toast : params;
  const level = isPluginWebviewToastLevel(raw.level) ? raw.level : "info";
  const message = boundedText(raw.message, PLUGIN_WEBVIEW_TOAST_MESSAGE_MAX_CHARS);
  if (!message) throw new PluginSdkError("invalid_args", '"message" must be a non-empty string.');
  const actionLabel = boundedText(raw.actionLabel, PLUGIN_WEBVIEW_TOAST_LABEL_MAX_CHARS);
  const actionId = boundedText(raw.actionId, PLUGIN_WEBVIEW_TOAST_LABEL_MAX_CHARS);
  return {
    level,
    message,
    // A label with no action is a button that does nothing, and an action with
    // no label is a button nobody can see. Both halves or neither.
    ...(actionLabel && actionId ? { actionLabel, actionId } : {}),
  };
}

/** Read a confirmation request, or refuse. Same bounding argument as the toast. */
export function readPluginWebviewConfirm(params: Record<string, unknown>): PluginWebviewConfirm {
  const raw = isRecord(params.confirm) ? params.confirm : params;
  const title = boundedText(raw.title, PLUGIN_WEBVIEW_CONFIRM_TITLE_MAX_CHARS);
  if (!title) throw new PluginSdkError("invalid_args", '"title" must be a non-empty string.');
  const body = boundedText(raw.body, PLUGIN_WEBVIEW_CONFIRM_BODY_MAX_CHARS);
  const confirmLabel = boundedText(raw.confirmLabel, PLUGIN_WEBVIEW_TOAST_LABEL_MAX_CHARS);
  const cancelLabel = boundedText(raw.cancelLabel, PLUGIN_WEBVIEW_TOAST_LABEL_MAX_CHARS);
  return {
    title,
    ...(body ? { body } : {}),
    ...(confirmLabel ? { confirmLabel } : {}),
    ...(cancelLabel ? { cancelLabel } : {}),
    ...(raw.destructive === true ? { destructive: true } : {}),
  };
}

/**
 * Read the issue a page asked to attach to the composer, or refuse.
 *
 * `url` is dropped rather than refused when it is not `http(s):` — a chip
 * without a link still names the right issue, and a chip carrying a `file:` or
 * `javascript:` href would be a way out of the sandbox through ADE's own UI.
 */
export function readPluginWebviewComposerAttach(
  params: Record<string, unknown>,
): PluginWebviewComposerAttach {
  const raw = isRecord(params.issue) ? params.issue : params;
  const provider = boundedText(raw.provider, 64);
  const issueId = boundedText(raw.issueId, 256);
  const identifier = boundedText(raw.identifier, 64);
  const title = boundedText(raw.title, 400);
  if (!provider || !issueId || !identifier || !title) {
    throw new PluginSdkError(
      "invalid_args",
      "An attached issue needs a provider, an issueId, an identifier and a title.",
    );
  }
  let url: string | null = null;
  if (typeof raw.url === "string" && raw.url.length > 0 && raw.url.length <= 2048) {
    try {
      const parsed = new URL(raw.url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") url = parsed.toString();
    } catch {
      url = null;
    }
  }
  return { provider, issueId, identifier, title, ...(url ? { url } : {}) };
}

/**
 * Read a dialog answer, or refuse.
 *
 * `{issue: null}` is the one shape that is not an issue and is still valid: it
 * is how a page says the reader CLEARED their choice, which a dialog must be
 * able to hear or a selection made inside the page could never be undone. Every
 * other shape goes through {@link readPluginWebviewComposerAttach}, deliberately
 * — the composer chip and the dialog answer are the same five facts, and two
 * readers for one record is how they drift.
 */
export function readPluginWebviewDialogSubmit(
  params: Record<string, unknown>,
): PluginWebviewDialogSubmit {
  if (params.issue === null) return { issue: null };
  return { issue: readPluginWebviewComposerAttach(params) };
}

/**
 * The prompt answer a window sent back, or null.
 *
 * Rebuilt through `buildPluginActionPromptAnswer` rather than passed through,
 * so a page gets the same shape — and the same ceiling refusal — a socket
 * press's re-invocation gets. An over-ceiling answer is null: the client was
 * supposed to refuse the submit, and honouring it here would write a note the
 * host says is too long.
 */
export function readPluginWebviewPromptAnswer(
  prompt: PluginActionPrompt,
  value: unknown,
): PluginActionPromptAnswer | null {
  if (!isRecord(value)) return null;
  const text = typeof value.text === "string" ? value.text : null;
  if (text === null) return null;
  return buildPluginActionPromptAnswer(prompt, text);
}

/**
 * Resolve the guest a message came from, or refuse.
 *
 * Two independent facts have to agree: the frame's own origin, and the registry
 * entry the window layer wrote when it approved the attach. Either alone would
 * be enough on a good day — the disagreement is what a compromised renderer
 * attaching a guest it forged, or a stale registry entry on a recycled
 * webContents id, would look like.
 */
export function resolvePluginWebviewSender(sender: PluginWebviewSender): PluginWebviewGuest {
  const guest = getPluginWebviewGuest(sender.webContentsId);
  if (!guest) {
    throw new PluginSdkError("not_permitted", "This page is not a plugin surface.");
  }
  const parsed = parsePluginWebviewUrl(sender.frameUrl);
  if (!parsed || parsed.pluginId !== guest.pluginId) {
    throw new PluginSdkError("not_permitted", "This page is not a plugin surface.");
  }
  return guest;
}

export function createPluginWebviewBridgeServer(
  deps: PluginWebviewBridgeDeps,
): PluginWebviewBridgeServer {
  const log = deps.log ?? (() => {});
  const setTimer = deps.setTimer ?? ((run: () => void, ms: number) => {
    const handle = setTimeout(run, ms);
    return () => clearTimeout(handle);
  });

  // -------------------------------------------------------------------------
  // The relay to the owning window
  // -------------------------------------------------------------------------

  type Pending = {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
    cancelTimer: () => void;
  };
  const pendingUi = new Map<string, Pending>();
  let requestSeq = 0;

  const settle = (requestId: string): Pending | null => {
    const pending = pendingUi.get(requestId);
    if (!pending) return null;
    pendingUi.delete(requestId);
    pending.cancelTimer();
    return pending;
  };

  /**
   * Ask the guest's own window to do something, and wait for its answer.
   *
   * Refused before it is sent when the guest's surface is not on screen. A
   * dismissed popover whose page is still running must not be able to open a
   * settings page or attach to the composer on its way out — the reader closed
   * it, and that is the answer.
   */
  const relay = (
    guest: PluginWebviewGuest,
    verb: PluginWebviewUiVerb,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    if (!guest.attached) {
      throw new PluginSdkError("not_permitted", "This page's surface is not open.");
    }
    if (guest.hostWindowId == null) {
      throw new PluginSdkError("not_permitted", "This page has no ADE window to act in.");
    }
    requestSeq += 1;
    const requestId = `${guest.pluginId}:${guest.webContentsId}:${requestSeq}`;
    const request: PluginWebviewUiRequest = {
      requestId,
      guestKey: guestKeyOf(guest),
      pluginId: guest.pluginId,
      surfaceId: guestSurfaceId(guest),
      placement: guestPlacement(guest),
      verb,
      args,
    };
    return new Promise<unknown>((resolve, reject) => {
      const cancelTimer = setTimer(() => {
        const pending = settle(requestId);
        if (!pending) return;
        log("plugin.webview_ui_timeout", { pluginId: guest.pluginId, verb });
        pending.reject(new PluginSdkError("internal_error", "ADE did not answer that in time."));
      }, pluginWebviewUiTimeoutMs(verb));
      pendingUi.set(requestId, { resolve, reject, cancelTimer });
      let delivered = false;
      try {
        delivered = deps.sendUiRequest({ guest, request });
      } catch {
        delivered = false;
      }
      if (!delivered) {
        const pending = settle(requestId);
        pending?.reject(new PluginSdkError("not_permitted", "This page has no ADE window to act in."));
      }
    });
  };

  // -------------------------------------------------------------------------
  // Pushes to a guest
  // -------------------------------------------------------------------------

  const push = (guest: PluginWebviewGuest, event: PluginWebviewEventName, payload: unknown): void => {
    const frame: PluginWebviewEventFrame = { event, payload };
    try {
      guest.send(IPC.pluginWebviewEvent, frame);
    } catch {
      // A guest that went away between the lookup and the send loses its
      // notification, not the change that produced it.
    }
  };

  // -------------------------------------------------------------------------
  // Theme
  // -------------------------------------------------------------------------

  /**
   * The last theme each window published, plus the last one ANY window did.
   *
   * The fallback matters on the first paint of a guest in a window that has not
   * published yet: a page that asked for the theme and got nothing would draw
   * itself in whatever it hard-coded, which is the flash of the wrong palette
   * this whole verb exists to prevent.
   */
  const themeByWindow = new Map<number, PluginWebviewThemeSnapshot>();
  let lastTheme: PluginWebviewThemeSnapshot | null = null;

  const themeFor = (guest: PluginWebviewGuest): PluginWebviewThemeSnapshot => {
    const windowTheme = guest.hostWindowId == null ? null : themeByWindow.get(guest.hostWindowId);
    return windowTheme ?? lastTheme ?? { scheme: "dark", tokens: {} };
  };

  // -------------------------------------------------------------------------
  // host.subscribe
  // -------------------------------------------------------------------------

  type HostSubscription = {
    guest: PluginWebviewGuest;
    kinds: Set<PluginWebviewHostKind>;
    /**
     * Ids gathered since the last flush, per family.
     *
     * `turns` is set on the `chat` entry alone and is what makes that family
     * different: an entity id is a bare "this moved", but a turn carries a
     * STATE, and two states for one session inside one window are not both
     * true. Keyed by session id so the last one written wins, while `ids` keeps
     * the insertion order the frame reports.
     */
    buffer: Map<
      PluginWebviewHostKind,
      { ids: Set<string>; overflow: boolean; turns?: Map<string, PluginWebviewChatTurn> }
    >;
    cancelFlush: (() => void) | null;
  };
  const hostSubscriptions = new Map<string, HostSubscription>();
  let hostSubscriptionSeq = 0;

  const flushHost = (subscriptionId: string): void => {
    const subscription = hostSubscriptions.get(subscriptionId);
    if (!subscription) return;
    subscription.cancelFlush = null;
    const buffered = [...subscription.buffer.entries()];
    subscription.buffer.clear();
    for (const [kind, entry] of buffered) {
      const payload: PluginWebviewHostEvent = {
        kind,
        ids: [...entry.ids],
        overflow: entry.overflow,
        // An overflowed chat frame carries NO turns: the page is being told to
        // refetch the sessions it watches, and half a turn list beside that
        // instruction is the half a page would patch from instead.
        ...(kind === "chat" && entry.turns && !entry.overflow
          ? { turns: [...entry.turns.values()] }
          : {}),
      };
      push(subscription.guest, "host", payload);
    }
  };

  const bufferHostChange = (
    subscription: HostSubscription,
    subscriptionId: string,
    kind: PluginWebviewHostKind,
    ids: readonly string[],
  ): void => {
    const entry = subscription.buffer.get(kind) ?? { ids: new Set<string>(), overflow: false };
    for (const id of ids) {
      if (entry.ids.size >= PLUGIN_WEBVIEW_HOST_IDS_MAX) {
        // Past the cap the frame stops naming ids and says so. A page that gets
        // `overflow` refetches the family, which is cheaper and more correct
        // than a truncated list it would treat as complete.
        entry.overflow = true;
        break;
      }
      if (typeof id === "string" && id.length > 0) entry.ids.add(id);
    }
    // An emission with no ids at all is still "this family moved" — the bus
    // documents that explicitly — so the frame goes out with an empty list
    // rather than being dropped.
    subscription.buffer.set(kind, entry);
    if (subscription.cancelFlush) return;
    subscription.cancelFlush = setTimer(() => flushHost(subscriptionId), PLUGIN_WEBVIEW_HOST_COALESCE_MS);
  };

  /**
   * Fold one turn into a subscription's `chat` buffer.
   *
   * Last state wins inside the coalescing window: a session that started and
   * then failed within the same 120ms delivers `failed` only, because "started"
   * is no longer true and a page told both would have to know which came last.
   * The session id keeps its ORIGINAL position in `ids`, so the frame's id order
   * is the order the sessions first moved in.
   */
  const bufferChatTurn = (
    subscription: HostSubscription,
    subscriptionId: string,
    turn: PluginWebviewChatTurn,
  ): void => {
    const entry = subscription.buffer.get("chat")
      ?? { ids: new Set<string>(), overflow: false, turns: new Map<string, PluginWebviewChatTurn>() };
    const turns = entry.turns ?? new Map<string, PluginWebviewChatTurn>();
    entry.turns = turns;
    if (!turns.has(turn.sessionId) && turns.size >= PLUGIN_WEBVIEW_CHAT_TURNS_MAX) {
      // Past the cap the frame stops naming turns at all — see the flush.
      entry.overflow = true;
    } else {
      turns.set(turn.sessionId, turn);
      entry.ids.add(turn.sessionId);
    }
    subscription.buffer.set("chat", entry);
    if (subscription.cancelFlush) return;
    subscription.cancelFlush = setTimer(() => flushHost(subscriptionId), PLUGIN_WEBVIEW_HOST_COALESCE_MS);
  };

  const unsubscribeEntities = subscribeToPluginEntityChanges((emission) => {
    if (hostSubscriptions.size === 0) return;
    const kind = emission.family;
    if (!isPluginWebviewHostKind(kind)) return;
    for (const [subscriptionId, subscription] of [...hostSubscriptions]) {
      // A guest that was destroyed takes its subscriptions with it. The window
      // layer forgets the guest record; this is where the buffer that was
      // pointing at it stops being fed and stops being kept.
      if (getPluginWebviewGuest(subscription.guest.webContentsId) !== subscription.guest) {
        subscription.cancelFlush?.();
        hostSubscriptions.delete(subscriptionId);
        continue;
      }
      if (!subscription.kinds.has(kind)) continue;
      // Scoped to the guest's own checkout. A window bound to project A must
      // not hear that a lane moved in project B — the plugin host is
      // machine-wide, so an unscoped fan-out would leak the existence of every
      // other project a user has open.
      const root = deps.projectFor(subscription.guest)?.root ?? null;
      if (emission.projectRoot && root && emission.projectRoot !== root) continue;
      bufferHostChange(subscription, subscriptionId, kind, emission.ids);
    }
  });

  // -------------------------------------------------------------------------
  // Hot reload
  // -------------------------------------------------------------------------

  /** Installs seen for a plugin in this app run. See `PluginWebviewReloadEvent`. */
  const revisionByPlugin = new Map<string, number>();

  const announceReload = async (pluginId: string): Promise<void> => {
    const guests = listPluginWebviewGuests(pluginId);
    // Nothing is drawing this plugin, so there is nothing to recreate. The next
    // guest to attach loads the new bytes because it loads them fresh.
    if (guests.length === 0) return;
    const revision = (revisionByPlugin.get(pluginId) ?? 0) + 1;
    revisionByPlugin.set(pluginId, revision);
    let version = "";
    try {
      const domain = await deps.domainFor(guests[0]!);
      version = (await domain.getManifest({ pluginId }))?.version ?? "";
    } catch {
      // A version this process could not read still reloads: the revision alone
      // changes the key, and a dev loop that re-copied a tree without bumping
      // the version is exactly the case that needs it.
      version = "";
    }
    deps.sendReload({ pluginId, version, revision });
  };

  const declaredCollection = async (
    domain: PluginWebviewDomain,
    pluginId: string,
    params: Record<string, unknown>,
  ): Promise<string> => {
    const collection = assertPluginCollectionName(requireString(params, "collection"));
    const manifest = await domain.getManifest({ pluginId });
    if (!manifest) throw new PluginSdkError("plugin_not_found", `Plugin "${pluginId}" is not installed.`);
    if (!Object.prototype.hasOwnProperty.call(manifest.collections, collection)) {
      throw new PluginSdkError(
        "not_permitted",
        `Collection "${collection}" is not declared in ${pluginId}'s manifest.`,
      );
    }
    return collection;
  };

  /**
   * One page of collection rows, honouring an `after` cursor.
   *
   * The plugin domain reads by prefix and limit and knows nothing about a
   * cursor — it is a closed action list mirrored by the RPC schema and iOS's
   * allowlist, so widening it for the page tier alone is not on the table. Rows
   * come back in key order (`order by key` in `pluginDataStore`), so a cursor is
   * "skip everything at or before this key", and the skipped rows have to be
   * fetched to be skipped. The fetch window doubles until it reaches past the
   * cursor or hits the per-plugin row ceiling, which bounds the work at a
   * handful of reads rather than a scan per row.
   */
  const listPage = async (
    domain: PluginWebviewDomain,
    pluginId: string,
    collection: string,
    keyPrefix: string,
    limit: number,
    after: string | null,
  ): Promise<PluginCollectionRow[]> => {
    const read = (fetchLimit: number): Promise<PluginCollectionRow[]> => domain.getCollection({
      pluginId,
      collection,
      ...(keyPrefix ? { keyPrefix } : {}),
      limit: fetchLimit,
    });
    if (!after) return (await read(limit)).slice(0, limit);
    let fetchLimit = limit;
    for (;;) {
      const rows = await read(fetchLimit);
      const page = rows.filter((row) => row.key > after).slice(0, limit);
      if (page.length >= limit) return page;
      // A short read means the collection has no more rows to skip, so the
      // partial page is the whole answer rather than a reason to fetch again.
      if (rows.length < fetchLimit) return page;
      if (fetchLimit >= PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN) return page;
      fetchLimit = Math.min(fetchLimit * 2, PLUGIN_COLLECTIONS_MAX_ROWS_PER_PLUGIN);
    }
  };

  /**
   * `invoke`, plus the control flow the same result would get from a socket.
   *
   * Item 3 of the page-tier spec, and the reason a page does not reimplement
   * seven verbs to act on what its own handler returned. The order is the one
   * the other clients keep:
   *
   * 1. What MAIN owns is done here — `{openUrl}` goes to the real browser and
   *    `{authSession}` presents the host-stamped sign-in. Neither needs a
   *    renderer, and routing them through one would put a URL through a hop
   *    that cannot add anything.
   * 2. `{prompt}` is asked and the action is re-invoked ONCE with the answer
   *    under `args.prompt`. One hop, exactly as `PluginActionPrompt` documents:
   *    a re-invocation's own prompt is ignored, so a plugin cannot build a
   *    wizard out of it or trap the reader in a loop.
   * 3. Everything else that moves ADE's UI — `{navigate}`, `{openSettings}`,
   *    `{composer}`, `{dialog}`, `{message}` — is handed to the owning window
   *    as one `actionResult`, where the renderer's existing reader applies it.
   *
   * The RAW result is still what the page receives, so a handler that returns
   * both an answer and a control-flow verb gets both.
   */
  const invokeWithControlFlow = async (
    guest: PluginWebviewGuest,
    domain: PluginWebviewDomain,
    action: string,
    args: Record<string, unknown>,
    depth: number,
  ): Promise<unknown> => {
    const pluginId = guest.pluginId;
    const result = await domain.invoke({ pluginId, action, args });

    const openUrl = readPluginActionOpenUrl(result);
    if (openUrl) {
      try {
        await deps.openExternalUrl(openUrl.url);
      } catch {
        log("plugin.webview_open_url_failed", { pluginId, action });
      }
    }

    const session = readPluginActionAuthSession(result);
    if (session) {
      const present = deps.openAuthSession
        ?? (async ({ session: stamped }) => { await deps.openExternalUrl(stamped.url); });
      try {
        await present({ guest, session });
      } catch {
        log("plugin.webview_auth_session_failed", { pluginId, action });
      }
    }

    const prompt = depth === 0 ? readPluginActionPrompt(result) : null;
    if (prompt) {
      const answered = await relay(guest, "ui.prompt", { prompt });
      const answer = readPluginWebviewPromptAnswer(prompt, answered);
      // A dismissed prompt is not a failure: the reader said no, and the first
      // result stands as the action's answer.
      if (answer) return await invokeWithControlFlow(guest, domain, action, { ...args, prompt: answer }, 1);
      return result;
    }

    const movesUi = !!readPluginActionNavigation(result)
      || !!readPluginActionOpenSettings(result)
      || !!readPluginActionComposerEdit(result)
      || !!readPluginActionMessage(result)
      || (isRecord(result) && isRecord(result.dialog));
    if (movesUi) {
      try {
        await relay(guest, "actionResult", { action, result });
      } catch (error) {
        // The action itself succeeded. A window that would not draw its answer
        // is a logged line, not a rejected `invoke` — the page still gets what
        // its handler returned.
        log("plugin.webview_action_result_failed", {
          pluginId,
          action,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  };

  const runMethod = async (
    guest: PluginWebviewGuest,
    method: PluginWebviewMethod,
    params: Record<string, unknown>,
  ): Promise<unknown> => {
    const pluginId = guest.pluginId;
    const domain = await deps.domainFor(guest);
    switch (method) {
      case "collections.get": {
        const collection = await declaredCollection(domain, pluginId, params);
        const key = assertPluginCollectionKey(requireString(params, "key"));
        // The domain reads by prefix; an exact key is a prefix of itself, so the
        // row is picked out here rather than adding a second read path that
        // could disagree with the list one about scoping.
        const rows = await domain.getCollection({ pluginId, collection, keyPrefix: key });
        return rows.find((row) => row.key === key)?.value ?? null;
      }

      case "collections.put": {
        const collection = await declaredCollection(domain, pluginId, params);
        const key = assertPluginCollectionKey(requireString(params, "key"));
        await deps.putCollection({ guest, collection, key, value: params.value });
        return null;
      }

      case "collections.list": {
        const collection = await declaredCollection(domain, pluginId, params);
        const options = isRecord(params.options) ? params.options : {};
        const keyPrefix = typeof options.keyPrefix === "string" ? options.keyPrefix : "";
        const requested = typeof options.limit === "number" && Number.isFinite(options.limit)
          ? Math.max(1, Math.trunc(options.limit))
          : PLUGIN_WEBVIEW_LIST_MAX_ROWS;
        const limit = Math.min(requested, PLUGIN_WEBVIEW_LIST_MAX_ROWS);
        const after = typeof options.after === "string" && options.after.length > 0
          ? options.after
          : null;
        const rows = await listPage(domain, pluginId, collection, keyPrefix, limit, after);
        // `{key, value}` only: the host row also carries its collection and a
        // timestamp, and the page already knows which collection it asked for.
        return rows.map((row) => ({ key: row.key, value: row.value }));
      }

      case "invoke": {
        const action = requireString(params, "action");
        const args = isRecord(params.args) ? params.args : {};
        return await invokeWithControlFlow(guest, domain, action, args, 0);
      }

      case "config.get": {
        const detail = await domain.get({ pluginId });
        if (!detail) throw new PluginSdkError("plugin_not_found", `Plugin "${pluginId}" is not installed.`);
        return detail.config ?? {};
      }

      case "config.set": {
        // Not routed and not the domain — see the module header and
        // `PluginWebviewBridgeDeps.setConfig`. The host validates against the
        // manifest and refuses a `secret` setting, so this layer adds no rule
        // of its own and a page cannot be held to a different one than a child.
        const values = isRecord(params.values) ? params.values : {};
        return await deps.setConfig({ guest, values });
      }

      case "openDeeplink": {
        const url = requireString(params, "url");
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new PluginSdkError("invalid_args", "That is not a URL.");
        }
        if (parsed.protocol === "ade:") {
          await deps.openDeeplink({ guest, url: parsed.toString() });
          return null;
        }
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          await deps.openExternalUrl(parsed.toString());
          return null;
        }
        // `file:`, `javascript:`, `data:` and the guest's own scheme all land
        // here. Opening any of them would be a way out of the sandbox the page
        // was given, so the list of what is allowed is the whole policy.
        throw new PluginSdkError("not_permitted", "Only ade:// and http(s) links can be opened.");
      }

      case "openSettings": {
        // Read through the SAME reader the action answer uses, so a page and a
        // socket cannot reach different settings pages: the closed entry list
        // and the manifest-identifier rule for a socket id are one rule.
        const target = readPluginActionOpenSettings({ openSettings: params });
        if (!target) {
          throw new PluginSdkError("invalid_args", "That is not a settings page this host opens.");
        }
        await relay(guest, "openSettings", { target });
        return null;
      }

      case "surface.close": {
        await relay(guest, "surface.close", {});
        return null;
      }

      case "composer.attach": {
        const issue = readPluginWebviewComposerAttach(params);
        await relay(guest, "composer.attach", { issue });
        return null;
      }

      case "dialog.submit": {
        // Refused on the PLACEMENT the host captured at attach, not on anything
        // the page says about itself. A tab that could answer a dialog would be
        // filling in a form the reader is not looking at — and it would be
        // choosing the lane name for a Create-lane sheet somebody else opened.
        if (guestPlacement(guest) !== "dialog-picker") {
          throw new PluginSdkError(
            "not_permitted",
            "Only a page drawn as a dialog picker can answer a dialog.",
          );
        }
        const { issue } = readPluginWebviewDialogSubmit(params);
        await relay(guest, "dialog.submit", { issue });
        return null;
      }

      case "composer.insert": {
        const text = requireString(params, "text");
        if (pluginUtf8ByteLength(text) > PLUGIN_COMPOSER_TEXT_MAX_BYTES) {
          throw budgetExceeded(
            "composer_text",
            PLUGIN_COMPOSER_TEXT_MAX_BYTES,
            pluginUtf8ByteLength(text),
          );
        }
        await relay(guest, "composer.insert", { text });
        return null;
      }

      case "ui.toast": {
        const toast = readPluginWebviewToast(params);
        const answer = await relay(guest, "ui.toast", { toast });
        const id = isRecord(answer) && typeof answer.id === "string" ? answer.id : "";
        return { id };
      }

      case "ui.dismissToast": {
        const id = requireString(params, "id");
        await relay(guest, "ui.dismissToast", { id });
        return null;
      }

      case "ui.prompt": {
        const prompt = readPluginActionPrompt({ prompt: params.prompt ?? params });
        if (!prompt) throw new PluginSdkError("invalid_args", "That is not a prompt this host draws.");
        const answer = await relay(guest, "ui.prompt", { prompt });
        return readPluginWebviewPromptAnswer(prompt, answer);
      }

      case "ui.confirm": {
        const confirm = readPluginWebviewConfirm(params);
        return (await relay(guest, "ui.confirm", { confirm })) === true;
      }

      case "clipboard.read": {
        const text = await deps.readClipboard();
        const value = typeof text === "string" ? text : "";
        // Clamped rather than refused: the reader copied whatever they copied,
        // and a page asking what is on the clipboard should not fail because
        // the answer is a large file listing.
        return pluginUtf8ByteLength(value) > PLUGIN_CLIPBOARD_TEXT_MAX_BYTES
          ? value.slice(0, PLUGIN_CLIPBOARD_TEXT_MAX_BYTES)
          : value;
      }

      case "clipboard.write": {
        const text = params.text;
        if (typeof text !== "string") {
          throw new PluginSdkError("invalid_args", '"text" must be a string.');
        }
        if (pluginUtf8ByteLength(text) > PLUGIN_CLIPBOARD_TEXT_MAX_BYTES) {
          throw budgetExceeded(
            "clipboard_text",
            PLUGIN_CLIPBOARD_TEXT_MAX_BYTES,
            pluginUtf8ByteLength(text),
          );
        }
        await deps.writeClipboard(text);
        return null;
      }

      case "theme.get":
        return themeFor(guest);

      case "host.subscribe": {
        const raw = Array.isArray(params.kinds) ? params.kinds : [];
        const kinds = new Set<PluginWebviewHostKind>();
        for (const kind of raw) if (isPluginWebviewHostKind(kind)) kinds.add(kind);
        if (kinds.size === 0) {
          throw new PluginSdkError("invalid_args", '"kinds" must name lane, session, pr or chat.');
        }
        hostSubscriptionSeq += 1;
        const subscriptionId = `${guest.webContentsId}:${hostSubscriptionSeq}`;
        hostSubscriptions.set(subscriptionId, {
          guest,
          kinds,
          buffer: new Map(),
          cancelFlush: null,
        });
        return { subscriptionId };
      }

      case "host.unsubscribe": {
        const subscriptionId = requireString(params, "subscriptionId");
        const subscription = hostSubscriptions.get(subscriptionId);
        // Silently ignored for another guest's id rather than refused: telling a
        // page that an id it does not own exists is itself an answer.
        if (subscription && subscription.guest.webContentsId === guest.webContentsId) {
          subscription.cancelFlush?.();
          hostSubscriptions.delete(subscriptionId);
        }
        return null;
      }

      default:
        throw new PluginSdkError("unsupported_method", `Unsupported bridge method: ${String(method)}`);
    }
  };

  const unsubscribe = subscribeToPluginChanges((event) => {
    if (!event.pluginId) return;
    const listeners = listPluginWebviewGuests(event.pluginId);
    // An install is what moves a plugin's bytes on disk, so it is what makes a
    // guest stale. Announced even before the `changed` fan-out below, because a
    // page about to be recreated does not need to hear the change first.
    if (event.kind === "installs") void announceReload(event.pluginId);
    if (listeners.length === 0) return;
    // Minus `pluginId`: a page only ever hears about its own plugin, and
    // carrying the id would invite a page to branch on someone else's.
    const payload: PluginWebviewChangeEvent = {
      kind: event.kind,
      ...(event.panelId ? { panelId: event.panelId } : {}),
      ...(event.collection ? { collection: event.collection } : {}),
    };
    for (const guest of listeners) push(guest, "changed", payload);
  });

  return {
    resolvePluginId(sender) {
      try {
        return resolvePluginWebviewSender(sender).pluginId;
      } catch {
        return null;
      }
    },

    resolveHandshake(sender) {
      try {
        const guest = resolvePluginWebviewSender(sender);
        // `project` is stamped HERE, never read off the guest's URL: the window's
        // binding is the host's own fact, and a page that could name its project
        // could name one it was not opened in. See `PluginWebviewContext`.
        const project = deps.projectFor(guest);
        const context = { ...(guest.context ?? { subject: null }), project };
        return { pluginId: guest.pluginId, context };
      } catch {
        return null;
      }
    },

    handleUiResponse(payload) {
      if (!isRecord(payload)) return;
      const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
      if (!requestId) return;
      const pending = settle(requestId);
      if (!pending) return;
      if (payload.ok === true) {
        pending.resolve(payload.value);
        return;
      }
      const message = typeof payload.message === "string" && payload.message
        ? payload.message
        : "ADE could not do that.";
      pending.reject(new PluginSdkError("not_permitted", message));
    },

    publishTheme(hostWindowId, payload) {
      const theme = sanitizePluginWebviewTheme(payload);
      if (!theme) return;
      lastTheme = theme;
      if (hostWindowId != null) themeByWindow.set(hostWindowId, theme);
      for (const guest of listAllPluginWebviewGuests()) {
        // A window publishes for its OWN guests. A guest in another window has
        // its own renderer publishing its own theme, and painting it with this
        // one would make two windows on different themes fight.
        if (hostWindowId != null && guest.hostWindowId !== hostWindowId) continue;
        push(guest, "theme", theme);
      }
    },

    publishChatTurn(hostWindowId, payload) {
      // Sanitized rather than trusted even though the publisher is ADE's own
      // renderer, for the same reason the theme is: this crosses into an
      // untrusted guest. A frame that is not a turn is dropped silently — the
      // producer has nothing to do with a refusal, and a page hearing a
      // malformed turn is worse than hearing none.
      const turn = sanitizePluginWebviewChatTurn(payload);
      if (!turn) return;
      for (const [subscriptionId, subscription] of [...hostSubscriptions]) {
        if (getPluginWebviewGuest(subscription.guest.webContentsId) !== subscription.guest) {
          subscription.cancelFlush?.();
          hostSubscriptions.delete(subscriptionId);
          continue;
        }
        if (!subscription.kinds.has("chat")) continue;
        // A window publishes for its OWN guests, exactly as it does for the
        // theme. A page in another window is watching another project's
        // conversations, and there is no reason it should learn a session id
        // from a checkout it was never opened in.
        if (subscription.guest.hostWindowId !== hostWindowId) continue;
        bufferChatTurn(subscription, subscriptionId, turn);
      }
    },

    async handle(sender, payload) {
      const guest = resolvePluginWebviewSender(sender);
      if (!isRecord(payload)) {
        throw new PluginSdkError("invalid_args", "The bridge expects a request object.");
      }
      const bridgeVersion = payload.bridgeVersion;
      if (typeof bridgeVersion !== "number" || !Number.isInteger(bridgeVersion) || bridgeVersion < 1) {
        throw new PluginSdkError("invalid_args", "The bridge request carries no version.");
      }
      // Additive means an OLDER page keeps working; a page claiming a version
      // this host has never shipped is not a page this host wrote the preload
      // for.
      if (bridgeVersion > PLUGIN_WEBVIEW_BRIDGE_VERSION) {
        throw new PluginSdkError("unsupported_method", "This page needs a newer version of ADE.");
      }
      if (!isPluginWebviewMethod(payload.method)) {
        throw new PluginSdkError("unsupported_method", `Unsupported bridge method: ${String(payload.method)}`);
      }
      const params = isRecord(payload.params) ? payload.params : {};
      try {
        return await runMethod(guest, payload.method, params);
      } catch (error) {
        log("plugin.webview_bridge_failed", {
          pluginId: guest.pluginId,
          method: payload.method,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    dispose() {
      unsubscribe();
      unsubscribeEntities();
      for (const subscription of hostSubscriptions.values()) subscription.cancelFlush?.();
      hostSubscriptions.clear();
      for (const requestId of [...pendingUi.keys()]) {
        const pending = settle(requestId);
        pending?.reject(new PluginSdkError("internal_error", "ADE is shutting down."));
      }
      themeByWindow.clear();
    },
  };
}
