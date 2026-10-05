import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sparkle, Camera, WarningCircle } from "@phosphor-icons/react";

import {
  buildSceneDocument,
  isSceneParseFailure,
  parseSceneFence,
  parseSceneHostMessage,
  SCENE_FALLBACK_THEME,
  SCENE_LIMITS,
  SCENE_SETTLE_MAX_MS,
  SCENE_SETTLE_QUIET_MS,
  type SceneTheme,
} from "../../../shared/chatScene";
import { COLORS, fgTint } from "../lanes/laneDesignTokens";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { HighlightedCode } from "./CodeHighlighter";
import { rememberSceneStill } from "./sceneStillStore";
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
 * Chrome is deliberate and permanent: a hairline rule and a mark in the corner,
 * because a view drawn by a model must never be mistakable for ADE's own UI.
 */

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 760;
/**
 * How long a finished turn waits, after its scene settles, for the still —
 * which waits in turn for the scene to come fully on screen — before giving up
 * and leaving the live frame up uncaptured.
 *
 * There has to be a deadline, because "fully visible" is a state some scenes
 * can never reach: `MAX_HEIGHT` is 760, and in a short window a tall scene is
 * taller than the viewport no matter where it is scrolled. Without this the
 * status stays `running` forever and the iframe keeps executing in scrollback,
 * which is the exact thing freezing exists to stop.
 */
const SCENE_FREEZE_DEADLINE_MS = 4_000;

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

function readSceneTheme(): SceneTheme {
  if (typeof window === "undefined") return SCENE_FALLBACK_THEME;
  try {
    const probe = window.getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => {
      const value = probe.getPropertyValue(name).trim();
      return value.length ? value : fallback;
    };
    return {
      bg: read("--color-bg", SCENE_FALLBACK_THEME.bg),
      surface: fgTint(3.5),
      border: read("--color-border", SCENE_FALLBACK_THEME.border),
      fg: read("--color-fg", SCENE_FALLBACK_THEME.fg),
      fgMuted: read("--color-muted-fg", SCENE_FALLBACK_THEME.fgMuted),
      accent: read("--color-accent", SCENE_FALLBACK_THEME.accent),
      success: read("--color-success", SCENE_FALLBACK_THEME.success),
      warning: read("--color-warning", SCENE_FALLBACK_THEME.warning),
      danger: read("--color-error", SCENE_FALLBACK_THEME.danger),
      fontSans: SCENE_FALLBACK_THEME.fontSans,
      fontMono: SCENE_FALLBACK_THEME.fontMono,
    };
  } catch {
    return SCENE_FALLBACK_THEME;
  }
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
   * component, and the two flags were never independently meaningful here —
   * `sealed` mattered only while `live`. Defaults false: every caller that does
   * not stream (a settled transcript row) is complete by construction.
   */
  streaming?: boolean;
  /**
   * This scene's identity: what its still is filed under and looked up by, and
   * what separates two byte-identical scenes at different positions.
   *
   * Required, and explicitly null for a scene that has none — a reasoning body,
   * a reasoning body. Null means the scene runs and leaves nothing
   * behind, which is a decision each caller has to make rather than fall into
   * by omitting a prop.
   */
  scopeKey: string | null;
  onEmit?: (name: string, payload: unknown) => void;
};

type Status = "loading" | "running" | "frozen";

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

