/**
 * The wire between the hosted web client and a plugin page in an iframe.
 *
 * On desktop the same contract rides `contextBridge` + `ipcRenderer.invoke`,
 * where the function reference IS the capability and there is nothing to
 * impersonate. A browser has no such door: the only channel into a sandboxed
 * frame is `postMessage`, which is a broadcast into a window ANY holder of a
 * reference to it can also post on, and out of which the guest can post to any
 * window it can name.
 *
 * So the frame carries two facts nobody else has:
 *
 * 1. **A per-guest nonce**, minted by the host and handed to the guest in the
 *    URL of the document the service worker serves it — a URL only the host and
 *    that guest ever see. Every message in both directions carries it, and a
 *    message without it is dropped without a reply.
 * 2. **The window identity.** The host checks `event.source` against the
 *    element's own `contentWindow`, and the guest checks `event.source ===
 *    window.parent`. The nonce alone would survive a frame being handed a
 *    reference to another window; identity alone would survive nothing, because
 *    `contentWindow` is reachable from any script in the host page.
 *
 * Neither check is about the origin: the guest's origin is `null` (opaque, by
 * the `sandbox` its response is served with), which is precisely the property
 * that keeps it out of the app's storage, and precisely why `event.origin` is
 * not an identity here.
 *
 * The plugin id is bound when the host is created, from the surface the
 * renderer drew, and is never read off a message — the same rule the desktop
 * bridge states in its own header, for the same reason.
 */

import type {
  PluginWebviewContext,
  PluginWebviewEventName,
  PluginWebviewMethod,
  PluginWebviewPlacement,
  PluginWebviewThemeSnapshot,
} from "../../../shared/plugins/webviewBridge";

/** Names this channel, so a page sharing the frame with anything else is not confused for it. */
export const PLUGIN_PAGE_CHANNEL = "ade-plugin-page";

/** Bumped only for a breaking change to the envelope, never for a new method. */
export const PLUGIN_PAGE_PROTOCOL_VERSION = 1;

/** The query parameters the host writes onto the guest document's URL. */
export const PLUGIN_PAGE_NONCE_PARAM = "ade_n";
export const PLUGIN_PAGE_CSP_NONCE_PARAM = "ade_csp";

/**
 * How long a guest's own boot may take before the host gives up on it.
 *
 * The guest asks for its bytes as its first act, so this covers a frame that
 * never ran its bootstrap at all — a document the service worker did not serve,
 * or a page killed by a policy. The reader sees the "didn't load" card rather
 * than an empty frame that never resolves.
 */
export const PLUGIN_PAGE_BOOT_TIMEOUT_MS = 15_000;

/**
 * Ceilings on what a guest may push at the host in one message.
 *
 * A page is untrusted code with a channel into the app's own UI, and the two
 * things it can do with volume are exhaust memory and fill the toast stack. The
 * per-verb argument caps live with the verbs; these bound the envelope itself.
 */
export const PLUGIN_PAGE_MAX_INFLIGHT_REQUESTS = 64;
export const PLUGIN_PAGE_MAX_HOST_SUBSCRIPTIONS = 8;

/** Guest → host. */
export type PluginPageGuestMessage =
  | { kind: "ready" }
  | { kind: "request"; id: number; method: PluginWebviewMethod | "page.boot"; params: Record<string, unknown> }
  /** The measured content height of a `settings-section` guest. */
  | { kind: "resize"; height: number };

/** One page file as it crosses into the guest. */
export type PluginPageWireFile = { path: string; mime: string; bytes: ArrayBuffer };

/** What the guest needs to draw the page, answered to its `page.boot` request. */
export type PluginPageBootPayload = {
  bridgeVersion: number;
  pluginId: string;
  context: PluginWebviewContext | null;
  theme: PluginWebviewThemeSnapshot | null;
  entry: string;
  files: PluginPageWireFile[];
};

/** Host → guest. */
export type PluginPageHostMessage =
  | { kind: "response"; id: number; ok: true; value: unknown }
  | { kind: "response"; id: number; ok: false; message: string }
  | { kind: "event"; event: PluginWebviewEventName; payload: unknown };

export type PluginPageEnvelope<TBody> = TBody & {
  channel: typeof PLUGIN_PAGE_CHANNEL;
  v: number;
  nonce: string;
};

/** What the host stamps into the bootstrap document. The guest's only input. */
export type PluginPageGuestConfig = {
  nonce: string;
  /** The exact origin the guest may post to. Never `"*"`. */
  parentOrigin: string;
  pluginId: string;
  placement: PluginWebviewPlacement;
};

export function pluginPageEnvelope<TBody>(nonce: string, body: TBody): PluginPageEnvelope<TBody> {
  return { ...body, channel: PLUGIN_PAGE_CHANNEL, v: PLUGIN_PAGE_PROTOCOL_VERSION, nonce };
}

/**
 * Read a message of this channel out of an untrusted `MessageEvent.data`.
 *
 * Returns null for anything that is not this channel at this version with this
 * exact nonce. A constant-time compare is not warranted — the nonce never
 * leaves the two windows that hold it, and a timing oracle would need a channel
 * back out that the caller does not have.
 */
export function readPluginPageEnvelope(data: unknown, nonce: string): Record<string, unknown> | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.channel !== PLUGIN_PAGE_CHANNEL) return null;
  if (record.v !== PLUGIN_PAGE_PROTOCOL_VERSION) return null;
  if (typeof record.nonce !== "string" || record.nonce !== nonce) return null;
  return record;
}

/** A URL-safe random token. Used for both nonces the guest document carries. */
export function mintPluginPageNonce(crypto: Pick<Crypto, "getRandomValues">): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
