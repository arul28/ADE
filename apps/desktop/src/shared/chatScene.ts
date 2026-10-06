/**
 * Scenes — agent-authored generated UI.
 *
 * A scene is a ```scene fence containing ordinary HTML, CSS and JS. Unlike a
 * mosaic card (data, validated, rendered by ADE's own components) a scene is
 * *code the agent wrote*, so it never runs in ADE's renderer. It runs inside a
 * frame that has its own opaque origin, its own Content-Security-Policy, and
 * `sandbox="allow-scripts"` WITHOUT `allow-same-origin` — that pair is the one
 * combination which would hand the frame back its own origin, and nothing here
 * may ever set both.
 *
 * The policy below is the whole security story, so read it before changing it:
 *
 *   default-src 'none'   nothing loads unless a later directive allows it
 *   connect-src 'none'   no fetch, no XHR, no WebSocket, no beacon
 *   script-src 'unsafe-inline'   inline script only; no remote code, no eval
 *   img-src data: blob:  pixels the host handed over, never a remote URL
 *
 * A scene therefore cannot FETCH anything out: no request it can originate is
 * allowed to leave. It is not a total seal, and the difference matters —
 * navigating the frame (`location = "https://elsewhere/?" + secret`) is a
 * navigation, not a fetch, and nothing in this policy speaks to it. Two doors
 * close that one, both outside this file: the renderer's own `frame-src`
 * bounds where a nested context may go, and main refuses a subframe navigation
 * outside that same allowlist (`will-frame-navigate` in `main.ts`).
 *
 * Two further risks remain and are handled elsewhere. It can draw something
 * misleading, so the host labels every scene on hover and a scene can never
 * approve, confirm or reach anything: its only ways out are the messages
 * {@link parseSceneHostMessage} accepts. And it can burn CPU and GPU. The bounds
 * on that are the source-size cap below, the clamped frame height, the host
 * running a frame only while its scene is on screen (a still stands in
 * otherwise), and the SDK idling a settled scene nobody is touching: endless
 * animations pause and `requestAnimationFrame` drops to a few frames a second
 * until the pointer or focus comes back. There is no CPU watchdog for a busy
 * script loop.
 *
 * Division of labour with mosaic: a scene SHOWS, a mosaic ASKS. Approvals and
 * destructive confirmations stay in mosaic and in ADE's native surfaces — a
 * scene drawing its own "Approve" button would be a scene approving itself.
 */

export const SCENE_FENCE_LANGUAGE = "scene";

/**
 * The identity of ONE scene inside a message.
 *
 * A row identity is not enough on its own: a message may hold two scene
 * fences, and both of them being handed the row's identity meant they shared a
 * still — whichever settled last overwrote the other, and a reopened chat
 * showed the same picture twice. The source hash is what separates them, the
 * same way mosaic cards separate two answerable cards in one message.
 *
 * Stored with the still in main, so it must be derived identically on every
 * mount: a pure function of the row identity and the fence body, and nothing
 * else. Pass {@link sceneRowIdentity}, not a transcript render key — see it for
 * why the render key is not stable enough to be a still's name on disk.
 */
export function sceneScopeKeyFor(rowIdentity: string, source: string): string {
  return `${rowIdentity}:${djb2Hash(source)}`;
}

/**
 * What identifies the ROW a scene was drawn in, across every rebuild of the
 * transcript.
 *
 * This is a FILE NAME on disk, so its format is frozen: stills already filed
 * under `message:` / `item:` names must keep matching. Render keys used to
 * embed the event's index in the loaded window (so a prepended page or a front
 * trim renamed every row, and a scene re-ran and re-filed a second still on
 * every reopen); they are now built from the same identity facts
 * (`allocateTranscriptEventRowKey`), but they carry a session prefix and an
 * event-type tag this name never had.
 *
 * `messageId` is the provider's own name for the message. `turnId` + `itemId`
 * is the same fact assembled from two fields, for providers that name items
 * but not messages. The row key is the last resort — for a text event carrying
 * none of the three it is timestamp-based, which survives paging but not a
 * provider that rewrites timestamps.
 */
export function sceneRowIdentity(
  event: { messageId?: string | null; turnId?: string | null; itemId?: string | null },
  rowKey: string,
): string {
  const messageId = event.messageId?.trim();
  if (messageId) return `message:${messageId}`;
  const turnId = event.turnId?.trim();
  const itemId = event.itemId?.trim();
  if (turnId && itemId) return `item:${turnId}:${itemId}`;
  return rowKey;
}

/** djb2, base 36. Short, stable, and not a security boundary. */
function djb2Hash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export const SCENE_LIMITS = {
  /** Source bytes. Past this a scene is a document, not a view. */
  maxSourceBytes: 96_000,
  /**
   * Bytes of ASSEMBLED document the main process will hold for a frame.
   *
   * The renderer checks `maxSourceBytes` before it ever calls `scene.prepare`,
   * but the document store is bounded by document COUNT, so a renderer that
   * skipped that check could pin 64 unbounded strings in main. This is the
   * server-side bound: the fence source plus the fixed template and the two
   * inlined app fonts (~150 KB as data URLs; see `sceneFonts.ts`), with room
   * for both rather than a second magic number at the IPC edge.
   */
  maxDocumentBytes: 400_000,
  maxTitleLength: 120,
  /** A scene that never calls ade.ready() is frozen anyway after this. */
  readyTimeoutMs: 8_000,
} as const;

/**
 * How long the DOM has to hold still, with no animation running, before a
 * scene is called settled.
 *
 * Long enough to bridge the gap between two steps of a staged reveal — a scene
 * that fades a header in and then, a beat later, counts a number up is one
 * animation as far as the author is concerned — and short enough that the
 * still is taken while the view still means what it drew.
 */
