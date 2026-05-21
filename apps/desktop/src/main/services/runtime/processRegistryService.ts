import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";

export type RuntimeProcessRole =
  | "desktop-main"
  | "ade-serve-daemon"
  | "tui-runtime";

export type RuntimeProcessRow = {
  pid: number;
  role: RuntimeProcessRole | string;
  projectRoot: string | null;
  startedAt: string;
  lastSeen: string;
};

export type ProcessRegistryServiceOptions = {
  db: AdeDb;
  logger: Logger;
  pid?: number;
  role: RuntimeProcessRole;
  projectRoot?: string | null;
  /**
   * How often we refresh our own row's `last_seen`. Defaults to 5s. Reconcile
   * callers wait for at least one stale interval before treating a peer as
   * dead, so heartbeat cadence sets the floor on "how fast does a crashed
   * sibling get cleaned up." Faster = noisier writes; slower = stale rows
   * linger longer after a crash.
   */
  heartbeatIntervalMs?: number;
  /**
   * A peer is considered alive if its `last_seen` is within this window.
   * Defaults to 3x heartbeat interval so a single missed heartbeat (GC pause,
   * fs hiccup) doesn't false-positive a sibling as dead.
   */
  livenessWindowMs?: number;
};

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_LIVENESS_WINDOW_MS = DEFAULT_HEARTBEAT_INTERVAL_MS * 3;

function nowIso(): string {
  return new Date().toISOString();
}

export function createProcessRegistryService(options: ProcessRegistryServiceOptions) {
  const { db, logger, role } = options;
  const pid = options.pid ?? process.pid;
  const projectRoot = options.projectRoot ?? null;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let started = false;

  const writeOwnRow = (startedAtIso: string | null): void => {
    const lastSeen = nowIso();
    db.run(
      `
        insert into runtime_processes (pid, role, project_root, started_at, last_seen)
        values (?, ?, ?, ?, ?)
        on conflict(pid) do update set
          role = excluded.role,
          project_root = excluded.project_root,
          started_at = case
            when ? is not null then excluded.started_at
            else runtime_processes.started_at
          end,
          last_seen = excluded.last_seen
      `,
      [pid, role, projectRoot, startedAtIso ?? lastSeen, lastSeen, startedAtIso],
    );
  };

  return {
    pid,
    role,

    start(): void {
      if (started) return;
      started = true;
      try {
        writeOwnRow(nowIso());
        this.pruneStale();
      } catch (error) {
        logger.warn("process_registry.start_failed", {
          pid,
          role,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      heartbeatTimer = setInterval(() => {
        try {
          writeOwnRow(null);
        } catch (error) {
          logger.warn("process_registry.heartbeat_failed", {
            pid,
            role,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    },

    /** Force a heartbeat write now — useful right before a long blocking op. */
    heartbeat(): void {
      try {
        writeOwnRow(null);
      } catch (error) {
        logger.warn("process_registry.heartbeat_failed", {
          pid,
          role,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    stop(): void {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (!started) return;
      started = false;
      try {
        db.run("delete from runtime_processes where pid = ?", [pid]);
      } catch (error) {
        logger.debug("process_registry.stop_failed", {
          pid,
          role,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    /**
     * Returns pids of every ADE process whose last heartbeat is within the
     * liveness window. Used by reconcile/dispose paths to decide whether a
     * `terminal_sessions.owner_pid` is still owned by a live sibling.
     */
    listLivePids(): Set<number> {
      const cutoffIso = new Date(Date.now() - livenessWindowMs).toISOString();
      const rows = db.all<{ pid: number }>(
        "select pid from runtime_processes where last_seen >= ?",
        [cutoffIso],
      );
      const live = new Set<number>();
      for (const row of rows) {
        if (typeof row.pid === "number" && Number.isFinite(row.pid)) {
          live.add(row.pid);
        }
      }
      // Always include our own pid even if the heartbeat row hasn't been
      // written yet (e.g. start() not called, or first tick hasn't fired) —
      // we are demonstrably alive right now.
      live.add(pid);
      return live;
    },

    /** Quick "is this peer still heartbeating" check. */
    isPidLive(candidatePid: number | null | undefined): boolean {
      if (candidatePid == null || !Number.isFinite(candidatePid)) return false;
      if (candidatePid === pid) return true;
      const cutoffIso = new Date(Date.now() - livenessWindowMs).toISOString();
      const row = db.get<{ pid: number }>(
        "select pid from runtime_processes where pid = ? and last_seen >= ? limit 1",
        [candidatePid, cutoffIso],
      );
      return row != null;
    },

    /** Read-only view of every heartbeat row (live and stale). */
    listAllProcesses(): RuntimeProcessRow[] {
      const rows = db.all<{
        pid: number;
        role: string;
        project_root: string | null;
        started_at: string;
        last_seen: string;
      }>(
        "select pid, role, project_root, started_at, last_seen from runtime_processes order by last_seen desc",
        [],
      );
      return rows.map((row) => ({
        pid: row.pid,
        role: row.role,
        projectRoot: row.project_root ?? null,
        startedAt: row.started_at,
        lastSeen: row.last_seen,
      }));
    },

    /** Sweeps rows whose last_seen is older than 10x the liveness window. */
    pruneStale(): number {
      const cutoffIso = new Date(Date.now() - livenessWindowMs * 10).toISOString();
      const row = db.get<{ count: number }>(
        "select count(1) as count from runtime_processes where pid != ? and last_seen < ?",
        [pid, cutoffIso],
      );
      const count = Number(row?.count ?? 0);
      if (!Number.isFinite(count) || count <= 0) return 0;
      db.run(
        "delete from runtime_processes where pid != ? and last_seen < ?",
        [pid, cutoffIso],
      );
      return count;
    },
  };
}

export type ProcessRegistryService = ReturnType<typeof createProcessRegistryService>;
