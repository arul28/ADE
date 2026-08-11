import type { AdeDb } from "../../../../desktop/src/main/services/state/kvDb";

/**
 * Per-plugin sync wire accounting.
 *
 * Plugin panels stream over the same websocket as everything else, so "which
 * plugin is costing me bandwidth" is otherwise unanswerable — the frames are
 * indistinguishable from chat and changeset traffic once they are on the wire.
 * Every plugin-attributable frame carries an optional `pluginId` in its envelope
 * header (~20 bytes), and the two chokepoints that already see every byte —
 * `encodeFramesFor` on the way out, `parseSyncEnvelopeFrame` on the way in —
 * report it here.
 *
 * Accounting is in memory and flushed on a timer. Those chokepoints run per
 * frame on a synchronous SQLite driver: a write there would put a disk round
 * trip inside the send path of every plugin frame, which is a worse cost than
 * the one being measured. Losing at most one flush window of counters to a
 * crash is the right trade for a usage meter.
 *
 * Persistence is the machine-local `plugin_wire_meter_daily` table — see
 * LOCAL_ONLY_CRR_EXCLUDED_TABLES in kvDb.ts for why it must not replicate.
 */

export type PluginWireDirection = "in" | "out";

export type PluginWireUsageEntry = {
  pluginId: string;
  bytesIn: number;
  bytesOut: number;
  framesIn: number;
  framesOut: number;
};

export type PluginWireUsageSummary = {
  /** Inclusive first day (YYYY-MM-DD) covered by `plugins`. */
  fromDay: string;
  /** Inclusive last day (YYYY-MM-DD) covered by `plugins`. */
  toDay: string;
  plugins: PluginWireUsageEntry[];
};

/** Days of history `summary()` reports when the caller does not say. */
export const PLUGIN_WIRE_SUMMARY_DEFAULT_DAYS = 30;
/** How often accumulated counters are written through to SQLite. */
export const PLUGIN_WIRE_METER_FLUSH_MS = 60_000;

/**
 * Distinct (day, plugin, direction) accumulators held between flushes.
 *
 * The plugin id is read off an inbound envelope header, so it is chosen by
 * whoever is sending frames rather than by anything on this machine. Without a
 * ceiling, a sender that varies the id per frame grows this map without bound
 * between flush windows, in the message handler, for as long as the socket is
 * open. A real machine attributes traffic to a handful of installed plugins;
 * anything past this is not measurement.
 */
export const PLUGIN_WIRE_METER_MAX_PENDING = 512;

type MeterDb = Pick<AdeDb, "run" | "get" | "all">;

// The map key exists only to coalesce; the tuple is carried in the value so a
// plugin id containing the delimiter can never be split back apart wrongly.
type Accumulator = {
  day: string;
  pluginId: string;
  direction: PluginWireDirection;
  bytes: number;
  frames: number;
};

