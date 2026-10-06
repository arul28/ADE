import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsOutSimple, Camera, Sparkle, WarningCircle } from "@phosphor-icons/react";

import {
  buildSceneDocument,
  isSceneParseFailure,
  parseSceneFence,
  parseSceneHostMessage,
  sameSceneTheme,
  sceneFrameMessage,
  SCENE_LIMITS,
  SCENE_SETTLE_MAX_MS,
  SCENE_SETTLE_QUIET_MS,
  type SceneTheme,
} from "../../../shared/chatScene";
import { parseDeeplink } from "../../../shared/deeplinks";
import { openAdeDeeplink, openUrlInAdeBrowser } from "../../lib/openExternal";
import { COLORS } from "../lanes/laneDesignTokens";
import { Dialog } from "../ui/dialog";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { HighlightedCode } from "./CodeHighlighter";
import { SceneDataFeed, type SceneDataPayload } from "./sceneData";
import { loadSceneFontFaceCss, sceneFontFaceCssNow } from "./sceneFonts";
import { rememberSceneStill } from "./sceneStillStore";
import { useSceneTheme } from "./sceneTheme";
import { useSceneStillLatch } from "./useSceneStillLatch";

/**
 * Host for an agent-authored scene.
 *
 * The frame gets `sandbox="allow-scripts"` and never `allow-same-origin`; with
 * both it would recover its own origin and could reach back into ADE. In
 * Electron the document is served over `ade-scene:` so it carries a real CSP
 * response header and a distinct origin. In the browser preview there is no
 * such scheme, so it falls back to a blob URL — also a separate origin, with
 * the same policy delivered by the meta tag inside the document.
 *
 * A scene reads as part of the reply: no border, no badge, its content on the
 * reply's text column in the reply's font. What it is — a view a model drew —
 * is said on hover, in the toolbar that also expands it and files it as proof.
 *
 * A scene is live while it is on screen, so its hovers, toggles and zooms keep
 * working in scrollback, and a still stands in for it everywhere else:
 *
 *  - It mounts when it has been on (or about to come on) screen for a beat,
 *    so a fast scroll past only ever shows stills.
 *  - It unmounts after it has been off screen for a few seconds.
 *  - A scene that already played comes back RESTORED: the SDK skips its
 *    entrance, and the still covers the frame until it is drawn, so scrolling
 *    back shows the same picture, now interactive.
 *  - A settled scene nobody is touching idles inside the frame (endless
 *    animations paused, requestAnimationFrame at a few frames a second); see
 *    the SDK in `shared/chatScene.ts`.
 *
 * The still is still taken once, when the scene first settles fully on screen,
 * for scrollback, reopened chats, remote clients and the proof drawer.
 */
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 960;
/** On screen this long before a frame mounts: a fast scroll past mounts nothing. */
const SCENE_ACTIVATE_DWELL_MS = 120;
/** The least time between two links a scene may open. */
const SCENE_OPEN_MIN_INTERVAL_MS = 800;
/** Off screen this long before a frame unmounts back to its still. */
const SCENE_DEACTIVATE_LINGER_MS = 4_000;
/** How far outside the viewport counts as "about to be on screen". */
const SCENE_ACTIVATE_MARGIN = "240px 0px";
/**
 * Scrolling must have paused this long before a frame mounts. A reader moving
 * through a transcript sees stills; frames load where they stop. Measured: a
 * steady scroll through six scenes cost the scene process 12% of a core in
 * mounts when frames loaded as they passed.
 */
const SCENE_SCROLL_QUIET_MS = 150;

