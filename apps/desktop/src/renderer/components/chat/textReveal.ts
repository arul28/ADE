/**
 * Paced text reveal — pure state machine (no rAF, no DOM, no React).
 *
 * Streamed assistant text arrives in lumps: the runtime flushes 5-7 times a
 * second, and in subagent-heavy turns the gaps stretch past half a second. The
 * store must keep the full text the instant it arrives (copy buttons, exports
 * and every derivation read it), so the *store* is never delayed — only the
 * painted slice is. This module owns that slice: given the full text and a
 * clock, it decides how many characters are visible, draining whatever backlog
 * exists over a fixed horizon so paint advances every frame while streaming.
 *
 * The algorithm is Paseo's (getpaseo/paseo#3612): per commit,
 *
 *   step = min(backlog, max(1, ceil(backlog * elapsedMs / horizonMs)))
 *
 * which is exponential decay toward zero backlog with a one-character floor.
 * A burst catches up within roughly `horizonMs`; a trickle still advances one
 * character per commit so the text never looks frozen.
 *
 * Boundaries are grapheme-safe: a cut is never placed inside an emoji ZWJ
 * sequence, a surrogate pair, or a flag. Without `Intl.Segmenter` we cannot
 * guarantee that, so pacing disables itself entirely and the caller paints on
 * arrival exactly as before.
 */

/** Default reveal horizon. `<= 0` disables pacing (paint on arrival). */
export const DEFAULT_TEXT_REVEAL_HORIZON_MS = 150;

/**
 * Upper bound on the elapsed time fed into one commit. Without it, a tab that
 * was backgrounded for a minute would compute `elapsed/horizon` in the
 * hundreds and dump everything in a single frame *and* a stalled runtime would
 * make the first frame after the stall paint the entire backlog — the exact
 * lump we are removing.
 */
export const TEXT_REVEAL_MAX_ELAPSED_MS = 250;

/**
 * Commits are capped at 60 Hz. On a 240 Hz display rAF fires every ~4 ms; one
 * character per frame there is both invisible and four times the React work
 * for the same perceived speed. Frames below this interval accumulate their
 * elapsed time (see `carryMs`) instead of committing.
 *
 * The half-millisecond tolerance matters: at exactly 16.667 ms per frame,
 * floating-point drift in the timestamps would otherwise make a true 60 Hz
 * display skip every other commit.
 */
export const TEXT_REVEAL_MIN_COMMIT_INTERVAL_MS = 1000 / 60 - 0.5;

/** `localStorage` override, parsed once per session. */
export const TEXT_REVEAL_HORIZON_STORAGE_KEY = "ade.textRevealHorizonMs";

/* ────────────────────────────── configuration ────────────────────────────── */

let cachedHorizonMs: number | null = null;

/**
 * The reveal horizon for this session, in ms.
 *
 * Read once and memoized: this is on the per-frame path, and `localStorage`
 * access is a synchronous main-thread hop. Set `ade.textRevealHorizonMs` in
 * devtools and reload to A/B without rebuilding; `0` (or any non-positive
 * value) restores the pre-pacing paint-on-arrival behavior exactly.
 */
export function readTextRevealHorizonMs(): number {
  if (cachedHorizonMs !== null) return cachedHorizonMs;
  let resolved = DEFAULT_TEXT_REVEAL_HORIZON_MS;
  try {
    const raw = typeof localStorage === "undefined"
      ? null
      : localStorage.getItem(TEXT_REVEAL_HORIZON_STORAGE_KEY);
    if (raw !== null && raw.trim().length > 0) {
      const parsed = Number(raw);
      // A malformed value must not silently disable the feature — ignore it.
      if (Number.isFinite(parsed)) resolved = parsed;
    }
  } catch {
    // Private-mode / disabled storage: keep the default.
  }
  cachedHorizonMs = resolved;
  return resolved;
}

