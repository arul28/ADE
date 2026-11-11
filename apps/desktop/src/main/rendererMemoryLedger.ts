/**
 * The last thing each window's renderer said about its memory
 * (`renderer/lib/rendererMemorySnapshot.ts`, every 30 s while visible), kept
 * so a renderer killed for running out of memory still leaves a record: the
 * dead process cannot report, but main can say what it held half a minute
 * before. One small record per window; no timer here.
 */

export type RendererMemoryRecord = {
  heapUsedMb: number | null;
  heapLimitMb: number | null;
  /** The highest heap this renderer process reported. */
  peakHeapUsedMb: number | null;
  openForSec: number;
  openChatPanes: number;
  largestTranscriptEvents: number;
  replayActive: boolean;
  /** How long before the crash the snapshot was taken. */
  reportedAtMs: number;
};

const records = new Map<number, RendererMemoryRecord>();

function clampNumber(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(max, Math.round(value)) : null;
}

/** Store one snapshot from a renderer. Anything malformed is dropped. */
export function noteRendererMemory(webContentsId: number, raw: unknown, nowMs = Date.now()): void {
  if (!raw || typeof raw !== "object") return;
  const value = raw as Record<string, unknown>;
  const heapUsedMb = clampNumber(value.heapUsedMb, 1_000_000);
  const previous = records.get(webContentsId);
  const peak = Math.max(previous?.peakHeapUsedMb ?? 0, heapUsedMb ?? 0);
  records.set(webContentsId, {
    heapUsedMb,
    heapLimitMb: clampNumber(value.heapLimitMb, 1_000_000),
    peakHeapUsedMb: peak > 0 ? peak : null,
    openForSec: clampNumber(value.openForSec, 10 * 365 * 86_400) ?? 0,
    openChatPanes: clampNumber(value.openChatPanes, 10_000) ?? 0,
    largestTranscriptEvents: clampNumber(value.largestTranscriptEvents, 100_000_000) ?? 0,
    replayActive: value.replayActive === true,
    reportedAtMs: nowMs,
  });
}

/**
 * The window's last record, then forgotten: the reloaded renderer is a new
 * process and starts its own peak.
 */
export function takeRendererMemory(webContentsId: number): RendererMemoryRecord | null {
  const record = records.get(webContentsId) ?? null;
  records.delete(webContentsId);
  return record;
}

export function forgetRendererMemory(webContentsId: number): void {
  records.delete(webContentsId);
}

/** Closed buckets for `ade_renderer_recovered`; never the exact numbers. */
export function rendererMemoryAnalytics(record: RendererMemoryRecord | null): {
  heap_mb_bucket: string;
  heap_pct_bucket: string;
  duration_bucket?: string;
  chat_session_count?: number;
  transcript_bucket: string;
  replay_active?: boolean;
} {
  if (!record) return { heap_mb_bucket: "unknown", heap_pct_bucket: "unknown", transcript_bucket: "unknown" };
  const heap = record.peakHeapUsedMb ?? record.heapUsedMb;
  const heapMbBucket = heap == null
    ? "unknown"
    : heap < 512 ? "under_512" : heap < 1024 ? "512_1024" : heap < 2048 ? "1024_2048" : heap < 3072 ? "2048_3072" : "3072_plus";
  const pct = heap != null && record.heapLimitMb ? (heap / record.heapLimitMb) * 100 : null;
  const heapPctBucket = pct == null
    ? "unknown"
    : pct < 50 ? "under_50" : pct < 75 ? "50_75" : pct < 90 ? "75_90" : "90_plus";
  const sec = record.openForSec;
  const durationBucket = sec < 10 ? "under_10s" : sec < 60 ? "under_1m" : sec < 300 ? "under_5m"
    : sec < 1800 ? "under_30m" : sec < 7200 ? "under_2h" : "over_2h";
  const events = record.largestTranscriptEvents;
  const transcriptBucket = record.openChatPanes === 0
    ? "none"
    : events < 1000 ? "under_1k" : events < 5000 ? "1k_5k" : events < 20000 ? "5k_20k" : "20k_plus";
  return {
    heap_mb_bucket: heapMbBucket,
    heap_pct_bucket: heapPctBucket,
    duration_bucket: durationBucket,
    chat_session_count: Math.min(record.openChatPanes, 50),
    transcript_bucket: transcriptBucket,
    replay_active: record.replayActive,
  };
}
