import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { nextCronFireAt } from "../../../shared/chatScheduledWork";
import { isRecord } from "../../../shared/plugins/parse";
import {
  budgetExceeded,
  encodePluginJsonWithinBudget,
  PluginSdkError,
  PLUGIN_SCHEDULES_MAX_PER_PLUGIN,
  PLUGIN_SCHEDULE_ARGS_MAX_BYTES,
  PLUGIN_SCHEDULE_MIN_INTERVAL_MS,
  PLUGIN_SCHEDULE_NOTE_MAX_CHARS,
  type PluginSchedule,
} from "../../../shared/plugins/sdk";
import type { Logger } from "../logging/logger";
import { writeTextAtomic } from "../shared/utils";

/**
 * Plugin-owned schedules: "call this plugin's action later".
 *
 * A separate scheduler from ADE's chat scheduled work, deliberately. The chat
 * scheduler exists to wake a *conversation* — it is keyed by session, it fires
 * by injecting a prompt, and its rows carry no owner. A plugin reaching it
 * through `actions.invoke` leaves a cron nobody can attribute and nobody
 * collects: uninstall the plugin and the prompt keeps arriving in the user's
 * chat forever. Rows here belong to a plugin by construction, which is what
 * makes the quota, the listing and the uninstall sweep all possible at once.
 *
 * The store is one JSON file beside the install registry, machine-scoped like
 * the plugin children themselves. It is not in a project database because a
 * schedule outlives whichever project happened to be open when it was made, and
 * not a cr-sqlite table because a schedule is a claim on THIS machine's clock —
 * replicating it would fire the same job once per paired device.
 */

const STATE_VERSION = 1;

/**
 * `setTimeout` silently fires immediately past this, so a schedule a month out
 * is armed in hops rather than in one call.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Actions are JS identifiers on the plugin's exports; this is the whole rule. */
const PLUGIN_SCHEDULE_ACTION_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Bounded so one failing action cannot write an unbounded string into the file. */
const PLUGIN_SCHEDULE_ERROR_MAX_CHARS = 200;

type PluginScheduleRecord = {
  id: string;
  pluginId: string;
  action: string;
  kind: "cron" | "once";
  cron?: string;
  args: Record<string, unknown>;
  note?: string;
  createdAt: string;
  /** Epoch ms. Null means fired and awaiting sweep. */
  fireAt: number | null;
  lastRunAt?: string;
  lastError?: string;
};

type PluginScheduleState = { version: number; schedules: PluginScheduleRecord[] };

export type PluginScheduleService = {
  create(pluginId: string, input: unknown): PluginSchedule;
  list(pluginId: string): PluginSchedule[];
  delete(pluginId: string, scheduleId: string): void;
  /** Drop every schedule a plugin owns. Returns how many went, for the log. */
  removeAllForPlugin(pluginId: string): number;
  /** Arm the timer for whatever survived the last run. */
  start(): void;
  dispose(): void;
};

