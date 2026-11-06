import path from "node:path";
import type { StorageLaneSizingState } from "../../../shared/types/storage";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import { nonAsarFs } from "../shared/nonAsarFs";
import { measureTree } from "./diskUsage";
import { isDirectChildFolder, sameFolder } from "../shared/sameFolder";

/**
 * Each lane folder's full size, measured in the background and kept in the
 * local-only `local_lane_size_measurements` table.
 *
 * The storage snapshot walks with a shared entry cap, and a lane is mostly
 * `node_modules` and build output: a capped walk stopped before those and
 * showed "≥ 8 GB" for lanes `du` put at 125 GB. A full walk of every lane
 * takes about a minute, too slow for opening a page, so it runs here, one lane
 * at a time, and the snapshot reads the result with the time it was measured.
 *
 * Same accounting as everywhere (`measureTree`: allocated blocks, each
 * hard-linked file once, pnpm store clones left out), with no entry cap. The
 * walk awaits the filesystem for every few entries, pauses between lanes, and
 * stops on `dispose()`; a lane cut short is not stored.
 */

/** Folders read at once inside one lane. */
const MEASURE_CONCURRENCY = 4;
/** Pause between two lanes, so a pass never holds the disk for long. */
const LANE_PAUSE_MS = 250;

export type LaneSizeRecord = {
  laneId: string;
  worktreePath: string;
  bytes: number;
  fileCount: number;
  lastModifiedMs: number | null;
  measuredAt: string;
};

type LaneRowLike = { id: string; worktree_path: string };

type MeasurementRow = {
  lane_id: string;
  worktree_path: string;
  bytes: number;
  file_count: number;
  last_modified_at: string | null;
  measured_at: string;
};

export type LaneSizePassResult = {
  measured: number;
  /** Lanes the pass meant to measure and did not reach (stopped early). */
  skipped: number;
  bytes: number;
  durationMs: number;
  aborted: boolean;
};

