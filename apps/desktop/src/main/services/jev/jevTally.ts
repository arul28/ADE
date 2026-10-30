/**
 * Jev's day tally: one project's `decide()` outcomes per local day, numbers
 * only (no state text, questions or answers), kept so the daily usage summary
 * can show what paying for Jev would cost. The recent days live in a JSON file
 * on this machine and are written at most once a minute, and on flush.
 */
import fs from "node:fs";
import path from "node:path";
import {
  JEV_FEATURES,
  JEV_KEY_SKIP_REASONS,
  JEV_OUTCOMES,
  JEV_ROUTES,
  type JevDayTally,
  type JevFeature,
  type JevKeySkipReason,
  type JevOutcome,
  type JevRoute,
} from "../../../shared/types/jev";
import type { Logger } from "../logging/logger";
import { writeFileAtomic } from "../state/durableFile";
import { localDayKey } from "../usage/localDay";
import { asRecord, finiteNumberOrNull } from "../shared/utils";

/** Days of tallies kept in the project store; the daily report reads yesterday's. */
const TALLY_DAYS_KEPT = 8;
/** The tally is written at most this often, and on flush. */
const TALLY_SAVE_INTERVAL_MS = 60_000;
/** An answer slower than this counts as slow in the tally. */
const SLOW_ANSWER_MS = 1_000;

export type JevUsage = { inputTokens: number; outputTokens: number };

/** Where a project keeps its recent day tallies, so a restart does not lose the day. */
export type JevTallyStore = {
  read: () => unknown;
  write: (days: JevDayTally[]) => void;
};

/** What one `decide()` outcome adds to the day tally. */
export type JevTallyDetails = {
  /** This caller put a request on the wire (not cached, not joined). */
  sent?: boolean;
  latencyMs?: number;
  usage?: JevUsage | null;
  /** For wanted calls never sent: the request's estimated input tokens. */
  estimatedInputTokens?: number;
  /** The route that answered. */
  route?: JevRoute;
  breakerOpened?: boolean;
  /** No answer, and the ADE bonus was never tried: why. */
  keySkip?: JevKeySkipReason | null;
};

export type JevTally = {
  /** Adds one outcome to today's tally. */
  add: (feature: JevFeature, outcome: JevOutcome, details: JevTallyDetails) => void;
  /** One local day (`YYYY-MM-DD`), or null when Jev was not wanted that day. */
  forDay: (day: string) => JevDayTally | null;
  /** The current local day's tally; null before its first call. */
  today: (nowMs: number) => JevDayTally | null;
  /** Writes any unsaved counts now. */
  flush: () => void;
};

/**
 * The tallies as a JSON file on this machine. Not the project database: that
 * syncs to the user's other machines, and each machine counts its own calls.
 */
export function jevTallyFileStore(filePath: string): JevTallyStore {
  return {
    read: () => {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      } catch {
        return null;
      }
    },
    write: (days) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileAtomic(filePath, `${JSON.stringify(days)}\n`);
    },
  };
}

const UNSENT_OUTCOMES: ReadonlySet<JevOutcome> = new Set(["breaker_open", "busy"]);

function emptyTally(day: string): JevDayTally {
  return {
    day,
    wanted: 0,
    sent: 0,
    failed: 0,
    outcomes: {},
    sentByFeature: {},
    unsentByFeature: {},
    keySkippedByReason: {},
    answeredByRoute: {},
    inputTokens: 0,
    outputTokens: 0,
    unsentInputTokensEstimate: 0,
    breakerOpens: 0,
    latencyTotalMs: 0,
    latencyCount: 0,
    slowCount: 0,
  };
}

function count(value: unknown): number {
  const parsed = finiteNumberOrNull(value);
  return parsed != null && parsed > 0 ? Math.floor(parsed) : 0;
}

function countMap<K extends string>(value: unknown, keys: readonly K[]): Partial<Record<K, number>> {
  const record = asRecord(value) ?? {};
  const out: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const n = count(record[key]);
    if (n > 0) out[key] = n;
  }
  return out;
}

