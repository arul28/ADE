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
import type { PluginActionPrompt, PluginActionPromptAnswer } from "./sdk";

/**
 * Bumped only for an additive change. See the module header.
 *
 * v2 adds the host verbs a compiled page needs to behave like ADE's own UI —
 * settings, the composer, toasts, prompts, confirmations, the clipboard, the
 * theme, live host entities and the project the window is bound to — plus the
 * `theme` and `host` events. Nothing from v1 moved.
 */
export const PLUGIN_WEBVIEW_BRIDGE_VERSION = 2;

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
  /**
   * The manifest surface this guest draws, as the renderer named it when it
   * built the source URL. Read at attach, exactly like `subject`.
   *
   * The host needs it to say WHICH surface a relayed request came from — a
   * popover asking to close itself is a different instruction from a tab asking
   * the same thing — and a page may read it to lay itself out for the placement
   * it actually got.
   */
  surfaceId?: string;
  /** Where the host put this guest. See {@link PLUGIN_WEBVIEW_PLACEMENTS}. */
  placement?: PluginWebviewPlacement;
  /**
   * The project the hosting window is bound to. HOST-WRITTEN, never decoded
   * from the source URL.
   *
   * `context.project` sits beside `context.subject` because a page asks the
   * same question about both — "what am I looking at?" — and both answers are
   * the host's own word. The difference is where they are captured: a subject
   * is fixed at attach from the URL the renderer chose, and the project is
   * read at handshake from the window's own binding, so a page cannot name a
   * project it was not opened in. Null when the window is bound to nothing.
   */
  project?: PluginWebviewProjectContext | null;
};

/**
 * The project a plugin page is running against.
 *
 * `binding` is the fact a page cannot derive: `remote` means the checkout lives
 * on another machine and `root` is that machine's path, so a page must not
 * present it as something the user can open here. `projectId` is null when the
 * window has no project open at all, which is an ordinary state (the welcome
 * screen), not an error.
 */
export type PluginWebviewProjectContext = {
  projectId: string | null;
  root: string | null;
  binding: "local" | "remote";
};

/**
 * Where the host drew a guest.
 *
 * A closed list because it is half of the relay's addressing: `surface.close`
 * means "close the popover", "close the picker" or "do nothing" depending on
 * this value alone, and a placement the renderer does not know would be a
 * request it silently drops.
 */
export const PLUGIN_WEBVIEW_PLACEMENTS = [
  "tab",
  "pane",
  "drawer",
  "overlay",
  "popover",
  "settings-section",
  "composer-picker",
  "dialog-picker",
] as const;

export type PluginWebviewPlacement = (typeof PLUGIN_WEBVIEW_PLACEMENTS)[number];

export function isPluginWebviewPlacement(value: unknown): value is PluginWebviewPlacement {
  return PLUGIN_WEBVIEW_PLACEMENTS.some((placement) => placement === value);
}

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
  // `surfaceId` and `placement` come off the URL because the RENDERER wrote it,
  // and the renderer is the only party that knows where it put the guest. They
  // are still shape-checked: a placement outside the closed list would make the
  // relay address a host the app does not draw.
  const surfaceId = typeof record.surfaceId === "string" && record.surfaceId.length > 0
    ? record.surfaceId
    : undefined;
  const placement = isPluginWebviewPlacement(record.placement) ? record.placement : undefined;
  // `project` is deliberately NOT read here. It is the host's own word about the
  // window's binding, stamped at handshake; accepting one off the URL would let
  // a recycled or hand-typed address name a project the window is not bound to.
  return {
    subject: subjectValue,
    ...(pointerValue ? { pointer: pointerValue } : {}),
    ...(surfaceId ? { surfaceId } : {}),
    ...(placement ? { placement } : {}),
  };
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
 *
 * `config.set` IS here: a plugin's settings page is a page, and a form that
 * cannot save what it renders is the reason it was added. It does not reopen
 * the secrets hole — the host refuses a `secret`-kind setting on this path the
 * same way it does on the child's.
 */