/** Test-only: drop the memoized horizon so a new `localStorage` value is read. */
export function resetTextRevealHorizonCacheForTests(): void {
  cachedHorizonMs = null;
  cachedSegmenter = undefined;
}

let cachedSegmenter: Intl.Segmenter | null | undefined;

function graphemeSegmenter(): Intl.Segmenter | null {
  if (cachedSegmenter !== undefined) return cachedSegmenter;
  try {
    cachedSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
  } catch {
    cachedSegmenter = null;
  }
  return cachedSegmenter;
}

/**
 * Whether pacing may run at all. False means "paint on arrival": the caller
 * must not allocate state, schedule a frame, or split the markdown.
 */
export function isTextRevealEnabled(horizonMs: number = readTextRevealHorizonMs()): boolean {
  return horizonMs > 0 && graphemeSegmenter() !== null;
}

/* ─────────────────────────── grapheme-safe cutting ─────────────────────────── */

const ZERO_WIDTH_JOINER = 0x200d;
const REGIONAL_INDICATOR_START = 0x1f1e6;
const REGIONAL_INDICATOR_END = 0x1f1ff;

/**
 * How far past the proposed cut the segmenter is allowed to look. A grapheme
 * cluster (family emoji with skin tones, long ZWJ chain) is bounded well below
 * this; segmenting more would put the cost of the whole message back on the
 * frame.
 */
const GRAPHEME_LOOKAHEAD = 64;

/** How far back the segmenter window may start when no known boundary is near. */
const GRAPHEME_LOOKBEHIND = 512;

/**
 * Largest grapheme-cluster boundary `<= to`, never below `from`.
 *
 * `from` must itself be a boundary (the previously revealed length always is),
 * which lets us segment a short window instead of the whole message.
 */
export function clampToGraphemeBoundary(text: string, from: number, to: number): number {
  const end = Math.min(to, text.length);
  if (end <= from) return Math.max(0, Math.min(from, text.length));
  if (end >= text.length && !endsMidCluster(text)) return text.length;
  const segmenter = graphemeSegmenter();
  if (!segmenter) return end;

  const windowStart = end - from > GRAPHEME_LOOKBEHIND ? Math.max(0, end - GRAPHEME_LOOKBEHIND) : from;
  const windowEnd = Math.min(text.length, end + GRAPHEME_LOOKAHEAD);
  const window = text.slice(windowStart, windowEnd);
  let boundary = windowStart;
  for (const segment of segmenter.segment(window)) {
    const absolute = windowStart + segment.index;
    if (absolute > end) break;
    boundary = absolute;
    if (absolute + segment.segment.length <= end) boundary = absolute + segment.segment.length;
  }
  return Math.max(Math.min(boundary, end), Math.min(from, end));
}

/** True when the very end of `text` cannot be a stable cluster boundary yet. */
function endsMidCluster(text: string): boolean {
  if (text.length === 0) return false;
  const lastUnit = text.charCodeAt(text.length - 1);
  // Dangling high surrogate: the low half has not arrived.
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) return true;
  if (lastUnit === ZERO_WIDTH_JOINER) return true;
  // Odd number of trailing regional indicators = half a flag.
  let regionals = 0;
  let index = text.length;
  while (index > 0) {
    const codePoint = text.codePointAt(index - 2) ?? -1;
    if (codePoint < REGIONAL_INDICATOR_START || codePoint > REGIONAL_INDICATOR_END) break;
    regionals += 1;
    index -= 2;
  }
  return regionals % 2 === 1;
}

/**
 * Trim a cut that lands on an incomplete trailing cluster. Only meaningful
 * while streaming: once the text is final, half a surrogate pair is all there
 * will ever be and hiding it forever would lose a character.
 */
export function trimIncompleteTail(text: string, end: number): number {
  if (end < text.length || end === 0) return end;
  if (!endsMidCluster(text)) return end;
  return clampToGraphemeBoundary(text, 0, end - 1);
}

/* ───────────────────────────── the state machine ───────────────────────────── */

