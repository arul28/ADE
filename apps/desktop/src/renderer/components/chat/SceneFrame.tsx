import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsOutSimple, Camera, Sparkle, WarningCircle } from "@phosphor-icons/react";

import { buildSceneDocument } from "../../../shared/chatSceneDocument";
import {
  isSceneParseFailure,
  parseSceneFence,
  parseSceneHostMessage,
  sceneFrameMessage,
  sceneThemeMessage,
  sceneThemeSignature,
  SCENE_LIMITS,
  SCENE_SETTLE_MAX_MS,
  SCENE_SETTLE_QUIET_MS,
  type SceneFrameInbound,
  type SceneTheme,
} from "../../../shared/chatScene";
import { parseDeeplink } from "../../../shared/deeplinks";
import type { SceneDataPayload } from "../../../shared/sceneDataProjection";
import { openUrlInAdeBrowser } from "../../lib/openExternal";
import { COLORS } from "../lanes/laneDesignTokens";
import { Dialog } from "../ui/dialog";
import { Banner } from "../ui/notice";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { openChatDeeplinkTarget } from "./ChipText";
import { HighlightedCode } from "./CodeHighlighter";
import {
  captureSceneShell,
  measureCapturableSceneRect,
  SCENE_CAPTURE_RETRY_MAX_MS,
  SCENE_CAPTURE_RETRY_MS,
} from "./sceneCapture";
import { SceneDataFeed } from "./sceneData";
import {
  cachedPreparedUrl,
  cachedSceneDocument,
  forgetPreparedUrl,
  hasScenePlayed,
  knownSceneHeight,
  markScenePlayed,
  rememberPreparedUrl,
  rememberSceneHeight,
} from "./sceneDocumentCache";
import { loadSceneFontFaceCss, sceneFontFaceCssNow } from "./sceneFonts";
import { readSceneStill, rememberSceneStill } from "./sceneStillStore";
import { useSceneTheme } from "./sceneTheme";
import { useSceneOnScreen } from "./useSceneOnScreen";
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
 * working in scrollback, and a still stands in for it everywhere else
 * (`useSceneOnScreen`). A scene that already played comes back RESTORED: the
 * SDK skips its entrance, and the still covers the frame until it is drawn. A
 * settled scene nobody is touching idles inside the frame (see the SDK in
 * `shared/chatSceneDocument.ts`).
 *
 * The still is taken when a scene with none first settles fully on screen, and
 * again after a theme switch, for scrollback, reopened chats, remote clients
 * and the proof drawer.
 */
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 960;
/** The least time between two links a scene may open. */
const SCENE_OPEN_MIN_INTERVAL_MS = 800;

