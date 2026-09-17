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
  type SceneStillRecord,
  type SceneTheme,
} from "../../../shared/chatScene";
import { COLORS } from "../lanes/laneDesignTokens";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { HighlightedCode } from "./CodeHighlighter";
import {
  rememberSceneStill,
  useSceneStillRecord,
  useSceneStillSrc,
  useSessionStillsReady,
} from "./sceneStillStore";

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
 * How long a freeze waits for a scene to come fully on screen before giving up
 * and leaving the live frame up uncaptured.
 *
 * There has to be a deadline, because "fully visible" is a state some scenes
 * can never reach: `MAX_HEIGHT` is 760, and in a short window a tall scene is
 * taller than the viewport no matter where it is scrolled. Without this the
 * status stays `running` forever and the iframe keeps executing in scrollback,
 * which is the exact thing freezing exists to stop.
 */
const SCENE_FREEZE_DEADLINE_MS = 4_000;

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
      surface: "rgba(255,255,255,0.035)",
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
  /** True while the turn or call that produced this scene is still running. */
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
   * not stream (the voice HUD, a settled transcript row) is complete by
   * construction.
   */
  streaming?: boolean;
  /**
   * Stable key for the transcript row. It feeds the document identity below so
   * two byte-identical scenes at different positions get their own frame rather
   * than sharing one.
   */
  scopeKey?: string;
  /**
   * The call this scene was drawn on, when it was drawn on one. Stored with the
   * still so the finished call's card can find its pictures again from the
   * broker rather than from anything this window kept.
   */
  voiceCallId?: string;
  onEmit?: (name: string, payload: unknown) => void;
  /**
   * Called once, with the stored record, the first time this scene's still
   * lands on disk. The voice HUD is the caller that needs it: its scene is
   * unmounted with the HUD when the call ends, so the still has to be handed to
   * something that outlives it before that happens.
   */
  onStill?: (record: SceneStillRecord) => void;
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

