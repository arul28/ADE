/**
 * The `adePlugin` bridge — the contract between a plugin's own HTML page and
 * ADE.
 *
 * A `webview` surface is the one place a plugin ships UI code instead of a
 * panel schema. That page runs as an untrusted guest: its own process, its own
 * non-persistent session, no Node, no `window.ade`, and a strict CSP that lets
 * it load nothing executable from outside its own install directory. What it
 * gets instead is this bridge — a deliberately small door into the SAME plugin
 * domain the vocabulary surfaces use, scoped to the plugin that owns the page.
 *
 * ## The stability promise
 *
 * {@link PLUGIN_WEBVIEW_BRIDGE_VERSION} is a handshake, and it is additive in
 * exactly the way `PLUGIN_SDK_VERSION` is. `window.adePlugin.version` tells a
 * page what it is talking to; methods are added, never removed or re-shaped. A
 * page written against v1 keeps working when the host reaches v2, and a page
 * written against v2 checks `version` before it calls something v1 lacks.
 *
 * ## Where the plugin id comes from
 *
 * Not from the page. Every call is answered against the plugin id the HOST
 * derives from the guest's own origin (`ade-plugin://<pluginId>`), which the
 * page cannot forge: it is fixed when the guest is attached and re-read on each
 * call. A `pluginId` field in a request payload would be a claim, and honouring
 * a claim is how one plugin reads another's collections. The bridge therefore
 * carries no plugin id on the wire at all — there is no field to ignore.
 *
 * ## Why contextBridge rather than a message channel
 *
 * The page reaches the preload through `contextBridge.exposeInMainWorld`, and
 * the preload reaches the host through `ipcRenderer.invoke`. A `postMessage`
 * hop between them would add a channel any script in the page could also post
 * on, with no way for the preload to tell the page's own code from an injected
 * script's. The function reference is the capability; there is nothing to
 * impersonate.
 */

import type { PluginSurfaceContext } from "./context";
import { isValidPluginId } from "./manifest";

/** Bumped only for an additive change. See the module header. */
export const PLUGIN_WEBVIEW_BRIDGE_VERSION = 1;

/**
 * The host-injected subject a plugin page is attached to.
 *
 * A full tab or pane webview carries none of this — it is the plugin's own front
 * page and belongs to no chat, lane or PR. The drawer tab and the button-opened
 * overlay do: they mount a page ONTO something the user was already looking at,
 * and the page needs to know which one.
 *
 * The word to hold on to is INJECTED. `subject` is set by the host from what it
 * already knows — the chat the drawer sits on, the row the button sat on — and
 * the guest cannot forge it: it is captured from the guest's source URL at
 * attach, before the page runs a line of script, and stored on the host's own
 * guest record. A page that later rewrites its own query string does not change
 * what {@link AdePluginWebviewBridge.context} reports, exactly the way it cannot
 * change {@link AdePluginWebviewBridge.pluginId}. `pointer` is the one part a
 * plugin may author itself — a small hint an `openWebview` action chose to pass
 * — and it is labelled apart precisely so a page never mistakes it for the
 * host's own word about the subject.
 */
export type PluginWebviewContext = {
  /** What the host attached this page to. Null on a full tab/pane webview. */
  subject: PluginSurfaceContext | null;
  /** A plugin-authored hint, e.g. from an `openWebview` action. */
  pointer?: Record<string, unknown>;
};

/**
 * The whole context envelope, as bytes on the source URL, is capped here.
 *
 * It rides in the guest's `src` query and is captured host-side at attach, so it
 * is bounded for the same reason a navigation context is (`sdk.ts`): a pointer,
 * not a payload. The page reads the plugin's collections for everything else.
 */
export const PLUGIN_WEBVIEW_CONTEXT_MAX_BYTES = 4 * 1024;

/**
 * The query parameter the host reads the injected context out of.
 *
 * A double-underscore name so it cannot collide with a query a plugin's own page
 * cares about, and read only by the host — the file the protocol serves is
 * chosen by the path, never the query.
 */
export const PLUGIN_WEBVIEW_CONTEXT_QUERY_PARAM = "__adeCtx";

/**
 * The scheme plugin pages are served on. One origin per plugin, which is what
 * makes the browser's own same-origin rules do most of the isolation work.
 */
export const PLUGIN_WEBVIEW_PROTOCOL = "ade-plugin";

/** `ade-plugin://<pluginId>` — the guest's origin, and its identity. */
export function pluginWebviewOrigin(pluginId: string): string {
  return `${PLUGIN_WEBVIEW_PROTOCOL}://${pluginId}`;
}

/**
 * The URL a guest loads for one of the plugin's files.
 *
 * A `context` rides as a query parameter, which the host reads at attach and the
 * protocol handler ignores when it resolves the path. It is the ONE way the
 * trusted renderer hands a per-instance subject to a page: the renderer knows
 * which chat the drawer is on, encodes it here, and the host captures it before
 * the page runs. See {@link PluginWebviewContext}. An oversize context is
 * dropped rather than truncated — a page opens without a subject rather than
 * with half of one.
 */
