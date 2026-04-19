import type { AgentTurnCompletionSound } from "../state/appStore";

function playChime(ctx: AudioContext, frequency: number, durationSec: number, type: OscillatorType) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, ctx.currentTime);
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationSec);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + durationSec + 0.05);
}

/**
 * Short synthesized notification (no asset files). Safe to call from UI after user gesture for preview.
 */
export function playAgentTurnCompletionSound(kind: Exclude<AgentTurnCompletionSound, "off">): void {
  const Ctor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  const ctx = new Ctor();
  const now = ctx.currentTime;

  const play = () => {
    try {
      if (kind === "chime") {
        playChime(ctx, 880, 0.22, "sine");
        playChime(ctx, 1320, 0.18, "sine");
      } else if (kind === "ping") {
        playChime(ctx, 1200, 0.12, "triangle");
      } else {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.setValueAtTime(520, now);
        osc.frequency.exponentialRampToValueAtTime(380, now + 0.08);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.06, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.25);
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
