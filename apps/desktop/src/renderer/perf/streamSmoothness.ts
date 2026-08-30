import { useEffect } from "react";
import { isPerfActive } from "./markers";

/**
 * Streaming-text paint smoothness sampler.
 *
 * Two questions, measured on a real Work thread while a turn streams:
 *   (a) what fraction of animation frames actually advanced the assistant text,
 *   (b) how big are the gaps between the frames that did advance.
 *
 * Measurement notes / limitations (read before trusting the numbers):
 *
 * - We read `data-stream-text-len`, which is written from the store text during
 *   React's render. Sampling it therefore observes the *commit*, not the paint.
 *   The rAF callback runs after commit and before the frame is painted, so a
 *   change observed in frame N is painted at the end of frame N — an
 *   approximation that is off by at most one frame, and only when the browser
 *   drops the frame it was about to paint. This is deliberate: the alternative
 *   (`textContent.length`) walks and concatenates the whole markdown subtree of
 *   every assistant row on every frame, which is O(total transcript text) of
 *   allocation at 60 Hz and would perturb the very thing we are measuring.
 *   Reading a numeric attribute is O(1) per node with no string building.
 *
 * - We sum across ALL streaming assistant nodes, never just the last one: an
 *   assistant message handover starts a fresh node whose length restarts at
 *   ~0, and a last-node-only reading would score that as a huge regression.
 *
 * - The sum can still legitimately shrink (virtualization unmounts rows,
 *   navigation away, transcript collapse). A decrease is treated as a new
 *   baseline and counted as "did not advance" rather than as negative chars.
 */

export const STREAM_TEXT_LEN_ATTRIBUTE = "data-stream-text-len";

const STREAM_TEXT_LEN_SELECTOR = `[${STREAM_TEXT_LEN_ATTRIBUTE}]`;

/** Window length for aggregated emission. One event per window, never per frame. */
export const STREAM_SMOOTHNESS_WINDOW_MS = 1000;

export type StreamSmoothnessWindow = {
  /** rAF frames observed in this window. */
  framesTotal: number;
  /** Frames in which the summed assistant text length grew. */
  framesAdvanced: number;
  /**
   * framesAdvanced / framesTotal, 0..1.
   *
   * NOT comparable across machines: `framesTotal` is set by the display's
   * refresh rate, so the same stream scores ~0.25 on a 240 Hz panel and ~1.0 on
   * a 60 Hz one while painting identically. Use `frameIntervalP50` to recover
   * the refresh rate, or the aggregator's `advancedPerSecond` /
   * `advancedRatio60`, when comparing runs from different displays.
   */
  advancedRatio: number;
  /** Gap (ms) between consecutive advancing frames — p50 / p95 / max. */
  gapP50: number;
  gapP95: number;
  gapMax: number;
  /**
   * Median interval (ms) between consecutive rAF callbacks in this window.
   * 1000 / this ≈ the display refresh rate (≈16.7 at 60 Hz, ≈4.2 at 240 Hz),
   * which is what makes `advancedRatio` interpretable across machines.
   */
  frameIntervalP50: number;
  /** Wall-clock length (ms) of this window — the denominator for per-second rates. */
  durationMs: number;
  /** Characters gained across the window. */
  charsAdvanced: number;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Same convention as the main-process aggregator: floor((n - 1) * p). */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx]!;
}

/**
 * Pure frame accumulator — no rAF, no DOM, no IPC. The sampler feeds it
 * `(frameTs, totalChars)` pairs; tests feed it synthetic ones.
 */
export class StreamSmoothnessAccumulator {
  private windowStartTs: number | null = null;
  private lastTotalChars: number | null = null;
  /**
   * Timestamp of the previous advancing frame. Deliberately NOT reset per
   * window: a gap that spans a window boundary is counted exactly once, in the
   * window where it ends (i.e. where the advancing frame landed).
   */
  private lastAdvanceTs: number | null = null;
  /**
   * Timestamp of the previous frame of ANY kind. Like `lastAdvanceTs` it
   * survives the window reset, so the interval straddling a boundary is
   * attributed to the window the later frame landed in.
   */
  private lastFrameTs: number | null = null;
  private framesTotal = 0;
  private framesAdvanced = 0;
  private charsAdvanced = 0;
  private gaps: number[] = [];
  private frameIntervals: number[] = [];

  constructor(private readonly windowMs: number = STREAM_SMOOTHNESS_WINDOW_MS) {}

