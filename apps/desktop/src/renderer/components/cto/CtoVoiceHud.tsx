import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useDragControls, useReducedMotion } from "motion/react";
import { Microphone, MicrophoneSlash, Phone, Warning } from "@phosphor-icons/react";

import {
  formatVoiceCost,
  formatVoiceElapsed,
  isVoiceCallLive,
  isVoiceCallVisible,
  type CtoVoiceConfirmation,
  type CtoVoicePhase,
  type CtoVoiceState,
  type LiveVoicePhase,
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

/**
 * What makes a pill look like a pill, in one place so the failed one cannot
 * drift from the live one.
 *
 * Solid rather than blurred: a backdrop-filter here promotes the buttons to
 * their own compositing layer, which software rasterisation then paints at the
 * wrong origin — a ghost copy of the controls appeared in the opposite corner.
 * Opacity alone reads the same over app chrome and cannot do that.
 */
function pillChrome(borderColor: string): React.CSSProperties {
  return {
    background: "rgba(16,14,22,0.96)",
    border: `1px solid ${borderColor}`,
    boxShadow: "0 12px 32px rgba(0,0,0,0.38)",
  };
}

/**
 * One label per phase a running call can be in.
 *
 * Keyed by the shared `LiveVoicePhase`, so a phase added to the call cannot be
 * added without a word for it here. `failed` is not in this map: it is not a
 * running call and it has its own pill.
 */
const PHASE_LABEL: Record<LiveVoicePhase, string> = {
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Working",
  speaking: "Speaking",
  confirming: "Waiting on you",
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

/**
 * One caption bubble, in two tones.
 *
 * `final` is something that was said; `pending` is what the transcriber is
 * still revising, dimmer and italic so it does not read as a fact. They were
 * two copies of the same bubble, which is how the finished line and the live
 * one drifted apart by a padding value.
 */
function CaptionBubble({
  tone,
  testId,
  colour,
  children,
}: {
  tone: "final" | "pending";
  testId: string;
  colour: string;
  children: React.ReactNode;
}) {
  const pending = tone === "pending";
  return (
    <div
      className={`max-w-[420px] rounded-xl px-3 py-1.5 text-[11px] leading-snug${pending ? " italic" : ""}`}
      style={{
        background: pending ? "rgba(10,9,14,0.78)" : "rgba(10,9,14,0.94)",
        border: `1px solid ${COLORS.borderMuted}`,
        color: colour,
      }}
      data-testid={testId}
    >
      {children}
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
  // A strip that can authorise a destructive action must be ANNOUNCED, and it
  // must be where the keyboard already is: it appears with no click behind it,
  // so a user who is not looking at the corner of the screen would otherwise
  // have to go hunting for the thing that is waiting on them.
  //
  // The STRIP takes the focus, never the approve button. This arrives
  // unannounced under whatever the user was already doing, and a stray Enter or
  // Space on a focused "Yes, do it" would authorise a force-push nobody read.
  // `role="alert"` announces it either way, and from the strip one Tab reaches
  // each answer.
  const stripRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { stripRef.current?.focus(); }, [confirmation.id]);
  return (
    <div
      data-testid="cto-voice-confirm"
      role="alert"
      ref={stripRef}
      tabIndex={-1}
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

/**
 * The pill a call leaves behind when it never started.
 *
 * Its own component because it shares nothing with a running call but the
 * shape: no meter, no timer, no mute, no captions, nothing to drag a canvas
 * around. Gating one pill on `failed` in five places made the live path read
 * as though every one of those things had a failed variant.
 *
 * It says only that the call failed. The reason is a sentence, and a sentence
 * belongs on the CTO page under the header, where there is a line's width for
 * it — not trailing off the bottom of a pill onto the composer.
 */
function FailedPill({ onDismiss }: { onDismiss: () => void }) {
  const reduced = useReducedMotion();
  return (
    <div className="pointer-events-none fixed inset-0 z-[112]" data-testid="cto-voice-hud-layer">
      <motion.div
        initial={reduced ? false : { opacity: 0, y: 14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 360, damping: 30 }}
        className="pointer-events-auto absolute bottom-6 right-6 flex items-center gap-2.5 rounded-full py-1.5 pl-3 pr-1.5"
        style={{ height: PILL_HEIGHT, ...pillChrome(COLORS.danger) }}
        data-testid="cto-voice-hud"
        data-phase="failed"
      >
        <Warning size={15} weight="fill" style={{ color: COLORS.danger }} />
        <span className="text-[11px] font-medium" style={{ color: COLORS.danger }}>
          Call failed
        </span>
        <button
          type="button"
          onClick={onDismiss}
          title="Dismiss"
          aria-label="Dismiss"
          data-testid="cto-voice-end"
          className="grid size-8 place-items-center rounded-full transition-transform hover:scale-105"
          style={{ background: COLORS.danger, color: "#0b0910" }}
        >
          <Phone size={14} weight="fill" style={{ transform: "rotate(135deg)" }} />
        </button>
      </motion.div>
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
  // Visible but not live can only be `failed`, and that is a different pill.
  if (!isVoiceCallLive(state.phase)) return <FailedPill onDismiss={onEnd} />;

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

        {/* The spoken half of the call, announced.
            Everything a screen reader would otherwise miss is in here: the
            captions are the only record of what was said, and the phase label
            below is the only word for what the call is doing. `polite`, not
            `assertive` — a caption must not interrupt the user's own reader
            mid-sentence. The wrapper is always mounted, because a live region
            that appears with its content already in it announces nothing — and
            never `display: none`, which takes it back out of the accessibility
            tree and costs the same announcement. An empty one is a row of
            nothing instead. */}
        <div
          aria-live="polite"
          aria-atomic="false"
          className="flex min-h-px w-full flex-col items-end gap-2"
          data-testid="cto-voice-captions"
        >
          {/* Caption — one line, the most recent thing said. */}
          <AnimatePresence>
            {showCaptions && latestCaption ? (
              <motion.div
                key={`${latestCaption.role}-${latestCaption.atMs}`}
                initial={reduced ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                <CaptionBubble
                  tone="final"
                  testId="cto-voice-caption"
                  colour={latestCaption.role === "user" ? COLORS.textSecondary : COLORS.textPrimary}
                >
                  {latestCaption.role === "user" ? (
                    <span style={{ color: COLORS.textDim }}>you · </span>
                  ) : null}
                  {latestCaption.text}
                  {/* A response the user talked over stops mid-sentence, and the
                      transcript is whatever had been said by then. The ellipsis is
                      the difference between "that is all it said" and "that is
                      where you cut it off". */}
                  {latestCaption.interrupted ? (
                    <span style={{ color: COLORS.textDim }} data-testid="cto-voice-caption-cut">…</span>
                  ) : null}
                </CaptionBubble>
              </motion.div>
            ) : null}
          </AnimatePresence>

          {/* What the user is saying right now, as the transcriber hears it.
              It sits under the captions so the finished line and the one being
              spoken never swap places. Without it the HUD stayed blank for the
              seconds a final transcript takes, and the user repeated themselves
              into a call that had heard them. */}
          <AnimatePresence>
            {showCaptions && state.pendingUserText ? (
              <motion.div
                key="pending-user-text"
                initial={reduced ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                <CaptionBubble tone="pending" testId="cto-voice-pending-caption" colour={COLORS.textDim}>
                  <span>you · </span>
                  {state.pendingUserText}
                </CaptionBubble>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        {/* The pill, and nothing below it. A sentence hung off the bottom of
            this stack sits outside every border the HUD draws and lands on the
            composer's icon row; the reason for a failed call is the page's to
            tell, under the CTO header, where there is a line's worth of room
            for it. */}
        <div
          onPointerDown={(event) => dragControls.start(event)}
          className="flex items-center gap-2.5 rounded-full py-1.5 pl-3 pr-1.5"
          style={{
            height: PILL_HEIGHT,
            ...pillChrome(state.interrupted ? COLORS.accent : COLORS.border),
            ...(dragging ? { boxShadow: "0 20px 48px rgba(0,0,0,0.5)" } : null),
            cursor: dragging ? "grabbing" : "grab",
            transition: "border-color 140ms ease, box-shadow 140ms ease",
          }}
        >
          <LevelMeter level={state.inputLevel} phase={state.phase} interrupted={state.interrupted} />

          <div className="flex min-w-0 max-w-[180px] flex-col leading-none">
            {/* The only word for what the call is doing, and the meter beside
                it is `aria-hidden` — so this is the one that has to speak. */}
            <span
              className="truncate text-[11px] font-medium"
              aria-live="polite"
              data-testid="cto-voice-phase-label"
              style={{ color: COLORS.textPrimary }}
            >
              {PHASE_LABEL[state.phase]}
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
      </motion.div>
    </div>
  );
}