function toWire(record: PluginScheduleRecord): PluginSchedule {
  return {
    id: record.id,
    pluginId: record.pluginId,
    action: record.action,
    kind: record.kind,
    ...(record.cron ? { cron: record.cron } : {}),
    args: record.args,
    ...(record.note ? { note: record.note } : {}),
    createdAt: record.createdAt,
    nextRunAt: record.fireAt == null ? null : new Date(record.fireAt).toISOString(),
    ...(record.lastRunAt ? { lastRunAt: record.lastRunAt } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
  };
}

/**
 * Read one persisted row, dropping anything unrecognizable.
 *
 * A whitelist rather than a cast: the file is rewritten by whichever ADE
 * version runs next, and a row half-written by a newer build must not be able
 * to arm a timer this build cannot describe.
 */
function readRecord(value: unknown): PluginScheduleRecord | null {
  if (!isRecord(value)) return null;
  const { id, pluginId, action, kind, createdAt } = value;
  if (typeof id !== "string" || !id) return null;
  if (typeof pluginId !== "string" || !pluginId) return null;
  if (typeof action !== "string" || !action) return null;
  if (kind !== "cron" && kind !== "once") return null;
  const fireAt = typeof value.fireAt === "number" && Number.isFinite(value.fireAt) ? value.fireAt : null;
  return {
    id,
    pluginId,
    action,
    kind,
    ...(typeof value.cron === "string" && value.cron ? { cron: value.cron } : {}),
    args: isRecord(value.args) ? value.args : {},
    ...(typeof value.note === "string" && value.note ? { note: value.note } : {}),
    createdAt: typeof createdAt === "string" && createdAt ? createdAt : new Date().toISOString(),
    fireAt,
    ...(typeof value.lastRunAt === "string" ? { lastRunAt: value.lastRunAt } : {}),
    ...(typeof value.lastError === "string" ? { lastError: value.lastError } : {}),
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PluginSdkError("invalid_args", `"${field}" must be a non-empty string.`);
  }
  return value.trim();
}

/**
 * Resolve exactly one timing expression into a first fire time.
 *
 * Refuses two of them rather than picking a winner: `{cron, delaySeconds}` is a
 * plugin that does not know what it is asking for, and honouring one silently
 * would make a bug look like it worked.
 */
function resolveFirstFire(
  input: Record<string, unknown>,
  nowMs: number,
): { kind: "cron" | "once"; fireAt: number; cron?: string } {
  const named = ["cron", "runAt", "delaySeconds"].filter((key) => input[key] != null);
  if (named.length !== 1) {
    throw new PluginSdkError(
      "invalid_args",
      "A schedule needs exactly one of cron, runAt, or delaySeconds.",
    );
  }
  if (input.cron != null) {
    const cron = requireString(input.cron, "cron");
    const fireAt = nextCronFireAt(cron, nowMs);
    if (fireAt == null) {
      throw new PluginSdkError("invalid_args", `"${cron}" is not a five-field cron expression.`);
    }
    return { kind: "cron", fireAt, cron };
  }
  if (input.runAt != null) {
    const runAt = requireString(input.runAt, "runAt");
    const at = Date.parse(runAt);
    if (!Number.isFinite(at)) {
      throw new PluginSdkError("invalid_args", `"runAt" is not an ISO-8601 timestamp: ${runAt}`);
    }
    if (at <= nowMs) {
      throw new PluginSdkError("invalid_args", `"runAt" is in the past: ${runAt}`);
    }
    return { kind: "once", fireAt: at };
  }
  const delaySeconds = input.delaySeconds;
  if (typeof delaySeconds !== "number" || !Number.isFinite(delaySeconds)) {
    throw new PluginSdkError("invalid_args", '"delaySeconds" must be a number.');
  }
  const delayMs = Math.trunc(delaySeconds) * 1_000;
  if (delayMs < PLUGIN_SCHEDULE_MIN_INTERVAL_MS) {
    throw new PluginSdkError(
      "invalid_args",
      `"delaySeconds" must be at least ${PLUGIN_SCHEDULE_MIN_INTERVAL_MS / 1_000}.`,
    );
  }
  return { kind: "once", fireAt: nowMs + delayMs };
}

export function createPluginScheduleService(args: {
  filePath: string;
  logger: Logger;
  /** Run one of a plugin's own actions, exactly as `plugin.invoke` would. */
  invoke: (input: { pluginId: string; action: string; args: Record<string, unknown> }) => Promise<unknown>;
  now?: () => number;
}): PluginScheduleService {
  const { logger } = args;
  const now = args.now ?? (() => Date.now());
  let schedules: PluginScheduleRecord[] | null = null;
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;

  const load = (): PluginScheduleRecord[] => {
    if (schedules) return schedules;
    try {
      const parsed = JSON.parse(fs.readFileSync(args.filePath, "utf8")) as Partial<PluginScheduleState>;
      schedules = (Array.isArray(parsed?.schedules) ? parsed.schedules : [])
        .map(readRecord)
        .filter((record): record is PluginScheduleRecord => record !== null);
    } catch {
      // Missing on first run; unreadable means the file was corrupted. Either
      // way there is nothing to fire, and starting empty is the only honest
      // reading — inventing schedules would be worse than losing them.
      schedules = [];
    }
    return schedules;
  };

  const persist = (): void => {
    const state: PluginScheduleState = { version: STATE_VERSION, schedules: load() };
    try {
      fs.mkdirSync(path.dirname(args.filePath), { recursive: true });
      // Atomic, like `config.json` in the same directory. A bare write that is
      // cut short by a crash or ENOSPC leaves truncated JSON, and `load()`
      // reads that as "no schedules" — silently losing every schedule on the
      // machine, which is the one outcome this file exists to prevent.
      writeTextAtomic(args.filePath, `${JSON.stringify(state)}\n`);
    } catch (error) {
      // In-memory schedules still fire this session; only durability is lost.
      logger.warn("plugin.schedules_persist_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const arm = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (disposed) return;
    const pending = load()
      .map((record) => record.fireAt)
      .filter((fireAt): fireAt is number => fireAt != null);
    if (pending.length === 0) return;
    const nextAt = Math.min(...pending);
    // Clamped, then re-armed on wake: a schedule further out than the timer
    // ceiling would otherwise fire immediately, which is the opposite of what
    // it asked for.
    const delay = Math.min(Math.max(0, nextAt - now()), MAX_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      timer = null;
      void processDue();
    }, delay);
    timer.unref?.();
  };

  const fire = async (record: PluginScheduleRecord): Promise<void> => {
    try {
      await args.invoke({ pluginId: record.pluginId, action: record.action, args: record.args });
      record.lastError = undefined;
    } catch (error) {
      // A schedule whose action throws is kept, not cancelled: the action may
      // be failing for a reason the user can fix (a missing setting, an offline
      // service), and silently dropping the schedule would make the fix look
      // like it did not work. The message is carried on the row so a broken
      // schedule is visible rather than merely quiet.
      const message = error instanceof Error ? error.message : String(error);
      record.lastError = message.slice(0, PLUGIN_SCHEDULE_ERROR_MAX_CHARS);
      logger.warn("plugin.schedule_action_failed", {
        pluginId: record.pluginId,
        scheduleId: record.id,
        action: record.action,
        error: record.lastError,
      });
    }
  };

  const processDue = async (): Promise<void> => {
    if (disposed) return;
    const nowMs = now();
    const current = load();
    const due = current.filter((record) => record.fireAt != null && record.fireAt <= nowMs);
    if (due.length === 0) {
      arm();
      return;
    }
    // Claim every due row BEFORE awaiting: a slow action must not leave its own
    // schedule due when the next timer lands, or one wedged plugin would fire
    // in a loop for as long as it stayed wedged.
    for (const record of due) {
      record.lastRunAt = new Date(nowMs).toISOString();
      record.fireAt = record.kind === "cron" && record.cron
        ? nextCronFireAt(record.cron, nowMs)
        : null;
    }
    persist();
    for (const record of due) {
      await fire(record);
    }
    // A one-shot is gone once it has run. Keeping it would hold a quota slot
    // for a job that will never run again, and its outcome is already the
    // plugin's own — its action just ran in its own process.
    schedules = load().filter((record) => record.fireAt != null);
    persist();
    arm();
  };

  return {
    create(pluginId, input) {
      if (!isRecord(input)) {
        throw new PluginSdkError("invalid_args", '"input" must be an object.');
      }
      const action = requireString(input.action, "action");
      if (!PLUGIN_SCHEDULE_ACTION_PATTERN.test(action)) {
        throw new PluginSdkError("invalid_args", `Invalid schedule action name: ${action}`);
      }
      const nowMs = now();
      const timing = resolveFirstFire(input, nowMs);
      const scheduleArgs = input.args == null
        ? {}
        : isRecord(input.args)
          ? input.args
          : ((): Record<string, unknown> => {
            throw new PluginSdkError("invalid_args", '"args" must be an object.');
          })();
      encodePluginJsonWithinBudget(scheduleArgs, "schedule_args", PLUGIN_SCHEDULE_ARGS_MAX_BYTES);
      const note = input.note == null ? undefined : requireString(input.note, "note");
      if (note && note.length > PLUGIN_SCHEDULE_NOTE_MAX_CHARS) {
        throw new PluginSdkError(
          "invalid_args",
          `"note" is longer than ${PLUGIN_SCHEDULE_NOTE_MAX_CHARS} characters.`,
        );
      }
      const current = load();
      // Live rows only: a fired one-shot is already gone, so the quota measures
      // standing claims on the clock rather than lifetime creations.
      const live = current.filter((record) => record.pluginId === pluginId && record.fireAt != null);
      if (live.length >= PLUGIN_SCHEDULES_MAX_PER_PLUGIN) {
        throw budgetExceeded("schedules", PLUGIN_SCHEDULES_MAX_PER_PLUGIN, live.length + 1);
      }
      const record: PluginScheduleRecord = {
        id: `plugin:${pluginId}:${randomUUID()}`,
        pluginId,
        action,
        kind: timing.kind,
        ...(timing.cron ? { cron: timing.cron } : {}),
        args: scheduleArgs,
        ...(note ? { note } : {}),
        createdAt: new Date(nowMs).toISOString(),
        fireAt: timing.fireAt,
      };
      current.push(record);
      persist();
      arm();
      return toWire(record);
    },

    list(pluginId) {
      return load()
        .filter((record) => record.pluginId === pluginId)
        .map(toWire);
    },

    delete(pluginId, scheduleId) {
      const current = load();
      // Scoped by plugin id, not just by schedule id: ids are handed to the
      // plugin that made them, but a plugin that guessed another's id must not
      // be able to cancel its work. A miss is a no-op — delete is idempotent,
      // and a plugin cleaning up after itself should not have to race the
      // scheduler to find out whether a one-shot already fired.
      const next = current.filter(
        (record) => !(record.id === scheduleId && record.pluginId === pluginId),
      );
      if (next.length === current.length) return;
      schedules = next;
      persist();
      arm();
    },

    removeAllForPlugin(pluginId) {
      const current = load();
      const next = current.filter((record) => record.pluginId !== pluginId);
      const removed = current.length - next.length;
      if (removed === 0) return 0;
      schedules = next;
      persist();
      arm();
      return removed;
    },

    start() {
      // Anything that came due while ADE was not running fires on the next
      // tick rather than being skipped: a daily report the user missed because
      // their laptop was shut is still worth having, and `processDue` re-arms
      // cron rows from the current time so a long outage produces one catch-up
      // run, not a backlog.
      //
      // DEFERRED, not called inline. `processDue` runs synchronously up to its
      // first `await`, so a schedule that is already due would reach `invoke`
      // — and through it the whole plugin host — while the host is still being
      // constructed, before the bindings that path needs are initialized. A
      // zero-delay timer costs nothing and makes "the host is fully built
      // before a schedule can fire" true by construction rather than by the
      // order of two lines in another file.
      const kickoff = setTimeout(() => {
        void processDue();
      }, 0);
      kickoff.unref?.();
    },

    dispose() {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
