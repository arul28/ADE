import {
  HEAP_MB_BUCKETS,
  HEAP_PCT_BUCKETS,
  NO_TRANSCRIPT_BUCKET,
  OPEN_FOR_SEC_BUCKETS,
  TRANSCRIPT_EVENT_BUCKETS,
  UNKNOWN_BUCKET,
  type BucketTable,
  type RendererMemorySnapshot,
} from "../shared/types/rendererMemory";

/**
 * The last thing each window's renderer said about its memory
 * (`renderer/lib/rendererMemorySnapshot.ts`, every 30 s while visible), kept
 * so a renderer killed for running out of memory still leaves a record: the
 * dead process cannot report, but main can say what it held half a minute
 * before. One small record per window; no timer here.
 */

export type RendererMemoryRecord = RendererMemorySnapshot & {
  /** The highest heap this renderer process reported. */
  peakHeapUsedMb: number | null;
  /** When the last snapshot arrived (epoch ms). */
  reportedAtMs: number;
};

const records = new Map<number, RendererMemoryRecord>();

function clampNumber(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(max, Math.round(value)) : null;
}

/** Store one snapshot from a renderer. Anything malformed is dropped. */
export function noteRendererMemory(webContentsId: number, raw: unknown): void {
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
    reportedAtMs: Date.now(),
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

function bucketOf(value: number | null, table: BucketTable): string {
  if (value == null) return UNKNOWN_BUCKET;
  return table.find(([, below]) => value < below)?.[0] ?? UNKNOWN_BUCKET;
}

export type RendererMemoryAnalytics = {
  heap_mb_bucket: string;
  heap_pct_bucket: string;
  duration_bucket?: string;
  chat_session_count?: number;
  transcript_bucket: string;
  replay_active?: boolean;
};

/** What `ade_renderer_recovered` carries. */
export type RendererRecoveryOutcome = { crash_reason: string; recovered: boolean } & RendererMemoryAnalytics;

/** Closed buckets for `ade_renderer_recovered`; never the exact numbers. */
export function rendererMemoryAnalytics(record: RendererMemoryRecord | null): RendererMemoryAnalytics {
  if (!record) {
    return { heap_mb_bucket: UNKNOWN_BUCKET, heap_pct_bucket: UNKNOWN_BUCKET, transcript_bucket: UNKNOWN_BUCKET };
  }
  const heap = record.peakHeapUsedMb ?? record.heapUsedMb;
  const pct = heap != null && record.heapLimitMb ? (heap / record.heapLimitMb) * 100 : null;
  return {
    heap_mb_bucket: bucketOf(heap, HEAP_MB_BUCKETS),
    heap_pct_bucket: bucketOf(pct, HEAP_PCT_BUCKETS),
    duration_bucket: bucketOf(record.openForSec, OPEN_FOR_SEC_BUCKETS),
    chat_session_count: Math.min(record.openChatPanes, 50),
    transcript_bucket: record.openChatPanes === 0
      ? NO_TRANSCRIPT_BUCKET
      : bucketOf(record.largestTranscriptEvents, TRANSCRIPT_EVENT_BUCKETS),
    replay_active: record.replayActive,
  };
}