export type RevealState = {
  /** Full text as the store has it. Never mutated or delayed. */
  readonly target: string;
  /** Number of code units currently painted. Always a grapheme boundary. */
  readonly revealed: number;
  /** Timestamp of the last frame observed, or null before the first. */
  readonly lastFrameMs: number | null;
  /** Elapsed time seen since the last *commit* but not yet spent (60 Hz cap). */
  readonly carryMs: number;
};

/**
 * Start revealing. `instant` (the default) paints everything immediately —
 * a row that first appears already complete must never type itself out.
 */
export function beginReveal(target: string, options?: { instant?: boolean }): RevealState {
  const instant = options?.instant ?? true;
  return {
    target,
    revealed: instant ? target.length : 0,
    lastFrameMs: null,
    carryMs: 0,
  };
}

/**
 * Point the machine at new store text.
 *
 * Growth keeps the revealed length (the backlog widens and gets drained).
 * Anything else — a shrink, a rewrite, a different message in the same row —
 * snaps to the new text: showing a paced prefix of text the user never saw
 * grow would be a glitch, not a reveal.
 */
export function retargetReveal(state: RevealState, target: string): RevealState {
  if (target === state.target) return state;
  const grew = target.length >= state.target.length
    && state.revealed <= target.length
    && target.startsWith(state.target);
  if (!grew) {
    return { target, revealed: target.length, lastFrameMs: null, carryMs: 0 };
  }
  // A delta that lands on a caught-up row restarts the clock. The loop stops
  // whenever the backlog empties, so `lastFrameMs` would otherwise be as old
  // as the gap between runtime flushes (often several hundred ms) and the
  // first frame back would spend it all at once — exactly the lump pacing
  // exists to remove.
  const restart = state.revealed >= state.target.length;
  return restart ? { ...state, target, lastFrameMs: null, carryMs: 0 } : { ...state, target };
}

/** Reveal everything now (turn ended, row left the tail, surface went hidden). */
export function completeReveal(state: RevealState): RevealState {
  if (state.revealed === state.target.length) return state;
  return { ...state, revealed: state.target.length, carryMs: 0 };
}

/**
 * Advance one animation frame.
 *
 * The returned state is a fresh object on almost every frame — the clock and
 * the carried remainder move even when no character was committed — so callers
 * must decide whether to re-render by comparing FIELDS (`revealed`), never
 * references. Reference equality is returned only in the one case where nothing
 * at all changed (already caught up on the same timestamp).
 */
export function stepReveal(
  state: RevealState,
  nowMs: number,
  horizonMs: number = readTextRevealHorizonMs(),
): RevealState {
  const backlog = state.target.length - state.revealed;
  if (backlog <= 0) {
    return state.lastFrameMs === nowMs ? state : { ...state, lastFrameMs: nowMs, carryMs: 0 };
  }
  if (horizonMs <= 0) return completeReveal(state);

  const sinceLastFrame = state.lastFrameMs === null ? 0 : Math.max(0, nowMs - state.lastFrameMs);
  const pending = state.carryMs + sinceLastFrame;
  // The very first frame after a retarget has no elapsed time to spend; hold
  // the clock and commit on the next one rather than committing on `0`.
  if (state.lastFrameMs === null) {
    return { ...state, lastFrameMs: nowMs, carryMs: 0 };
  }
  if (pending < TEXT_REVEAL_MIN_COMMIT_INTERVAL_MS) {
    return { ...state, lastFrameMs: nowMs, carryMs: pending };
  }

  const elapsed = Math.min(pending, TEXT_REVEAL_MAX_ELAPSED_MS);
  const step = Math.min(backlog, Math.max(1, Math.ceil((backlog * elapsed) / horizonMs)));
  const proposed = state.revealed + step;
  const clamped = trimIncompleteTail(
    state.target,
    clampToGraphemeBoundary(state.target, state.revealed, proposed),
  );
  const revealed = Math.max(state.revealed, clamped);
  return {
    target: state.target,
    revealed,
    lastFrameMs: nowMs,
    // Time beyond the clamp is dropped, not banked: banking a 3-second stall
    // would make the next commit paint everything at once.
    carryMs: 0,
  };
}