export const PLUGIN_WEBVIEW_METHODS = [
  "collections.get",
  "collections.put",
  "collections.list",
  "invoke",
  "config.get",
  "config.set",
  "openDeeplink",
  // v2. Everything below reaches ADE's own UI or the machine around it, which
  // is why each one is named here rather than folded into a generic "ask the
  // host" verb: the list IS the permission model, and a page cannot widen it.
  "openSettings",
  "surface.close",
  "composer.attach",
  "composer.insert",
  "ui.toast",
  "ui.dismissToast",
  "ui.prompt",
  "ui.confirm",
  "clipboard.read",
  "clipboard.write",
  "theme.get",
  "host.subscribe",
  "host.unsubscribe",
  "dialog.submit",
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
export const PLUGIN_WEBVIEW_EVENTS = ["changed", "theme", "host"] as const;

export type PluginWebviewEventName = (typeof PLUGIN_WEBVIEW_EVENTS)[number];

export function isPluginWebviewEventName(value: unknown): value is PluginWebviewEventName {
  return PLUGIN_WEBVIEW_EVENTS.some((name) => name === value);
}

/**
 * One push to a guest, on the single event channel.
 *
 * The name rides IN the frame rather than in the channel because a guest gets
 * exactly one `ipcRenderer.on` in its preload: a channel per event name would
 * mean the preload subscribing to every name a future host might send, and a
 * page that heard nothing when the host added a fourth. The preload fans one
 * channel out to the page's own listeners by reading `event`.
 */
export type PluginWebviewEventFrame = {
  event: PluginWebviewEventName;
  payload: unknown;
};

/**
 * The theme a page paints itself with.
 *
 * `scheme` is what the app calls dark or light; `tokens` are the `--ade-*`
 * custom properties with their leading dashes intact, so a page can write them
 * straight onto its own `:root` and match ADE without knowing the palette. It
 * is a SNAPSHOT: the renderer republishes on every theme change, and the guest
 * hears the new one as the `theme` event.
 */
export type PluginWebviewThemeSnapshot = {
  scheme: "dark" | "light";
  tokens: Record<string, string>;
};

/** Ceilings on a published theme, so one window cannot push a payload at guests. */
export const PLUGIN_WEBVIEW_THEME_MAX_TOKENS = 400;
export const PLUGIN_WEBVIEW_THEME_TOKEN_MAX_CHARS = 240;

/**
 * Trim a published theme to what a guest may be handed.
 *
 * Shape-checked rather than trusted even though the publisher is ADE's own
 * renderer: this value crosses into an untrusted guest, and a token map that
 * grew without a bound would be a per-frame cost paid by every plugin page.
 */
export function sanitizePluginWebviewTheme(value: unknown): PluginWebviewThemeSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const scheme = record.scheme === "light" ? "light" : record.scheme === "dark" ? "dark" : null;
  if (!scheme) return null;
  const rawTokens = record.tokens;
  const tokens: Record<string, string> = {};
  if (rawTokens && typeof rawTokens === "object" && !Array.isArray(rawTokens)) {
    for (const [name, tokenValue] of Object.entries(rawTokens as Record<string, unknown>)) {
      if (Object.keys(tokens).length >= PLUGIN_WEBVIEW_THEME_MAX_TOKENS) break;
      if (typeof tokenValue !== "string") continue;
      if (tokenValue.length > PLUGIN_WEBVIEW_THEME_TOKEN_MAX_CHARS) continue;
      if (!name.startsWith("--")) continue;
      tokens[name] = tokenValue;
    }
  }
  return { scheme, tokens };
}

/**
 * The host families a page may follow live.
 *
 * The first three are the entity families the SDK's change events name, and a
 * page needs them for the same reason: a Linear browser that does not hear
 * about a new lane draws a stale list until the reader reloads it.
 *
 * `chat` is the fourth and it is not an entity family. It reports where a
 * chat session's TURN is — started, completed or failed — because a page that
 * launched an agent has no other way to learn that the first turn died. A
 * launched issue would sit on "Ready" forever, which is the one state it is
 * certainly not in. See {@link PluginWebviewChatTurn}.
 */
export const PLUGIN_WEBVIEW_HOST_KINDS = ["lane", "session", "pr", "chat"] as const;

export type PluginWebviewHostKind = (typeof PLUGIN_WEBVIEW_HOST_KINDS)[number];

export function isPluginWebviewHostKind(value: unknown): value is PluginWebviewHostKind {
  return PLUGIN_WEBVIEW_HOST_KINDS.some((kind) => kind === value);
}

/**
 * How long the host gathers entity changes before it tells a guest.
 *
 * A rebase moves a dozen lanes in a few milliseconds and a PR poll finishes a
 * whole page of them at once. Delivered raw that is a dozen wake-ups of a
 * webview that will redraw once either way, so the host batches and sends the
 * union.
 */