export function SceneFrame({
  source,
  live = false,
  streaming = false,
  scopeKey,
  onEmit,
}: SceneFrameProps) {
  // Proof in ADE is chat-scoped, so a snapshot filed with no owner is an
  // artifact nobody can trace back to a conversation. Read from the chat scope
  // rather than taken as a prop: the value is session-constant, and threading
  // it here meant two components in between carrying a prop neither reads.
  const { sessionId } = useChatRuntimeScope();
  const parsed = useMemo(() => parseSceneFence(source), [source]);
  const failed = isSceneParseFailure(parsed);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  /** The current document, for the two callbacks that stamp a settle with it. */
  const srcRef = useRef<string | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(220);
  const [status, setStatus] = useState<Status>("loading");
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [proofState, setProofState] = useState<"idle" | "saving" | "saved">("idle");
  /**
   * When a finished turn stops waiting for its scene's still and freezes
   * without one. Armed per document, at the first settle after the turn ended.
   */
  const freezeDeadlineRef = useRef<number | null>(null);

  /**
   * The still: the picture taken when the scene STOPPED MOVING, not when its
   * turn ended.
   *
   * Freezing at the end of the turn was the only capture there was, and it
   * answered nothing for the two cases the user actually hits — a scene that
   * had scrolled out of view by then, and a window too short to ever hold one
   * fully — because both fall through to "leave the live frame up", which
   * leaves scrollback and every later reopen with no picture at all.
   */
  const [still, setStill] = useState<string | null>(null);
  /**
   * The document that has reported it is done animating — not a boolean.
   *
   * A caller can keep ONE mounted frame and swap its source, and on a swap the
   * reset below and the capture effect run in the SAME commit, with the reset's `setSettled(false)`
   * still only scheduled. The capture therefore fired against the previous
   * view's `settled`, took a picture of a document that had just been replaced,
   * threw it away (its own effect was torn down a tick later) and burned the
   * one-capture latch — so every view after the first left nothing behind.
   * Stamped with the src it belongs to, a stale settle simply is not one.
   */
  const [settledSrc, setSettledSrc] = useState<string | null>(null);
  /** Bumped when a settle capture that was waiting for visibility should retry. */
  const [stillAttempt, setStillAttempt] = useState(0);
  /** One still per mounted scene: a second capture would only cost a window grab. */
  const stillTakenRef = useRef(false);
  /** Consecutive captures thrown away for moving; sets the retry backoff. */
  const captureMissesRef = useRef(0);

  /**
   * Show the picture this scene already left behind, or run its code? The whole
   * decision lives in {@link useSceneStillLatch}.
   */
  const { rehydrated, undecided, storedStillSrc } = useSceneStillLatch({
    sessionId,
    scopeKey,
    live,
  });

  const theme = useMemo(readSceneTheme, []);
  // A fence that is still arriving draws nothing: one placeholder now beats a
  // frame that reloads on every tick.
  const doc = useMemo(() => {
    if (failed || streaming || rehydrated || undecided) return null;
    // Minted here, with the document, because here is the only place that
    // knows a new document is being built — which is precisely the event the
    // nonce exists to mark. See {@link prepared} for what it is worth.
    const nonce = mintSceneNonce();
    return {
      nonce,
      html: buildSceneDocument({ html: parsed.html, title: parsed.title, theme, scopeKey, nonce }),
    };
  }, [failed, streaming, rehydrated, undecided, parsed, theme, scopeKey]);

  /**
   * The document the frame is currently showing, and the nonce that document
   * stamps its messages with — one piece of state, never two.
   *
   * The pair has to move together. When one mounted frame has its `src`
   * swapped, an iframe's `contentWindow` is the SAME
   * object across that swap — so the `event.source` check below cannot tell the
   * outgoing document from the incoming one. A `settled` or `ready` the old
   * document posted after the swap was therefore stamped onto the new one,
   * marking a barely-painted view settled and burning the one-still latch on
   * it. Matching the nonce is what makes "which document said this" answerable.
   */
  const [prepared, setPrepared] = useState<{ url: string; nonce: string } | null>(null);
  const src = prepared?.url ?? null;
  /** The nonce the current `src` was prepared with; see {@link prepared}. */
  const nonceRef = useRef<string | null>(null);
  // Written in an effect rather than during render: a render can be thrown
  // away (StrictMode, a suspended or abandoned commit) and the ref would then
  // name a document the frame was never handed. `useEffect` and not
  // `useLayoutEffect` is enough because the only reader is the `message`
  // handler below, and a frame's postMessage cannot arrive before the commit
  // that gave it its `src`.
  useEffect(() => {
    srcRef.current = src;
    nonceRef.current = prepared?.nonce ?? null;
  }, [src, prepared]);
  /** True only for a settle this document reported; see {@link settledSrc}. */
  const settled = settledSrc !== null && settledSrc === src;

  // Prefer the real scheme; blob is the preview path. Both give the frame an
  // origin of its own, which is the property that matters.
  useEffect(() => {
    if (!doc) return;
    let revoked: string | null = null;
    let cancelled = false;
    // The blob path needs no exception from the nonce rule: the blob is built
    // from these same bytes, so it carries the same stamp the `ade-scene:` URL
    // would have.
    const show = (url: string) => setPrepared({ url, nonce: doc.nonce });
    const fallBackToBlob = () => {
      const blob = new Blob([doc.html], { type: "text/html" });
      revoked = URL.createObjectURL(blob);
      show(revoked);
    };
    const prepare = window.ade?.scene?.prepare;
    if (typeof prepare === "function") {
      // A non-string answer is a failure, not a URL. On the hosted web client
      // the `scene.prepare` the adapter exposes is a generic fallback proxy: it
      // is a function, it resolves, and it resolves `null` — so a bare
      // `typeof === "function"` check passed, `src` became null, and the scene
      // rendered as a blank gap with no error anywhere.
      void prepare(doc.html)
        .then((url) => {
          if (cancelled) return;
          if (typeof url === "string" && url.length > 0) show(url);
          else fallBackToBlob();
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

  // Only messages from this frame's own contentWindow are considered, every one
  // is shape-checked before it reaches state, and every one must name the
  // document currently in the frame.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const message = parseSceneHostMessage(event.data);
      if (!message) return;
      // A missing nonce is dropped as firmly as a wrong one. Every document
      // this host builds carries one, so an unstamped message is either a
      // document from before this check existed — which is exactly the stale
      // document the check is here to reject — or not one of ours at all.
      if (!message.nonce || message.nonce !== nonceRef.current) return;
      if (message.type === "error") {
        setSceneError(message.payload.message);
        return;
      }
      if (message.type === "emit") {
        onEmit?.(message.payload.name, message.payload.payload);
        return;
      }
      if (message.payload.height) {
        setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, message.payload.height)));
      }
      if (message.type === "settled") setSettledSrc(srcRef.current);
      if (message.type === "ready") setStatus((prev) => (prev === "loading" ? "running" : prev));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onEmit]);

  // A scene that never reports ready is not necessarily broken — it may simply
  // not call ade.ready() — so this stops the spinner rather than the scene.
  useEffect(() => {
    if (status !== "loading" || !src) return;
    const timer = window.setTimeout(() => setStatus("running"), SCENE_LIMITS.readyTimeoutMs);
    return () => window.clearTimeout(timer);
  }, [status, src]);

  // A new document is a new scene and gets its own wait; an expired deadline
  // from the previous one would freeze it uncaptured on sight.
  //
  // The still is reset with it, and so is the one-capture latch: a latch that
  // survived a source swap on one mounted frame would keep a picture of the
  // first view and none of the rest.
  useEffect(() => {
    freezeDeadlineRef.current = null;
    stillTakenRef.current = false;
    captureMissesRef.current = 0;
    setStill(null);
  }, [src]);

  /**
   * The host's own settle deadline.
   *
   * The frame reports `settled` itself, and the SDK caps its own wait — but a
   * scene that never reports is exactly the scene that most needs a picture: an
   * older prepared document still in the store, a script that threw before the
   * watcher was armed, a frame whose message never arrived. So the host runs
   * the same deadline independently and calls it settled when it passes. One
   * quiet window longer than the frame's own cap, so a frame that IS going to
   * report gets to do it first and the two do not race.
   *
   * Armed PER DOCUMENT, and it stamps the document it was armed for. When the
   * source is swapped on one mounted frame, `status` stays `running` across the
   * swap — so a deadline left over from a view that never settled
   * survived it and stamped the NEW document settled almost immediately,
   * capturing a barely-painted view and burning the one-still latch on it.
   */
  useEffect(() => {
    if (status !== "running" || settled || rehydrated || !src) return;
    const armedSrc = src;
    const timer = window.setTimeout(
      () => setSettledSrc(armedSrc),
      SCENE_SETTLE_MAX_MS + SCENE_SETTLE_QUIET_MS,
    );
    return () => window.clearTimeout(timer);
  }, [status, settled, rehydrated, src]);

  /**
   * Take the still.
   *
   * Runs while the scene is still LIVE — that is the whole point, and it is why
   * this is a separate effect from the freeze below rather than a flag on it.
   * The frame keeps running afterwards; nothing here tears anything down. It is
   * also the ONLY capture: the freeze waits for this picture rather than taking
   * its own.
   *
   * Visibility is all-or-nothing, see {@link measureCapturableSceneRect}: a
   * capture is a crop of the window, so a scene that is not wholly on screen
   * and on top would be kept forever as a picture of something else. There is
   * no deadline here — a scene that is never capturable simply has no still —
   * so this waits on scroll and an IntersectionObserver and takes the picture
   * the first moment the whole view is on screen.
   */
  useEffect(() => {
    if (!settled || stillTakenRef.current || status !== "running" || !src) return;
    const capture = window.ade?.scene?.snapshot;
    const shell = shellRef.current;
    if (typeof capture !== "function" || !shell) return;
    if (!measureCapturableSceneRect(shell)) {
      const retry = () => {
        const current = shellRef.current;
        if (current && measureCapturableSceneRect(current)) setStillAttempt((attempt) => attempt + 1);
      };
      // Scroll is captured because the transcript has its own scroller; the
      // observer covers what scrolling does not, such as a pane resize.
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
    // Latched BEFORE the await: the effect re-runs on every `stillAttempt`, and
    // two captures in flight would write two artifacts for one scene.
    stillTakenRef.current = true;
    let cancelled = false;
    let retryTimer: number | null = null;
    const title = (!failed && parsed.title) || "Generated view";
    void captureSceneShell(shell, capture)
      .then(async (result) => {
        if (cancelled) return;
        if (result.kind !== "captured") {
          // Not a picture of this scene. Release the latch and look again
          // shortly: a re-pin or a re-measure is usually over within a frame
          // or two, and the scroll/intersection wait takes over if the scene
          // has gone off screen meanwhile.
          stillTakenRef.current = false;
          if (result.kind !== "empty") {
            const misses = captureMissesRef.current++;
            retryTimer = window.setTimeout(
              () => setStillAttempt((attempt) => attempt + 1),
              Math.min(SCENE_CAPTURE_RETRY_MS * 2 ** misses, SCENE_CAPTURE_RETRY_MAX_MS),
            );
          }
          return;
        }
        captureMissesRef.current = 0;
        const { dataUrl } = result;
        setStill(dataUrl);
        if (scopeKey) rememberSceneStill(scopeKey, { dataUrl });
        // Bytes on disk are what survives this window. A host with no route for
        // it (the browser preview) still keeps the in-memory picture above, so
        // scrollback in THIS session works either way.
        const store = window.ade?.scene?.storeStill;
        // No scope key is no identity: main keys the stored still by it, and a
        // still nothing can ever look up is bytes on disk with no reader.
        if (typeof store !== "function" || !scopeKey) return;
        const record = await store({
          dataUrl,
          title,
          sessionId,
          // The scope key is the still's identity in the index: main keeps one
          // still per key, so a scene that settles twice supersedes its own
          // picture instead of leaving a trail of them on disk.
          scopeKey,
        }).catch(() => null);
        if (cancelled || !record) return;
        if (scopeKey) rememberSceneStill(scopeKey, { record });
      })
      .catch(() => {
        // A failed capture is not a failed scene. Allow another attempt if the
        // view comes back into a capturable state.
        stillTakenRef.current = false;
      });
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [settled, status, src, stillAttempt, scopeKey, failed, parsed, sessionId]);

  /**
   * Freeze: once the turn is over, swap the frame for its still and drop the
   * frame so nothing keeps executing in scrollback.
   *
   * The freeze takes no picture of its own. It used to, the moment the turn
   * ended — and `status === "running"` only means the scene said `ready`, which
   * an author may call synchronously at the end of the script, before a single
   * animation has played. A turn that ended a beat after its scene mounted froze
   * a half-drawn view (a bar at 70%, a card still at opacity 0), and the status
   * flip cancelled the settle capture that was about to take the right one. So
   * the freeze waits for the settle, and the settle still IS the picture.
   *
   * The wait is bounded twice. The settle is bounded by the host's own settle
   * deadline above. After it, the still may still be waiting for the scene to
   * come fully on screen, which some scenes never do (`MAX_HEIGHT` is taller
   * than a short window) — so after {@link SCENE_FREEZE_DEADLINE_MS} the freeze
   * gives up and leaves the live frame up, uncaptured, rather than wait forever.
   */
  useEffect(() => {
    if (live || status !== "running" || !src) return;
    if (still) { setStatus("frozen"); return; }
    if (typeof window.ade?.scene?.snapshot !== "function") {
      // No capture route (browser preview): leave the frame up rather than
      // replacing a working view with nothing.
      setStatus("frozen");
      return;
    }
    if (!settled) return;
    const now = Date.now();
    if (freezeDeadlineRef.current == null) freezeDeadlineRef.current = now + SCENE_FREEZE_DEADLINE_MS;
    const timer = window.setTimeout(
      () => setStatus((prev) => (prev === "running" ? "frozen" : prev)),
      Math.max(0, freezeDeadlineRef.current - now),
    );
    return () => window.clearTimeout(timer);
  }, [live, src, status, settled, still]);

  /** True while the latch says "picture", so a release can be told from a mount. */
  const wasRehydratedRef = useRef(false);
  // A rehydrated scene never mounts a frame, so nothing will ever promote it
  // out of `loading`; it is a picture from the first paint and says so.
  //
  // The latch can also let go again — its picture failed to resolve, so it
  // falls back to running the scene — and `frozen` left over from the
  // rehydrate would gate the freeze effect off and caption a live frame as
  // frozen. A release puts the status back where a fresh mount starts.
  useEffect(() => {
    if (rehydrated) {
      wasRehydratedRef.current = true;
      setStatus("frozen");
      return;
    }
    if (wasRehydratedRef.current) {
      wasRehydratedRef.current = false;
      setStatus("loading");
    }
  }, [rehydrated]);

  const fileProof = useCallback(() => {
    const attach = window.ade?.scene?.attachProof;
    if (typeof attach !== "function") return;
    setProofState("saving");
    void attach({
      // The settle-time still: the one picture this mount takes, and the one
      // the user is looking at once the scene has frozen.
      dataUrl: still,
      title: (!failed && parsed.title) || "Generated view",
      sessionId: sessionId ?? null,
    })
      .then((ok) => setProofState(ok ? "saved" : "idle"))
      .catch(() => setProofState("idle"));
  }, [failed, parsed, still, sessionId]);

  if (streaming) {
    // Deliberately not the parse-failure block: a fence that is two lines in is
    // not a broken scene, and showing "could not be rendered" mid-stream would
    // be a lie that corrects itself a second later.
    return (
      <div className="group/scene my-3" data-testid="chat-scene" data-scene-status="drawing">
        <div className="flex">
          <div
            aria-hidden
            className="w-px shrink-0 rounded-full"
            style={{ background: `linear-gradient(to bottom, ${COLORS.accent}, transparent)` }}
          />
          <div className="min-w-0 flex-1 pl-3" style={{ height: MIN_HEIGHT }} />
        </div>
        <div className="mt-1 flex items-center gap-2 pl-3.5">
          <span className="text-[10px] tracking-wide" style={{ color: COLORS.textMuted }}>
            {(!failed && parsed.title) || "Generated view"}
            <span style={{ color: COLORS.textDim }}> · drawing</span>
          </span>
        </div>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="my-2">
        <div
          className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide"
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
  /**
   * The picture, in order of how close it is to what the user last saw: this
   * mount's settle still, then the still a previous mount or a previous window
   * left on disk.
   */
  const pictureSrc = still ?? storedStillSrc;
  const showFrame = !rehydrated && !undecided && (status !== "frozen" || !pictureSrc);

  return (
    <div className="group/scene my-3" data-testid="chat-scene" data-scene-status={status}>
      <div className="flex">
        {/* The hairline is the mark. Everything else stays out of the way. */}
        <div
          aria-hidden
          className="w-px shrink-0 rounded-full transition-colors"
          style={{
            background: status === "running"
              ? `linear-gradient(to bottom, ${COLORS.accent}, transparent)`
              : COLORS.borderMuted,
          }}
        />
        <div ref={shellRef} className="relative min-w-0 flex-1 overflow-hidden pl-3">
          {showFrame && src ? (
            <iframe
              ref={frameRef}
              title={title}
              data-testid="chat-scene-frame"
              // The nonce the document in this frame stamps its messages with.
              // On the element because the frame is the only place the pair is
              // observable from outside — the frame's own origin cannot read
              // this attribute, and a test otherwise has no way to speak as the
              // document actually loaded.
              data-scene-nonce={prepared?.nonce}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              src={src}
              className="block w-full border-0 bg-transparent"
              style={{ height, colorScheme: "dark" }}
            />
          ) : pictureSrc ? (
            <img
              src={pictureSrc}
              alt={title}
              data-testid="chat-scene-snapshot"
              className="block w-full rounded-sm"
              style={{ maxHeight: MAX_HEIGHT }}
            />
          ) : (
            <div style={{ height: MIN_HEIGHT }} />
          )}

          {/* Corner mark: a quiet, permanent "a model drew this". */}
          <div
            aria-hidden
            className="pointer-events-none absolute right-1 top-1 flex items-center gap-1 rounded-full px-1.5 py-0.5 opacity-70"
            style={{ background: "rgba(0,0,0,0.34)", backdropFilter: "blur(6px)" }}
          >
            <Sparkle size={9} weight="fill" style={{ color: COLORS.accent }} />
            {status === "running" ? (
              <span
                className="inline-block size-1 animate-pulse rounded-full"
                style={{ background: COLORS.accent }}
              />
            ) : null}
          </div>
        </div>
      </div>

      <div className="mt-1 flex items-center gap-2 pl-3.5">
        <span className="text-[10px] tracking-wide" style={{ color: COLORS.textMuted }}>
          {title}
          <span style={{ color: COLORS.textDim }}>
            {status === "running" ? " · live" : status === "loading" ? " · drawing" : " · frozen"}
          </span>
        </span>
        {sceneError ? (
          <span className="truncate text-[10px]" style={{ color: COLORS.warning }} title={sceneError}>
            {sceneError}
          </span>
        ) : null}
        <button
          type="button"
          onClick={fileProof}
          data-testid="chat-scene-proof"
          className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] opacity-0 transition-opacity group-hover/scene:opacity-100 focus-visible:opacity-100"
          style={{ color: COLORS.textSecondary, border: `1px solid ${COLORS.borderMuted}` }}
          title="Save this view to the proof drawer"
        >
          <Camera size={10} weight="bold" />
          {proofState === "saved" ? "Saved" : proofState === "saving" ? "Saving…" : "Proof"}
        </button>
      </div>
    </div>
  );
}