/** The painted slice. */
export function revealedText(state: RevealState): string {
  return state.revealed >= state.target.length ? state.target : state.target.slice(0, state.revealed);
}

/* ────────────────────────── settled / growing-tail split ────────────────────────── */

/**
 * Incremental markdown block scanner.
 *
 * Re-parsing the whole message through `ReactMarkdown` at 60 Hz is
 * unaffordable on a long answer, so the revealed prefix is cut at the last
 * top-level block boundary: everything before it is *settled* (byte-identical
 * between frames, so the memoized markdown body bails out) and only the short
 * growing tail re-parses.
 *
 * The cut is only ever placed on a blank line at fence depth zero. Splitting
 * inside a fenced code block would leave the settled half with an unterminated
 * fence, which swallows the rest of the message into a code block — a visible
 * corruption, not a slow frame.
 */
export type SplitScanState = {
  /** Text this scan state describes; the caller validates growth. */
  readonly scannedTo: number;
  /** Open fence marker (``` / ~~~ run) or null at depth zero. */
  readonly fence: string | null;
  /** Index just past the last blank line at fence depth zero. */
  readonly settledEnd: number;
};

const EMPTY_SCAN: SplitScanState = { scannedTo: 0, fence: null, settledEnd: 0 };

function fenceRunAt(line: string): string | null {
  let index = 0;
  while (index < line.length && line[index] === " " && index < 3) index += 1;
  const char = line[index];
  if (char !== "`" && char !== "~") return null;
  let end = index;
  while (end < line.length && line[end] === char) end += 1;
  if (end - index < 3) return null;
  return line.slice(index, end);
}

function closesFence(line: string, fence: string): boolean {
  const run = fenceRunAt(line);
  if (run === null) return false;
  if (run[0] !== fence[0] || run.length < fence.length) return false;
  // A closing fence carries no info string.
  return line.trimEnd().endsWith(run);
}

/**
 * Scan `text.slice(0, end)` for the last safe split point, resuming from a
 * previous scan of the same (growing) text.
 *
 * Only whole lines are consumed, so a partially arrived last line is rescanned
 * on the next call and never mistaken for a fence delimiter.
 */
export function advanceSplitScan(
  previous: SplitScanState | null,
  text: string,
  end: number = text.length,
): SplitScanState {
  const limit = Math.min(end, text.length);
  const base = previous && previous.scannedTo <= limit ? previous : EMPTY_SCAN;
  let cursor = base.scannedTo;
  let fence = base.fence;
  let settledEnd = base.settledEnd;

  while (cursor < limit) {
    const newlineIndex = text.indexOf("\n", cursor);
    if (newlineIndex === -1 || newlineIndex >= limit) break;
    const line = text.slice(cursor, newlineIndex);
    if (fence === null) {
      const opening = fenceRunAt(line);
      if (opening !== null) {
        fence = opening;
      } else if (line.trim().length === 0) {
        settledEnd = newlineIndex + 1;
      }
    } else if (closesFence(line, fence)) {
      fence = null;
    }
    cursor = newlineIndex + 1;
  }

  return { scannedTo: cursor, fence, settledEnd };
}

/**
 * Split the revealed prefix into the settled markdown and the growing tail.
 * `settled` always ends on a blank line at fence depth zero, so parsing the
 * two halves separately produces the same blocks as parsing the whole.
 */
export function splitRevealed(
  text: string,
  end: number,
  scan: SplitScanState,
): { settled: string; tail: string } {
  const limit = Math.min(end, text.length);
  const cut = Math.min(scan.settledEnd, limit);
  return { settled: text.slice(0, cut), tail: text.slice(cut, limit) };
}