export function pluginWebviewUrl(
  pluginId: string,
  relativePath: string,
  context?: PluginWebviewContext | null,
): string {
  const path = relativePath.replace(/^\/+/, "");
  const base = `${pluginWebviewOrigin(pluginId)}/${path}`;
  const encoded = context ? encodePluginWebviewContext(context) : null;
  return encoded ? `${base}?${PLUGIN_WEBVIEW_CONTEXT_QUERY_PARAM}=${encoded}` : base;
}

/**
 * Encode a context for the guest's source URL, or null when it will not fit.
 *
 * `encodeURIComponent` of the JSON, so the value is one opaque query token the
 * host reverses with {@link decodePluginWebviewContext}. Over the ceiling, or
 * unserializable, yields null and the caller loads the page with no context.
 */
export function encodePluginWebviewContext(context: PluginWebviewContext): string | null {
  let json: string;
  try {
    json = JSON.stringify(context);
  } catch {
    return null;
  }
  if (!json || pluginWebviewByteLength(json) > PLUGIN_WEBVIEW_CONTEXT_MAX_BYTES) return null;
  return encodeURIComponent(json);
}

/**
 * Reverse {@link encodePluginWebviewContext}, refusing anything malformed.
 *
 * The value arrives from a URL the host itself set, but it is decoded defensively
 * anyway: a recycled webContents, a hand-typed address, or a future host writing
 * a shape this one does not know must degrade to "no context", never to a throw
 * or a half-built subject. Only the two known fields are kept, each shape-checked.
 */
export function decodePluginWebviewContext(raw: string | null | undefined): PluginWebviewContext | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (pluginWebviewByteLength(raw) > PLUGIN_WEBVIEW_CONTEXT_MAX_BYTES * 2) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const record = decoded as Record<string, unknown>;
  const subject = record.subject;
  // A subject is one of the typed context objects, every one of which carries a
  // string `kind`. Anything else — including a page's attempt to smuggle a bare
  // record — is dropped to null rather than passed through as a subject.
  const subjectValue = subject && typeof subject === "object" && typeof (subject as Record<string, unknown>).kind === "string"
    ? (subject as PluginSurfaceContext)
    : null;
  const pointer = record.pointer;
  const pointerValue = pointer && typeof pointer === "object" && !Array.isArray(pointer)
    ? (pointer as Record<string, unknown>)
    : undefined;
  return { subject: subjectValue, ...(pointerValue ? { pointer: pointerValue } : {}) };
}

/**
 * UTF-8 byte length without a Node `Buffer`, so this runs in the renderer, the
 * daemon and iOS's transcription alike. Mirrors `pluginUtf8ByteLength` in
 * `sdk.ts`, restated here to keep this module free of that file's imports.
 */
function pluginWebviewByteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value).length;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Read a plugin id and a request path out of a guest URL.
 *
 * Returns null for anything that is not this scheme or does not name a valid
 * plugin id. The PATH is returned raw and un-decoded: resolving it against the
 * install directory — and refusing what escapes it — belongs to the process
 * that owns the filesystem, not to a shared parser that cannot see disk.
 */
export function parsePluginWebviewUrl(rawUrl: string): { pluginId: string; path: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${PLUGIN_WEBVIEW_PROTOCOL}:`) return null;
  // `hostname` rather than `host`: a port would make `ade-plugin://x:1` and
  // `ade-plugin://x` the same plugin with two origins.
  if (url.port) return null;
  const pluginId = url.hostname;
  if (!isValidPluginId(pluginId)) return null;
  return { pluginId, path: url.pathname };
}

/**
 * A per-plugin, non-persistent session partition.
 *
 * No `persist:` prefix, deliberately: a plugin page's cookies, storage and
 * caches die with the window. Plugin state belongs in the plugin's collections,
 * where it is budgeted, synced and visible in the usage meter — a page that
 * squirrels data into localStorage instead has put it somewhere the user cannot
 * see and the platform cannot account for.
 */
export function pluginWebviewPartition(pluginId: string): string {
  return `ade-plugin-${pluginId}`;
}

/**
 * The Content-Security-Policy served with every plugin page.
 *
 * The load-bearing clauses:
 *
 * - `default-src 'self'` — with `'self'` being `ade-plugin://<pluginId>`, so
 *   the page can only execute what shipped in that plugin's own directory.
 *   There is no CDN escape hatch: a plugin that wants a library vendors it.
 * - `img-src` / `media-src` reach `https:` because showing a remote avatar is
 *   ordinary and images do not execute.
 * - `connect-src https:` — plugin pages may call their own service. A plugin is
 *   ambient-trust code the user chose to install; pretending a page cannot
 *   reach the network while its child process can would be theatre.
 * - `frame-ancestors 'none'` and `object-src 'none'` close the two ways a page
 *   gets rendered somewhere it did not intend.
 */