/** The stored tallies, newest last; anything unreadable is dropped. */
function readTallies(store: JevTallyStore | null | undefined): JevDayTally[] {
  let raw: unknown = null;
  try {
    raw = store?.read() ?? null;
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const days: JevDayTally[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    const day = typeof record?.day === "string" ? localDayKey(record.day) : "";
    if (!record || !day || days.some((existing) => existing.day === day)) continue;
    days.push({
      day,
      wanted: count(record.wanted),
      sent: count(record.sent),
      failed: count(record.failed),
      outcomes: countMap(record.outcomes, JEV_OUTCOMES),
      sentByFeature: countMap(record.sentByFeature, JEV_FEATURES),
      unsentByFeature: countMap(record.unsentByFeature, JEV_FEATURES),
      keySkippedByReason: countMap(record.keySkippedByReason, JEV_KEY_SKIP_REASONS),
      answeredByRoute: countMap(record.answeredByRoute, JEV_ROUTES),
      inputTokens: count(record.inputTokens),
      outputTokens: count(record.outputTokens),
      unsentInputTokensEstimate: count(record.unsentInputTokensEstimate),
      breakerOpens: count(record.breakerOpens),
      latencyTotalMs: count(record.latencyTotalMs),
      latencyCount: count(record.latencyCount),
      slowCount: count(record.slowCount),
    });
  }
  return days.sort((a, b) => a.day.localeCompare(b.day)).slice(-TALLY_DAYS_KEPT);
}

export function createJevTally(store: JevTallyStore | null | undefined, logger: Logger): JevTally {
  const tallies = readTallies(store);
  let dirty = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const save = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (!dirty || !store) return;
    dirty = false;
    try {
      store.write(structuredClone(tallies));
    } catch (error) {
      logger.debug("jev.tally_save_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const tallyFor = (day: string): JevDayTally => {
    let tally = tallies.find((existing) => existing.day === day);
    if (!tally) {
      tally = emptyTally(day);
      tallies.push(tally);
      tallies.sort((a, b) => a.day.localeCompare(b.day));
      while (tallies.length > TALLY_DAYS_KEPT) tallies.shift();
    }
    return tally;
  };

  return {
    add(feature, outcome, details) {
      // A call the user switched off is not counted, nor one refused before it was sent.
      if (outcome === "disabled" || (outcome === "invalid_request" && !details.sent)) return;
      const day = localDayKey(Date.now());
      if (!day) return;
      const current = tallyFor(day);
      current.wanted += 1;
      current.outcomes[outcome] = (current.outcomes[outcome] ?? 0) + 1;
      if (details.sent) {
        current.sent += 1;
        current.sentByFeature[feature] = (current.sentByFeature[feature] ?? 0) + 1;
        if (outcome !== "ok") current.failed += 1;
      }
      if (details.route && outcome === "ok") {
        current.answeredByRoute[details.route] = (current.answeredByRoute[details.route] ?? 0) + 1;
      }
      if (details.usage) {
        current.inputTokens += details.usage.inputTokens;
        current.outputTokens += details.usage.outputTokens;
      }
      if (UNSENT_OUTCOMES.has(outcome) && !details.sent) {
        current.unsentByFeature[feature] = (current.unsentByFeature[feature] ?? 0) + 1;
        if (details.estimatedInputTokens) current.unsentInputTokensEstimate += details.estimatedInputTokens;
      }
      if (details.keySkip) {
        current.keySkippedByReason[details.keySkip] = (current.keySkippedByReason[details.keySkip] ?? 0) + 1;
      }
      if (details.breakerOpened) current.breakerOpens += 1;
      if (details.latencyMs != null) {
        current.latencyTotalMs += Math.max(0, Math.round(details.latencyMs));
        current.latencyCount += 1;
        if (details.latencyMs > SLOW_ANSWER_MS) current.slowCount += 1;
      }
      dirty = true;
      if (store && !saveTimer) {
        saveTimer = setTimeout(save, TALLY_SAVE_INTERVAL_MS);
        saveTimer.unref?.();
      }
    },

    forDay(day) {
      const found = tallies.find((existing) => existing.day === day);
      return found && found.wanted > 0 ? structuredClone(found) : null;
    },

    today(nowMs) {
      return structuredClone(tallies.find((existing) => existing.day === localDayKey(nowMs)) ?? null);
    },

    flush: save,
  };
}
