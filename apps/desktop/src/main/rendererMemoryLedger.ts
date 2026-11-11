import {
  CHAT_PANE_BUCKETS,
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
/** When each window's current page loaded, so a crash knows how long it was open. */
const pageStartedAtMs = new Map<number, number>();

/**
 * A snapshot older than this does not describe the crash: snapshots come
 * every 30 s while the window is visible and stop while it is hidden.
 */
const STALE_SNAPSHOT_MS = 2 * 60_000;

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

/** A page loaded in this window (first load, reload, recovery): it starts a fresh record and peak. */
export function noteRendererPageStarted(webContentsId: number): void {
  records.delete(webContentsId);
  pageStartedAtMs.set(webContentsId, Date.now());
}

/** What is known about a window's renderer at the moment it was lost. */
export type RendererCrashState = {
  /** The last snapshot, or null when there was none or it was stale. */
  record: RendererMemoryRecord | null;
  /** How old the last snapshot was, stale or not; null with no snapshot. */
  snapshotAgeSec: number | null;
  /** How long the page was open when it was lost, from its load. */
  openForSec: number | null;
};

/** The window's state at a crash, then forgotten: the reloaded page starts its own. */
export function takeRendererCrashState(webContentsId: number): RendererCrashState {
  const now = Date.now();
  const last = records.get(webContentsId) ?? null;
  const startedAt = pageStartedAtMs.get(webContentsId) ?? null;
  records.delete(webContentsId);
  pageStartedAtMs.delete(webContentsId);
  const ageMs = last ? Math.max(0, now - last.reportedAtMs) : null;
  return {
    record: last && ageMs != null && ageMs <= STALE_SNAPSHOT_MS ? last : null,
    snapshotAgeSec: ageMs == null ? null : Math.round(ageMs / 1000),
    openForSec: startedAt != null
      ? Math.round((now - startedAt) / 1000)
      : last && ageMs != null ? last.openForSec + Math.round(ageMs / 1000) : null,
  };
}

export function forgetRendererMemory(webContentsId: number): void {
  records.delete(webContentsId);
  pageStartedAtMs.delete(webContentsId);
}

function bucketOf(value: number | null, table: BucketTable): string {
  if (value == null) return UNKNOWN_BUCKET;
  return table.find(([, below]) => value < below)?.[0] ?? UNKNOWN_BUCKET;
}

export type RendererMemoryAnalytics = {
  heap_mb_bucket: string;
  heap_pct_bucket: string;
  duration_bucket?: string;
  chat_pane_bucket?: string;
  transcript_bucket: string;
  replay_active?: boolean;
};

/** What `ade_renderer_recovered` carries. */
export type RendererRecoveryOutcome = { crash_reason: string; recovered: boolean } & RendererMemoryAnalytics;

/**
 * Closed buckets for `ade_renderer_recovered`; never the exact numbers. How
 * long the page was open is measured at the crash; the rest comes from a
 * fresh snapshot only, and reads `unknown` without one.
 */
export function rendererMemoryAnalytics(state: RendererCrashState): RendererMemoryAnalytics {
  const duration = state.openForSec != null ? { duration_bucket: bucketOf(state.openForSec, OPEN_FOR_SEC_BUCKETS) } : {};
  const record = state.record;
  if (!record) {
    return { heap_mb_bucket: UNKNOWN_BUCKET, heap_pct_bucket: UNKNOWN_BUCKET, transcript_bucket: UNKNOWN_BUCKET, ...duration };
  }
  const heap = record.peakHeapUsedMb ?? record.heapUsedMb;
  const pct = heap != null && record.heapLimitMb ? (heap / record.heapLimitMb) * 100 : null;
  return {
    heap_mb_bucket: bucketOf(heap, HEAP_MB_BUCKETS),
    heap_pct_bucket: bucketOf(pct, HEAP_PCT_BUCKETS),
    ...duration,
    chat_pane_bucket: bucketOf(record.openChatPanes, CHAT_PANE_BUCKETS),
    transcript_bucket: record.openChatPanes === 0
      ? NO_TRANSCRIPT_BUCKET
      : bucketOf(record.largestTranscriptEvents, TRANSCRIPT_EVENT_BUCKETS),
    replay_active: record.replayActive,
  };
}