export const PLUGIN_WEBVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "media-src 'self' https: blob:",
  "font-src 'self' data:",
  "connect-src https:",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

/**
 * Everything the page may ask for, as one closed list.
 *
 * A subset of the child SDK, not a mirror of it. Absent on purpose: `secrets`
 * (a page is the one place a plugin's credentials should never be readable, and
 * a page is also the place an injected script would look first),
 * `contributions.publish` and `panels.update` (a page draws itself; publishing
 * into other surfaces is the child process's job), and `collections.delete`
 * (destructive, and not needed to build a UI).
 */
export const PLUGIN_WEBVIEW_METHODS = [
  "collections.get",
  "collections.put",
  "collections.list",
  "invoke",
  "config.get",
  "openDeeplink",
] as const;

export type PluginWebviewMethod = (typeof PLUGIN_WEBVIEW_METHODS)[number];

export function isPluginWebviewMethod(value: unknown): value is PluginWebviewMethod {
  return PLUGIN_WEBVIEW_METHODS.some((method) => method === value);
}

/** One bridge call. Note the absence of a plugin id — see the module header. */
export type PluginWebviewRequest = {
  bridgeVersion: number;
  method: PluginWebviewMethod;
  params: Record<string, unknown>;
};

/**
 * What the page hears when its plugin's data moves.
 *
 * Structurally the renderer's `PluginClientChangeEvent` minus `pluginId`, which
 * is always this page's own plugin. `kind` is open in practice: a page that
 * does not recognize one should refetch rather than ignore it.
 */
export type PluginWebviewChangeEvent = {
  kind: string;
  panelId?: string;
  collection?: string;
};

/** The event names {@link AdePluginWebviewBridge.events.on} accepts. */
export const PLUGIN_WEBVIEW_EVENTS = ["changed"] as const;

export type PluginWebviewEventName = (typeof PLUGIN_WEBVIEW_EVENTS)[number];

/**
 * The host's synchronous answer to the preload's attach-time handshake.
 *
 * Both facts a page reads while rendering — its own plugin id and the subject it
 * was attached to — come back in one `sendSync`, because a second round trip for
 * the context would make every drawer page await a value the host already knew
 * before the page loaded. An empty `pluginId` means "this is not a plugin
 * surface", which is also when `context` is null.
 *
 * This shape is internal to one app build (the preload and the host ship
 * together), not a cross-release wire contract, so it may grow fields freely.
 */
export type PluginWebviewHandshake = {
  pluginId: string;
  context: PluginWebviewContext | null;
};

/**
 * `window.adePlugin`, exactly.
 *
 * Every method is async and rejects with an ordinary `Error` whose message is
 * the host's typed refusal — a page has no `PluginSdkError` class to catch, so
 * the code is carried in the message rather than pretending to be structural.
 */
export type AdePluginWebviewBridge = {
  /** {@link PLUGIN_WEBVIEW_BRIDGE_VERSION} of the host that attached this page. */
  readonly version: number;
  /** The page's own plugin id, reported by the host. Informational. */
  readonly pluginId: string;
  /**
   * The subject the host attached this page to, or null.
   *
   * Null for a full tab or pane webview — the plugin's own front page belongs to
   * no chat, lane or PR. Present when a plugin page is mounted as a drawer tab or
   * summoned as an overlay from a button: `subject` is the host's own word about
   * which chat/lane/PR, unforgeable, and `pointer` is a hint the plugin's own
   * action chose to pass. See {@link PluginWebviewContext}. Reported at attach
   * and stable for the life of the guest.
   */
  readonly context: PluginWebviewContext | null;

  collections: {
    get(collection: string, key: string): Promise<unknown>;
    put(collection: string, key: string, value: unknown): Promise<void>;
    list(
      collection: string,
      options?: { keyPrefix?: string; limit?: number },
    ): Promise<{ key: string; value: unknown }[]>;
  };

  /** Call one of the plugin's own named action handlers. */
  invoke(action: string, args?: Record<string, unknown>): Promise<unknown>;

  config: {
    get(): Promise<Record<string, string | number | boolean | null>>;
  };

  events: {
    /** Returns an unsubscribe function. */
    on(event: PluginWebviewEventName, listener: (payload: PluginWebviewChangeEvent) => void): () => void;
  };

  /**
   * Open an `ade://` deeplink, or an `http(s):` URL in the user's real browser.
   * `http:` is accepted alongside `https:` because a plugin's own dev server is
   * a normal thing to link to. Nothing else is, so a page cannot use this to
   * reach `file:`, `javascript:` or its own origin out of band.
   */
  openDeeplink(url: string): Promise<void>;
};
