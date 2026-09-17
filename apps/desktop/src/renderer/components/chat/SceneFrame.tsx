import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sparkle, Camera, WarningCircle } from "@phosphor-icons/react";

import {
  buildSceneDocument,
  isSceneParseFailure,
  parseSceneFence,
  parseSceneHostMessage,
  SCENE_FALLBACK_THEME,
  SCENE_LIMITS,
  type SceneTheme,
} from "../../../shared/chatScene";
import { COLORS } from "../lanes/laneDesignTokens";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { HighlightedCode } from "./CodeHighlighter";

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

export function SceneFrame({ source, live = false, streaming = false, scopeKey, onEmit }: SceneFrameProps) {
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

  const theme = useMemo(readSceneTheme, []);
  // A fence that is still arriving draws nothing: one placeholder now beats a
  // frame that reloads on every tick.
  const doc = useMemo(() => {
    if (failed || streaming) return null;
    return buildSceneDocument({ html: parsed.html, title: parsed.title, theme, scopeKey });
  }, [failed, streaming, parsed, theme, scopeKey]);

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
  useEffect(() => { freezeDeadlineRef.current = null; }, [src]);

  // Freeze: capture the frame's rect, then swap the image in and drop the frame
  // so nothing keeps executing in scrollback.
  useEffect(() => {
    // `status === "running"` is the draw gate: at `loading` the frame was
    // handed its src on this very render and has painted nothing, so a capture
    // here snapshots a blank rect.
    if (live || status !== "running" || !src) return;
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
      // Re-check, never freeze blind. The earlier version armed a one-shot
      // listener and then froze on the NEXT scroll whatever the rect said, so
      // the transcript's own auto-scroll — which fires constantly and usually
      // leaves the scene no more visible than before — left a live iframe
      // mounted in scrollback. Nothing here changes state unless the scene is
      // genuinely visible or the deadline has passed.
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
  }, [live, src, status, freezeAttempt]);

  const fileProof = useCallback(() => {
    const attach = window.ade?.scene?.attachProof;
    if (typeof attach !== "function") return;
    setProofState("saving");
    void attach({
      dataUrl: snapshot,
      title: (!failed && parsed.title) || "Generated view",
      sessionId: sessionId ?? null,
    })
      .then((ok) => setProofState(ok ? "saved" : "idle"))
      .catch(() => setProofState("idle"));
  }, [failed, parsed, snapshot, sessionId]);

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
  const showFrame = status !== "frozen" || !snapshot;

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
          ) : snapshot ? (
            <img
              src={snapshot}
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
