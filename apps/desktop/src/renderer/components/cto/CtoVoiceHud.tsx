import React, { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useDragControls, useReducedMotion } from "motion/react";
import { Microphone, MicrophoneSlash, Phone, Warning } from "@phosphor-icons/react";

import {
  formatVoiceCost,
  formatVoiceElapsed,
  isVoiceCallVisible,
  type CtoVoiceConfirmation,
  type CtoVoicePhase,
  type CtoVoiceState,
} from "../../../shared/types/ctoVoice";
import { COLORS } from "../lanes/laneDesignTokens";

/**
 * The call HUD: a pill that grows a canvas.
 *
 * It floats above the app rather than occupying a screen, because the whole
 * point of talking to the CTO is doing it while you are looking at something
 * else. It mounts at the shell level, so it survives tab and project switches.
 *
 * Everything here is driven by `CtoVoiceState` and nothing else — no fetching,
 * no session ownership. That keeps the visual states reproducible and lets the
 * main process stay the only thing that talks to the API.
 */

const PILL_HEIGHT = 44;
const CANVAS_WIDTH = 420;

const PHASE_LABEL: Record<CtoVoicePhase, string> = {
  idle: "Ready",
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Working",
  speaking: "Speaking",
  confirming: "Waiting on you",
  ended: "Call ended",
  failed: "Call failed",
};

/**
 * The level meter, and the interrupt.
 *
 * While the CTO speaks the bars move to its voice; when the user talks over it
 * the bars visibly break — a flat line and an accent flash — so a barge-in is
 * something you SEE landing, not something you hope landed.
 */
function LevelMeter({ level, phase, interrupted }: { level: number; phase: CtoVoicePhase; interrupted: boolean }) {
  const reduced = useReducedMotion();
  const bars = 5;
  const active = phase === "listening" || phase === "speaking";
  const tint = interrupted ? COLORS.accent : phase === "speaking" ? COLORS.textPrimary : COLORS.textSecondary;

  return (
    <div className="flex h-4 items-center gap-[3px]" aria-hidden data-testid="cto-voice-meter">
      {Array.from({ length: bars }).map((_, index) => {
        const centre = 1 - Math.abs(index - (bars - 1) / 2) / bars;
        const height = interrupted
          ? 2
          : active
            ? Math.max(3, Math.round(3 + level * 13 * centre))
            : 3;
        return (
          <motion.span
            key={index}
            className="block w-[2px] rounded-full"
            style={{ background: tint }}
            animate={{ height }}
            transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 26 }}
          />
        );
      })}
    </div>
  );
}

function ConfirmationStrip({
  confirmation,
  onApprove,
  onDeny,
}: {
  confirmation: CtoVoiceConfirmation;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <div
      data-testid="cto-voice-confirm"
      className="flex flex-col gap-2 rounded-xl px-3 py-2.5"
      style={{
        background: COLORS.cardBgSolid,
        border: `1px solid ${confirmation.destructive ? COLORS.danger : COLORS.accentBorder}`,
      }}
    >
      <div className="flex items-start gap-2">
        {confirmation.destructive ? (
          <Warning size={13} weight="fill" style={{ color: COLORS.danger, marginTop: 1 }} />
        ) : null}
        <span className="text-[12px] leading-snug" style={{ color: COLORS.textPrimary }}>
          {confirmation.prompt}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onApprove}
          data-testid="cto-voice-confirm-approve"
          className="rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors"
          style={{
            background: confirmation.destructive ? COLORS.danger : COLORS.accent,
            color: "#0b0910",
          }}
        >
          {confirmation.destructive ? "Yes, do it" : "Go ahead"}
        </button>
        <button
          type="button"
          onClick={onDeny}
          className="rounded-lg px-2.5 py-1 text-[11px] transition-colors"
          style={{ color: COLORS.textSecondary, border: `1px solid ${COLORS.border}` }}
        >
          Not now
        </button>
        <span className="ml-auto text-[10px]" style={{ color: COLORS.textDim }}>
          {confirmation.destructive ? "tap to confirm" : "or just say yes"}
        </span>
      </div>
    </div>
  );
}

export type CtoVoiceHudProps = {
  state: CtoVoiceState;
  /** Rendered above the pill while the call has drawn something. */
  canvas?: React.ReactNode;
  showCaptions?: boolean;
  onToggleMute: () => void;
  onEnd: () => void;
  onApproveConfirmation: (id: string) => void;
  onDenyConfirmation: (id: string) => void;
};

