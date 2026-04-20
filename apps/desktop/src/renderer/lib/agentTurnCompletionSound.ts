/**
 * Short Web Audio notification tones for agent chat (no external assets).
 * Defers `AudioContext.close()` until after scheduled oscillators finish so playback is audible.
 */
import type { AgentTurnCompletionSound } from "../state/appStore";

/** Collapse rapid successive turn-completions into a single chime. */
const DEBOUNCE_MS = 1_500;
let lastPlayedAtMs = 0;

/** @internal — resets the module-level debounce timestamp (tests only). */
export function __resetAgentTurnCompletionSoundDebounce(): void {
  lastPlayedAtMs = 0;
}

export type PlayAgentTurnCompletionSoundOptions = {
  /** 0..1 gain multiplier. Values outside the range are clamped. */
  volume?: number;
  /** When true and the document currently has focus, the call is a no-op. */
  skipWhenFocused?: boolean;
};

function clampVolume(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

/** Schedule a short tone on `ctx` (caller must not close `ctx` until after stop + tail). */
function playChime(
  ctx: AudioContext,
  frequency: number,
  durationSec: number,
  type: OscillatorType,
  volume: number,
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const peak = 0.12 * volume;
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, ctx.currentTime);
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), ctx.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationSec);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + durationSec + 0.05);
}

/**
 * Play one completion tone. Call from a user gesture when possible; resumes a suspended context when needed.
 *
 * @param kind Which tone to play.
 * @param options Playback modulation — volume (0..1) and skip-when-focused gate.
 */
export function playAgentTurnCompletionSound(
  kind: Exclude<AgentTurnCompletionSound, "off">,
  options: PlayAgentTurnCompletionSoundOptions = {},
): void {
  if (options.skipWhenFocused && typeof document !== "undefined" && typeof document.hasFocus === "function" && document.hasFocus()) {
    return;
  }
  const volume = clampVolume(options.volume);
  if (volume === 0) return;

  const Ctor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;

  // Debounce after early-bail checks so no-op paths (muted, no AudioContext, focus-gated)
  // do not burn the window that a real chime would then get suppressed by.
  const now = Date.now();
  if (now - lastPlayedAtMs < DEBOUNCE_MS) return;
  lastPlayedAtMs = now;

  const ctx = new Ctor();
  const ctxNow = ctx.currentTime;

  const play = () => {
    try {
      if (kind === "chime") {
        playChime(ctx, 880, 0.22, "sine", volume);
        playChime(ctx, 1320, 0.18, "sine", volume);
      } else if (kind === "ping") {
        playChime(ctx, 1200, 0.12, "triangle", volume);
      } else {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const peak = 0.06 * volume;
        osc.type = "square";
        osc.frequency.setValueAtTime(520, ctxNow);
        osc.frequency.exponentialRampToValueAtTime(380, ctxNow + 0.08);
        gain.gain.setValueAtTime(0.0001, ctxNow);
        gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), ctxNow + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctxNow + 0.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctxNow);
        osc.stop(ctxNow + 0.25);
      }
    } catch {
      // ignore — rare graph failures
    }
    // Let oscillators finish before closing (immediate close can silence output).
    globalThis.setTimeout(() => {
      void ctx.close().catch(() => {});
    }, 450);
  };

  try {
    if (ctx.state === "suspended") {
      void ctx.resume().then(play).catch(() => {
        void ctx.close().catch(() => {});
      });
    } else {
      play();
    }
  } catch {
    void ctx.close().catch(() => {});
  }
}