  /**
   * Record one frame. Returns a completed window when this frame closed one,
   * otherwise null.
   */
  addFrame(ts: number, totalChars: number): StreamSmoothnessWindow | null {
    if (this.windowStartTs === null) this.windowStartTs = ts;
    this.framesTotal += 1;
    if (this.lastFrameTs !== null) this.frameIntervals.push(ts - this.lastFrameTs);
    this.lastFrameTs = ts;

    const previous = this.lastTotalChars;
    this.lastTotalChars = totalChars;
    if (previous !== null && totalChars > previous) {
      this.framesAdvanced += 1;
      this.charsAdvanced += totalChars - previous;
      if (this.lastAdvanceTs !== null) this.gaps.push(ts - this.lastAdvanceTs);
      this.lastAdvanceTs = ts;
    }
    // previous === null establishes the baseline; totalChars < previous means
    // nodes left the DOM — rebaseline silently (already done above).

    if (ts - this.windowStartTs >= this.windowMs) {
      return this.closeWindow(ts);
    }
    return null;
  }

  /** Close the in-flight partial window (turn ended). Null when it saw no frames. */
  flush(ts: number): StreamSmoothnessWindow | null {
    if (this.framesTotal === 0) return null;
    return this.closeWindow(ts);
  }

  private closeWindow(ts: number): StreamSmoothnessWindow {
    const sorted = [...this.gaps].sort((a, b) => a - b);
    const sortedIntervals = [...this.frameIntervals].sort((a, b) => a - b);
    const closed: StreamSmoothnessWindow = {
      framesTotal: this.framesTotal,
      framesAdvanced: this.framesAdvanced,
      advancedRatio:
        this.framesTotal > 0 ? round2(this.framesAdvanced / this.framesTotal) : 0,
      gapP50: round2(percentile(sorted, 0.5)),
      gapP95: round2(percentile(sorted, 0.95)),
      gapMax: round2(sorted.length > 0 ? sorted[sorted.length - 1]! : 0),
      frameIntervalP50: round2(percentile(sortedIntervals, 0.5)),
      durationMs: round2(this.windowStartTs === null ? 0 : ts - this.windowStartTs),
      charsAdvanced: this.charsAdvanced,
    };
    this.windowStartTs = ts;
    this.framesTotal = 0;
    this.framesAdvanced = 0;
    this.charsAdvanced = 0;
    this.gaps = [];
    this.frameIntervals = [];
    // `lastTotalChars` and `lastAdvanceTs` intentionally survive the reset.
    return closed;
  }
}

/** Sum the committed assistant text length across every streaming node. */
function readTotalAssistantTextLength(): number {
  const nodes = document.querySelectorAll(STREAM_TEXT_LEN_SELECTOR);
  let total = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    const raw = nodes[i]!.getAttribute(STREAM_TEXT_LEN_ATTRIBUTE);
    if (raw === null) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) total += parsed;
  }
  return total;
}

let rafId: number | null = null;
let accumulator: StreamSmoothnessAccumulator | null = null;
let samplerSessionId: string | null = null;
/**
 * Several chat panes can stream at once (grid mode). One loop measures the whole
 * document, so callers are ref-counted: the first starts it, the last stops it.
 */
const owners = new Set<object>();

function emit(sample: StreamSmoothnessWindow): void {
  window.ade?.perf?.recordEvent({
    kind: "streamSmoothness",
    ts: Date.now(),
    sessionId: samplerSessionId,
    ...sample,
  });
}

/**
 * Start the rAF loop. No-op unless a perf run is active, so production never
 * schedules a frame callback or allocates an accumulator.
 */
export function startStreamSmoothnessSampler(
  sessionId: string | null,
  owner: object = globalThis,
): void {
  if (!isPerfActive()) return;
  owners.add(owner);
  if (rafId !== null) return;
  accumulator = new StreamSmoothnessAccumulator();
  samplerSessionId = sessionId;
  const frame = (now: number) => {
    rafId = requestAnimationFrame(frame);
    const completed = accumulator?.addFrame(now, readTotalAssistantTextLength());
    if (completed) emit(completed);
  };
  rafId = requestAnimationFrame(frame);
}

/** Stop the loop and emit the trailing partial window. */
export function stopStreamSmoothnessSampler(owner: object = globalThis): void {
  owners.delete(owner);
  if (owners.size > 0) return;
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  const trailing = accumulator?.flush(performance.now()) ?? null;
  accumulator = null;
  if (trailing) emit(trailing);
  samplerSessionId = null;
}

/**
 * Run the sampler only while a turn is actively streaming. When no perf run is
 * active this costs one boolean read per streaming transition.
 */
export function useStreamSmoothnessSampler(
  streaming: boolean,
  sessionId: string | null,
): void {
  useEffect(() => {
    if (!streaming || !isPerfActive()) return;
    // Allocated only when a perf run is active and a turn is streaming.
    const token = {};
    startStreamSmoothnessSampler(sessionId, token);
    return () => {
      stopStreamSmoothnessSampler(token);
    };
  }, [streaming, sessionId]);
}