/** The nearest ancestor that scrolls, or null for the viewport. */
function scrollParentOf(element: HTMLElement): HTMLElement | null {
  for (let el = element.parentElement; el && el !== document.body; el = el.parentElement) {
    const style = window.getComputedStyle(el);
    if (/(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflowX}`)) return el;
  }
  return null;
}

/**
 * A fresh id for one built document.
 *
 * Not a security boundary — the frame is already sandboxed and origin-isolated,
 * and this only has to separate one of OUR documents from the previous one — so
 * `randomUUID` where it exists and a counter-plus-random string where it does
 * not (an older jsdom, a non-secure context) is enough.
 */
let sceneNonceCounter = 0;
function mintSceneNonce(): string {
  sceneNonceCounter += 1;
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${sceneNonceCounter}-${random}`;
}

/** Scenes that have played to a settle in this window: they come back restored. */
const playedScopes = new Set<string>();
/** Last measured height per scene, so a placeholder holds the space it will take. */
const knownHeights = new Map<string, number>();

/**
 * Built documents and their prepared URLs, reused across remounts.
 *
 * A scene now mounts and unmounts as it scrolls, and each mount used to build a
 * fresh document (new nonce), send it over IPC and take a new slot in main's
 * 64-document store. A remount of the same scene in the same theme reuses both.
 * Reusing a nonce across mounts is safe: a message is first matched to the
 * frame element's own `contentWindow`, and a remount is a new element.
 */
const DOCUMENT_CACHE_LIMIT = 24;
const documentCache = new Map<string, { html: string; nonce: string }>();
const preparedUrlCache = new Map<string, string>();

function rememberBounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > DOCUMENT_CACHE_LIMIT) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

function themeSignature(theme: SceneTheme): string {
  return JSON.stringify(theme);
}

export type SceneFrameProps = {
  source: string;
  /** True while the turn that produced this scene is still running. */
  live?: boolean;
  /**
   * True while this scene's ```scene fence is still ARRIVING — live AND not
   * yet closed. The markdown parser hands a half-written fence over as a
   * finished code block on every reveal tick, so mounting on one would prepare
   * a new document and reload the iframe several times a second, throwing away
   * whatever the scene had already drawn.
   *
   * One prop rather than a `live` + `sealed` pair, because only the caller can
   * answer it: fence state is a property of the markdown body, not of this
   * component. Defaults false: every caller that does not stream (a settled
   * transcript row) is complete by construction.
   */
  streaming?: boolean;
  /**
   * This scene's identity: what its still is filed under and looked up by, and
   * what separates two byte-identical scenes at different positions.
   *
   * Required, and explicitly null for a scene that has none — a reasoning body,
   * the expanded view. Null means the scene runs and leaves nothing behind,
   * which is a decision each caller has to make rather than fall into by
   * omitting a prop.
   */
  scopeKey: string | null;
  onEmit?: (name: string, payload: unknown) => void;
  /**
   * `expanded` fills its container, always runs, and takes no still: it is the
   * full-size view the inline scene's Expand button opens.
   */
  variant?: "inline" | "expanded";
};

type Status = "loading" | "running";

/**
 * True when the whole shell is inside the viewport.
 *
 * Deliberately all-or-nothing rather than "intersects": the snapshot path
 * crops to what is on screen, so anything less than the whole rect produces a
 * picture of part of a view with no sign that it is partial.
 */
function isSceneRectFullyVisible(rect: DOMRect): boolean {
  if (rect.width < 1 || rect.height < 1) return false;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  if (!viewportWidth || !viewportHeight) return false;
  return rect.top >= 0 && rect.left >= 0 && rect.bottom <= viewportHeight && rect.right <= viewportWidth;
}

/** The `overflow` values that clip descendants to the element's padding box. */
const CLIPPING_OVERFLOW = new Set(["hidden", "clip", "auto", "scroll", "overlay"]);

/** Sub-pixel slack for the containment checks: layout is fractional, a capture is not. */
const SCENE_RECT_EPSILON = 0.5;

/**
 * The shell's rect, but only when every pixel inside it is this scene, on
 * screen, right now. Null otherwise.
 *
 * The snapshot is a grab of the WINDOW cropped to this rect, so whatever is
 * painted there is what gets kept. Inside the window viewport is not enough:
 *
 *  - The transcript is its own scroller, and the chat header sits above it in
 *    the same window. A scene scrolled half under the scroller's top edge still
 *    has a non-negative window rect, so the crop came back as the chat header
 *    painted over the scene's hidden top. Every clipping ancestor has to
 *    contain the rect too.
 *  - The composer floats over the bottom of the transcript, and a dialog or
 *    menu can sit over anything. Hit-testing a few points finds whatever is
 *    painted on top; anything that is not this shell means "not now".
 */
function measureCapturableSceneRect(shell: HTMLElement): DOMRect | null {
  const rect = shell.getBoundingClientRect();
  if (!isSceneRectFullyVisible(rect)) return null;
  for (let el = shell.parentElement; el && el !== document.documentElement; el = el.parentElement) {
    const style = window.getComputedStyle(el);
    if (!CLIPPING_OVERFLOW.has(style.overflowX) && !CLIPPING_OVERFLOW.has(style.overflowY)) continue;
    // The clip edge is the padding box: the border box less the borders.
    const box = el.getBoundingClientRect();
    const left = box.left + el.clientLeft;
    const top = box.top + el.clientTop;
    if (
      rect.left < left - SCENE_RECT_EPSILON
      || rect.top < top - SCENE_RECT_EPSILON
      || rect.right > left + el.clientWidth + SCENE_RECT_EPSILON
      || rect.bottom > top + el.clientHeight + SCENE_RECT_EPSILON
    ) {
      return null;
    }
  }
  if (typeof document.elementFromPoint === "function") {
    const inset = 2;
    const points: Array<[number, number]> = [
      [rect.left + inset, rect.top + inset],
      [rect.right - inset, rect.top + inset],
      [rect.left + inset, rect.bottom - inset],
      [rect.right - inset, rect.bottom - inset],
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
    ];
    for (const [x, y] of points) {
      const hit = document.elementFromPoint(x, y);
      if (!hit || !shell.contains(hit)) return null;
    }
  }
  return rect;
}

function sameSceneRect(a: DOMRect, b: DOMRect): boolean {
  return Math.abs(a.left - b.left) < SCENE_RECT_EPSILON
    && Math.abs(a.top - b.top) < SCENE_RECT_EPSILON
    && Math.abs(a.width - b.width) < SCENE_RECT_EPSILON
    && Math.abs(a.height - b.height) < SCENE_RECT_EPSILON;
}

type SceneCapture = (rect: { x: number; y: number; width: number; height: number }) => Promise<string | null>;

/**
 * Grab the shell, or answer why not.
 *
 * Measured twice — before the request and after the picture comes back —
 * because the grab is asynchronous: it lands on a later compositor frame, and
 * the transcript re-pins its scroll and re-measures rows at exactly the moments
 * a scene tends to be captured (a turn ending, the composer resizing). A rect
 * that moved in between describes a place the scene no longer was, and the
 * picture is of whatever slid into it. Such a picture is thrown away, never kept.
 */
async function captureSceneShell(
  shell: HTMLElement,
  capture: SceneCapture,
): Promise<{ kind: "captured"; dataUrl: string } | { kind: "not-visible" | "moved" | "empty" }> {
  const before = measureCapturableSceneRect(shell);
  if (!before) return { kind: "not-visible" };
  const dataUrl = await capture({
    x: before.x, y: before.y, width: before.width, height: before.height,
  });
  const after = shell.isConnected ? measureCapturableSceneRect(shell) : null;
  if (!after || !sameSceneRect(before, after)) return { kind: "moved" };
  return dataUrl ? { kind: "captured", dataUrl } : { kind: "empty" };
}

/**
 * How long a capture thrown away for moving waits before it tries again. It
 * doubles per consecutive miss up to the cap: a pinned transcript scrolls every
 * frame while a turn streams, and each try is a window grab plus a PNG encode.
 */
const SCENE_CAPTURE_RETRY_MS = 250;
const SCENE_CAPTURE_RETRY_MAX_MS = 4_000;

/**
 * True while the shell is on screen or about to be, with a dwell before it
 * turns true and a linger before it turns false; see the constants above.
 */
function useSceneOnScreen(target: React.RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const element = target.current;
    if (!enabled || !element) return;
    if (typeof IntersectionObserver !== "function") {
      // No way to tell (an old test host): behave as if always visible.
      setOnScreen(true);
      return;
    }
    let timer: number | null = null;
    const clear = () => { if (timer !== null) { window.clearTimeout(timer); timer = null; } };
    // Only scrolling that moves THIS scene counts: a terminal streaming output
    // elsewhere in the window scrolls constantly and must not hold scenes back.
    let lastScrollAt = 0;
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target === document || (target instanceof Node && target.contains(element))) lastScrollAt = performance.now();
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    // Mount only once scrolling has paused; keep checking until it has.
    const activateWhenQuiet = () => {
      const sinceScroll = performance.now() - lastScrollAt;
      if (sinceScroll < SCENE_SCROLL_QUIET_MS) {
        timer = window.setTimeout(activateWhenQuiet, SCENE_SCROLL_QUIET_MS - sinceScroll);
        return;
      }
      timer = null;
      setOnScreen(true);
    };
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      clear();
      timer = visible
        ? window.setTimeout(activateWhenQuiet, SCENE_ACTIVATE_DWELL_MS)
        : window.setTimeout(() => { timer = null; setOnScreen(false); }, SCENE_DEACTIVATE_LINGER_MS);
    // Rooted at the transcript's own scroller: a margin on the viewport root
    // is clipped by that scroller and would prefetch nothing.
    }, { root: scrollParentOf(element), rootMargin: SCENE_ACTIVATE_MARGIN, threshold: 0 });
    observer.observe(element);
    return () => {
      clear();
      window.removeEventListener("scroll", onScroll, true);
      observer.disconnect();
    };
  }, [target, enabled]);
  return onScreen;
}