/** Every whole http(s) URL written in a scene's source. */
function webUrlsIn(source: string): Set<string> {
  return new Set(source.match(/https?:\/\/[^\s"'<>`)]+/g) ?? []);
}

/** True when `url` is a web link ADE itself put in a scene's data snapshot. */
function urlInSceneData(data: SceneDataPayload | null, url: string): boolean {
  return Boolean(data?.prs?.some((pr) => pr.githubUrl === url));
}

/**
 * How far the document in the frame has got. Stamped with the URL it belongs
 * to, so a caller that swaps the source on one mounted frame never reads the
 * last document's progress as the new one's.
 */
type FrameStage = { src: string; ready: boolean; settled: boolean; revealed: boolean };

const PROOF_LABEL = { idle: "Proof", saving: "Saving…", saved: "Saved", failed: "Not saved" } as const;

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
  const { sessionId, pin, laneId } = useChatRuntimeScope();
  const parsed = useMemo(() => parseSceneFence(source), [source]);
  const failed = isSceneParseFailure(parsed);
  const title = (!failed && parsed.title) || "Generated view";
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(() => knownSceneHeight(scopeKey) ?? 220);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [proofState, setProofState] = useState<keyof typeof PROOF_LABEL>("idle");
  const [expanded, setExpanded] = useState(false);
  /** True while the Proof button is grabbing the view; hides the toolbar from the picture. */
  const [capturingProof, setCapturingProof] = useState(false);
  /** This mount's settle-time still; see the capture effect. */
  const [still, setStill] = useState<string | null>(null);
  /** Bumped when a capture that was waiting for visibility should retry. */
  const [stillAttempt, setStillAttempt] = useState(0);
  /** One still per document: a second capture would only cost a window grab. */
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
   * view. It collapses to one inline banner (Retry, Show code, Show anyway)
   * instead of holding a tall empty box with an error in its corner.
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
  const themeKey = sceneThemeSignature(theme);

  const [fontFaceCss, setFontFaceCss] = useState<string | null>(sceneFontFaceCssNow);
  useEffect(() => {
    if (fontFaceCss !== null) return;
    let cancelled = false;
    void loadSceneFontFaceCss().then((css) => { if (!cancelled) setFontFaceCss(css); });
    return () => { cancelled = true; };
  }, [fontFaceCss]);

  // Up while on screen (during its own turn too: a scene drawn and then
  // scrolled past during a ten-minute turn must not run all that time), and
  // always as the expanded view. During its turn the scroll-pause gate is off,
  // since a streaming transcript scrolls itself on every delta.
  const onScreen = useSceneOnScreen(wrapperRef, !expandedVariant && !failed && !streaming, { ignoreScroll: live });
  const wantFrame = (expandedVariant || onScreen) && !collapsed;

  /**
   * Whether the document should skip its entrance. Read at build time through
   * a ref: a still that arrives while the scene is running must not rebuild the
   * document and reload a frame the user is watching.
   */
  const restoredRef = useRef(false);
  restoredRef.current = expandedVariant || rehydrated || Boolean(pictureSrc) || hasScenePlayed(scopeKey);

  // A fence that is still arriving draws nothing: one placeholder now beats a
  // frame that reloads on every tick.
  const doc = useMemo(() => {
    if (failed || streaming || undecided || !wantFrame || fontFaceCss === null) return null;
    const builtTheme = themeRef.current;
    const restored = restoredRef.current;
    const key = `${scopeKey ?? ""}|${attempt}|${restored ? 1 : 0}|${sceneThemeSignature(builtTheme)}|${fontFaceCss.length}|${source}`;
    const { html, nonce } = cachedSceneDocument(key, (fresh) => buildSceneDocument({
      html: parsed.html,
      title: parsed.title,
      theme: builtTheme,
      scopeKey,
      nonce: fresh,
      restored,
      fontFaceCss,
    }));
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
  const srcRef = useRef<string | null>(null);
  const nonceRef = useRef<string | null>(null);
  /** The theme the frame currently has: built in, or last posted. */
  const frameThemeRef = useRef<SceneTheme | null>(null);
  useEffect(() => {
    srcRef.current = src;
    nonceRef.current = src ? prepared?.nonce ?? null : null;
    frameThemeRef.current = src ? prepared?.theme ?? null : null;
  }, [src, prepared]);

  const [stage, setStage] = useState<FrameStage | null>(null);
  const current = stage && src !== null && stage.src === src ? stage : null;
  const ready = Boolean(current?.ready);
  const settled = Boolean(current?.settled);
  const frameShown = Boolean(current?.revealed);
  const readyRef = useRef(false);
  readyRef.current = ready;
  /** Advance the stage of the document at `forSrc`; a stage for another document starts over. */
  const advanceStage = useCallback((forSrc: string | null, patch: Partial<Omit<FrameStage, "src">>) => {
    if (!forSrc) return;
    setStage((previous) => ({
      ...(previous && previous.src === forSrc ? previous : { src: forSrc, ready: false, settled: false, revealed: false }),
      ...patch,
    }));
  }, []);

  // A new document gets its own capture latch. When the frame comes down the
  // stage is dropped: a remount is handed the same cached URL, and a stage left
  // from the last mount would call the new, unloaded frame ready, settled and
  // revealed — a blank frame where the still should be.
  useEffect(() => {
    stillTakenRef.current = false;
    captureMissesRef.current = 0;
    if (src === null) setStage(null);
  }, [src]);

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
    const cachedUrl = cachedPreparedUrl(doc.html);
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
            rememberPreparedUrl(doc.html, url);
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

  const postToFrame = useCallback((message: SceneFrameInbound) => {
    // The frame's origin is opaque, so "*" is the only target that reaches it.
    try { frameRef.current?.contentWindow?.postMessage(sceneFrameMessage(message), "*"); } catch { /* frame gone */ }
  }, []);

  /**
   * A scene opens links only while its frame has focus (a click inside it
   * gives it focus), while this window holds transient user activation (a
   * click in a child frame activates its ancestors too, and the activation
   * lapses seconds later, so a timer firing after one click is refused), and
   * at most one per {@link SCENE_OPEN_MIN_INTERVAL_MS}. Every open is visible:
   * ADE navigates, or the page opens in ADE's browser.
   */
  const lastOpenRef = useRef(0);
  const latestDataRef = useRef<SceneDataPayload | null>(null);
  // Whole URLs only: a substring match would let a scene open any prefix of a
  // URL it was written with, and pick which one, to spell out its data.
  const writtenUrls = useMemo(() => webUrlsIn(source), [source]);
  const openFromScene = useCallback((url: string) => {
    const now = Date.now();
    const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    const pressed = frameRef.current !== null
      && document.activeElement === frameRef.current
      && (activation ? activation.isActive : true);
    if (!pressed || now - lastOpenRef.current < SCENE_OPEN_MIN_INTERVAL_MS) return;
    lastOpenRef.current = now;
    const deeplink = parseDeeplink(url);
    if (deeplink.ok) {
      openChatDeeplinkTarget(url, deeplink.target, { laneId, pin });
      return;
    }
    if (/^https?:\/\//i.test(url)) {
      // A scene with live ADE data could build a URL around that data and
      // send it out on a click. Such a scene may open only the web pages it
      // was written with or that ADE sent it (a PR's GitHub link), never one
      // assembled at run time.
      if (!failed && parsed.data.length && !writtenUrls.has(url) && !urlInSceneData(latestDataRef.current, url)) {
        setSceneError("This scene shows live ADE data, so it can only open the web links written in it.");
        return;
      }
      openUrlInAdeBrowser(url, { runtimePin: pin });
      return;
    }
    setSceneError("A scene can open ADE links (ade://) and web pages only.");
  }, [failed, parsed, writtenUrls, pin, laneId]);

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
        // Thrown before the frame said it was up: the view did not draw. A
        // policy block (a remote font or image) is reported, not collapsed.
        if (!message.payload.policy && !readyRef.current) setDrawFailed(true);
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
        rememberSceneHeight(scopeKey, next);
      }
      // A document that has settled has loaded, whether or not its ready
      // arrived first.
      if (message.type === "settled") {
        advanceStage(srcRef.current, { ready: true, settled: true });
        markScenePlayed(scopeKey);
      }
      if (message.type === "ready") advanceStage(srcRef.current, { ready: true });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onEmit, scopeKey, openFromScene, advanceStage]);

  // Live ADE data, for a scene that asked for it, while its frame is up.
  const sendData = useCallback((payload: SceneDataPayload) => {
    latestDataRef.current = payload;
    if (readyRef.current) postToFrame({ type: "data", payload });
  }, [postToFrame]);
  const dataFeed = !failed && src && parsed.data.length
    ? <SceneDataFeed sources={parsed.data} send={sendData} />
    : null;

  // The frame is up (ready, settled, or the ready timeout), or the theme
  // switched while it is: hand it the current palette if it has another one,
  // and the latest data snapshot when it comes up.
  useEffect(() => {
    if (!ready) return;
    const frameTheme = frameThemeRef.current;
    if (!frameTheme || sceneThemeSignature(frameTheme) === themeKey) return;
    frameThemeRef.current = themeRef.current;
    postToFrame(sceneThemeMessage(themeRef.current));
  }, [ready, themeKey, postToFrame]);
  useEffect(() => {
    if (ready && latestDataRef.current) postToFrame({ type: "data", payload: latestDataRef.current });
  }, [ready, postToFrame]);

  // A different scene in the same mounted frame (its source swapped) owns none
  // of the previous scene's picture or failure.
  useEffect(() => {
    setStill(null);
    setSceneError(null);
    setDrawFailed(false);
    setShowAnyway(false);
    latestDataRef.current = null;
  }, [source, scopeKey]);

  /**
   * The theme a picture was drawn in. A still from before a theme switch must
   * not cover the frame (the reader would see the old palette flash) and is
   * taken again once the scene is live in the new one. A capture made in this
   * window remembers its theme across mounts (`sceneStillStore`); a still known
   * only from disk has no recorded theme and is taken as current.
   */
  const [pictureTheme, setPictureTheme] = useState<string | null>(null);
  useEffect(() => {
    if (!pictureSrc) { setPictureTheme(null); return; }
    setPictureTheme((existing) => existing ?? readSceneStill(scopeKey)?.theme ?? sceneThemeSignature(themeRef.current));
  }, [pictureSrc, scopeKey]);
  const stillStale = Boolean(pictureSrc) && pictureTheme !== null && pictureTheme !== themeKey;
  // A stale picture releases the one-capture latch.
  useEffect(() => {
    if (!stillStale) return;
    stillTakenRef.current = false;
    setStillAttempt((value) => value + 1);
  }, [stillStale]);
  // A picture from another theme is never shown; the space is held until the frame draws.
  const visiblePicture = stillStale ? null : pictureSrc;

  /**
   * Reveal. A frame coming back under its still stays hidden until it has
   * drawn (up, then two frames for the paint), so the swap from picture to
   * live view shows no blank and no replayed entrance. A frame with nothing
   * over it shows at once: its entrance is the point.
   */
  const coveredByStill = Boolean(visiblePicture) && Boolean(prepared?.restored);
  useEffect(() => {
    if (!src || frameShown) return;
    if (!coveredByStill) { advanceStage(src, { revealed: true }); return; }
    if (!ready) return;
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => advanceStage(src, { revealed: true }));
    });
    return () => {
      window.cancelAnimationFrame(first);
      if (second) window.cancelAnimationFrame(second);
    };
  }, [src, ready, frameShown, coveredByStill, advanceStage]);

  // A scene that never reports ready is not necessarily broken — it may simply
  // not call ade.ready() — so this stops the wait rather than the scene. A
  // prepared URL that never came up may have been evicted in main; it is
  // forgotten so the next mount prepares it again.
  useEffect(() => {
    if (ready || !src) return;
    const armedSrc = src;
    const timer = window.setTimeout(() => {
      forgetPreparedUrl(armedSrc);
      advanceStage(armedSrc, { ready: true });
    }, SCENE_LIMITS.readyTimeoutMs);
    return () => window.clearTimeout(timer);
  }, [ready, src, advanceStage]);

  /**
   * The host's own settle deadline, for a frame that never reports one. One
   * quiet window longer than the frame's own cap, so a frame that IS going to
   * report gets to do it first.
   */
  useEffect(() => {
    if (!ready || settled || !src) return;
    const armedSrc = src;
    const timer = window.setTimeout(
      () => advanceStage(armedSrc, { settled: true }),
      SCENE_SETTLE_MAX_MS + SCENE_SETTLE_QUIET_MS,
    );
    return () => window.clearTimeout(timer);
  }, [ready, settled, src, advanceStage]);

  /**
   * Take the still, for a scene with none (or one from another theme).
   *
   * It runs while the scene is live, after it settles, and only when the whole
   * view is on screen and on top (see `measureCapturableSceneRect`); it waits
   * on scroll and an IntersectionObserver for that moment, with no deadline. A
   * scene with a current picture takes no new one: a scene remounts every time
   * it scrolls back, and each capture is a window grab, a PNG encode and a file.
   */
  useEffect(() => {
    if (expandedVariant || !settled || stillTakenRef.current || !src || visiblePicture) return;
    const capture = window.ade?.scene?.snapshot;
    const shell = shellRef.current;
    if (typeof capture !== "function" || !shell) return;
    if (!measureCapturableSceneRect(shell)) {
      const retry = () => {
        const shellNow = shellRef.current;
        if (shellNow && measureCapturableSceneRect(shellNow)) setStillAttempt((value) => value + 1);
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
    void captureSceneShell(shell, capture)
      .then(async (result) => {
        if (cancelled) return;
        if (result.kind !== "captured") {
          // Not a picture of this scene. Release the latch and look again on a
          // backoff: a re-pin or re-measure is usually over in a frame or two.
          stillTakenRef.current = false;
          const misses = captureMissesRef.current++;
          retryTimer = window.setTimeout(
            () => setStillAttempt((value) => value + 1),
            Math.min(SCENE_CAPTURE_RETRY_MS * 2 ** misses, SCENE_CAPTURE_RETRY_MAX_MS),
          );
          return;
        }
        captureMissesRef.current = 0;
        const { dataUrl } = result;
        const capturedTheme = sceneThemeSignature(themeRef.current);
        setStill(dataUrl);
        setPictureTheme(capturedTheme);
        if (scopeKey) rememberSceneStill(scopeKey, { dataUrl, theme: capturedTheme });
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
  }, [expandedVariant, settled, src, stillAttempt, scopeKey, title, sessionId, visiblePicture]);

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
      const ok = await attach({ dataUrl, title, sessionId: sessionId ?? null });
      setProofState(ok ? "saved" : "failed");
    } catch {
      setProofState("failed");
    }
  }, [title, still, pictureSrc, sessionId]);

  if (streaming) {
    // Deliberately not the parse-failure block: a fence that is two lines in is
    // not a broken scene, and saying so mid-stream would be a lie that corrects
    // itself a second later.
    return (
      <div className="my-3 w-screen max-w-full" data-testid="chat-scene" data-scene-status="drawing">
        <div
          className="flex items-end rounded-md px-3 py-2"
          style={{ height: knownSceneHeight(scopeKey) ?? MIN_HEIGHT, background: COLORS.recessedBg }}
        >
          <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: COLORS.textMuted }}>
            <Sparkle size={10} weight="fill" style={{ color: COLORS.accent }} />
            {title}
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
        <Banner
          layout="inline"
          model={{
            id: `scene-failed-${scopeKey ?? "anon"}`,
            tone: "warning",
            title: `${title} did not draw`,
            detail: sceneError ?? undefined,
            actions: [
              {
                label: "Retry",
                onClick: () => { setDrawFailed(false); setSceneError(null); setAttempt((value) => value + 1); },
              },
              { label: showCode ? "Hide code" : "Show code", variant: "secondary", onClick: () => setShowCode((value) => !value) },
              { label: "Show anyway", variant: "link", onClick: () => setShowAnyway(true) },
            ],
          }}
        />
        {showCode ? <div className="mt-2"><HighlightedCode code={source} language="html" /></div> : null}
      </div>
    );
  }

  const frameMounted = Boolean(src);
  const dataStatus = frameMounted ? (frameShown ? "running" : "loading") : pictureSrc ? "still" : "idle";
  const toolbarPinned = Boolean(sceneError) || proofState === "saving" || proofState === "failed";
  let toolbarVisibility = "pointer-events-none opacity-0 group-hover/scene:pointer-events-auto group-hover/scene:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100";
  if (capturingProof) toolbarVisibility = "pointer-events-none opacity-0";
  else if (toolbarPinned) toolbarVisibility = "opacity-100";

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
        {!frameMounted && !visiblePicture ? <div aria-hidden style={{ height }} /> : null}
      </div>

      {/* Hover toolbar: says what this is, expands it, files it as proof. */}
      <div
        className={`absolute right-1 top-1 flex items-center gap-0.5 rounded-md p-0.5 transition-opacity duration-150 ${toolbarVisibility}`}
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
          {PROOF_LABEL[proofState]}
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
