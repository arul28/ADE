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
 * A scene therefore cannot exfiltrate anything it is shown. Two risks remain and
 * are handled elsewhere rather than here. It can draw something misleading, so
 * the host gives every frame permanent "generated view" chrome and a title —
 * a scene must never be mistakable for ADE's own UI. And it can burn CPU: the
 * bounds on that today are the source-size cap below, the clamped frame height,
 * and the fact that a scene stops at the end of its turn on any surface that
 * can snapshot it. There is no CPU watchdog; a runaway scene on a surface with
 * no capture route will keep running until the transcript is closed.
 *
 * Division of labour with mosaic: a scene SHOWS, a mosaic ASKS. Approvals and
 * destructive confirmations stay in mosaic and in ADE's native surfaces — a
 * scene drawing its own "Approve" button would be a scene approving itself.
 */

export const SCENE_FENCE_LANGUAGE = "scene";

export const SCENE_LIMITS = {
  /** Source bytes. Past this a scene is a document, not a view. */
  maxSourceBytes: 96_000,
  maxTitleLength: 120,
  /** A scene that never calls ade.ready() is frozen anyway after this. */
  readyTimeoutMs: 8_000,
} as const;

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

export type ParsedScene = {
  title: string | null;
  /** The agent's markup, unwrapped from any document tags it supplied. */
  html: string;
};

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
 * Models emit anything from a bare `<div>` to a full document. Normalize both
 * to a fragment so the host template owns <head> and the policy that lives in
 * it. Dropping <base> matters even though `default-src 'none'` already blocks
 * every fetch: it keeps relative-URL behaviour predictable if the policy is
 * ever loosened.
 */
function unwrapDocument(source: string): string {
  let html = source;
  html = html.replace(/<!doctype[^>]*>/gi, "");
  html = html.replace(/<\/?html[^>]*>/gi, "");
  html = html.replace(/<base[^>]*>/gi, "");
  // Keep the contents of <head> (styles, fonts) but drop the tag itself so the
  // fragment concatenates cleanly into the template body.
  html = html.replace(/<\/?head[^>]*>/gi, "");
  html = html.replace(/<\/?body[^>]*>/gi, "");
  // A scene cannot relax its own policy: strip any CSP meta the model wrote.
  html = html.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");
  return html.trim();
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
      bodyStart = i + 1;
    }
    break;
  }

  const html = unwrapDocument(lines.slice(bodyStart).join("\n"));
  if (!html.length) return { reason: "empty", detail: "Scene has no markup." };
  return { title, html };
}

export function isSceneParseFailure(value: ParsedScene | SceneParseFailure): value is SceneParseFailure {
  return "reason" in value;
}

/**
 * Tokens forwarded into the frame as CSS custom properties. The frame cannot
 * read ADE's stylesheet — different origin — so a scene that wants to look like
 * ADE has to be handed the palette. Resolved values only; `var(--color-fg)`
 * would mean nothing on the other side.
 */
export type SceneTheme = {
  bg: string;
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
};