export const SCENE_SETTLE_QUIET_MS = 600;

/**
 * The longest a scene may keep the settle watcher waiting after `ready`.
 *
 * There has to be a cap: a scene with a looping animation (a pulsing dot, a
 * marquee) is never quiet and never will be, and without a deadline it would
 * simply never produce a still. At the cap the host takes the picture anyway —
 * a frame of a loop is a truthful picture of a view that loops.
 */
export const SCENE_SETTLE_MAX_MS = 4_000;

export const SCENE_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join("; ");

/**
 * Live ADE data a scene may ask for on its marker line,
 * `<!-- @scene title="…" data="lanes,prs" -->`. The host sends each one as a
 * read-only snapshot and again when it changes; see `sceneData.ts`.
 */
export const SCENE_DATA_SOURCES = ["lanes", "sessions", "prs"] as const;
export type SceneDataSource = (typeof SCENE_DATA_SOURCES)[number];

export type ParsedScene = {
  title: string | null;
  /** The agent's markup, unwrapped from any document tags it supplied. */
  html: string;
  /** The live sources the scene asked for, in a fixed order; empty for none. */
  data: SceneDataSource[];
};

function readSceneDataSources(raw: string | undefined): SceneDataSource[] {
  if (!raw) return [];
  const asked = new Set(raw.toLowerCase().split(/[\s,]+/).filter(Boolean));
  return SCENE_DATA_SOURCES.filter((source) => asked.has(source));
}

export type SceneParseFailure = {
  reason: "empty" | "too-large";
  detail: string;
};

const MARKER = /^\s*<!--\s*@scene\b([^>]*?)-->\s*$/i;
const ATTR = /(\w+)\s*=\s*"([^"]*)"/g;

/** Pull `title="…"` (and any future keys) off the `<!-- @scene … -->` line. */
function readMarkerAttributes(rest: string): Record<string, string> {
  const out: Record<string, string> = {};
  let match: RegExpExecArray | null;
  ATTR.lastIndex = 0;
  while ((match = ATTR.exec(rest))) out[match[1].toLowerCase()] = match[2];
  return out;
}

/**
 * The document furniture a scene never gets to keep.
 *
 * `<head>`/`<body>` lose the tag but keep their contents (styles, fonts, the
 * markup itself) so the fragment concatenates cleanly into the host template.
 * Dropping `<base>` matters even though `default-src 'none'` already blocks
 * every fetch: it keeps relative-URL behaviour predictable if the policy is
 * ever loosened. And a scene cannot relax its own policy, so a CSP meta the
 * model wrote goes too.
 */
const DOCUMENT_WRAPPER = new RegExp([
  "<!doctype[^>]*>",
  "</?(?:html|head|body)(?:\\s[^>]*)?>",
  "<base(?:\\s[^>]*)?>",
  "<meta[^>]+http-equiv\\s*=\\s*[\"']?content-security-policy[\"']?[^>]*>",
].join("|"), "gi");

/**
 * Regions whose text is DATA, not markup, and must survive byte for byte.
 *
 * One alternation rather than three passes so the earliest opener wins: a
 * `<script>` written inside a comment is part of the comment, and a `<!--`
 * inside a script is part of the script.
 */
const VERBATIM_REGION = /<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->/gi;

/**
 * Models emit anything from a bare `<div>` to a full document. Normalize both
 * to a fragment so the host template owns <head> and the policy that lives in
 * it.
 *
 * The strip runs only OUTSIDE script, style and comment bodies. A blanket
 * `replace` over the whole source deleted the literal text `<body>` from inside
 * a JS string — a scene that rendered a snippet of HTML as its own content came
 * out silently corrupted, with no parse error to point at. Scanning for the
 * verbatim regions first costs one extra pass and makes the strip mean what its
 * name says: document furniture, not anything that happens to look like it.
 */
function unwrapDocument(source: string): string {
  let out = "";
  let cursor = 0;
  VERBATIM_REGION.lastIndex = 0;
  let region: RegExpExecArray | null;
  while ((region = VERBATIM_REGION.exec(source))) {
    out += source.slice(cursor, region.index).replace(DOCUMENT_WRAPPER, "");
    out += region[0];
    cursor = region.index + region[0].length;
  }
  out += source.slice(cursor).replace(DOCUMENT_WRAPPER, "");
  return out.trim();
}

/**
 * True while the last ```scene fence in a markdown body is still open.
 *
 * The markdown parser renders an unterminated fence as a finished code block on
 * every streamed tick, so without this the host prepares a new document and
 * reloads the frame several times a second — each reload throwing away whatever
 * the half-written scene had drawn. Fence state is tracked for every language,
 * not just `scene`: a ``` inside an open ```ts block closes that block and does
 * not open a scene.
 */
export function hasOpenSceneFence(markdown: string): boolean {
  return openFenceLanguage(markdown) === SCENE_FENCE_LANGUAGE;
}

/**
 * The language of the fence a still-arriving document leaves open, or null
 * when every fence is closed. A block that renders its fence as something
 * other than code (a scene, a mermaid diagram) holds while its own language
 * is open, so it never draws half a source.
 */
export function openFenceLanguage(markdown: string): string | null {
  return openFence(markdown)?.language ?? null;
}

/** The fence a still-arriving document leaves open: its language and the body so far. */
export function openFence(markdown: string): { language: string; body: string } | null {
  const { open } = scanFences(markdown);
  return open ? { language: open.language, body: open.body } : null;
}