export function CtoVoiceHud({
  state,
  canvas,
  showCaptions = true,
  onToggleMute,
  onEnd,
  onApproveConfirmation,
  onDenyConfirmation,
}: CtoVoiceHudProps) {
  const reduced = useReducedMotion();
  const dragControls = useDragControls();
  const constraintsRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const latestCaption = useMemo(() => {
    for (let i = state.captions.length - 1; i >= 0; i -= 1) {
      if (state.captions[i].text.trim().length) return state.captions[i];
    }
    return null;
  }, [state.captions]);

  if (!isVoiceCallVisible(state.phase)) return null;

  const failed = state.phase === "failed";
  const expanded = Boolean(canvas) || Boolean(state.pendingConfirmation);
  // Hoisted so the JSX below narrows without a non-null assertion.
  const pending = state.pendingConfirmation;

  return (
    <div
      ref={constraintsRef}
      className="pointer-events-none fixed inset-0 z-[112]"
      data-testid="cto-voice-hud-layer"
    >
      <motion.div
        drag
        dragListener={false}
        dragControls={dragControls}
        dragConstraints={constraintsRef}
        dragMomentum={false}
        onDragStart={() => setDragging(true)}
        onDragEnd={() => setDragging(false)}
        initial={reduced ? false : { opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 360, damping: 30 }}
        className="pointer-events-auto absolute bottom-6 right-6 flex flex-col items-end gap-2"
        style={{ width: expanded ? CANVAS_WIDTH : "auto" }}
        data-testid="cto-voice-hud"
        data-phase={state.phase}
      >
        {/* Canvas — only present when the call has something to show. */}
        <AnimatePresence>
          {canvas ? (
            <motion.div
              key="canvas"
              initial={reduced ? false : { opacity: 0, height: 0, y: 8 }}
              animate={{ opacity: 1, height: "auto", y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0, y: 8 }}
              transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 300, damping: 32 }}
              className="w-full overflow-hidden rounded-2xl"
              style={{
                background: COLORS.cardBgSolid,
                border: `1px solid ${COLORS.border}`,
                boxShadow: "0 18px 48px rgba(0,0,0,0.44)",
              }}
              data-testid="cto-voice-canvas"
            >
              {canvas}
            </motion.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence>
          {pending ? (
            <motion.div
              key="confirm"
              initial={reduced ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
              className="w-full"
              style={{ boxShadow: "0 14px 36px rgba(0,0,0,0.40)" }}
            >
              <ConfirmationStrip
                confirmation={pending}
                onApprove={() => onApproveConfirmation(pending.id)}
                onDeny={() => onDenyConfirmation(pending.id)}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* Caption — one line, the most recent thing said. */}
        <AnimatePresence>
          {showCaptions && latestCaption && !failed ? (
            <motion.div
              key={`${latestCaption.role}-${latestCaption.atMs}`}
              initial={reduced ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="max-w-[420px] rounded-xl px-3 py-1.5 text-[11px] leading-snug"
              style={{
                background: "rgba(10,9,14,0.94)",
                border: `1px solid ${COLORS.borderMuted}`,
                color: latestCaption.role === "user" ? COLORS.textSecondary : COLORS.textPrimary,
              }}
              data-testid="cto-voice-caption"
            >
              {latestCaption.role === "user" ? (
                <span style={{ color: COLORS.textDim }}>you · </span>
              ) : null}
              {latestCaption.text}
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* The pill. */}
        <div
          onPointerDown={(event) => dragControls.start(event)}
          className="flex items-center gap-2.5 rounded-full py-1.5 pl-3 pr-1.5"
          style={{
            height: PILL_HEIGHT,
            // Solid rather than blurred: a backdrop-filter on this pill promotes
            // its buttons to their own compositing layer, which software
            // rasterisation then paints at the wrong origin — a ghost copy of the
            // controls appeared in the opposite corner. Opacity alone reads the
            // same over app chrome and cannot do that.
            background: "rgba(16,14,22,0.96)",
            border: `1px solid ${failed ? COLORS.danger : state.interrupted ? COLORS.accent : COLORS.border}`,
            boxShadow: dragging ? "0 20px 48px rgba(0,0,0,0.5)" : "0 12px 32px rgba(0,0,0,0.38)",
            cursor: dragging ? "grabbing" : "grab",
            transition: "border-color 140ms ease, box-shadow 140ms ease",
          }}
        >
          <LevelMeter level={state.inputLevel} phase={state.phase} interrupted={state.interrupted} />

          <div className="flex min-w-0 flex-col leading-none">
            <span className="text-[11px] font-medium" style={{ color: failed ? COLORS.danger : COLORS.textPrimary }}>
              {failed ? "Call failed" : PHASE_LABEL[state.phase]}
            </span>
            <span className="mt-0.5 text-[10px] tabular-nums" style={{ color: COLORS.textDim }}>
              {formatVoiceElapsed(state.elapsedMs)} · {formatVoiceCost(state.elapsedMs)}
            </span>
          </div>

          <div className="ml-1 flex items-center gap-1">
            <button
              type="button"
              onClick={onToggleMute}
              title={state.muted ? "Unmute" : "Mute"}
              aria-label={state.muted ? "Unmute" : "Mute"}
              data-testid="cto-voice-mute"
              className="grid size-8 place-items-center rounded-full transition-colors"
              style={{
                background: state.muted ? COLORS.accentSubtle : "transparent",
                color: state.muted ? COLORS.accent : COLORS.textSecondary,
              }}
            >
              {state.muted ? <MicrophoneSlash size={14} weight="fill" /> : <Microphone size={14} />}
            </button>
            <button
              type="button"
              onClick={onEnd}
              title="End call"
              aria-label="End call"
              data-testid="cto-voice-end"
              className="grid size-8 place-items-center rounded-full transition-transform hover:scale-105"
              style={{ background: COLORS.danger, color: "#0b0910" }}
            >
              <Phone size={14} weight="fill" style={{ transform: "rotate(135deg)" }} />
            </button>
          </div>
        </div>

        {failed && state.error ? (
          <span className="max-w-[360px] text-right text-[10px]" style={{ color: COLORS.textDim }}>
            {state.error}
          </span>
        ) : null}
      </motion.div>
    </div>
  );
}
