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
   * Stable key for the transcript row. It feeds the document identity below so
   * two byte-identical scenes at different positions get their own frame rather
   * than sharing one.
   */
  scopeKey?: string;
  onEmit?: (name: string, payload: unknown) => void;
};

type Status = "loading" | "running" | "frozen" | "failed";

export function SceneFrame({ source, live = false, scopeKey, onEmit }: SceneFrameProps) {
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

  const theme = useMemo(readSceneTheme, []);
  const doc = useMemo(() => {
    if (failed) return null;
    return buildSceneDocument({ html: parsed.html, title: parsed.title, theme, scopeKey });
  }, [failed, parsed, theme, scopeKey]);

  const [src, setSrc] = useState<string | null>(null);

  // Prefer the real scheme; blob is the preview path. Both give the frame an
  // origin of its own, which is the property that matters.
  useEffect(() => {
    if (!doc) return;
    let revoked: string | null = null;
    let cancelled = false;
    const prepare = window.ade?.scene?.prepare;
    if (typeof prepare === "function") {
      void prepare(doc)
        .then((url) => { if (!cancelled) setSrc(url); })
        .catch(() => {
          if (cancelled) return;
          const blob = new Blob([doc], { type: "text/html" });
          revoked = URL.createObjectURL(blob);
          setSrc(revoked);
        });
    } else {
      const blob = new Blob([doc], { type: "text/html" });
      revoked = URL.createObjectURL(blob);
      setSrc(revoked);
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
    if (status !== "loading") return;
    const timer = window.setTimeout(() => setStatus("running"), SCENE_LIMITS.readyTimeoutMs);
    return () => window.clearTimeout(timer);
  }, [status]);

  // Freeze: capture the frame's rect, then swap the image in and drop the frame
  // so nothing keeps executing in scrollback.
  useEffect(() => {
    // `status === "running"` is the draw gate: at `loading` the frame was
    // handed its src on this very render and has painted nothing, so a capture
    // here snapshots a blank rect.
    if (live || status !== "running" || !src) return;
    let cancelled = false;
    const capture = window.ade?.scene?.snapshot;
    const rect = shellRef.current?.getBoundingClientRect();
    if (typeof capture !== "function" || !rect) {
      // No capture route (browser preview): leave the frame up rather than
      // replacing a working view with nothing.
      setStatus("frozen");
      return;
    }
    void capture({
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height),
    })
      .then((url) => { if (!cancelled) { setSnapshot(url ?? null); setStatus("frozen"); } })
      .catch(() => { if (!cancelled) setStatus("frozen"); });
    return () => { cancelled = true; };
  }, [live, src, status]);

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