/** One fence, as the scanner below located it. */
type FenceSpan = {
  language: string;
  /** Line indexes, half-open: the fence's own opening and closing lines included. */
  startLine: number;
  endLineExclusive: number;
  body: string;
};

/**
 * Every top-level fence in a markdown document, in order.
 *
 * The same line scanner `hasOpenSceneFence` uses, and deliberately so: the two
 * have to agree on \`\`\` versus ~~~, on up to three spaces of indentation, and on
 * the rule that a fence inside an open block closes that block rather than
 * opening a nested one. A second, looser regex somewhere else is how "the
 * streaming guard says a scene is open" and "the splitter found no scene" end
 * up both being true.
 */
function readFenceSpans(markdown: string): FenceSpan[] {
  return scanFences(markdown).spans;
}

/**
 * The CommonMark fence rule both readers share: a fence opens on three or more
 * backticks or tildes (indented at most three spaces) and closes only on a
 * bare run of the SAME character at least as long. So a ~~~ line inside a ```
 * block, or ``` inside a ```` block, is content, as the markdown renderer
 * reads it.
 */
function scanFences(markdown: string): { spans: FenceSpan[]; open: FenceSpan | null } {
  const lines = String(markdown ?? "").split("\n");
  const spans: FenceSpan[] = [];
  let opener: { marker: string; language: string; at: number } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (opener === null) {
      const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      const info = fence?.[2] ?? "";
      // A backtick fence's info string may not contain a backtick (then the
      // line is inline code, not a fence).
      if (fence && !(fence[1]![0] === "`" && info.includes("`"))) {
        opener = { marker: fence[1]!, language: (info.trim().split(/\s+/)[0] ?? "").toLowerCase(), at: i };
      }
      continue;
    }
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
    if (!close || close[1]![0] !== opener.marker[0] || close[1]!.length < opener.marker.length) continue;
    spans.push({ language: opener.language, startLine: opener.at, endLineExclusive: i + 1, body: lines.slice(opener.at + 1, i).join("\n") });
    opener = null;
  }
  const open = opener
    ? { language: opener.language, startLine: opener.at, endLineExclusive: lines.length, body: lines.slice(opener.at + 1).join("\n") }
    : null;
  return { spans, open };
}

/**
 * Split a message into what should be read aloud and the one scene it drew.
 *
 * The fence has to come OUT of the prose or a voice model reads HTML aloud —
 * and so does every OTHER scene fence, because the prompt allows exactly one
 * and a second one left behind is read out in full. Only the first VALID fence
 * becomes the scene; a malformed one is left in the prose rather than silently
 * dropped, so the failure is audible instead of invisible.
 */
export function extractSceneFence(markdown: string): {
  spoken: string;
  sceneSource?: string;
} {
  const text = String(markdown ?? "");
  const spans = readFenceSpans(text).filter((span) => span.language === SCENE_FENCE_LANGUAGE);
  if (!spans.length) return { spoken: text.trim() };

  const chosen = spans.find((span) => !isSceneParseFailure(parseSceneFence(span.body))) ?? null;
  // Every scene fence leaves the prose, valid or not, EXCEPT a malformed one
  // that is the only candidate — that one stays, so the user hears that
  // something was meant to be here.
  const removed = chosen ? spans : spans.slice(1);
  if (!removed.length) return { spoken: text.trim() };

  const lines = text.split("\n");
  const dropped = new Set<number>();
  for (const span of removed) {
    for (let i = span.startLine; i < span.endLineExclusive; i += 1) dropped.add(i);
  }
  const spoken = lines.filter((_line, index) => !dropped.has(index)).join("\n").trim();
  return chosen ? { spoken, sceneSource: chosen.body } : { spoken };
}

/** `Buffer` does not exist in the renderer; this file is shared by both sides. */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function parseSceneFence(source: string): ParsedScene | SceneParseFailure {
  const raw = String(source ?? "");
  if (utf8ByteLength(raw) > SCENE_LIMITS.maxSourceBytes) {
    return { reason: "too-large", detail: `Scene exceeds ${SCENE_LIMITS.maxSourceBytes} bytes.` };
  }

  const lines = raw.split("\n");
  let title: string | null = null;
  let data: SceneDataSource[] = [];
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().length) {
      bodyStart = i + 1;
      continue;
    }
    const marker = MARKER.exec(lines[i]);
    if (marker) {
      const attrs = readMarkerAttributes(marker[1] ?? "");
      const parsed = (attrs.title ?? "").trim();
      if (parsed.length) title = parsed.slice(0, SCENE_LIMITS.maxTitleLength);
      data = readSceneDataSources(attrs.data);
      bodyStart = i + 1;
    }
    break;
  }

  const html = unwrapDocument(lines.slice(bodyStart).join("\n"));
  if (!html.length) return { reason: "empty", detail: "Scene has no markup." };
  return { title, html, data };
}

export function isSceneParseFailure(value: ParsedScene | SceneParseFailure): value is SceneParseFailure {
  return "reason" in value;
}

/**
 * One line standing in for a scene on a surface that cannot run one.
 *
 * The TUI is the caller that matters: a scene is up to 96 KB of HTML and CSS,
 * and printing it into a terminal transcript buries the answer the user asked
 * for under a wall of markup. The mosaic fence already collapses this way; this
 * is the same contract for the other fence ADE renders natively.
 */
export function summarizeSceneFence(source: string): string {
  const parsed = parseSceneFence(source);
  const title = isSceneParseFailure(parsed) ? null : parsed.title;
  return `[scene: ${title ?? "generated view"}]`;
}