export const SCENE_FALLBACK_THEME: SceneTheme = {
  bg: "#0d0b14",
  surface: "rgba(255,255,255,0.035)",
  border: "rgba(255,255,255,0.10)",
  fg: "#ece9f5",
  fgMuted: "rgba(236,233,245,0.58)",
  accent: "#a78bfa",
  success: "#4ade80",
  warning: "#fbbf24",
  danger: "#f87171",
  fontSans: "Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
  fontMono: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

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
 */
function sdkSource(): string {
  return `
(function () {
  var listeners = Object.create(null);
  var reducedMotion = false;
  try { reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}

  // Measure the CONTENT, not the frame. document.documentElement is sized by
  // the iframe element itself, so measuring it lets a scene grow but never
  // shrink below the host's initial guess.
  function measure() {
    var body = document.body;
    if (!body) return 0;
    var style = window.getComputedStyle(body);
    return Math.ceil(body.scrollHeight + parseFloat(style.marginTop || "0") + parseFloat(style.marginBottom || "0"));
  }

  function post(type, payload) {
    try { parent.postMessage({ __adeScene: 1, type: type, payload: payload }, "*"); } catch (e) {}
  }

  var ade = {
    data: window.__ADE_SCENE_DATA__ || null,
    theme: window.__ADE_SCENE_THEME__ || null,
    reducedMotion: reducedMotion,
    on: function (event, fn) {
      if (typeof fn !== "function") return function () {};
      (listeners[event] = listeners[event] || []).push(fn);
      return function () {
        listeners[event] = (listeners[event] || []).filter(function (f) { return f !== fn; });
      };
    },
    emit: function (name, payload) { post("emit", { name: String(name), payload: payload }); },
    ready: function () { post("ready", { height: measure() }); },
    resize: function () { post("resize", { height: measure() }); },
    /** WAAPI wrapper that collapses to the end state under reduced motion. */
    animate: function (target, keyframes, options) {
      var el = typeof target === "string" ? document.querySelector(target) : target;
      if (!el) return null;
      var opts = Object.assign({ duration: 420, easing: "cubic-bezier(.22,.61,.36,1)", fill: "both" }, options || {});
      if (reducedMotion) opts.duration = 0;
      return el.animate(keyframes, opts);
    },
    /** Count a number up; the single most-wanted effect in a live view. */
    countUp: function (target, to, options) {
      var el = typeof target === "string" ? document.querySelector(target) : target;
      if (!el) return;
      var o = options || {};
      var from = typeof o.from === "number" ? o.from : 0;
      var duration = reducedMotion ? 0 : (typeof o.duration === "number" ? o.duration : 900);
      var decimals = typeof o.decimals === "number" ? o.decimals : 0;
      var start = null;
      function frame(now) {
        if (start === null) start = now;
        var t = duration <= 0 ? 1 : Math.min(1, (now - start) / duration);
        var eased = 1 - Math.pow(1 - t, 3);
        el.textContent = (from + (to - from) * eased).toFixed(decimals);
        if (t < 1) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    },
  };

  window.ade = ade;

  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || msg.__adeSceneHost !== 1) return;
    var fns = listeners[msg.type] || [];
    for (var i = 0; i < fns.length; i++) {
      try { fns[i](msg.payload); } catch (e) { post("error", { message: String(e && e.message || e) }); }
    }
  });

  window.addEventListener("error", function (event) {
    post("error", { message: String(event.message || "scene error") });
  });

  // Report height once layout settles so the host can size the frame, and again
  // on any resize the scene causes itself.
  function reportHeight() { post("resize", { height: measure() }); }
  window.addEventListener("load", function () { reportHeight(); post("ready", { height: measure() }); });
  if (typeof ResizeObserver === "function") {
    try { new ResizeObserver(reportHeight).observe(document.body); } catch (e) {}
  }
})();
`.trim();
}

function baseStyles(theme: SceneTheme): string {
  return `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
body {
  color: var(--fg);
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  padding: 18px 20px;
}
:root {
  --bg: ${theme.bg};
  --surface: ${theme.surface};
  --border: ${theme.border};
  --fg: ${theme.fg};
  --fg-muted: ${theme.fgMuted};
  --accent: ${theme.accent};
  --success: ${theme.success};
  --warning: ${theme.warning};
  --danger: ${theme.danger};
  --font-sans: ${theme.fontSans};
  --font-mono: ${theme.fontMono};
  color-scheme: dark;
}
a { color: var(--accent); }
code, pre { font-family: var(--font-mono); }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.16); border-radius: 999px; }
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
    `<style>${baseStyles(theme)}</style>`,
    "<script>",
    `window.__ADE_SCENE_DATA__ = ${escapeForScript(args.data ?? null)};`,
    `window.__ADE_SCENE_THEME__ = ${escapeForScript(theme)};`,
    "</script>",
    `<script>${sdkSource()}</script>`,
    `</head><body${args.scopeKey ? ` data-scene-scope="${sceneScopeAttribute(args.scopeKey)}"` : ""}>`,
    args.html,
    "</body></html>",
  ].join("\n");
}

/** Messages the frame is allowed to send. Anything else is dropped. */
export type SceneHostMessage =
  | { type: "ready"; payload: { height?: number } }
  | { type: "resize"; payload: { height?: number } }
  | { type: "emit"; payload: { name: string; payload?: unknown } }
  | { type: "error"; payload: { message: string } };

const ALLOWED_MESSAGE_TYPES = new Set(["ready", "resize", "emit", "error"]);

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

  if (type === "emit") {
    const name = typeof payload.name === "string" ? payload.name.slice(0, 120) : "";
    if (!name.length) return null;
    return { type: "emit", payload: { name, payload: payload.payload } };
  }
  if (type === "error") {
    const message = typeof payload.message === "string" ? payload.message.slice(0, 500) : "scene error";
    return { type: "error", payload: { message } };
  }
  const height = typeof payload.height === "number" && Number.isFinite(payload.height)
    ? Math.max(0, Math.min(4000, Math.round(payload.height)))
    : undefined;
  return type === "ready"
    ? { type: "ready", payload: { height } }
    : { type: "resize", payload: { height } };
}