function dayOf(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

export type PluginSyncMeter = {
  /** Record one plugin-attributable frame. Hot path — never touches the DB. */
  record(pluginId: string, direction: PluginWireDirection, bytes: number): void;
  /** Write accumulated counters through to SQLite. Safe to call at any time. */
  flush(): void;
  /** Flushed, day-ranged rollup. This is what `plugin.usageSummary` returns. */
  summary(options?: { days?: number; pluginId?: string | null }): PluginWireUsageSummary;
  dispose(): void;
};

export function createPluginSyncMeter(args: {
  db: MeterDb;
  logger?: { warn?: (message: string, meta?: Record<string, unknown>) => void };
  now?: () => number;
  flushIntervalMs?: number;
  /** Injected so tests drive flushes explicitly instead of waiting on a timer. */
  setInterval?: (handler: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (handle: unknown) => void;
  /** Overrides {@link PLUGIN_WIRE_METER_MAX_PENDING}. */
  maxPendingEntries?: number;
}): PluginSyncMeter {
  const now = args.now ?? (() => Date.now());
  const pending = new Map<string, Accumulator>();
  const maxPending = args.maxPendingEntries ?? PLUGIN_WIRE_METER_MAX_PENDING;
  let disposed = false;
  let warnedOnOverflow = false;

  const flush = (): void => {
    if (pending.size === 0) return;
    const batch = [...pending.values()];
    pending.clear();
    try {
      for (const entry of batch) {
        args.db.run(
          `insert into plugin_wire_meter_daily (day, plugin_id, direction, bytes, frames)
           values (?, ?, ?, ?, ?)
           on conflict(day, plugin_id, direction) do update set
             bytes = plugin_wire_meter_daily.bytes + excluded.bytes,
             frames = plugin_wire_meter_daily.frames + excluded.frames`,
          [entry.day, entry.pluginId, entry.direction, entry.bytes, entry.frames],
        );
      }
    } catch (error) {
      // A meter is never worth failing a sync connection or a shutdown over.
      // The batch is already detached from `pending`, so a failed flush drops
      // that window's counters rather than retrying against a broken DB.
      args.logger?.warn?.("plugin.wire_meter_flush_failed", {
        error: error instanceof Error ? error.message : String(error),
        entries: batch.length,
      });
    }
  };

  const scheduleInterval = args.setInterval
    ?? ((handler: () => void, ms: number) => setInterval(handler, ms));
  const cancelInterval = args.clearInterval
    ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  const timer = scheduleInterval(() => flush(), args.flushIntervalMs ?? PLUGIN_WIRE_METER_FLUSH_MS);
  timer?.unref?.();

  return {
    record(pluginId, direction, bytes) {
      if (disposed) return;
      const trimmed = pluginId.trim();
      if (!trimmed || !Number.isFinite(bytes) || bytes <= 0) return;
      const day = dayOf(now());
      const coalesceKey = JSON.stringify([day, trimmed, direction]);
      const entry = pending.get(coalesceKey);
      if (entry) {
        entry.bytes += bytes;
        entry.frames += 1;
        return;
      }
      // Drop on full rather than evict: an eviction policy would let a flood of
      // one-off ids push out the counters for the plugins actually installed,
      // which is the opposite of what the meter is for. Warn once per process so
      // the log records that attribution went incomplete without becoming the
      // flood itself.
      if (pending.size >= maxPending) {
        if (!warnedOnOverflow) {
          warnedOnOverflow = true;
          args.logger?.warn?.("plugin.wire_meter_pending_full", {
            maxPendingEntries: maxPending,
            droppedPluginId: trimmed,
          });
        }
        return;
      }
      pending.set(coalesceKey, { day, pluginId: trimmed, direction, bytes, frames: 1 });
    },
    flush,
    summary(options) {
      // Flush first: without it a summary requested in the same minute as the
      // traffic reports zero, which reads as a broken meter rather than a
      // buffered one.
      flush();
      const days = Math.max(1, Math.floor(options?.days ?? PLUGIN_WIRE_SUMMARY_DEFAULT_DAYS));
      const toDay = dayOf(now());
      const fromDay = dayOf(now() - (days - 1) * 24 * 60 * 60 * 1_000);
      const pluginFilter = options?.pluginId?.trim() ?? "";
      const rows = args.db.all<{
        plugin_id: string;
        direction: string;
        bytes: number;
        frames: number;
      }>(
        `select plugin_id, direction, sum(bytes) as bytes, sum(frames) as frames
           from plugin_wire_meter_daily
          where day >= ? and day <= ?${pluginFilter ? " and plugin_id = ?" : ""}
          group by plugin_id, direction`,
        pluginFilter ? [fromDay, toDay, pluginFilter] : [fromDay, toDay],
      );
      const byPlugin = new Map<string, PluginWireUsageEntry>();
      for (const row of rows) {
        const entry = byPlugin.get(row.plugin_id) ?? {
          pluginId: row.plugin_id,
          bytesIn: 0,
          bytesOut: 0,
          framesIn: 0,
          framesOut: 0,
        };
        if (row.direction === "in") {
          entry.bytesIn += Number(row.bytes ?? 0);
          entry.framesIn += Number(row.frames ?? 0);
        } else {
          entry.bytesOut += Number(row.bytes ?? 0);
          entry.framesOut += Number(row.frames ?? 0);
        }
        byPlugin.set(row.plugin_id, entry);
      }
      return {
        fromDay,
        toDay,
        plugins: [...byPlugin.values()].sort(
          (left, right) =>
            (right.bytesIn + right.bytesOut) - (left.bytesIn + left.bytesOut)
            || left.pluginId.localeCompare(right.pluginId),
        ),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelInterval(timer);
      flush();
    },
  };
}