/**
 * Tokens forwarded into the frame as CSS custom properties. The frame cannot
 * read ADE's stylesheet — different origin — so a scene that wants to look like
 * ADE has to be handed the palette. Resolved values only; `var(--color-fg)`
 * would mean nothing on the other side.
 */
export type SceneTheme = {
  bg: string;
  /**
   * A raised fill for cards. Must be a value that resolves on its own inside
   * the frame: a `var(--color-fg)` reference means nothing there, and an
   * invalid custom property turned every `var(--surface)` transparent.
   */
  surface: string;
  border: string;
  fg: string;
  fgMuted: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  fontSans: string;
  fontMono: string;
  /** `color-scheme` for form controls and scrollbars. */
  scheme: "dark" | "light";
  /** The transcript's prose size in px, so scene text sits at the reply's size. */
  fontSize: number;
};

export const SCENE_FALLBACK_THEME: SceneTheme = {
  bg: "#0f0f11",
  surface: "rgba(255,255,255,0.04)",
  border: "rgba(255,255,255,0.10)",
  fg: "#F0F0F2",
  fgMuted: "rgba(240,240,242,0.58)",
  accent: "#A78BFA",
  success: "#4ade80",
  warning: "#fbbf24",
  danger: "#f87171",
  fontSans: "Geist, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
  fontMono: "\"JetBrains Mono\", ui-monospace, SFMono-Regular, Menlo, monospace",
  scheme: "dark",
  fontSize: 13,
};

/** The CSS custom properties a theme becomes inside the frame. */
export function sceneThemeVariables(theme: SceneTheme): Array<[string, string]> {
  return [
    ["--bg", theme.bg],
    ["--surface", theme.surface],
    ["--border", theme.border],
    ["--fg", theme.fg],
    ["--fg-muted", theme.fgMuted],
    ["--accent", theme.accent],
    ["--success", theme.success],
    ["--warning", theme.warning],
    ["--danger", theme.danger],
    ["--font-sans", theme.fontSans],
    ["--font-mono", theme.fontMono],
    ["--font-size", `${theme.fontSize}px`],
  ];
}

/** True when two themes would draw a scene identically. */
export function sameSceneTheme(a: SceneTheme, b: SceneTheme): boolean {
  return sceneThemeVariables(a).every(([, value], index) => value === sceneThemeVariables(b)[index]![1])
    && a.scheme === b.scheme;
}

/**
 * A message from the host into a scene frame. The frame acts on these only when
 * they come from its parent window.
 *
 * - `theme`: ADE's theme changed; the SDK re-applies the variables and
 *   `color-scheme`, updates `ade.theme`, and calls `ade.on("theme")` listeners.
 * - `data`: new live data; the SDK sets `ade.data` and calls `ade.on("data")`.
 */
export type SceneFrameInbound =
  | { type: "theme"; payload: SceneTheme }
  /** A snapshot of the live sources the scene asked for (`sceneData.ts`). */
  | { type: "data"; payload: unknown };

/** The envelope the in-frame SDK listens for. */
export function sceneFrameMessage(message: SceneFrameInbound): { __adeSceneHost: 1 } & SceneFrameInbound {
  return { __adeSceneHost: 1, ...message };
}