export function SceneFrame({
  source,
  live = false,
  streaming = false,
  scopeKey,
  onEmit,
  variant = "inline",
}: SceneFrameProps) {
  const expandedVariant = variant === "expanded";
  // Proof in ADE is chat-scoped, so a snapshot filed with no owner is an
  // artifact nobody can trace back to a conversation. Read from the chat scope
  // rather than taken as a prop: the value is session-constant.
  const { sessionId } = useChatRuntimeScope();
  const parsed = useMemo(() => parseSceneFence(source), [source]);
  const failed = isSceneParseFailure(parsed);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  /** The current document, for the two callbacks that stamp a settle with it. */
  const srcRef = useRef<string | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(() => (scopeKey && knownHeights.get(scopeKey)) || 220);
  /**
   * The document that has reported it is up (ready, or settled, or the ready
   * timeout passed) — stamped like {@link settledSrc}, never a bare flag. A
   * remount reuses the same cached URL, so a boolean or a stale stamp would
   * call a frame that has not loaded yet ready.
   */
  const [readySrc, setReadySrc] = useState<string | null>(null);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [proofState, setProofState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [expanded, setExpanded] = useState(false);
  /** True while the Proof button is grabbing the view; hides the toolbar from the picture. */
  const [capturingProof, setCapturingProof] = useState(false);
  /** This mount's settle-time still; see the capture effect. */
  const [still, setStill] = useState<string | null>(null);
  /**
   * The document that has reported it is done animating — not a boolean.
   * A caller can keep ONE mounted frame and swap its source; stamped with the
   * src it belongs to, a stale settle simply is not one.
   */
  const [settledSrc, setSettledSrc] = useState<string | null>(null);
  /** The document whose frame may be shown; it stays hidden under the still until then. */
  const [revealedSrc, setRevealedSrc] = useState<string | null>(null);
  /** Bumped when a settle capture that was waiting for visibility should retry. */
  const [stillAttempt, setStillAttempt] = useState(0);
  /** One still per mounted scene: a second capture would only cost a window grab. */
  const stillTakenRef = useRef(false);
  /** Consecutive captures thrown away for moving; sets the retry backoff. */
  const captureMissesRef = useRef(0);

  const { rehydrated, undecided, storedStillSrc } = useSceneStillLatch({
    sessionId,
    scopeKey: expandedVariant ? null : scopeKey,
    live,
  });
  /**
   * The picture, in order of how close it is to what the user last saw: this
   * mount's settle still, then the still a previous mount or window left.
   */
  const pictureSrc = expandedVariant ? null : (still ?? storedStillSrc);

  /**
   * The scene threw before it was up: almost always a blank or half-drawn
   * view. It collapses to one row (Retry, Show code, Show anyway) instead of
   * holding a tall empty box with an error in its corner.
   */
  const [drawFailed, setDrawFailed] = useState(false);
  const [showAnyway, setShowAnyway] = useState(false);
  const [showCode, setShowCode] = useState(false);
  /** Bumped by Retry: a fresh document, not the cached one that failed. */
  const [attempt, setAttempt] = useState(0);
  const collapsed = drawFailed && !showAnyway && !expandedVariant;

  const theme = useSceneTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const [fontFaceCss, setFontFaceCss] = useState<string | null>(sceneFontFaceCssNow);
  useEffect(() => {
    if (fontFaceCss !== null) return;
    let cancelled = false;
    void loadSceneFontFaceCss().then((css) => { if (!cancelled) setFontFaceCss(css); });
    return () => { cancelled = true; };
  }, [fontFaceCss]);

  const onScreen = useSceneOnScreen(wrapperRef, !expandedVariant && !failed && !streaming);
  // Live for its own turn (the author's entrance plays and the still is taken),
  // on screen otherwise, and always when it is the expanded view.
  const wantFrame = (expandedVariant || live || onScreen) && !collapsed;

  /**
   * Whether the document should skip its entrance. Read at build time through
   * a ref: a still that arrives while the scene is running must not rebuild the
   * document and reload a frame the user is watching.
   */
  const restoredRef = useRef(false);
  restoredRef.current = expandedVariant
    || rehydrated
    || Boolean(pictureSrc)
    || (scopeKey !== null && playedScopes.has(scopeKey));

  // A fence that is still arriving draws nothing: one placeholder now beats a
  // frame that reloads on every tick.
  const doc = useMemo(() => {
    if (failed || streaming || undecided || !wantFrame || fontFaceCss === null) return null;
    const builtTheme = themeRef.current;
    const restored = restoredRef.current;
    const key = `${scopeKey ?? ""}|${attempt}|${restored ? 1 : 0}|${themeSignature(builtTheme)}|${fontFaceCss.length}|${source}`;
    const cached = documentCache.get(key);
    if (cached) {
      rememberBounded(documentCache, key, cached);
      return { ...cached, theme: builtTheme, restored };
    }
    const nonce = mintSceneNonce();
    const html = buildSceneDocument({
      html: parsed.html,
      title: parsed.title,
      theme: builtTheme,
      scopeKey,
      nonce,
      restored,
      fontFaceCss,
    });
    rememberBounded(documentCache, key, { html, nonce });
    return { html, nonce, theme: builtTheme, restored };
    // `source` is in the key, so `parsed` adds nothing; theme is applied live.
  }, [failed, streaming, undecided, wantFrame, fontFaceCss, parsed, scopeKey, source, attempt]);

  /**
   * The document the frame is currently showing, and the nonce that document
   * stamps its messages with — one piece of state, never two. When one mounted
   * frame has its `src` swapped, its `contentWindow` is the SAME object, so only
   * the nonce can tell the outgoing document from the incoming one.
   */
  const [prepared, setPrepared] = useState<{ url: string; nonce: string; theme: SceneTheme; restored: boolean } | null>(null);
  const src = doc && prepared && prepared.nonce === doc.nonce ? prepared.url : null;
  const nonceRef = useRef<string | null>(null);
  const builtThemeRef = useRef<SceneTheme | null>(null);
  useEffect(() => {
    srcRef.current = src;
    nonceRef.current = src ? prepared?.nonce ?? null : null;
    builtThemeRef.current = src ? prepared?.theme ?? null : null;
  }, [src, prepared]);

  /** True only for a settle this document reported; see {@link settledSrc}. */
  const settled = settledSrc !== null && settledSrc === src;
  const status: Status = src !== null && readySrc === src ? "running" : "loading";
  const readySrcRef = useRef<string | null>(null);
  readySrcRef.current = readySrc;

  // Prefer the real scheme; blob is the preview path. Both give the frame an
  // origin of its own, which is the property that matters.
  useEffect(() => {
    if (!doc) {
      setPrepared(null);
      return;
    }
    let revoked: string | null = null;
    let cancelled = false;
    const show = (url: string) => setPrepared({ url, nonce: doc.nonce, theme: doc.theme, restored: doc.restored });
    const cachedUrl = preparedUrlCache.get(doc.html);
    if (cachedUrl) {
      show(cachedUrl);
      return;
    }
    const fallBackToBlob = () => {
      const blob = new Blob([doc.html], { type: "text/html" });
      revoked = URL.createObjectURL(blob);
      show(revoked);
    };
    const prepare = window.ade?.scene?.prepare;
    if (typeof prepare === "function") {
      // A non-string answer is a failure, not a URL: on the hosted web client
      // `scene.prepare` is a generic fallback proxy that resolves `null`.
      void prepare(doc.html)
        .then((url) => {
          if (cancelled) return;
          if (typeof url === "string" && url.length > 0) {
            rememberBounded(preparedUrlCache, doc.html, url);
            show(url);
          } else {
            fallBackToBlob();
          }
        })
        .catch(() => { if (!cancelled) fallBackToBlob(); });
    } else {
      fallBackToBlob();
    }
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [doc]);

  const postToFrame = useCallback((message: Parameters<typeof sceneFrameMessage>[0]) => {
    // The frame's origin is opaque, so "*" is the only target that reaches it.
    // Only ADE's theme travels this way; nothing in it is private.
    try { frameRef.current?.contentWindow?.postMessage(sceneFrameMessage(message), "*"); } catch { /* frame gone */ }
  }, []);

  /** Send the current theme if the document was built with another one. */
  const syncTheme = useCallback(() => {
    const built = builtThemeRef.current;
    const current = themeRef.current;
    if (!built || sameSceneTheme(built, current)) return;
    builtThemeRef.current = current;
    postToFrame({ type: "theme", payload: current });
  }, [postToFrame]);

  /**
   * A scene opens links only while its frame has focus (a click inside it
   * gives it focus), while this window holds transient user activation (a
   * click in a child frame activates its ancestors too, and the activation
   * lapses seconds later, so a timer firing after one click is refused), and
   * at most one per {@link SCENE_OPEN_MIN_INTERVAL_MS}. Every open is visible:
   * ADE navigates, or the page opens in ADE's browser.
   */
  const lastOpenRef = useRef(0);

  const openFromScene = useCallback((url: string) => {
    const now = Date.now();
    const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    const pressed = frameRef.current !== null
      && document.activeElement === frameRef.current
      && (activation ? activation.isActive : true);
    if (!pressed || now - lastOpenRef.current < SCENE_OPEN_MIN_INTERVAL_MS) return;
    lastOpenRef.current = now;
    if (parseDeeplink(url).ok) {
      openAdeDeeplink(url);
      return;
    }
    if (/^https?:\/\//i.test(url)) {
      openUrlInAdeBrowser(url);
      return;
    }
    setSceneError("A scene can open ADE links (ade://) and web pages only.");
  }, []);

  // Only messages from this frame's own contentWindow are considered, every one
  // is shape-checked before it reaches state, and every one must name the
  // document currently in the frame.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const message = parseSceneHostMessage(event.data);
      if (!message) return;
      if (!message.nonce || message.nonce !== nonceRef.current) return;
      if (message.type === "error") {
        setSceneError(message.payload.message);
        // Thrown before the frame said it was up: the view did not draw.
        if (readySrcRef.current !== srcRef.current) setDrawFailed(true);
        return;
      }
      if (message.type === "emit") {
        onEmit?.(message.payload.name, message.payload.payload);
        return;
      }
      if (message.type === "open") {
        openFromScene(message.payload.url);
        return;
      }
      if (message.payload.height) {
        const next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, message.payload.height));
        setHeight(next);
        if (scopeKey) knownHeights.set(scopeKey, next);
      }
      if (message.type === "settled") {
        // A document that has settled has loaded, whether or not its ready
        // arrived first.
        setReadySrc(srcRef.current);
        setSettledSrc(srcRef.current);
        if (scopeKey) playedScopes.add(scopeKey);
      }
      if (message.type === "ready") setReadySrc(srcRef.current);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onEmit, scopeKey, syncTheme, openFromScene, postToFrame]);

  // Live ADE data, for a scene that asked for it, while its frame is up.
  const latestDataRef = useRef<SceneDataPayload | null>(null);
  const statusRef = useRef<Status>(status);
  statusRef.current = status;
  const sendData = useCallback((payload: SceneDataPayload) => {
    latestDataRef.current = payload;
    if (statusRef.current === "running") postToFrame({ type: "data", payload });
  }, [postToFrame]);
  const dataFeed = !failed && src && parsed.data.length
    ? <SceneDataFeed sources={parsed.data} send={sendData} />
    : null;

  // The frame is up (however it got there: ready, settled, or the ready
  // timeout), or the theme switched while it is: hand it the current palette
  // and the latest data snapshot.
  useEffect(() => {
    if (status !== "running") return;
    syncTheme();
  }, [theme, status, syncTheme]);
  useEffect(() => {
    if (status === "running" && latestDataRef.current) postToFrame({ type: "data", payload: latestDataRef.current });
  }, [status, postToFrame]);

  // A different scene in the same mounted frame (its source swapped) owns none
  // of the previous scene's picture.
  useEffect(() => {
    setStill(null);
    setSceneError(null);
    setDrawFailed(false);
    setShowAnyway(false);
  }, [source, scopeKey]);

  // A new document is a new scene and gets its own wait; an expired deadline
  // from the previous one would mark it settled on sight. The one-capture latch
  // is reset with it. When the frame comes down, every per-document stamp is
  // dropped: a remount is handed the same cached URL, and a stamp left over
  // from the last mount would call the new, unloaded frame ready, settled and
  // revealed — a blank frame where the still should be.
  useEffect(() => {
    stillTakenRef.current = false;
    captureMissesRef.current = 0;
    if (src === null) {
      setReadySrc(null);
      setSettledSrc(null);
      setRevealedSrc(null);
    }
  }, [src]);

  /**
   * Reveal. A frame coming back under its still stays hidden until it has
   * drawn (ready, then two frames for the paint), so the swap from picture to
   * live view shows no blank and no replayed entrance. A frame with nothing
   * over it shows at once: its entrance is the point.
   */
  /**
   * The theme a picture was drawn in. A still from before a theme switch must
   * not cover the frame (the reader would see the old palette flash) and is
   * re-taken once the scene is live in the new one. A picture this mount did
   * not take is assumed current when first seen.
   */
  const themeKey = themeSignature(theme);
  const [pictureTheme, setPictureTheme] = useState<string | null>(null);
  useEffect(() => {
    if (!pictureSrc) { setPictureTheme(null); return; }
    setPictureTheme((current) => current ?? themeSignature(themeRef.current));
  }, [pictureSrc]);
  const stillStale = Boolean(pictureSrc) && pictureTheme !== null && pictureTheme !== themeKey;
  // A stale picture releases this mount's one-capture latch, so the live
  // scene is pictured again in the current theme.
  useEffect(() => {
    if (!stillStale) return;
    stillTakenRef.current = false;
    setStillAttempt((value) => value + 1);
  }, [stillStale]);
  const coveredByStill = Boolean(pictureSrc) && !stillStale && Boolean(prepared?.restored);
  useEffect(() => {
    if (!src) return;
    if (!coveredByStill) { setRevealedSrc(src); return; }
    if (status !== "running") {
      // A scene that never says ready is not necessarily broken; do not hold
      // its still over it forever.
      const timer = window.setTimeout(() => setRevealedSrc(src), SCENE_LIMITS.readyTimeoutMs);
      return () => window.clearTimeout(timer);
    }
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => setRevealedSrc(src));
    });
    return () => {
      window.cancelAnimationFrame(first);
      if (second) window.cancelAnimationFrame(second);
    };
  }, [src, status, coveredByStill]);
  const frameShown = Boolean(src) && revealedSrc === src;

  // A scene that never reports ready is not necessarily broken — it may simply
  // not call ade.ready() — so this stops the wait rather than the scene.
  useEffect(() => {
    if (status !== "loading" || !src) return;
    const armedSrc = src;
    const timer = window.setTimeout(() => {
      // A prepared URL that never came up may have been evicted in main (a
      // 404 page never says ready): forget it, so the next mount re-prepares.
      for (const [html, url] of preparedUrlCache) if (url === armedSrc) preparedUrlCache.delete(html);
      setReadySrc(armedSrc);
    }, SCENE_LIMITS.readyTimeoutMs);
    return () => window.clearTimeout(timer);
  }, [status, src]);

  /**
   * The host's own settle deadline, for a frame that never reports one. One
   * quiet window longer than the frame's own cap, so a frame that IS going to
   * report gets to do it first. Armed per document, stamping the document it
   * was armed for.
   */
  useEffect(() => {
    if (status !== "running" || settled || !src) return;
    const armedSrc = src;
    const timer = window.setTimeout(
      () => setSettledSrc(armedSrc),
      SCENE_SETTLE_MAX_MS + SCENE_SETTLE_QUIET_MS,
    );
    return () => window.clearTimeout(timer);
  }, [status, settled, src]);

  /**
   * Take the still, once, for a scene that has none yet.
   *
   * It runs while the scene is live, after it settles, and only when the whole
   * view is on screen and on top (see {@link measureCapturableSceneRect}); it
   * waits on scroll and an IntersectionObserver for that moment, with no
   * deadline. A scene that already has a picture takes no new one: a scene now
   * remounts every time it scrolls back, and each capture is a window grab, a
   * PNG encode and a file.
   */
  useEffect(() => {
    if (expandedVariant || !settled || stillTakenRef.current || status !== "running" || !src || (pictureSrc && !stillStale)) return;
    const capture = window.ade?.scene?.snapshot;
    const shell = shellRef.current;
    if (typeof capture !== "function" || !shell) return;
    if (!measureCapturableSceneRect(shell)) {
      const retry = () => {
        const current = shellRef.current;
        if (current && measureCapturableSceneRect(current)) setStillAttempt((attempt) => attempt + 1);
      };
      window.addEventListener("scroll", retry, { capture: true, passive: true });
      let observer: IntersectionObserver | null = null;
      if (typeof IntersectionObserver === "function") {
        observer = new IntersectionObserver(
          (entries) => { if (entries.some((entry) => entry.isIntersecting)) retry(); },
          { threshold: [0, 1] },
        );
        observer.observe(shell);
      }
      return () => {
        window.removeEventListener("scroll", retry, true);
        observer?.disconnect();
      };
    }
    // Latched BEFORE the await: two captures in flight would write two files.
    stillTakenRef.current = true;
    let cancelled = false;
    let retryTimer: number | null = null;
    const title = (!failed && parsed.title) || "Generated view";
    void captureSceneShell(shell, capture)
      .then(async (result) => {
        if (cancelled) return;
        if (result.kind !== "captured") {
          // Not a picture of this scene. Release the latch and look again on a
          // backoff: a re-pin or re-measure is usually over in a frame or two.
          stillTakenRef.current = false;
          const misses = captureMissesRef.current++;
          retryTimer = window.setTimeout(
            () => setStillAttempt((attempt) => attempt + 1),
            Math.min(SCENE_CAPTURE_RETRY_MS * 2 ** misses, SCENE_CAPTURE_RETRY_MAX_MS),
          );
          return;
        }
        captureMissesRef.current = 0;
        const { dataUrl } = result;
        setStill(dataUrl);
        setPictureTheme(themeSignature(themeRef.current));
        if (scopeKey) rememberSceneStill(scopeKey, { dataUrl });
        const store = window.ade?.scene?.storeStill;
        if (typeof store !== "function" || !scopeKey) return;
        const record = await store({ dataUrl, title, sessionId, scopeKey }).catch(() => null);
        // Not gated on `cancelled`: the still this effect just set re-runs it
        // (a picture now exists), and the record is the same fact either way.
        if (!record) return;
        rememberSceneStill(scopeKey, { record });
      })
      .catch(() => {
        stillTakenRef.current = false;
      });
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [expandedVariant, settled, status, src, stillAttempt, scopeKey, failed, parsed, sessionId, pictureSrc, stillStale]);

  /**
   * File the view as proof: a fresh grab of what is on screen now, so a scene
   * the reader has hovered, zoomed or toggled is filed the way they see it. The
   * settle still is the fallback when the view cannot be grabbed (scrolled
   * partly out, a host with no capture route).
   */
  const fileProof = useCallback(async () => {
    const attach = window.ade?.scene?.attachProof;
    if (typeof attach !== "function") return;
    setProofState("saving");
    setCapturingProof(true);
    let dataUrl: string | null = null;
    try {
      const capture = window.ade?.scene?.snapshot;
      const shell = shellRef.current;
      if (typeof capture === "function" && shell) {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
        const result = await captureSceneShell(shell, capture);
        if (result.kind === "captured") dataUrl = result.dataUrl;
      }
    } catch {
      dataUrl = null;
    } finally {
      setCapturingProof(false);
    }
    dataUrl ??= still ?? (pictureSrc?.startsWith("data:") ? pictureSrc : null);
    try {
      const ok = await attach({
        dataUrl,
        title: (!failed && parsed.title) || "Generated view",
        sessionId: sessionId ?? null,
      });
      setProofState(ok ? "saved" : "failed");
    } catch {
      setProofState("failed");
    }
  }, [failed, parsed, still, pictureSrc, sessionId]);

  if (streaming) {
    // Deliberately not the parse-failure block: a fence that is two lines in is
    // not a broken scene, and saying so mid-stream would be a lie that corrects
    // itself a second later.
    return (
      <div className="my-3 w-screen max-w-full" data-testid="chat-scene" data-scene-status="drawing">
        <div
          className="flex items-end rounded-md px-3 py-2"
          style={{ height: (scopeKey && knownHeights.get(scopeKey)) || MIN_HEIGHT, background: COLORS.recessedBg }}
        >
          <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: COLORS.textMuted }}>
            <Sparkle size={10} weight="fill" style={{ color: COLORS.accent }} />
            {(!failed && parsed.title) || "Generated view"}
            <span style={{ color: COLORS.textDim }}>
              · drawing · {source.split("\n").length} lines · {Math.max(1, Math.round(source.length / 1024))} KB
            </span>
          </span>
        </div>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="my-2">
        <div
          className="mb-1 flex items-center gap-1.5 text-[11px]"
          style={{ color: COLORS.textMuted }}
        >
          <WarningCircle size={11} weight="bold" />
          Scene could not be rendered — {parsed.detail}
        </div>
        <HighlightedCode code={source} language="html" />
      </div>
    );
  }

  const title = parsed.title ?? "Generated view";

  if (expandedVariant) {
    return (
      <div className="h-full w-full" data-testid="chat-scene-expanded">
        {dataFeed}
        {src ? (
          <iframe
            ref={frameRef}
            title={title}
            data-testid="chat-scene-frame"
            data-scene-nonce={prepared?.nonce}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            src={src}
            className="block h-full w-full border-0 bg-transparent"
          />
        ) : null}
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="my-3 w-screen max-w-full" data-testid="chat-scene" data-scene-status="failed">
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-2 text-[12px]"
          style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.borderMuted}`, color: COLORS.textMuted }}
        >
          <span className="inline-flex min-w-0 items-center gap-1.5" style={{ color: COLORS.warning }}>
            <WarningCircle size={12} weight="bold" />
            <span className="truncate" title={sceneError ?? undefined}>
              {title} did not draw{sceneError ? `: ${sceneError}` : ""}
            </span>
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            <button
              type="button"
              data-testid="chat-scene-retry"
              className="rounded px-1.5 py-0.5 opacity-80 hover:opacity-100"
              onClick={() => { setDrawFailed(false); setSceneError(null); setAttempt((value) => value + 1); }}
            >
              Retry
            </button>
            <button
              type="button"
              className="rounded px-1.5 py-0.5 opacity-80 hover:opacity-100"
              onClick={() => setShowCode((value) => !value)}
            >
              {showCode ? "Hide code" : "Show code"}
            </button>
            <button
              type="button"
              className="rounded px-1.5 py-0.5 opacity-80 hover:opacity-100"
              onClick={() => setShowAnyway(true)}
            >
              Show anyway
            </button>
          </span>
        </div>
        {showCode ? <div className="mt-2"><HighlightedCode code={source} language="html" /></div> : null}
      </div>
    );
  }

  const frameMounted = Boolean(src);
  const dataStatus = frameMounted ? (frameShown ? "running" : "loading") : pictureSrc ? "still" : "idle";
  // A picture from another theme is never shown: it would flash the old
  // palette. The space is held empty until the frame draws.
  const visiblePicture = stillStale ? null : pictureSrc;
  const toolbarPinned = Boolean(sceneError) || proofState === "saving" || proofState === "failed";
  const showToolbar = !capturingProof;

  return (
    <div
      ref={wrapperRef}
      // w-screen + max-w-full: the reply row is a flex item that sizes to its
      // content, so a short reply left the scene as narrow as its text. A
      // viewport-wide preferred size makes the row take the whole column; the
      // max-width then holds the scene to it.
      className="group/scene relative my-3 w-screen max-w-full"
      data-testid="chat-scene"
      data-scene-status={dataStatus}
    >
      {dataFeed}
      <div ref={shellRef} className="relative min-w-0 overflow-hidden">
        {visiblePicture && !frameShown ? (
          <img
            src={visiblePicture}
            alt={title}
            data-testid="chat-scene-snapshot"
            className="block w-full"
            style={{ maxHeight: MAX_HEIGHT }}
            draggable={false}
          />
        ) : null}
        {frameMounted ? (
          <iframe
            ref={frameRef}
            title={title}
            data-testid="chat-scene-frame"
            // The nonce the document in this frame stamps its messages with; on
            // the element because the frame is the only place the pair is
            // observable from outside.
            data-scene-nonce={prepared?.nonce}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            src={src ?? undefined}
            className="block w-full border-0 bg-transparent"
            style={{
              height,
              colorScheme: theme.scheme,
              ...(frameShown || !visiblePicture
                ? null
                : { position: "absolute", left: 0, top: 0, opacity: 0, pointerEvents: "none" }),
            }}
          />
        ) : null}
        {!frameMounted && !visiblePicture ? (
          <div aria-hidden style={{ height: (scopeKey && knownHeights.get(scopeKey)) || height }} />
        ) : null}
      </div>

      {/* Hover toolbar: says what this is, expands it, files it as proof. */}
      <div
        className={`absolute right-1 top-1 flex items-center gap-0.5 rounded-md p-0.5 transition-opacity duration-150 ${
          showToolbar && toolbarPinned
            ? "opacity-100"
            : showToolbar
              ? "pointer-events-none opacity-0 group-hover/scene:pointer-events-auto group-hover/scene:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100"
              : "pointer-events-none opacity-0"
        }`}
        style={{
          background: "color-mix(in srgb, var(--chat-canvas-bg, var(--color-bg)) 92%, transparent)",
          border: `1px solid ${COLORS.borderMuted}`,
        }}
        data-testid="chat-scene-toolbar"
      >
        <span
          className="flex max-w-[260px] items-center gap-1 truncate px-1.5 text-[11px]"
          style={{ color: sceneError ? COLORS.warning : COLORS.textMuted }}
          title={sceneError ?? `${title} — a view the agent drew`}
        >
          {sceneError ? <WarningCircle size={11} weight="bold" /> : <Sparkle size={10} weight="fill" style={{ color: COLORS.accent }} />}
          <span className="truncate">{sceneError ?? title}</span>
        </span>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          data-testid="chat-scene-expand"
          className="inline-flex size-6 items-center justify-center rounded opacity-80 hover:opacity-100"
          style={{ color: COLORS.textSecondary }}
          title="Expand"
          aria-label={`Expand ${title}`}
        >
          <ArrowsOutSimple size={13} weight="bold" />
        </button>
        <button
          type="button"
          onClick={() => { void fileProof(); }}
          data-testid="chat-scene-proof"
          disabled={proofState === "saving"}
          className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] opacity-80 hover:opacity-100"
          style={{ color: proofState === "failed" ? COLORS.warning : COLORS.textSecondary }}
          title="Save this view to the proof drawer"
        >
          <Camera size={12} weight="bold" />
          {proofState === "saved" ? "Saved" : proofState === "saving" ? "Saving…" : proofState === "failed" ? "Not saved" : "Proof"}
        </button>
      </div>

      {expanded ? (
        <Dialog
          open
          onOpenChange={(open) => { if (!open) setExpanded(false); }}
          title={title}
          width="min(1280px, 94vw)"
          height="88vh"
          bodyPadding
          scrollBody={false}
          testId="chat-scene-dialog"
        >
          <SceneFrame source={source} scopeKey={null} onEmit={onEmit} variant="expanded" />
        </Dialog>
      ) : null}
    </div>
  );
}
