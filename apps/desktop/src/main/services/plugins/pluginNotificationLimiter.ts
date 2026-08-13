import fs from "node:fs";
import path from "node:path";

import {
  budgetExceeded,
  PLUGIN_NOTIFICATIONS_PER_BURST,
  PLUGIN_NOTIFICATIONS_PER_DAY,
  PLUGIN_NOTIFICATION_BURST_WINDOW_MS,
} from "../../../shared/plugins/sdk";
import type { Logger } from "../logging/logger";
import { writeTextAtomic } from "../shared/utils";

/**
 * The two ceilings on `ade.notifications.post`, and the state that makes them
 * survive a restart.
 *
 * DURABLE ON PURPOSE. An in-memory counter is a ceiling on how many
 * notifications a plugin can send *per ADE session*, which is not a ceiling at
 * all: the plugin child restarts on every crash, and a plugin that wanted to
 * evade a session counter only has to be unreliable. The file is small (one row
 * per plugin that has ever posted) and written at most
 * {@link PLUGIN_NOTIFICATIONS_PER_DAY} times a day per plugin, so the cost of
 * durability here is a rounding error.
 *
 * It lives beside the install registry rather than in a project database for
 * the same reason `config.json` does: plugin children are machine-scoped, and a
 * per-project counter would give a plugin one full allowance per project the
 * user happens to have open.
 */

const STATE_VERSION = 1;

type PluginNotificationUsage = {
  /** UTC day (`YYYY-MM-DD`) the `dayCount` belongs to. */
  day: string;
  dayCount: number;
  /**
   * Post times inside the burst window, as epoch ms.
   *
   * Bounded by {@link PLUGIN_NOTIFICATIONS_PER_BURST} because anything past
   * that was refused and never recorded, so this array cannot grow: it is at
   * most five numbers, pruned on every read.
   */
  recent: number[];
};

type PluginNotificationState = {
  version: number;
  plugins: Record<string, PluginNotificationUsage>;
};

export type PluginNotificationLimiter = {
  /**
   * Account for one post, or refuse it.
   *
   * Throws a `plugin_budget_exceeded` {@link budgetExceeded} naming which
   * ceiling was hit — `notifications.burst` or `notifications.daily` — so the
   * plugin's author can tell "I posted too fast" from "I posted too much today"
   * without reading a sentence. The post is recorded only when it is allowed,
   * so a refused call does not deepen the hole it is already in.
   */
  reserve(pluginId: string): void;
  /**
   * Give back a slot {@link reserve} took for a post that never happened.
   *
   * The reservation is made before the fan-out, so that a plugin over its
   * budget never reaches the relay — which means a machine with nowhere to
   * deliver spends a slot on every failure and then reports
   * `plugin_budget_exceeded`, telling the author "you posted too fast" when the
   * truth is "there is nowhere to post".
   */
  release(pluginId: string): void;
  /** Drop an uninstalled plugin's counters. */
  forget(pluginId: string): void;
};

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function emptyState(): PluginNotificationState {
  return { version: STATE_VERSION, plugins: {} };
}

function readUsage(value: unknown): PluginNotificationUsage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<PluginNotificationUsage>;
  if (typeof record.day !== "string") return null;
  return {
    day: record.day,
    dayCount: typeof record.dayCount === "number" && Number.isFinite(record.dayCount)
      ? Math.max(0, Math.trunc(record.dayCount))
      : 0,
    recent: Array.isArray(record.recent)
      ? record.recent.filter((at): at is number => typeof at === "number" && Number.isFinite(at))
      : [],
  };
}

export function createPluginNotificationLimiter(args: {
  filePath: string;
  logger: Logger;
  now?: () => number;
}): PluginNotificationLimiter {
  const { logger } = args;
  const now = args.now ?? (() => Date.now());
  /**
   * The file is read once and then owned in memory.
   *
   * Nothing else writes it, and re-reading before every post would turn a
   * notification into a synchronous disk read on the daemon's main thread for
   * no gain — a second ADE on the same machine is already excluded by the
   * single-daemon lock.
   */
  let state: PluginNotificationState | null = null;

  const load = (): PluginNotificationState => {
    if (state) return state;
    try {
      const parsed = JSON.parse(fs.readFileSync(args.filePath, "utf8")) as Partial<PluginNotificationState>;
      const plugins: Record<string, PluginNotificationUsage> = {};
      for (const [pluginId, value] of Object.entries(parsed?.plugins ?? {})) {
        const usage = readUsage(value);
        if (usage) plugins[pluginId] = usage;
      }
      state = { version: STATE_VERSION, plugins };
    } catch {
      // A missing file is the ordinary first run, and an unreadable one is a
      // corrupt counter. Both start empty: refusing every notification on this
      // machine because a bookkeeping file failed to parse would break a
      // working feature to protect a backstop.
      state = emptyState();
    }
    return state;
  };

  const persist = (): void => {
    if (!state) return;
    try {
      fs.mkdirSync(path.dirname(args.filePath), { recursive: true });
      // Atomic: a torn write parses as an empty file, which resets every
      // plugin's daily count to zero — the durability this ledger exists for.
      writeTextAtomic(args.filePath, `${JSON.stringify(state)}\n`);
    } catch (error) {
      // Fail open, loudly. The in-memory counters still hold for this session,
      // so the ceilings keep working until ADE restarts; the alternative —
      // refusing the post because the counter could not be written — would let
      // a read-only plugins directory silently disable notifications.
      logger.warn("plugin.notification_usage_persist_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    reserve(pluginId) {
      const current = load();
      const nowMs = now();
      const day = utcDay(nowMs);
      const existing = current.plugins[pluginId];
      // A stored day that is not today is last night's count, which is spent:
      // the bucket resets by comparison rather than by a sweep, so a machine
      // that was asleep across midnight does not need to have been running to
      // roll over.
      const usage: PluginNotificationUsage = existing && existing.day === day
        ? existing
        : { day, dayCount: 0, recent: [] };
      const burstFloor = nowMs - PLUGIN_NOTIFICATION_BURST_WINDOW_MS;
      const recent = usage.recent.filter((at) => at > burstFloor);
      if (recent.length >= PLUGIN_NOTIFICATIONS_PER_BURST) {
        throw budgetExceeded("notifications.burst", PLUGIN_NOTIFICATIONS_PER_BURST, recent.length + 1);
      }
      if (usage.dayCount >= PLUGIN_NOTIFICATIONS_PER_DAY) {
        throw budgetExceeded("notifications.daily", PLUGIN_NOTIFICATIONS_PER_DAY, usage.dayCount + 1);
      }
      current.plugins[pluginId] = {
        day,
        dayCount: usage.dayCount + 1,
        recent: [...recent, nowMs],
      };
      persist();
    },

    release(pluginId) {
      const current = load();
      const usage = current.plugins[pluginId];
      if (!usage) return;
      // Give back the most recent slot only. Both counters move together on
      // reserve, so both move back together here — and the burst entry that is
      // dropped is the last one pushed, which is the one this post took.
      current.plugins[pluginId] = {
        day: usage.day,
        dayCount: Math.max(0, usage.dayCount - 1),
        recent: usage.recent.slice(0, -1),
      };
      persist();
    },

    forget(pluginId) {
      const current = load();
      if (!(pluginId in current.plugins)) return;
      delete current.plugins[pluginId];
      persist();
    },
  };
}