export function SceneFrame({
  source,
  live = false,
  streaming = false,
  scopeKey,
  voiceCallId,
  onEmit,
  onStill,
}: SceneFrameProps) {
  // Proof in ADE is chat-scoped, so a snapshot filed with no owner is an
  // artifact nobody can trace back to a conversation. Read from the chat scope
  // rather than taken as a prop: the value is session-constant, and threading
  // it here meant two components in between carrying a prop neither reads.
  // Outside a chat — the voice HUD draws scenes too — the fallback is null.
  const { sessionId } = useChatRuntimeScope();
  const parsed = useMemo(() => parseSceneFence(source), [source]);
  const failed = isSceneParseFailure(parsed);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(220);
  const [status, setStatus] = useState<Status>("loading");
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [proofState, setProofState] = useState<"idle" | "saving" | "saved">("idle");
  /**
   * Bumped whenever something worth re-checking happened while a freeze was
   * waiting for the scene to come fully on screen. Only ever counts up: a
   * frozen scene never returns to `running` (the `ready` handler promotes from
   * `loading` only), so there is no transition that should reset it.
   */
  const [freezeAttempt, setFreezeAttempt] = useState(0);
  /** When the wait above runs out. Set on the first partial-visibility check. */
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
  /** True once the frame has reported it is done animating, or the cap passed. */
  const [settled, setSettled] = useState(false);
  /** Bumped when a settle capture that was waiting for visibility should retry. */
  const [stillAttempt, setStillAttempt] = useState(0);
  /** One still per mounted scene: a second capture would only cost a window grab. */
  const stillTakenRef = useRef(false);
  // Read through a ref so a caller passing an inline arrow does not restart the
  // capture effect on every render of its parent.
  const onStillRef = useRef(onStill);
  onStillRef.current = onStill;

  /**
   * The still this scene left behind on a previous mount, or in a previous
   * window. Present means the code has already run once and produced a picture.
   */
  const storedStill = useSceneStillRecord(sessionId, scopeKey);
  const storedStillSrc = useSceneStillSrc(storedStill);
  /**
   * Whether the answer above is final. The index lives in main now, so "no
   * still" and "not asked yet" look identical for the first tick after a mount.
   */
  const storedStillReady = useSessionStillsReady(sessionId);
  /**
   * True when this mount should show the picture instead of running the code.
   *
   * Latched on the FIRST render rather than derived, because `live` going false
   * at the end of a turn must not yank a frame the user is watching: a scene
   * that was live on this mount plays out and freezes the way it always did.
   * Only a mount that begins settled — scrollback, a remount, a reopened chat —
   * skips execution, and only when there is genuinely a picture to show.
   */
  const rehydrateRef = useRef<boolean | null>(null);
  // Undecided until the index has answered. A settled mount that guessed "no
  // still" while the query was in flight would run the generated code again,
  // which is the one thing the still exists to prevent; one placeholder tick is
  // the price. A live mount never waits — it is going to run either way.
  if (rehydrateRef.current === null && (live || storedStillReady || storedStill)) {
    rehydrateRef.current = !live && Boolean(storedStill);
  }
  const rehydrated = rehydrateRef.current === true;
  const undecided = rehydrateRef.current === null;

  const theme = useMemo(readSceneTheme, []);
  // A fence that is still arriving draws nothing: one placeholder now beats a
  // frame that reloads on every tick.
  const doc = useMemo(() => {
    if (failed || streaming || rehydrated || undecided) return null;
    return buildSceneDocument({ html: parsed.html, title: parsed.title, theme, scopeKey });
  }, [failed, streaming, rehydrated, undecided, parsed, theme, scopeKey]);

  const [src, setSrc] = useState<string | null>(null);

  // Prefer the real scheme; blob is the preview path. Both give the frame an
  // origin of its own, which is the property that matters.
  useEffect(() => {
    if (!doc) return;
    let revoked: string | null = null;
    let cancelled = false;
    const fallBackToBlob = () => {
      const blob = new Blob([doc], { type: "text/html" });
      revoked = URL.createObjectURL(blob);
      setSrc(revoked);
    };
    const prepare = window.ade?.scene?.prepare;
    if (typeof prepare === "function") {
      // A non-string answer is a failure, not a URL. On the hosted web client
      // the `scene.prepare` the adapter exposes is a generic fallback proxy: it
      // is a function, it resolves, and it resolves `null` — so a bare
      // `typeof === "function"` check passed, `src` became null, and the scene
      // rendered as a blank gap with no error anywhere.
      void prepare(doc)
        .then((url) => {
          if (cancelled) return;
          if (typeof url === "string" && url.length > 0) setSrc(url);
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

  // Only messages from this frame's own contentWindow are considered, and every
  // one is shape-checked before it reaches state.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const message = parseSceneHostMessage(event.data);
      if (!message) return;
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
      if (message.type === "settled") setSettled(true);
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
  // The still is reset with it, and so is the one-capture latch. The voice HUD
  // is the caller that proves this matters: it keeps ONE mounted frame for the
  // whole call and swaps the source each time the CTO draws, so a latch that
  // survived the swap meant every call kept a picture of its first view and
  // none of the rest.
  useEffect(() => {
    freezeDeadlineRef.current = null;
    stillTakenRef.current = false;
    setStill(null);
    setSettled(false);
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
   */
  useEffect(() => {
    if (status !== "running" || settled || rehydrated) return;
    const timer = window.setTimeout(
      () => setSettled(true),
      SCENE_SETTLE_MAX_MS + SCENE_SETTLE_QUIET_MS,
    );
    return () => window.clearTimeout(timer);
  }, [status, settled, rehydrated]);

  /**
   * Take the still.
   *
   * Runs while the scene is still LIVE — that is the whole point, and it is why
   * this is a separate effect from the freeze below rather than a flag on it.
   * The frame keeps running afterwards; nothing here tears anything down.
   *
   * Visibility is the same all-or-nothing rule the freeze uses, for the same
   * reason: main intersects the rect, so a partly visible scene would be kept
   * forever as a picture of a sliver of itself. Unlike the freeze there is no
   * deadline — a scene that is never fully visible simply has no still, which
   * is the state we were already in — so this waits on an IntersectionObserver
   * and takes the picture the first moment the whole view is on screen.
   */
  useEffect(() => {
    if (!settled || stillTakenRef.current || status !== "running" || !src) return;
    const capture = window.ade?.scene?.snapshot;
    const shell = shellRef.current;
    if (typeof capture !== "function" || !shell) return;
    const rect = shell.getBoundingClientRect();
    if (!isSceneRectFullyVisible(rect)) {
      const retry = () => {
        const current = shellRef.current?.getBoundingClientRect();
        if (current && isSceneRectFullyVisible(current)) setStillAttempt((attempt) => attempt + 1);
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
    const title = (!failed && parsed.title) || "Generated view";
    void capture({
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height),
    })
      .then(async (dataUrl) => {
        if (cancelled || !dataUrl) return;
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
          sessionId: sessionId ?? null,
          // The scope key is the still's identity in the index: main keeps one
          // still per key, so a scene that settles twice supersedes its own
          // picture instead of leaving a trail of them on disk.
          scopeKey: scopeKey ?? null,
          voiceCallId: voiceCallId ?? null,
        }).catch(() => null);
        if (cancelled || !record) return;
        if (scopeKey) rememberSceneStill(scopeKey, { record });
        onStillRef.current?.(record);
      })
      .catch(() => {
        // A failed capture is not a failed scene. Allow another attempt if the
        // view comes back into a capturable state.
        stillTakenRef.current = false;
      });
    return () => { cancelled = true; };
  }, [settled, status, src, stillAttempt, scopeKey, voiceCallId, failed, parsed, sessionId]);

  // Freeze: capture the frame's rect, then swap the image in and drop the frame
  // so nothing keeps executing in scrollback.
  useEffect(() => {
    // `status === "running"` is the draw gate: at `loading` the frame was
    // handed its src on this very render and has painted nothing, so a capture
    // here snapshots a blank rect.
    if (live || status !== "running" || !src) return;
    // A settle-time still already exists, so the freeze no longer has to hold a
    // capture window open: swap straight to the picture. This is what makes a
    // scene that is half off screen stop executing in scrollback instead of
    // waiting out a deadline it can never meet.
    if (still) { setStatus("frozen"); return; }
    let cancelled = false;
    const capture = window.ade?.scene?.snapshot;
    const shell = shellRef.current;
    const rect = shell?.getBoundingClientRect();
    if (typeof capture !== "function" || !rect) {
      // No capture route (browser preview): leave the frame up rather than
      // replacing a working view with nothing.
      setStatus("frozen");
      return;
    }
    // A snapshot is a window grab cropped to this rect, and main INTERSECTS
    // that rect with the content box rather than shifting it — so a scene that
    // is half scrolled off, or only partly on screen, freezes to the visible
    // sliver. That crop is permanent, and it is also what the Proof button
    // files. A partial picture of a view is worse than no picture of it, so
    // this waits instead.
    if (!isSceneRectFullyVisible(rect)) {
      const now = Date.now();
      if (freezeDeadlineRef.current == null) freezeDeadlineRef.current = now + SCENE_FREEZE_DEADLINE_MS;
      if (now >= freezeDeadlineRef.current) {
        // Waited long enough — and some scenes can never come fully on screen
        // at all. Fall back to the no-capture-route behaviour: the live frame
        // stays up rather than being replaced by a cropped still of itself.
        setStatus("frozen");
        return;
      }
      // Re-check, never freeze blind. The transcript's own auto-scroll fires
      // constantly and usually leaves the scene no more visible than before, so
      // freezing on the next scroll whatever the rect says would leave a live
      // iframe mounted in scrollback. Nothing here changes state unless the
      // scene is genuinely visible or the deadline has passed.
      const retry = () => {
        if (cancelled) return;
        const current = shellRef.current?.getBoundingClientRect();
        const visible = current ? isSceneRectFullyVisible(current) : false;
        if (visible || Date.now() >= (freezeDeadlineRef.current ?? 0)) {
          setFreezeAttempt((attempt) => attempt + 1);
        }
      };
      // Scroll is captured because the scene sits inside the transcript's own
      // scroller, not the window's; the observer covers the cases scrolling
      // does not, such as a pane resize.
      window.addEventListener("scroll", retry, { capture: true, passive: true });
      let observer: IntersectionObserver | null = null;
      if (shell && typeof IntersectionObserver === "function") {
        // `isIntersecting` plus the rect re-check inside `retry`, not
        // `intersectionRatio >= 1`: a fractional layout reports 0.999… for a
        // rect that is entirely on screen, and that ratio never fires.
        observer = new IntersectionObserver(
          (entries) => { if (entries.some((entry) => entry.isIntersecting)) retry(); },
          { threshold: [0, 1] },
        );
        observer.observe(shell);
      }
      // And the deadline itself has to be able to fire on its own: a scene in a
      // window too short to ever hold it produces no scroll and no new
      // intersection, so nothing else would ever wake this up.
      const deadlineTimer = window.setTimeout(
        retry,
        Math.max(0, freezeDeadlineRef.current - now),
      );
      return () => {
        cancelled = true;
        window.clearTimeout(deadlineTimer);
        window.removeEventListener("scroll", retry, true);
        observer?.disconnect();
      };
    }
    void capture({
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height),
    })
      .then((url) => { if (!cancelled) { setSnapshot(url ?? null); setStatus("frozen"); } })
      .catch(() => { if (!cancelled) setStatus("frozen"); });
    return () => { cancelled = true; };
  }, [live, src, status, freezeAttempt, still]);

  // A rehydrated scene never mounts a frame, so nothing will ever promote it
  // out of `loading`; it is a picture from the first paint and says so.
  useEffect(() => {
    if (rehydrated) setStatus("frozen");
  }, [rehydrated]);

  const fileProof = useCallback(() => {
    const attach = window.ade?.scene?.attachProof;
    if (typeof attach !== "function") return;
    setProofState("saving");
    void attach({
      // The settle-time still is the same picture the user is looking at, and
      // on a scene that was never fully visible at the end of its turn it is
      // the ONLY one — filing proof from `snapshot` alone meant the Proof
      // button on a scrolled-past scene filed nothing.
      dataUrl: snapshot ?? still,
      title: (!failed && parsed.title) || "Generated view",
      sessionId: sessionId ?? null,
    })
      .then((ok) => setProofState(ok ? "saved" : "idle"))
      .catch(() => setProofState("idle"));
  }, [failed, parsed, snapshot, still, sessionId]);

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
   * The picture, in order of how close it is to what the user last saw: the
   * freeze capture, then this mount's settle still, then the still a previous
   * mount or a previous window left on disk.
   */
  const pictureSrc = snapshot ?? still ?? storedStillSrc;
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
