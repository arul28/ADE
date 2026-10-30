/**
 * Pacing while a recording runs: what a viewer can follow. Typed text appears
 * a few characters at a time and a drag moves in visible steps, instead of the
 * instant input that reads as a paste or a jump in a video. Not recording,
 * input stays as fast as before; callers pass a plan only while recording.
 */

/** One keystroke's worth of time while a recording runs. */
const TYPING_STEP_MS = 45;
/** Long text goes in larger pieces, so no typing runs longer than about this. */
const TYPING_MAX_STEPS = 60;

/**
 * Text a recording will show as typed: the pieces to insert one after another
 * (single characters, or a few at a time for long text) and how long that
 * takes. Instant typing reads as a paste in a video.
 */
export function demoTypingPlan(text: string): { pieces: string[]; stepMs: number; seconds: number } {
  const characters = Array.from(text);
  const size = Math.max(1, Math.ceil(characters.length / TYPING_MAX_STEPS));
  const pieces: string[] = [];
  for (let index = 0; index < characters.length; index += size) pieces.push(characters.slice(index, index + size).join(""));
  return { pieces, stepMs: TYPING_STEP_MS, seconds: (pieces.length * TYPING_STEP_MS) / 1000 };
}

/**
 * Longest text a per-key driver paces. A driver that grows a field's value
 * one character at a time makes a round trip per character, so long text
 * would outlast the driver's request timeout; it goes in as fast as when not
 * recording instead.
 */
const PACED_TYPING_MAX_CHARS = 200;

/**
 * The same pace for a surface whose driver types one character at a time
 * (Mac Desktop, Linux, Windows, the simulator): the pause between characters
 * while it records, and how long the text takes. Null for text too long to
 * pace. `minGapMs` is the shortest gap that driver ever leaves between keys
 * (a Windows timer tick, about 16 ms; the simulator 12 ms; Linux 2 ms), so
 * `seconds` is the time the typing really takes.
 */
export function demoTypingPace(text: string, minGapMs = 0): { paceMs: number; seconds: number } | null {
  const length = Math.max(1, Array.from(text).length);
  if (length > PACED_TYPING_MAX_CHARS) return null;
  const paceMs = Math.min(TYPING_STEP_MS, Math.floor((TYPING_STEP_MS * TYPING_MAX_STEPS) / length));
  return { paceMs, seconds: (length * Math.max(paceMs, minGapMs)) / 1000 };
}

/** Inserts `text` all at once, or with a plan (while recording) piece by piece with its pauses. */
export async function typeDemoText(
  text: string,
  plan: { pieces: string[]; stepMs: number } | null,
  insert: (piece: string) => Promise<unknown>,
): Promise<void> {
  if (!plan) {
    await insert(text);
    return;
  }
  for (const [index, piece] of plan.pieces.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, plan.stepMs));
    await insert(piece);
  }
}

/** A drag a viewer can follow: at least this many moves, this far apart. */
export const DEMO_DRAG_STEPS = 24;
export const DEMO_DRAG_STEP_MS = 25;
/** The pause after pressing, before moving: drag libraries wait for it too. */
export const DEMO_DRAG_PRESS_MS = 150;

/** How long a recorded drag of `steps` moves takes: the press pause, then a pause between moves. */
export function demoDragSeconds(steps: number): number {
  return (DEMO_DRAG_PRESS_MS + Math.max(0, steps - 1) * DEMO_DRAG_STEP_MS) / 1000;
}
