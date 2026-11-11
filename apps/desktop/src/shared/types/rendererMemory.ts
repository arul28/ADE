/**
 * What a window's renderer reports about its memory every 30 s while visible
 * (`renderer/lib/rendererMemorySnapshot.ts` → `main/rendererMemoryLedger.ts`).
 * Main validates every field: the payload comes from the renderer.
 */
export type RendererMemorySnapshot = {
  heapUsedMb: number | null;
  heapLimitMb: number | null;
  openForSec: number;
  /** Chat panes mounted in this window. */
  openChatPanes: number;
  /** Events in the largest transcript any open pane holds. */
  largestTranscriptEvents: number;
  replayActive: boolean;
};

/**
 * The closed buckets `ade_renderer_recovered` reports these numbers in
 * (`main/rendererMemoryLedger.ts`). Each label covers values below its bound;
 * the last has none.
 */
export type BucketTable = readonly (readonly [label: string, below: number])[];

export const HEAP_MB_BUCKETS = [
  ["under_512", 512], ["512_1024", 1024], ["1024_2048", 2048], ["2048_3072", 3072], ["3072_plus", Infinity],
] as const satisfies BucketTable;
export const HEAP_PCT_BUCKETS = [
  ["under_50", 50], ["50_75", 75], ["75_90", 90], ["90_plus", Infinity],
] as const satisfies BucketTable;
/** The labels `duration_bucket` already uses elsewhere, in seconds. */
export const OPEN_FOR_SEC_BUCKETS = [
  ["under_10s", 10], ["under_1m", 60], ["under_5m", 300], ["under_30m", 1800], ["under_2h", 7200], ["over_2h", Infinity],
] as const satisfies BucketTable;
export const TRANSCRIPT_EVENT_BUCKETS = [
  ["under_1k", 1000], ["1k_5k", 5000], ["5k_20k", 20000], ["20k_plus", Infinity],
] as const satisfies BucketTable;
/** Labels for a value that was not known, or (transcripts) no chat open. */
export const UNKNOWN_BUCKET = "unknown";
export const NO_TRANSCRIPT_BUCKET = "none";

