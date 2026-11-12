import type { RendererMemorySnapshot } from "../../shared/types/rendererMemory";

/**
 * What this window holds, sent to main a second after load and then every 30
 * seconds while the window is visible, so a renderer that is killed for
 * running out of memory leaves a record of what was in it. A dead renderer
 * cannot report; main keeps the last snapshot and attaches it to the crash's
 * log line and analytics event.
 *
 * It rides the 1 s event-loop watchdog in `rendererBoot.tsx` (its first tick,
 * then every 30th), so it adds no timer. Each snapshot reads
 * `performance.memory` and one number per open chat pane: a few microseconds.
 */

const transcriptGauges = new Set<() => number>();
let sessionReplayActive = false;

/** Set by `sessionReplay.ts` when its recorder starts or stops. */
export function noteSessionReplayActive(active: boolean): void {
  sessionReplayActive = active;
}

/** A chat pane registers how many events its largest loaded transcript holds; returns the unregister. */
export function registerTranscriptGauge(read: () => number): () => void {
  transcriptGauges.add(read);
  return () => {
    transcriptGauges.delete(read);
  };
}

export function readRendererMemorySnapshot(): RendererMemorySnapshot {
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number };
  }).memory;
  let largest = 0;
  for (const read of transcriptGauges) {
    try {
      largest = Math.max(largest, read());
    } catch {
      // A pane that is unmounting reads nothing.
    }
  }
  return {
    heapUsedMb: typeof memory?.usedJSHeapSize === "number" ? Math.round(memory.usedJSHeapSize / 1048576) : null,
    heapLimitMb: typeof memory?.jsHeapSizeLimit === "number" ? Math.round(memory.jsHeapSizeLimit / 1048576) : null,
    openForSec: Math.round(performance.now() / 1000),
    openChatPanes: transcriptGauges.size,
    largestTranscriptEvents: largest,
    replayActive: sessionReplayActive,
  };
}

/** Sends one snapshot to main. Fire and forget; never throws. */
export function reportRendererMemorySnapshot(): void {
  try {
    window.ade?.app?.reportRendererMemory?.(readRendererMemorySnapshot());
  } catch {
    // Diagnostics must never affect the window.
  }
}