export const PLUGIN_WEBVIEW_HOST_COALESCE_MS = 120;

/** Ids one coalesced frame carries before it says `overflow` instead. */
export const PLUGIN_WEBVIEW_HOST_IDS_MAX = 200;

/**
 * "Something in this family moved."
 *
 * Identity and nothing else, the same rule the entity bus itself keeps: no
 * titles, no branch names, no diff. `overflow` means more ids moved than the
 * frame carries, so the page must refetch the family rather than patch the ids
 * it was given.
 */
export type PluginWebviewHostEvent = {
  kind: PluginWebviewHostKind;
  ids: string[];
  overflow: boolean;
  /**
   * Turn states, on a `chat` frame only. `ids` carries the same session ids, so
   * a page that only wants "this session moved" reads `ids` and ignores this.
   *
   * The one narrowing of the identity-only rule above, and it is narrow on
   * purpose: a turn carries its lifecycle position and the host's own failure
   * sentence, and nothing else. No prompt, no reply, no tool name, no token
   * count. It is here because "the turn you launched failed" is a fact the page
   * cannot re-derive from identity — the session exists either way.
   */
  turns?: PluginWebviewChatTurn[];
};

/**
 * Where a chat session's current turn is.
 *
 * Three states rather than the five the app tracks internally: a page draws a
 * launched issue as running, done or broken, and `interrupted` is a `failed`
 * the reader caused on purpose — which is still not "Ready". The host maps
 * `interrupted` onto `failed` so a page has one error path rather than two.
 */
export const PLUGIN_WEBVIEW_CHAT_TURN_STATES = ["started", "completed", "failed"] as const;

export type PluginWebviewChatTurnState = (typeof PLUGIN_WEBVIEW_CHAT_TURN_STATES)[number];

export function isPluginWebviewChatTurnState(
  value: unknown,
): value is PluginWebviewChatTurnState {
  return PLUGIN_WEBVIEW_CHAT_TURN_STATES.some((state) => state === value);
}

/**
 * One turn's move, as a page hears it.
 *
 * `message` is the host's own failure sentence and is present only on `failed`.
 * It is the sentence ADE would show the reader, so a page can draw the same one
 * rather than inventing "Something went wrong".
 */
export type PluginWebviewChatTurn = {
  sessionId: string;
  state: PluginWebviewChatTurnState;
  /** The host's turn id, when the producer knows it. Opaque to the page. */
  turnId?: string;
  /** Only on `failed`. Bounded by {@link PLUGIN_WEBVIEW_CHAT_MESSAGE_MAX_CHARS}. */
  message?: string;
};

/** Ceiling on a failure sentence handed to a page. */
export const PLUGIN_WEBVIEW_CHAT_MESSAGE_MAX_CHARS = 400;

/**
 * Turns one coalesced `chat` frame carries.
 *
 * Lower than {@link PLUGIN_WEBVIEW_HOST_IDS_MAX} because a turn is a record and
 * an id is a string: a batch launch of fifty issues is the realistic ceiling,
 * and past it the frame says `overflow` and the page refetches the sessions it
 * is watching.
 */
export const PLUGIN_WEBVIEW_CHAT_TURNS_MAX = 100;

/**
 * Trim one turn report to what a guest may be handed, or refuse it.
 *
 * Shape-checked even though the publisher is ADE's own renderer, for the same
 * reason {@link sanitizePluginWebviewTheme} is: this value crosses into an
 * untrusted guest, and an unbounded message would be a per-turn cost every
 * plugin page pays.
 */
export function sanitizePluginWebviewChatTurn(value: unknown): PluginWebviewChatTurn | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  if (!sessionId) return null;
  if (!isPluginWebviewChatTurnState(record.state)) return null;
  const turnId = typeof record.turnId === "string" ? record.turnId.trim() : "";
  const rawMessage = typeof record.message === "string" ? record.message.trim() : "";
  // A message on a state that is not a failure is dropped rather than carried:
  // the field means "why this turn broke", and a sentence on a completed turn
  // would be a second, unspecified channel a page would learn to read.
  const message =
    record.state === "failed" && rawMessage
      ? rawMessage.slice(0, PLUGIN_WEBVIEW_CHAT_MESSAGE_MAX_CHARS)
      : "";
  return {
    sessionId,
    state: record.state,
    ...(turnId ? { turnId } : {}),
    ...(message ? { message } : {}),
  };
}