function escapeForScript(value: unknown): string {
  // `</script>` inside a JSON blob would close the tag early. U+2028 and U+2029
  // are legal inside a JSON string but are literal line terminators in JS
  // source, so both have to travel as escapes.
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The in-frame SDK.
 *
 * Deliberately dependency-free: the frame has `connect-src 'none'`, so it could
 * not fetch an animation library even if one were referenced, and inlining a
 * third-party one would put its licence inside every generated view. The Web
 * Animations API and CSS animations are native to Chromium, cost nothing, and
 * are what models reach for anyway.
 *
 * A const rather than a function: it never varies, so building it per scene
 * only re-trimmed the same four kilobytes.
 */
const SCENE_SDK_SOURCE = `
(function () {
  var listeners = Object.create(null);
  var reducedMotion = false;
  try { reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  /*
   * Restored: this scene already played once and is being brought back (it
   * scrolled back into view, or a reopened chat is waking its still). Its
   * entrance must not replay: ade.animate and ade.countUp jump to their end
   * state, and finite CSS animations started while restoring are finished on
   * the spot, so the live frame comes up looking like the still it replaces.
   * Ends at the first settle.
   */
  var restoring = !!window.__ADE_SCENE_RESTORED__;

  // Measure the CONTENT, not the frame. document.documentElement is sized by
  // the iframe element itself, so measuring it lets a scene grow but never
  // shrink below the host's initial guess.
  function measure() {
    var body = document.body;
    if (!body) return 0;
    var style = window.getComputedStyle(body);
    return Math.ceil(body.scrollHeight + parseFloat(style.marginTop || "0") + parseFloat(style.marginBottom || "0"));
  }

  // Every message carries the nonce of the document it was sent from. The host
  // keeps ONE mounted frame and swaps its src, and a contentWindow's identity
  // survives that swap — so without this an outgoing document's late 'settled'
  // is indistinguishable from the incoming one's.
  function post(type, payload) {
    var message = { __adeScene: 1, type: type, payload: payload };
    try {
      if (window.__ADE_SCENE_NONCE__) message.nonce = String(window.__ADE_SCENE_NONCE__);
    } catch (e) {}
    try { parent.postMessage(message, "*"); } catch (e) {}
  }

  function emitLocal(type, payload) {
    var fns = (listeners[type] || []).slice();
    for (var i = 0; i < fns.length; i++) {
      try { fns[i](payload); } catch (e) { post("error", { message: String(e && e.message || e) }); }
    }
  }

  var ade = {
    data: window.__ADE_SCENE_DATA__ || null,
    theme: window.__ADE_SCENE_THEME__ || null,
    reducedMotion: reducedMotion,
    restored: restoring,
    on: function (event, fn) {
      if (typeof fn !== "function") return function () {};
      (listeners[event] = listeners[event] || []).push(fn);
      // Data that already arrived is delivered to a late listener too, so a
      // scene can register after its first snapshot without missing it.
      if (event === "data" && ade.data !== null) {
        // The snapshot current when this fires, not when it was scheduled: a
        // newer one may have arrived in between.
        setTimeout(function () {
          try { fn(ade.data); } catch (e) { post("error", { message: String(e && e.message || e) }); }
        }, 0);
      }
      return function () {
        listeners[event] = (listeners[event] || []).filter(function (f) { return f !== fn; });
      };
    },
    emit: function (name, payload) { post("emit", { name: String(name), payload: payload }); },
    /** Open an ade:// link in ADE or an http(s) page in ADE's browser. Needs a click in the scene. */
    open: function (url) { post("open", { url: String(url) }); },
    ready: function () { post("ready", { height: measure() }); },
    resize: function () { post("resize", { height: measure() }); },
    /** WAAPI wrapper that collapses to the end state under reduced motion. */
    animate: function (target, keyframes, options) {
      var el = typeof target === "string" ? document.querySelector(target) : target;
      if (!el) return null;
      var opts = Object.assign({ duration: 420, easing: "cubic-bezier(.22,.61,.36,1)", fill: "both" }, options || {});
      if (reducedMotion || restoring) { opts.duration = 0; opts.delay = 0; }
      return el.animate(keyframes, opts);
    },
    /** Count a number up; the single most-wanted effect in a live view. */
    countUp: function (target, to, options) {
      var el = typeof target === "string" ? document.querySelector(target) : target;
      if (!el) return;
      var o = options || {};
      var from = typeof o.from === "number" ? o.from : 0;
      var duration = reducedMotion || restoring ? 0 : (typeof o.duration === "number" ? o.duration : 900);
      var decimals = typeof o.decimals === "number" ? o.decimals : 0;
      if (duration <= 0) { el.textContent = Number(to).toFixed(decimals); return; }
      var start = null;
      function frame(now) {
        if (start === null) start = now;
        var t = Math.min(1, (now - start) / duration);
        var eased = 1 - Math.pow(1 - t, 3);
        el.textContent = (from + (to - from) * eased).toFixed(decimals);
        if (t < 1) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    },
  };

  window.ade = ade;

  function applyTheme(theme) {
    if (!theme || typeof theme !== "object") return;
    var root = document.documentElement;
    var pairs = [
      ["--bg", theme.bg], ["--surface", theme.surface], ["--border", theme.border],
      ["--fg", theme.fg], ["--fg-muted", theme.fgMuted], ["--accent", theme.accent],
      ["--success", theme.success], ["--warning", theme.warning], ["--danger", theme.danger],
      ["--font-sans", theme.fontSans], ["--font-mono", theme.fontMono],
      ["--font-size", typeof theme.fontSize === "number" ? theme.fontSize + "px" : null],
    ];
    for (var i = 0; i < pairs.length; i++) {
      if (typeof pairs[i][1] === "string" && pairs[i][1].length) root.style.setProperty(pairs[i][0], pairs[i][1]);
    }
    if (theme.scheme === "light" || theme.scheme === "dark") root.style.colorScheme = theme.scheme;
    ade.theme = theme;
  }

  // Only the parent may speak to a scene. Anything else that posts here (a
  // nested window the scene opened, another frame) is ignored.
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || msg.__adeSceneHost !== 1 || typeof msg.type !== "string") return;
    if (msg.type === "theme") { applyTheme(msg.payload); wake(1500); }
    if (msg.type === "data") { ade.data = msg.payload; wake(1500); }
    emitLocal(msg.type, msg.payload);
  });

  // A link in a scene goes through ADE rather than navigating the frame (which
  // is blocked): ade:// opens in ADE, http(s) in ADE's browser.
  document.addEventListener("click", function (event) {
    var target = event.target;
    var anchor = target && typeof target.closest === "function" ? target.closest("a[href]") : null;
    if (!anchor) return;
    var href = anchor.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#") return;
    event.preventDefault();
    post("open", { url: href });
  }, true);

  // Blocked requests are the most common silent failure; say what was blocked.
  var policyReports = 0;
  document.addEventListener("securitypolicyviolation", function (event) {
    if (policyReports >= 5) return;
    policyReports += 1;
    post("error", { message: "Blocked by the scene policy (" + event.effectiveDirective + "): " + (event.blockedURI || "inline") });
  });

  window.addEventListener("error", function (event) {
    post("error", { message: String(event.message || "scene error") });
  });

  /*
   * Idle: a settled scene nobody is touching should cost nothing.
   *
   * A view that loops (a spinner, a pulsing dot, a canvas particle field) keeps
   * the GPU compositing every frame at the display's refresh rate — 240 times a
   * second on the panels ADE is developed on — for a picture that is not
   * changing what it says. So once the scene has settled and the pointer and
   * focus are elsewhere: endless animations pause where they are, SVG (SMIL)
   * animations pause, and requestAnimationFrame callbacks are batched into a
   * few frames a second rather than dropped, so a scene that redraws on new
   * data still redraws. Pointer, focus, wheel or a key wakes it at full rate.
   */
  var IDLE_RAF_INTERVAL_MS = 250;
  var IDLE_AFTER_LEAVE_MS = 1200;
  var settleReported = false;
  var engaged = false;
  var idle = false;
  var paused = [];
  var idleTimer = null;
  var wakeUntil = 0;
  var nativeRaf = window.requestAnimationFrame.bind(window);
  var nativeCaf = window.cancelAnimationFrame.bind(window);
  var rafQueue = [];
  var rafSeq = 0;
  var rafFlush = null;
  // Ids cancelled after their callback left the queue for a flush batch that
  // has not run yet. Without this a cancel in that gap was silently ignored.
  var rafCancelled = Object.create(null);
  var rafBatchesPending = 0;

  function flushRafQueue() {
    rafFlush = null;
    if (!rafQueue.length) return;
    var batch = rafQueue;
    rafQueue = [];
    rafBatchesPending += 1;
    nativeRaf(function (now) {
      for (var i = 0; i < batch.length; i++) {
        var entry = batch[i];
        if (rafCancelled[entry.id]) continue;
        try { entry.cb(now); } catch (e) { post("error", { message: String(e && e.message || e) }); }
      }
      // With no batch in flight, every remembered cancel is moot (its callback
      // ran or was skipped), so the record cannot grow.
      rafBatchesPending -= 1;
      if (rafBatchesPending === 0) rafCancelled = Object.create(null);
    });
  }

  window.requestAnimationFrame = function (cb) {
    if (!idle) return nativeRaf(cb);
    rafSeq += 1;
    // Negative ids never collide with the browser's own positive handles.
    var id = -rafSeq;
    rafQueue.push({ id: id, cb: cb });
    if (rafFlush === null) rafFlush = setTimeout(flushRafQueue, IDLE_RAF_INTERVAL_MS);
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    if (typeof id === "number" && id < 0) {
      var before = rafQueue.length;
      rafQueue = rafQueue.filter(function (entry) { return entry.id !== id; });
      // Not in the queue: it may be in a batch waiting for its frame.
      if (rafQueue.length === before) rafCancelled[id] = true;
      return;
    }
    nativeCaf(id);
  };

  function isEndless(animation) {
    try {
      return animation.effect && animation.effect.getComputedTiming().endTime === Infinity;
    } catch (e) {
      return false;
    }
  }

  // SVG <animate>/<animateTransform> (SMIL) is not in getAnimations(), and
  // Chromium repaints an animated SVG on the main thread every frame.
  function setSvgPaused(pause) {
    try {
      var svgs = document.querySelectorAll("svg");
      for (var i = 0; i < svgs.length; i++) {
        var svg = svgs[i];
        if (pause && typeof svg.pauseAnimations === "function") svg.pauseAnimations();
        if (!pause && typeof svg.unpauseAnimations === "function") svg.unpauseAnimations();
      }
    } catch (e) {}
  }

  function pauseEndless() {
    try {
      var running = document.getAnimations();
      for (var i = 0; i < running.length; i++) {
        var a = running[i];
        if (a.playState === "running" && isEndless(a)) { a.pause(); paused.push(a); }
      }
    } catch (e) {}
    setSvgPaused(true);
  }

  function setIdle(next) {
    if (idle === next) return;
    idle = next;
    if (idle) { pauseEndless(); return; }
    var resume = paused;
    paused = [];
    for (var i = 0; i < resume.length; i++) { try { resume[i].play(); } catch (e) {} }
    setSvgPaused(false);
    if (rafFlush !== null) { clearTimeout(rafFlush); rafFlush = null; }
    flushRafQueue();
  }

  function scheduleIdle(delay) {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      idleTimer = null;
      var remaining = wakeUntil - Date.now();
      if (remaining > 0) { scheduleIdle(remaining); return; }
      if (settleReported && !engaged) setIdle(true);
    }, delay);
  }

  /** Run at full rate for a moment: a new theme or new data arrived. */
  function wake(ms) {
    wakeUntil = Math.max(wakeUntil, Date.now() + ms);
    setIdle(false);
    scheduleIdle(ms);
  }

  function engage() {
    engaged = true;
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
    setIdle(false);
  }
  function disengage() {
    engaged = false;
    scheduleIdle(IDLE_AFTER_LEAVE_MS);
  }
  document.addEventListener("pointerover", engage, true);
  document.addEventListener("pointerdown", engage, true);
  document.addEventListener("wheel", engage, { capture: true, passive: true });
  document.addEventListener("keydown", engage, true);
  document.addEventListener("pointerout", function (event) {
    // relatedTarget is null only when the pointer left this document.
    if (!event.relatedTarget) disengage();
  }, true);
  window.addEventListener("blur", function () { if (engaged) disengage(); });

  // An endless animation that starts while idle (a row turning into a spinner
  // on new data) is paused as soon as it appears.
  var idleWatch = null;
  try {
    idleWatch = new MutationObserver(function () {
      if (!idle) return;
      setTimeout(function () { if (idle) pauseEndless(); }, 50);
    });
  } catch (e) {}

  // Report height once layout settles so the host can size the frame, and again
  // on any resize the scene causes itself.
  function reportHeight() { post("resize", { height: measure() }); }

  /*
   * Settle watch: tell the host the moment this view has finished moving.
   *
   * The host needs it because a scene's still has to be taken WHILE the scene
   * is still up, after the animation the author wrote has played.
   *
   * Two signals, because neither alone is enough. getAnimations() sees
   * WAAPI and CSS animations (ade.animate, a keyframed reveal) but not a
   * requestAnimationFrame loop; the MutationObserver sees ade.countUp writing
   * into a text node but not a transform that never touches the DOM. Quiet on
   * both for SETTLE_QUIET_MS is the definition of stopped. Endless animations
   * never finish, so they do not hold a settle back.
   *
   * Reported exactly once. A scene that keeps changing forever hits the cap
   * and is reported anyway — a frame of a loop is a truthful picture of a view
   * that loops — and a late mutation after that must not produce a second
   * settle, because the host acts on the first one.
   */
  var quietTimer = null;
  var capTimer = null;
  var settleObserver = null;

  function animationsRunning() {
    try {
      if (typeof document.getAnimations !== "function") return false;
      var running = document.getAnimations();
      for (var i = 0; i < running.length; i++) {
        if (running[i].playState === "running" && !isEndless(running[i])) return true;
      }
      return false;
    } catch (e) {
      // A browser without the API cannot report an animation; the mutation
      // half still speaks for itself.
      return false;
    }
  }

  // While restoring, a finite CSS animation is the entrance replaying: finish it.
  function finishEntrances() {
    if (!restoring) return;
    try {
      var running = document.getAnimations();
      for (var i = 0; i < running.length; i++) {
        if (!isEndless(running[i])) { try { running[i].finish(); } catch (e) {} }
      }
    } catch (e) {}
  }

  function reportSettled() {
    if (settleReported) return;
    settleReported = true;
    restoring = false;
    if (quietTimer !== null) clearTimeout(quietTimer);
    if (capTimer !== null) clearTimeout(capTimer);
    try { if (settleObserver) settleObserver.disconnect(); } catch (e) {}
    try {
      if (idleWatch) idleWatch.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    } catch (e) {}
    post("settled", { height: measure() });
    if (!engaged) scheduleIdle(0);
  }

  function armQuiet() {
    if (settleReported) return;
    finishEntrances();
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = setTimeout(function () {
      // Re-arm rather than settle while something finite is still playing: a
      // long animation mutates nothing, so the debounce alone would call it
      // quiet half a second in.
      if (animationsRunning()) { armQuiet(); return; }
      reportSettled();
    }, ${SCENE_SETTLE_QUIET_MS});
  }

  function watchForSettle() {
    if (settleObserver || settleReported) return;
    try {
      settleObserver = new MutationObserver(armQuiet);
      settleObserver.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, characterData: true,
      });
    } catch (e) {
      settleObserver = null;
    }
    capTimer = setTimeout(reportSettled, ${SCENE_SETTLE_MAX_MS});
    armQuiet();
  }

  window.addEventListener("load", function () {
    finishEntrances();
    reportHeight();
    post("ready", { height: measure() });
    // Started from 'ready' on purpose: the cap is measured from the moment the
    // scene is up, not from a document that has not run its script yet.
    watchForSettle();
  });
  if (typeof ResizeObserver === "function") {
    try { new ResizeObserver(reportHeight).observe(document.body); } catch (e) {}
  }
})();
`.trim();

/**
 * The frame's own defaults. No padding: a scene's content lines up with the
 * reply text around it, the way a chart in a document does, and a scene that
 * wants a card draws one. `flow-root` keeps a first heading's margin inside the
 * measured height instead of collapsing out of the body and getting clipped.
 */
function baseStyles(theme: SceneTheme, fontFaceCss: string): string {
  const variables = sceneThemeVariables(theme).map(([name, value]) => `  ${name}: ${value};`).join("\n");
  return `
${fontFaceCss}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
body {
  display: flow-root;
  color: var(--fg);
  font-family: var(--font-sans);
  font-size: var(--font-size);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums;
}
:root {
${variables}
  color-scheme: ${theme.scheme};
}
a { color: var(--accent); }
code, pre, kbd, samp { font-family: var(--font-mono); }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--fg) 18%, transparent); border-radius: 999px; }
::-webkit-scrollbar-track { background: transparent; }
`.trim();
}

export type SceneDocumentArgs = {
  html: string;
  title?: string | null;
  theme?: SceneTheme;
  data?: unknown;
  /**
   * Transcript-row key. It lands on `<body>` so two byte-identical scenes at
   * different positions produce different documents — without it the host's
   * memo yields the same string and both rows share one frame.
   */
  scopeKey?: string | null;
  /**
   * This DOCUMENT's identity, echoed back on every message the frame sends.
   *
   * The scope key cannot do this job: it names a scene's position in the
   * transcript, and a caller may swap document after document into one frame
   * under one key. What the host has to tell apart is the outgoing document
   * from the incoming one, and only a value minted per build can do that.
   *
   * Carried in the document itself, so it survives both delivery paths — the
   * `ade-scene:` URL and the blob fallback both serve these exact bytes.
   */
  nonce?: string | null;
  /**
   * This scene already played once and is being brought back on screen; its
   * entrance animations must not replay. See the SDK's `restoring`.
   */
  restored?: boolean;
  /**
   * `@font-face` rules for ADE's own fonts, as data URLs (the frame may load
   * fonts from `data:` only). Empty means the system fallbacks in the theme.
   */
  fontFaceCss?: string;
};

/**
 * The scope key, made safe for an HTML attribute without losing identity.
 *
 * A plain strip of everything outside `[A-Za-z0-9_:-]` was lossy: two transcript
 * keys differing only in stripped characters produced the same attribute, the
 * same document, and therefore the same memoized frame — the exact bug the key
 * exists to prevent. Percent-encoding is reversible, so every key stays
 * distinct, and its output is already limited to the unreserved set plus `%` —
 * none of which can close an attribute or open a tag.
 */
function sceneScopeAttribute(scopeKey: string): string {
  return encodeURIComponent(scopeKey);
}

/**
 * Host-built font CSS, kept from closing the `<style>` it is placed in. It is
 * ADE's own string, not the agent's, but it is assembled from fetched bytes, so
 * it is held to the one property that matters here.
 */
function sanitizeFontFaceCss(css: string | null | undefined): string {
  if (!css) return "";
  return /<\/style/i.test(css) ? "" : css;
}

/**
 * Assemble the document served to the frame. The CSP meta is the FIRST element
 * in <head> on purpose: a policy that arrives after markup has already parsed
 * is a policy that arrived too late. In Electron the same policy is also sent
 * as a response header by the `ade-scene:` handler, so neither half is load
 * bearing alone.
 */
export function buildSceneDocument(args: SceneDocumentArgs): string {
  const theme = args.theme ?? SCENE_FALLBACK_THEME;
  const title = (args.title ?? "Generated view").slice(0, SCENE_LIMITS.maxTitleLength);
  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    `<meta http-equiv="Content-Security-Policy" content="${SCENE_CONTENT_SECURITY_POLICY}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta charset="utf-8">',
    `<title>${title.replace(/[<>&]/g, "")}</title>`,
    `<style>${baseStyles(theme, sanitizeFontFaceCss(args.fontFaceCss))}</style>`,
    "<script>",
    `window.__ADE_SCENE_DATA__ = ${escapeForScript(args.data ?? null)};`,
    `window.__ADE_SCENE_THEME__ = ${escapeForScript(theme)};`,
    `window.__ADE_SCENE_NONCE__ = ${escapeForScript(args.nonce ?? null)};`,
    `window.__ADE_SCENE_RESTORED__ = ${args.restored ? "true" : "false"};`,
    "</script>",
    `<script>${SCENE_SDK_SOURCE}</script>`,
    `</head><body${args.scopeKey ? ` data-scene-scope="${sceneScopeAttribute(args.scopeKey)}"` : ""}>`,
    args.html,
    "</body></html>",
  ].join("\n");
}

/**
 * A scene's still, once the bytes are on disk.
 *
 * The picture, not the code: a still is what a scene leaves behind so that
 * scrollback and a reopened chat both show SOMETHING
 * rather than an empty gap where a view used to be.
 *
 * `uri` is project-relative (`.ade/artifacts/computer-use/…png`) because that
 * is what `ade-artifact://project/` resolves and what survives a project moving
 * on disk. `artifactId` is the proof-drawer record when one was created; it can
 * be null — an unfiled still is still a picture, and losing the drawer row is a
 * smaller loss than losing the image.
 */
export type SceneStillRecord = {
  uri: string;
  artifactId: string | null;
  title: string;
};

/**
 * Messages the frame is allowed to send. Anything else is dropped.
 *
 * `nonce` is the sending DOCUMENT's id — see {@link SceneDocumentArgs.nonce}.
 * Optional in the type because the parser cannot require what an older prepared
 * document, still in main's store, was built without; it is the HOST that
 * decides an unstamped message is not one of its own.
 */
export type SceneHostMessage = { nonce?: string } & (
  | { type: "ready"; payload: { height?: number } }
  | { type: "resize"; payload: { height?: number } }
  /**
   * The scene has stopped moving: no animation is running and the DOM has been
   * quiet for {@link SCENE_SETTLE_QUIET_MS}, or {@link SCENE_SETTLE_MAX_MS}
   * elapsed since `ready`. It is the host's cue to take the still — the moment
   * the view is finished but before the turn ends and the frame comes down.
   */
  | { type: "settled"; payload: { height?: number } }
  | { type: "emit"; payload: { name: string; payload?: unknown } }
  | { type: "error"; payload: { message: string } }
  /**
   * Open a link: an `ade://` deeplink in ADE, or an http(s) page in ADE's
   * browser. Sent by `ade.open(url)` and by any `<a href>` click in the scene.
   * The host acts on it only right after the user clicked inside the frame.
   */
  | { type: "open"; payload: { url: string } }
);

const ALLOWED_MESSAGE_TYPES = new Set(["ready", "resize", "settled", "emit", "error", "open"]);

/**
 * Validate an inbound frame message. The frame is untrusted, so shape-check
 * every field rather than spreading whatever arrived into host state.
 */
export function parseSceneHostMessage(value: unknown): SceneHostMessage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.__adeScene !== 1) return null;
  const type = typeof record.type === "string" ? record.type : "";
  if (!ALLOWED_MESSAGE_TYPES.has(type)) return null;
  const payload = (record.payload && typeof record.payload === "object" ? record.payload : {}) as Record<string, unknown>;
  // Bounded like every other string off the wire, and absent rather than empty
  // when it is not a usable one — an empty nonce must never match a real one.
  const rawNonce = typeof record.nonce === "string" ? record.nonce.slice(0, 120) : "";
  const nonce = rawNonce.length ? { nonce: rawNonce } : {};

  if (type === "emit") {
    const name = typeof payload.name === "string" ? payload.name.slice(0, 120) : "";
    if (!name.length) return null;
    return { ...nonce, type: "emit", payload: { name, payload: payload.payload } };
  }
  if (type === "error") {
    const message = typeof payload.message === "string" ? payload.message.slice(0, 500) : "scene error";
    return { ...nonce, type: "error", payload: { message } };
  }
  if (type === "open") {
    const url = typeof payload.url === "string" ? payload.url.trim() : "";
    if (!url.length || url.length > 2048) return null;
    return { ...nonce, type: "open", payload: { url } };
  }
  const height = typeof payload.height === "number" && Number.isFinite(payload.height)
    ? Math.max(0, Math.min(4000, Math.round(payload.height)))
    : undefined;
  if (type === "ready") return { ...nonce, type: "ready", payload: { height } };
  if (type === "settled") return { ...nonce, type: "settled", payload: { height } };
  return { ...nonce, type: "resize", payload: { height } };
}