export function createLaneSizeMeasurer(options: {
  db: AdeDb;
  logger: Logger;
  projectId: string | null | undefined;
  worktreesDir: string;
  listLanes: () => LaneRowLike[];
  /**
   * When each lane last changed in a way that makes its stored size wrong
   * (build output removed), so a pass measures it again.
   */
  changedAtByLane?: (lanes: LaneRowLike[]) => Promise<Map<string, number>>;
  /** After a pass stored anything: the cached snapshot is out of date. */
  onMeasured?: () => void;
}) {
  const projectId = options.projectId?.trim() ?? "";
  const controller = new AbortController();
  let flight: Promise<LaneSizePassResult> | null = null;
  let progress = { done: 0, total: 0 };
  let lastFinishedAt: string | null = null;

  /** Stored sizes by lane id, only where the lane's folder is still the one measured. */
  const read = (lanes: LaneRowLike[] = options.listLanes()): Map<string, LaneSizeRecord> => {
    const out = new Map<string, LaneSizeRecord>();
    if (!projectId) return out;
    let rows: MeasurementRow[];
    try {
      rows = options.db.all<MeasurementRow>(
        `select lane_id, worktree_path, bytes, file_count, last_modified_at, measured_at
           from local_lane_size_measurements where project_id = ?`,
        [projectId],
      );
    } catch {
      // A database from before the table: nothing measured yet.
      return out;
    }
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
    for (const row of rows) {
      const lane = laneById.get(row.lane_id);
      if (!lane || !sameFolder(lane.worktree_path, row.worktree_path)) continue;
      const lastModifiedMs = row.last_modified_at ? Date.parse(row.last_modified_at) : Number.NaN;
      out.set(row.lane_id, {
        laneId: row.lane_id,
        worktreePath: row.worktree_path,
        bytes: Math.max(0, Number(row.bytes) || 0),
        fileCount: Math.max(0, Number(row.file_count) || 0),
        lastModifiedMs: Number.isFinite(lastModifiedMs) ? lastModifiedMs : null,
        measuredAt: row.measured_at,
      });
    }
    return out;
  };

  const state = (): StorageLaneSizingState => ({
    running: flight != null,
    done: progress.done,
    total: progress.total,
    lastFinishedAt,
  });

  const pause = (ms: number) => new Promise<void>((resolve) => {
    if (controller.signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    controller.signal.addEventListener("abort", done, { once: true });
  });

  const runPass = async (maxAgeMs: number): Promise<LaneSizePassResult> => {
    const startedAt = Date.now();
    const result: LaneSizePassResult = { measured: 0, skipped: 0, bytes: 0, durationMs: 0, aborted: false };
    if (!projectId) return result;
    const lanes = options.listLanes().filter((lane) => isDirectChildFolder(options.worktreesDir, lane.worktree_path));
    const known = read(lanes);
    const changedAt = await options.changedAtByLane?.(lanes).catch((error) => {
      // Without it, a lane whose build output was removed keeps its older size until it ages out.
      options.logger.warn("storage.lane_sizes_changed_at_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }) ?? null;
    // Never measured first, then the oldest measurement.
    const due = lanes
      .map((lane) => {
        const record = known.get(lane.id);
        const measuredMs = record ? Date.parse(record.measuredAt) : Number.NaN;
        const changed = changedAt?.get(lane.id);
        const stale = !Number.isFinite(measuredMs)
          || startedAt - measuredMs >= maxAgeMs
          || (changed != null && changed > measuredMs);
        return { lane, measuredMs: Number.isFinite(measuredMs) ? measuredMs : 0, stale };
      })
      .filter((entry) => entry.stale)
      .sort((left, right) => left.measuredMs - right.measuredMs);
    progress = { done: 0, total: due.length };
    for (const [index, { lane }] of due.entries()) {
      if (controller.signal.aborted) {
        result.aborted = true;
        result.skipped = due.length - index;
        break;
      }
      if (index > 0) await pause(LANE_PAUSE_MS);
      const folder = path.resolve(lane.worktree_path);
      const before = await nonAsarFs.promises.lstat(folder).catch(() => null);
      if (!before || !before.isDirectory() || before.isSymbolicLink()) {
        progress.done += 1;
        continue;
      }
      const laneStartedAt = Date.now();
      const size = await measureTree(folder, { concurrency: MEASURE_CONCURRENCY, signal: controller.signal });
      progress.done += 1;
      if (size.truncated) {
        result.aborted = controller.signal.aborted;
        result.skipped = due.length - index;
        break;
      }
      // Removed (reclaimed, deleted) while it was measured: the sum is of a
      // folder that is going away, not a size to keep.
      const after = await nonAsarFs.promises.lstat(folder).catch(() => null);
      if (!after || after.ino !== before.ino || after.dev !== before.dev) continue;
      const measuredAt = new Date().toISOString();
      options.db.run(
        `insert into local_lane_size_measurements(
           lane_id, project_id, worktree_path, bytes, file_count, last_modified_at, measured_at, duration_ms
         ) values(?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(lane_id) do update set
           project_id = excluded.project_id,
           worktree_path = excluded.worktree_path,
           bytes = excluded.bytes,
           file_count = excluded.file_count,
           last_modified_at = excluded.last_modified_at,
           measured_at = excluded.measured_at,
           duration_ms = excluded.duration_ms`,
        [
          lane.id,
          projectId,
          lane.worktree_path,
          size.bytes,
          size.fileCount,
          size.lastModifiedMs == null ? null : new Date(size.lastModifiedMs).toISOString(),
          measuredAt,
          Date.now() - laneStartedAt,
        ],
      );
      result.measured += 1;
      result.bytes += size.bytes;
    }
    // Lanes that no longer exist in this project keep no size.
    try {
      const stored = options.db.all<{ lane_id: string }>(
        "select lane_id from local_lane_size_measurements where project_id = ?",
        [projectId],
      );
      const laneIds = new Set(options.listLanes().map((lane) => lane.id));
      for (const row of stored) {
        if (!laneIds.has(row.lane_id)) {
          options.db.run("delete from local_lane_size_measurements where lane_id = ?", [row.lane_id]);
        }
      }
    } catch (error) {
      // Best effort: a stale row is never read for a lane that is gone.
      options.logger.warn("storage.lane_sizes_prune_failed", { error: error instanceof Error ? error.message : String(error) });
    }
    result.durationMs = Date.now() - startedAt;
    return result;
  };

  /**
   * Measures the lanes not measured within `maxAgeMs` (Infinity: only lanes
   * never measured), one at a time. One pass at a time: a second call gets
   * the running one.
   */
  const run = (opts: { maxAgeMs: number; reason: string }): Promise<LaneSizePassResult> => {
    if (flight) return flight;
    if (controller.signal.aborted) {
      return Promise.resolve({ measured: 0, skipped: 0, bytes: 0, durationMs: 0, aborted: true });
    }
    flight = runPass(opts.maxAgeMs)
      .then((result) => {
        options.logger.info("storage.lane_sizes_measured", { reason: opts.reason, ...result });
        return result;
      })
      .catch((error) => {
        options.logger.warn("storage.lane_sizes_failed", {
          reason: opts.reason,
          error: error instanceof Error ? error.message : String(error),
        });
        return { measured: 0, skipped: 0, bytes: 0, durationMs: 0, aborted: false };
      })
      .then((result) => {
        flight = null;
        lastFinishedAt = new Date().toISOString();
        progress = { done: 0, total: 0 };
        if (result.measured > 0) options.onMeasured?.();
        return result;
      });
    return flight;
  };

  const dispose = () => controller.abort();

  return { read, state, run, dispose };
}