/**
 * A toast a page asked ADE to show. Same levels ADE's own toasts use.
 *
 * `actionId` is the plugin's own action name: pressing the toast's button
 * invokes it, which is how a page raises a notice it can still act on after the
 * page itself is gone.
 */
export const PLUGIN_WEBVIEW_TOAST_LEVELS = ["info", "success", "warning", "error"] as const;

export type PluginWebviewToastLevel = (typeof PLUGIN_WEBVIEW_TOAST_LEVELS)[number];

export function isPluginWebviewToastLevel(value: unknown): value is PluginWebviewToastLevel {
  return PLUGIN_WEBVIEW_TOAST_LEVELS.some((level) => level === value);
}

export const PLUGIN_WEBVIEW_TOAST_MESSAGE_MAX_CHARS = 240;
export const PLUGIN_WEBVIEW_TOAST_LABEL_MAX_CHARS = 32;

export type PluginWebviewToast = {
  level: PluginWebviewToastLevel;
  message: string;
  actionLabel?: string;
  actionId?: string;
};

export const PLUGIN_WEBVIEW_CONFIRM_TITLE_MAX_CHARS = 120;
export const PLUGIN_WEBVIEW_CONFIRM_BODY_MAX_CHARS = 600;

/** A yes/no the page cannot draw itself, because it must sit above the guest. */
export type PluginWebviewConfirm = {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

/**
 * An issue a page asked to attach to the composer.
 *
 * The same five facts the socket `{composer}` answer carries for an issue chip.
 * `identifier` is the human key (`ADE-123`), which is what the chip draws;
 * `issueId` is the tracker's own id, which is what a later action resolves.
 */
export type PluginWebviewComposerAttach = {
  provider: string;
  issueId: string;
  identifier: string;
  title: string;
  url?: string | null;
};

/**
 * The answer a page drawn as a `dialog-picker` gives its dialog.
 *
 * The SAME five facts {@link PluginWebviewComposerAttach} carries, and
 * deliberately the same shape rather than a second issue type: a page that can
 * fill the composer's issue chip already builds this record, and a picker that
 * had to build a different one for the Create-lane dialog would be two
 * serialisers for one concept. What differs is where the record goes — a
 * composer chip, or the dialog's own name, branch and PR-reference derivation —
 * and that is the host's business, not the page's.
 *
 * `issue: null` is a real answer: it means "the reader cleared the selection",
 * which a dialog must be able to hear or a chosen issue could never be undone
 * from inside the page.
 */
export type PluginWebviewDialogSubmit = {
  issue: PluginWebviewComposerAttach | null;
};

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
 * Rows one `collections.list` page returns, and the ceiling on what a page may
 * ask for.
 *
 * A page draws a list, not a table — but a Linear browser genuinely has more
 * than 500 issues cached, so the cap is a PAGE size rather than a wall: a
 * result of exactly this many rows means "ask again with `after` set to the
 * last key you got".
 */
export const PLUGIN_WEBVIEW_LIST_MAX_ROWS = 500;

/** What `collections.list` accepts. `after` is the exclusive cursor. */
export type PluginWebviewListOptions = {
  keyPrefix?: string;
  limit?: number;
  /** The last key of the previous page. Rows at or before it are skipped. */
  after?: string;
};

// ---------------------------------------------------------------------------
// The host-window relay
// ---------------------------------------------------------------------------

/**
 * The verbs the MAIN process cannot answer on its own.
 *
 * The split is not arbitrary. Main owns the machine — the clipboard, the
 * browser, the plugin registry — so it answers `clipboard.*`, `theme.get`,
 * `host.subscribe` and `context.project` directly. Everything here is a piece
 * of ADE's OWN UI: the settings page, the composer, the toast stack, the prompt
 * sheet, the popover that is drawing the guest. Only the renderer of the window
 * that owns the guest can do any of it, so main forwards the request and waits
 * for that window's answer.
 *
 * `actionResult` is the odd one out and the reason item 3 of the spec exists: a
 * page's `invoke` may come back carrying the same control-flow answers a socket
 * press honours (`navigate`, `openSettings`, `composer`, `dialog`, `message`),
 * and the renderer already knows how to apply all of them. Rather than teach
 * main to decompose the result into four more verbs, main hands the renderer the
 * raw result under this verb and the renderer runs its existing reader — so a
 * page gets the socket-path behaviour without a second implementation of it.
 */
export const PLUGIN_WEBVIEW_UI_VERBS = [
  "openSettings",
  "surface.close",
  "composer.attach",
  "composer.insert",
  "ui.toast",
  "ui.dismissToast",
  "ui.prompt",
  "ui.confirm",
  "dialog.submit",
  "actionResult",
] as const;

export type PluginWebviewUiVerb = (typeof PLUGIN_WEBVIEW_UI_VERBS)[number];

export function isPluginWebviewUiVerb(value: unknown): value is PluginWebviewUiVerb {
  return PLUGIN_WEBVIEW_UI_VERBS.some((verb) => verb === value);
}

/**
 * Main → the owning window, on `IPC.pluginWebviewUiRequest`.
 *
 * Everything the renderer needs to act without trusting the guest: WHO asked
 * (`pluginId`, and it is the host's own derivation, never the page's claim),
 * WHERE it is drawn (`surfaceId` + `placement`, captured at attach), WHICH
 * guest (`guestKey`, the guest's `webContents` id as a string — the renderer
 * reads the same number off its own element with `getWebContentsId()`), and
 * WHAT was asked. The renderer must answer EVERY request exactly once on
 * `IPC.pluginWebviewUiResponse` with the same `requestId`; a request it does not
 * recognize is answered `{ ok: false }`, never dropped, or the page's promise
 * hangs until the timeout.
 */
export type PluginWebviewUiRequest = {
  requestId: string;
  guestKey: string;
  pluginId: string;
  surfaceId: string | null;
  placement: PluginWebviewPlacement | null;
  verb: PluginWebviewUiVerb;
  args: Record<string, unknown>;
};

/**
 * The owning window → main, on `IPC.pluginWebviewUiResponse`.
 *
 * `ok: false` with a `message` is a refusal the page sees as a rejected promise
 * carrying that sentence. `value` is the verb's answer: `{ id }` for a toast,
 * the answer or null for `ui.prompt`, a boolean for `ui.confirm`, and undefined
 * for the verbs that only do something.
 */
export type PluginWebviewUiResponse = {
  requestId: string;
  ok: boolean;
  value?: unknown;
  message?: string;
};

/**
 * How long main waits for the window before it gives the page an answer.
 *
 * Two numbers because two different things are being waited on. The short one
 * is a renderer round trip — a toast, a composer edit, a settings navigation —
 * and a window that has not answered in ten seconds is wedged, not slow. The
 * long one covers `ui.prompt` and `ui.confirm`, where the wait is a PERSON
 * reading a question; ten minutes is long enough that nobody is timed out
 * mid-thought and short enough that a forgotten sheet does not pin a promise
 * for the life of the app.
 */
export const PLUGIN_WEBVIEW_UI_TIMEOUT_MS = 10_000;
export const PLUGIN_WEBVIEW_UI_ASK_TIMEOUT_MS = 10 * 60_000;

/** Which timeout a verb gets. See the two constants above. */
export function pluginWebviewUiTimeoutMs(verb: PluginWebviewUiVerb): number {
  return verb === "ui.prompt" || verb === "ui.confirm"
    ? PLUGIN_WEBVIEW_UI_ASK_TIMEOUT_MS
    : PLUGIN_WEBVIEW_UI_TIMEOUT_MS;
}

/**
 * The guest's key in the relay, from its `webContents` id.
 *
 * A string rather than the bare number so it cannot be confused with a window
 * id or a surface index at a call site, and prefixed so a logged key says what
 * it is.
 */
export function pluginWebviewGuestKey(webContentsId: number): string {
  return `guest-${webContentsId}`;
}

// ---------------------------------------------------------------------------
// Hot reload
// ---------------------------------------------------------------------------

/**
 * Main → the renderer, on `IPC.pluginWebviewReload`: this plugin's bytes moved.
 *
 * The renderer recreates every guest of `pluginId` — a new element, not a
 * `reload()` on the old one, because the point is a fresh origin load with the
 * new files rather than a re-run of the ones the guest already fetched. Keying
 * the element on `${version}:${revision}` is enough to do that.
 *
 * `revision` counts installs within this app run. It exists because
 * `ade plugin dev` re-copies a source tree over the installed one without
 * changing `version`, and a dev loop that does not repaint the page is the
 * whole reason a plugin author reaches for Try again.
 */
export type PluginWebviewReloadEvent = {
  pluginId: string;
  version: string;
  revision: number;
};

// ---------------------------------------------------------------------------
// Size-to-content
// ---------------------------------------------------------------------------

/**
 * The `sendToHost` channel a page reports its own height on.
 *
 * The ONE thing on this bridge that does not go through the main process, and
 * the reason is the whole design: a settings section and a composer picker are
 * sized to their content, so the page measures itself with a `ResizeObserver`
 * and the element around it grows. Routing that through main would put an IPC
 * round trip on every layout tick to authorize a number that authorizes
 * nothing — a page cannot move, cover or resize anything but its own frame, and
 * the host clamps what it is told. `sendToHost` reaches the embedder element
 * directly, which is exactly the party that owns the frame.
 */
export const PLUGIN_WEBVIEW_RESIZE_CHANNEL = "ade:plugin-webview:resize";

/**
 * Tallest a page may ask its own frame to be.
 *
 * A ceiling rather than a promise: a settings section that reported 40,000
 * pixels would push every control below it off the page, and a scroll bar
 * inside the guest is the honest answer for content that long.
 */
export const PLUGIN_WEBVIEW_MAX_HEIGHT_PX = 2_000;

/** What a page sends on {@link PLUGIN_WEBVIEW_RESIZE_CHANNEL}. */
export type PluginWebviewResize = { height: number };

/**
 * The height a host should actually apply, or null when there is none.
 *
 * Clamped in the PAGE as well as in the host, so the two cannot disagree about
 * the ceiling and a page's own logging shows the number that will be used. A
 * value that is not a finite positive number is null rather than zero: "the
 * page said nothing usable" and "the page wants to be invisible" are different
 * instructions, and collapsing them would hide a broken observer.
 */
export function clampPluginWebviewHeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(Math.ceil(value), PLUGIN_WEBVIEW_MAX_HEIGHT_PX);
}

/**
 * The renderer → main, on `IPC.pluginWebviewSurfaceState`: this guest's surface
 * is (or is no longer) on screen.
 *
 * A relayed request from a guest whose surface is detached is refused
 * `not_permitted`. A popover that was dismissed while its page had a confirm in
 * flight must not be able to re-open ADE's UI on the way out, and "the element
 * is gone" is not something main can see on its own — a guest survives its own
 * detach for as long as the renderer keeps the element alive.
 */
export type PluginWebviewSurfaceState = {
  guestKey: string;
  attached: boolean;
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
    /**
     * One page of rows, newest ceiling {@link PLUGIN_WEBVIEW_LIST_MAX_ROWS}.
     *
     * A full page means there may be more: ask again with `after` set to the
     * last key you received. Rows come back in the host's own key order, so
     * paging this way cannot skip or repeat a row.
     */
    list(
      collection: string,
      options?: PluginWebviewListOptions,
    ): Promise<{ key: string; value: unknown }[]>;
  };

  /**
   * Call one of the plugin's own named action handlers.
   *
   * The result is handed back raw — AND its control-flow answers are applied
   * first. A handler that returns `{navigate}`, `{openSettings}`, `{composer}`,
   * `{dialog}`, `{message}`, `{openUrl}` or `{authSession}` moves ADE exactly
   * as it would from a socket press, so a page does not reimplement seven verbs
   * to get the behaviour its own plugin already returns. `{prompt}` is asked
   * and the action is re-invoked once with the answer, the same single hop
   * every other client makes.
   */
  invoke(action: string, args?: Record<string, unknown>): Promise<unknown>;

  config: {
    get(): Promise<Record<string, string | number | boolean | null>>;
    /**
     * Write this plugin's own declared settings; answers with the new
     * effective config.
     *
     * Present here — unlike `secrets` — because a plugin's settings page IS a
     * page, and a form that renders a setting it cannot save is the whole
     * reason this method exists. It is not a hole in the secrets rule: the host
     * refuses a `secret`-kind setting on this path exactly as it does on the
     * child's, so a credential still cannot be written from a page.
     *
     * `null` resets one setting to its manifest default. Same refusals as the
     * child SDK: undeclared key, wrong kind, a `select` value off its list.
     */
    set(key: string, value: string | number | boolean | null): Promise<Record<string, string | number | boolean | null>>;
    set(values: Record<string, string | number | boolean | null>): Promise<Record<string, string | number | boolean | null>>;
  };

  events: {
    /** Returns an unsubscribe function. */
    on(event: "changed", listener: (payload: PluginWebviewChangeEvent) => void): () => void;
    on(event: "theme", listener: (payload: PluginWebviewThemeSnapshot) => void): () => void;
    on(event: "host", listener: (payload: PluginWebviewHostEvent) => void): () => void;
  };

  /**
   * Open an `ade://` deeplink, or an `http(s):` URL in the user's real browser.
   * `http:` is accepted alongside `https:` because a plugin's own dev server is
   * a normal thing to link to. Nothing else is, so a page cannot use this to
   * reach `file:`, `javascript:` or its own origin out of band.
   */
  openDeeplink(url: string): Promise<void>;

  // -------------------------------------------------------------------------
  // v2
  // -------------------------------------------------------------------------

  /**
   * Send the reader to a settings page — one of ADE's own, by `entryId`, or
   * this plugin's own `settings-section`, by `socketId`.
   *
   * The same resolution the `{openSettings}` action answer gets, and the same
   * closed list of host entries. A socket id is scoped to the caller: a page
   * cannot open another plugin's section.
   */
  openSettings(target: { entryId: string } | { socketId: string }): Promise<void>;

  surface: {
    /**
     * Close the popover, overlay or picker this page is drawn in. A no-op in a
     * tab or a pane, where there is nothing to close and the page IS the view.
     */
    close(): Promise<void>;
  };

  composer: {
    /** Attach an issue chip to the chat composer. */
    attach(issue: PluginWebviewComposerAttach): Promise<void>;
    /** Insert text at the composer's caret. Never sends the message. */
    insert(text: string): Promise<void>;
  };

  dialog: {
    /**
     * Hand the chosen issue to the ADE dialog this page is drawn inside.
     *
     * Only meaningful in the `dialog-picker` placement. The dialog uses the
     * answer exactly as it used its own built-in picker's: Create-lane derives
     * the lane name and the branch from it, Create-PR derives the reference and
     * its magic word. Pass `{ issue: null }` to clear a previous choice.
     *
     * Refused with `not_permitted` in every other placement — a tab that could
     * name the issue for a dialog nobody opened would be writing into a form
     * the reader is not looking at.
     */
    submit(answer: PluginWebviewDialogSubmit): Promise<void>;
  };

  ui: {
    /** Raise a toast. The returned id is what {@link dismissToast} takes. */
    toast(toast: PluginWebviewToast): Promise<{ id: string }>;
    dismissToast(id: string): Promise<void>;
    /**
     * Ask the one-field question ADE's own prompt UI draws. Resolves to the
     * answer, or null when the reader dismissed it.
     */
    prompt(prompt: PluginActionPrompt): Promise<PluginActionPromptAnswer | null>;
    /** Ask a yes/no. Resolves false when the reader dismissed it. */
    confirm(request: PluginWebviewConfirm): Promise<boolean>;
    /**
     * Report this page's own content height so a size-to-content placement can
     * grow around it. Call it from a `ResizeObserver`.
     *
     * Honoured in `settings-section` and `dialog-picker` — the two placements
     * that sit INSIDE a taller ADE surface and therefore have no height of
     * their own to fill. Every other placement fills a frame the host already
     * sized, so the report is read and dropped. This is the ONLY supported way
     * a page states its height: writing `documentElement.style.height` or
     * posting a private `postMessage` reaches nothing on any host.
     *
     * Synchronous and void, and the ONLY member here that is — see
     * {@link PLUGIN_WEBVIEW_RESIZE_CHANNEL}. It is a report to the element
     * hosting the frame, not a request the host answers, so there is nothing to
     * await and a promise per layout tick would be pure cost. A placement that
     * is not sized to content ignores it. Clamped to
     * {@link PLUGIN_WEBVIEW_MAX_HEIGHT_PX}.
     */
    resize(size: PluginWebviewResize): void;
  };

  clipboard: {
    read(): Promise<string>;
    write(text: string): Promise<void>;
  };

  theme: {
    /** The theme as of now. Follow changes with `events.on("theme", …)`. */
    get(): Promise<PluginWebviewThemeSnapshot>;
  };

  host: {
    /**
     * Follow lane, session and PR changes in this window's project.
     *
     * Frames arrive on `events.on("host", …)`, coalesced. The returned promise
     * resolves to the unsubscribe function; calling it stops the delivery for
     * every kind this call named.
     */
    subscribe(options: { kinds: PluginWebviewHostKind[] }): Promise<() => void>;
  };
};
