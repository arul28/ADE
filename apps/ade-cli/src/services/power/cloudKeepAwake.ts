/**
 * Keeps a cloud machine awake exactly while ADE is doing something on it, and
 * puts it to sleep three minutes after that stops. At that idle moment it
 * first moves to its channel's newer image when it is behind (the server's
 * `updates.ts`), and each brain start reports in, which settles an update.
 *
 * The one busy list lives here (`decideCloudBusy`). Unknown is busy.
 *
 * the provider sleeps a machine with auto-sleep once nothing has moved through any
 * of its URLs for the idle timeout, 5 minutes at its shortest. It counts only that
 * traffic, so a brain working through its outbound relay connection looks idle to it.
 * While this brain has work (a chat turn, a running command, an agent CLI working,
 * setup, a scheduled wake-up due soon), it requests its own wake URL once a minute:
 * a public port ADE made for the machine, which counts as traffic. Measured on a
 * real box (2026-11-05): pings kept it awake past the timer, and it slept 312 s
 * after they stopped with a 300 s timeout. Sleep comes sooner, at three minutes
 * idle: this brain asks ADE's server to sleep it (`/cloud/instances/:id/idle`).
 *
 * The backstop sleeping is the provider's, so it happens even when every ADE window
 * on the account is closed and this brain can't reach the server. ADE writes the URL to `$ADE_HOME/cloud/wake.json`
 * when it makes the machine (with the machine's id: a copy of the disk on
 * another machine must not keep this one awake), and turns auto-sleep on only once this brain has
 * written `keep-awake.json`, so an older brain that never pings is never put
 * to sleep under its work.
 */

import fs from "node:fs";
import path from "node:path";
import { isAdeCloudComputer } from "../../../../desktop/src/main/services/adeCloud/cloudComputerRules";

/** One ping a minute: a 5-minute timeout (the provider's shortest) survives four missed pings. */
export const CLOUD_KEEP_AWAKE_INTERVAL_MS = 60_000;
/**
 * A timer (a scheduled wake-up, an automation) this close keeps the machine
 * awake. A later one is sent to ADE's account server, which wakes the machine
 * two minutes before it; while that can't be sent, the machine stays awake for
 * any timer within the hour instead.
 */
export const CLOUD_KEEP_AWAKE_SCHEDULE_WINDOW_MS = 5 * 60_000;
export const CLOUD_KEEP_AWAKE_UNSENT_SCHEDULE_WINDOW_MS = 60 * 60_000;
const PING_TIMEOUT_MS = 10_000;

/** Idle this long and the brain asks the server to sleep it; matches the chat process timer `SESSION_INACTIVITY_TIMEOUT_MS`. */
export const CLOUD_IDLE_SLEEP_AFTER_MS = 3 * 60_000;
/** A command or turn this silent, with nothing typed, counts as idle. */
export const CLOUD_UNTOUCHED_IDLE_MS = 60 * 60_000;
/**
 * The early disk grow (it restarts the computer) waits this long after
 * someone last used the computer, and for as long as a chat waits on them.
 */
export const CLOUD_EARLY_GROW_QUIET_MS = 5 * 60_000;
/** A gap this many intervals long between checks means the machine was asleep. */
const SLEEP_GAP_INTERVALS = 2.5;
/** The longest wait between boot report tries after failures. */
const BOOT_REPORT_RETRY_MAX_MS = 30 * 60_000;

/** What the busy list reads, per runtime on this brain. */
export type CloudBusyTerminal = {
  /** A tracked agent CLI session, or a terminal (a shell, or a command run in one). */
  kind: "agent_cli" | "shell";
  state: "running" | "idle" | "waiting-input" | string;
  /** The shell itself is in the foreground, so it sits at its prompt. Null when ADE can't tell. */
  atPrompt: boolean | null;
  /** The foreground process's name, or null. */
  foreground: string | null;
  lastOutputAt: number;
  lastInputAt: number;
};

export type CloudBusyChat = {
  /** The turn is stopped on a person's approval or question. */
  waitingOnPerson: boolean;
  /** Last event, send or answer in the chat. */
  lastActivityAt: number;
};

export type CloudBusyFacts = {
  chats: CloudBusyChat[];
  terminals: CloudBusyTerminal[];
  setupRunning: boolean;
  /**
   * New-lane launches still setting up (fetch, checkout, environment). They
   * run git and setup commands outside any terminal or chat turn.
   */
  laneSetups?: number;
  /** A move, copy, resize or first clone in progress (`holdCloudBusy`). */
  holds: string[];
};

/** Names an agent CLI runs under when someone starts it by hand in a shell. */
const AGENT_CLI_PROCESS_NAMES = new Set(["claude", "codex", "cursor-agent", "agent", "droid", "opencode", "muse"]);

function terminalBusyReason(terminal: CloudBusyTerminal, now: number): "agent_cli" | "terminal" | null {
  const untouched = now - Math.max(terminal.lastOutputAt, terminal.lastInputAt) >= CLOUD_UNTOUCHED_IDLE_MS;
  if (terminal.kind === "agent_cli" || (terminal.foreground != null && AGENT_CLI_PROCESS_NAMES.has(terminal.foreground))) {
    // An agent CLI's own screen moves (a spinner, a timer) while it works, and
    // stops at its prompt. `waiting-input` is it asking the person: idle.
    return terminal.state === "running" && !untouched ? "agent_cli" : null;
  }
  // A plain shell: its pty's output-based state reads idle under a quiet
  // command (`sleep 300`, a slow build), so what's in the foreground decides.
  // Not knowing is a command running; only 60 silent minutes make that idle.
  if (terminal.atPrompt === true) return null;
  return untouched ? null : "terminal";
}

/**
 * The busy list. Busy: a running chat turn, a real running command, an agent CLI
 * actually working, setup, a new lane setting up, first clone, move, copy, resize. Idle: a shell at its
 * prompt, an agent CLI at its prompt, a chat waiting on approval (answering wakes
 * it), and a command or turn with no output and no touch for an hour. Someone
 * watching a tool (`noteUse`) and a timer due soon are added by the keep-awake.
 */
export function decideCloudBusy(
  facts: CloudBusyFacts,
  now: number,
): { busy: boolean; reasons: string[]; waitingOnPerson: boolean } {
  const reasons = new Set<string>();
  for (const chat of facts.chats) {
    if (!chat.waitingOnPerson && now - chat.lastActivityAt < CLOUD_UNTOUCHED_IDLE_MS) reasons.add("chat");
  }
  for (const terminal of facts.terminals) {
    const reason = terminalBusyReason(terminal, now);
    if (reason) reasons.add(reason);
  }
  if (facts.setupRunning) reasons.add("setup");
  if ((facts.laneSetups ?? 0) > 0) reasons.add("lane_setup");
  for (const hold of facts.holds) reasons.add(hold);
  return { busy: reasons.size > 0, reasons: [...reasons], waitingOnPerson: facts.chats.some((chat) => chat.waitingOnPerson) };
}

export type CloudKeepAwakeBusy = {
  busy: boolean;
  /** What is running, for the state file and logs: "chat", "terminal", "agent_cli", "setup", "lane_setup", "move", "copy", "first_clone", "lane_launch", "schedule", "in_use". */
  reasons: string[];
  /** When the machine's next timer is due (a scheduled wake-up, an automation), or null. */
  nextWakeAt?: number | null;
  /** A chat's turn is stopped on the person's approval or question (idle, but they'd lose the card to a restart). */
  waitingOnPerson?: boolean;
};

/** What the account server is asked to do: wake this machine at `at`, or nothing. */
export type CloudTimedWake = { instanceId: string; url: string; at: number } | { instanceId: string; clear: true };

export type CloudKeepAwakeOptions = {
  env?: NodeJS.ProcessEnv;
  adeHome: string;
  readBusy: () => Promise<CloudKeepAwakeBusy>;
  /** Sends the next timer to ADE's account server (it wakes the machine then). Rejects when it couldn't. */
  sendTimedWake?: (wake: CloudTimedWake) => Promise<void>;
  /** Asks ADE's server to sleep this machine now (three minutes idle). Rejects when it couldn't; the provider's timer is the backstop. */
  requestIdleSleep?: (instanceId: string) => Promise<void>;
  /** Grows the disk if it's near full (it restarts the machine). True when it did, so sleep waits for the restart. */
  growDiskIfNeeded?: (stillIdle: () => boolean | Promise<boolean>) => Promise<boolean>;
  /**
   * The disk is close to the storage guard's stop line (a local read, no
   * server call): grow at the next check that finds nothing really running,
   * not at the three-minute idle point, so the grow comes before the guard
   * refuses a turn. Someone's use alone (`in_use`, a refused send, a watched
   * tool) doesn't keep it busy, but a use in the last
   * {@link CLOUD_EARLY_GROW_QUIET_MS} or a chat waiting on the person holds
   * the restart back.
   */
  diskGrowDueNow?: () => boolean;
  /**
   * Moves the machine to its channel's newer image when the server says it is
   * behind (it restarts the machine). True when an update started, so sleep
   * waits for the restart. Runs before the disk grow, at the same idle moment.
   */
  updateIfBehind?: (stillIdle: () => boolean) => Promise<boolean>;
  /**
   * Sends the server when the machine last had work and, now and then, what
   * uses its disk (the dashboard reads both without a wake). Runs at the idle
   * moment, after the disk grow and before the sleep; a failure never holds
   * the sleep back. `lastWorkAt` is null when nothing ran since this brain started.
   */
  reportUse?: (lastWorkAt: number | null, stillIdle: () => boolean) => Promise<void>;
  /**
   * Tells the server this brain started, which settles a waiting update.
   * `sleepWhenIdle`: the machine woke only for that update, so it sleeps at
   * its first idle check instead of after three minutes. Rejects to be tried
   * again at the next check.
   */
  reportBooted?: () => Promise<{ sleepWhenIdle: boolean }>;
  fetch?: (url: string, init: { method: string; signal: AbortSignal }) => Promise<{ status: number }>;
  logger?: {
    info(event: string, data?: unknown): void;
    warn(event: string, data?: unknown): void;
  };
  intervalMs?: number;
  now?: () => number;
};

export type CloudKeepAwake = {
  start(): void;
  dispose(): void;
  /**
   * Another machine just did work here (a command, a chat send, a file copied
   * in; never a read). Short commands finish between pings, so without this a
   * machine someone works on through the relay looked idle and slept under
   * them. Pings at once unless one went out within the interval.
   */
  noteUse(): Promise<void>;
  /** One check now (tests, and a host that knows work just started). */
  tick(): Promise<void>;
};

/** The files this brain and ADE share under `$ADE_HOME/cloud`. */
export function cloudKeepAwakePaths(adeHome: string) {
  const dir = path.join(adeHome, "cloud");
  return { dir, wakeUrl: path.join(dir, "wake.json"), state: path.join(dir, "keep-awake.json") };
}

/** The machine's wake URL, only when it was written for this machine (a forked disk carries its source's). */
function readWakeUrl(file: string, instanceId: string): string | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as { instanceId?: unknown; url?: unknown };
    if (value?.instanceId !== instanceId || typeof value.url !== "string") return null;
    return /^https:\/\/[a-z0-9-]+\.agent37\.app\/?$/i.test(value.url) ? value.url : null;
  } catch {
    return null;
  }
}

export function createCloudKeepAwake(options: CloudKeepAwakeOptions): CloudKeepAwake {
  const env = options.env ?? process.env;
  const enabled = isAdeCloudComputer(env);
  const instanceId = env.ADE_CLOUD_INSTANCE_ID?.trim() ?? "";
  const paths = cloudKeepAwakePaths(options.adeHome);
  const intervalMs = Math.max(1_000, options.intervalMs ?? CLOUD_KEEP_AWAKE_INTERVAL_MS);
  const now = options.now ?? Date.now;
  const fetcher = options.fetch ?? ((url, init) => fetch(url, { ...init, redirect: "manual" }));
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;
  let disposed = false;
  /** busy, reasons and wake-URL presence as last written, so the file changes only when they do. */
  let lastState: string | null = null;
  let lastPingAt: number | null = null;
  /** Work noted since the last check took it. Kept until one does, however late it runs. */
  let usedSinceTick = false;
  let lastPingOk: boolean | null = null;
  let warnedNoUrl = false;
  /** What the account server holds for this machine, as last sent: `none`, `<url>|<at>`, or null before the first send. */
  let sentWake: string | null = null;
  /** The last moment the machine had work. Starts at boot: a fresh machine gets the full three minutes. */
  let lastBusyAt = now();
  /** The last moment someone used the machine (`noteUse`), for the early grow. */
  let lastUseAt: number | null = null;
  /** The last moment real work ran (never the boot itself), for `reportUse`. */
  let lastWorkAt: number | null = null;
  let lastTickAt: number | null = null;
  /** The last check found work. */
  let wasBusy = false;
  /** Asked the server to sleep this machine; the next check runs after a wake, or a failed ask. */
  let askedToSleep = false;
  /** The boot report reached the server (or there is none to send); one in flight at a time. */
  let bootReported = !options.reportBooted;
  let bootReporting = false;
  /** After a failure the next try waits, doubling up to half an hour. */
  let bootReportFailures = 0;
  let bootReportRetryAt = 0;

  /** Once per brain start, beside the checks: a slow server must not hold a busy machine's ping back. */
  const reportBoot = (): void => {
    if (bootReported || bootReporting || !options.reportBooted || now() < bootReportRetryAt) return;
    bootReporting = true;
    void options.reportBooted().then(
      ({ sleepWhenIdle }) => {
        bootReported = true;
        options.logger?.info("cloud.boot_reported", { sleepWhenIdle });
        // Woken only for an update: the next idle check may sleep it at once.
        if (sleepWhenIdle && !wasBusy) lastBusyAt = Math.min(lastBusyAt, now() - CLOUD_IDLE_SLEEP_AFTER_MS);
      },
      (error: unknown) => {
        // A server without the boot report (404) never gets one: stop for this brain's life.
        if ((error as { status?: unknown } | null)?.status === 404) {
          bootReported = true;
          options.logger?.info("cloud.boot_report_unsupported", {});
          return;
        }
        bootReportFailures += 1;
        bootReportRetryAt = now() + Math.min(BOOT_REPORT_RETRY_MAX_MS, intervalMs * 2 ** (bootReportFailures - 1));
        if (bootReportFailures === 1 || bootReportFailures % 10 === 0) {
          options.logger?.warn("cloud.boot_report_failed", { error: error instanceof Error ? error.message : String(error), failures: bootReportFailures });
        }
      },
    ).finally(() => {
      bootReporting = false;
    });
  };

  /** Sends the next timer when it changed; true when the server holds it. */
  const syncTimedWake = async (url: string | null, nextWakeAt: number | null): Promise<boolean> => {
    if (!options.sendTimedWake) return false;
    const wanted = url && nextWakeAt != null ? `${url}|${nextWakeAt}` : "none";
    if (wanted === sentWake) return wanted !== "none";
    try {
      await options.sendTimedWake(url && nextWakeAt != null ? { instanceId, url, at: nextWakeAt } : { instanceId, clear: true });
      sentWake = wanted;
      return wanted !== "none";
    } catch (error) {
      // Tried again next tick; meanwhile the machine stays awake for it (the hour window).
      options.logger?.warn("cloud.timed_wake_send_failed", { error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  /** Written on every change, so ADE (and a person on the box) can read why it is awake. */
  const writeState = (busy: boolean, reasons: string[], hasWakeUrl: boolean) => {
    try {
      fs.mkdirSync(paths.dir, { recursive: true });
      const tmp = `${paths.state}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({
        v: 1,
        pid: process.pid,
        busy,
        reasons,
        hasWakeUrl,
        lastPingAt,
        lastPingOk,
        updatedAt: now(),
      })}\n`, { mode: 0o600 });
      fs.renameSync(tmp, paths.state);
    } catch (error) {
      options.logger?.warn("cloud.keep_awake_state_write_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const ping = async (url: string): Promise<boolean> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    try {
      // Any answer counts: nothing listens on the port, so the provider's edge
      // answers 502, and the request still reaches the machine and resets its
      // idle timer.
      await fetcher(url, { method: "GET", signal: controller.signal });
      return true;
    } catch (error) {
      options.logger?.warn("cloud.keep_awake_ping_failed", { error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      clearTimeout(timeout);
    }
  };

  /**
   * Three minutes with no work: an update or a grow if one is due, else ask
   * the server to sleep the machine. Both restart the machine, so neither
   * starts while a chat waits on the person (a restart would lose their
   * approval card or question); the sleep still goes ahead.
   */
  const sleepIfIdleLongEnough = async (at: number, waitingOnPerson: boolean): Promise<void> => {
    // Checks land a few milliseconds around each minute; that shouldn't cost a whole extra minute.
    if (!options.requestIdleSleep || at - lastBusyAt < CLOUD_IDLE_SLEEP_AFTER_MS - 5_000) return;
    askedToSleep = true;
    try {
      // An image behind its channel's goes first: the update restarts the
      // machine, and the new brain sleeps it once it is idle again. A failed
      // check (an older server) never stands in the way of the sleep.
      const updating = waitingOnPerson ? false : await options.updateIfBehind?.(() => !usedSinceTick).catch((error: unknown) => {
        options.logger?.warn("cloud.idle_update_check_failed", { error: error instanceof Error ? error.message : String(error) });
        return false;
      });
      if (updating) {
        options.logger?.info("cloud.idle_update_started", { idleMs: at - lastBusyAt });
        return;
      }
      if (!waitingOnPerson && await options.growDiskIfNeeded?.(() => !usedSinceTick)) return;
      await options.reportUse?.(lastWorkAt, () => !usedSinceTick).catch((error: unknown) => {
        options.logger?.warn("cloud.idle_use_report_failed", { error: error instanceof Error ? error.message : String(error) });
      });
      // Work noted while the disk check ran wins: sleep waits for the next idle stretch.
      if (usedSinceTick) {
        askedToSleep = false;
        return;
      }
      await options.requestIdleSleep(instanceId);
      options.logger?.info("cloud.idle_sleep_requested", { idleMs: at - lastBusyAt });
    } catch (error) {
      // The provider's own timer still sleeps it a couple of minutes later.
      options.logger?.warn("cloud.idle_sleep_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  /**
   * The early grow (`diskGrowDueNow`): only when nothing but someone's use
   * keeps the machine busy, nobody used it in the last
   * {@link CLOUD_EARLY_GROW_QUIET_MS}, and no chat waits on the person (a
   * restart would lose their approval card or their shell), checked again
   * right before the grow. True when a grow started (the machine restarts).
   */
  const growDiskEarlyIfDue = async (state: CloudKeepAwakeBusy): Promise<boolean> => {
    if (!options.growDiskIfNeeded || !options.diskGrowDueNow?.()) return false;
    if (!state.reasons.every((reason) => reason === "in_use")) return false;
    const quiet = (): boolean => lastUseAt == null || now() - lastUseAt >= CLOUD_EARLY_GROW_QUIET_MS;
    if (state.waitingOnPerson || !quiet()) return false;
    const nothingRuns = async (): Promise<boolean> => {
      if (usedSinceTick || !quiet()) return false;
      try {
        const busy = await options.readBusy();
        return !busy.busy && !busy.waitingOnPerson;
      } catch (error) {
        options.logger?.warn("cloud.disk_grow_early_busy_read_failed", { error: error instanceof Error ? error.message : String(error) });
        return false;
      }
    };
    try {
      const grew = await options.growDiskIfNeeded(nothingRuns);
      if (grew) options.logger?.info("cloud.disk_grow_early", { reasons: state.reasons });
      return grew;
    } catch (error) {
      options.logger?.warn("cloud.disk_grow_early_failed", { error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  /** A ping within the interval already holds the idle timer back. */
  const pingIsDue = (): boolean => lastPingAt == null || now() - lastPingAt >= intervalMs;

  const tick = async (): Promise<void> => {
    if (!enabled || ticking || disposed) return;
    ticking = true;
    reportBoot();
    try {
      const url = readWakeUrl(paths.wakeUrl, instanceId);
      let state: CloudKeepAwakeBusy;
      try {
        state = await options.readBusy();
      } catch (error) {
        // Unknown is busy: a failed read must never let the machine sleep under its work.
        options.logger?.warn("cloud.keep_awake_read_failed", { error: error instanceof Error ? error.message : String(error) });
        state = { busy: true, reasons: ["unknown"] };
      }
      // Used since the last check: the machine sleeps three minutes after the last use.
      if (usedSinceTick && !state.reasons.includes("in_use")) {
        state = { ...state, busy: true, reasons: [...state.reasons, "in_use"] };
      }
      usedSinceTick = false;
      const nextWakeAt = state.nextWakeAt ?? null;
      // An overdue timer fires on this awake machine on its own; only a future one is sent.
      const serverHolds = await syncTimedWake(url, nextWakeAt != null && nextWakeAt > now() ? nextWakeAt : null);
      if (nextWakeAt != null) {
        const window = serverHolds ? CLOUD_KEEP_AWAKE_SCHEDULE_WINDOW_MS : CLOUD_KEEP_AWAKE_UNSENT_SCHEDULE_WINDOW_MS;
        if (nextWakeAt - now() < window && !state.reasons.includes("schedule")) {
          state = { ...state, busy: true, reasons: [...state.reasons, "schedule"] };
        }
      }
      if (state.busy && url) {
        lastPingOk = await ping(url);
        lastPingAt = now();
      }
      const at = now();
      // Time spent asleep doesn't count: woken, the machine gets its full three
      // minutes. A short sleep leaves no gap, so a check after an ask counts too.
      if (askedToSleep || (lastTickAt != null && at - lastTickAt > intervalMs * SLEEP_GAP_INTERVALS)) {
        lastBusyAt = at;
        askedToSleep = false;
      }
      lastTickAt = at;
      // Work ends between checks. The first idle check still counts it, so a
      // machine sleeps at least three minutes after its last work, never less.
      if (state.busy || wasBusy) lastBusyAt = at;
      if (state.busy) lastWorkAt = at;
      wasBusy = state.busy;
      if (await growDiskEarlyIfDue(state)) {
        lastBusyAt = now();
      } else if (!state.busy) {
        await sleepIfIdleLongEnough(at, state.waitingOnPerson === true);
      }
      if (!url && state.busy && !warnedNoUrl) {
        warnedNoUrl = true;
        options.logger?.info("cloud.keep_awake_no_wake_url", {});
      }
      const key = `${state.busy}|${state.reasons.join(",")}|${url != null}`;
      if (key !== lastState) {
        options.logger?.info("cloud.keep_awake_state", { busy: state.busy, reasons: state.reasons, hasWakeUrl: url != null });
        lastState = key;
        writeState(state.busy, state.reasons, url != null);
      }
    } finally {
      ticking = false;
    }
    // Work noted while this check ran, and no ping for it yet.
    if (usedSinceTick && pingIsDue()) await tick();
  };

  return {
    start() {
      if (!enabled || timer || disposed) return;
      // Written at once: ADE reads this file to know the brain keeps the machine
      // awake, and only then lets the provider sleep it.
      writeState(false, [], readWakeUrl(paths.wakeUrl, instanceId) != null);
      void tick();
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref?.();
    },
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    async noteUse() {
      if (!enabled) return;
      usedSinceTick = true;
      lastBusyAt = now();
      lastWorkAt = lastBusyAt;
      lastUseAt = lastBusyAt;
      if (pingIsDue()) await tick();
    },
    tick,
  };
}

/** One hold on sleep, `$ADE_HOME/cloud/holds/<reason>.json`: `{ reason, until }`. */
function holdFile(adeHome: string, reason: string): string {
  return path.join(cloudKeepAwakePaths(adeHome).dir, "holds", `${reason}.json`);
}

/**
 * Keeps this machine from sleeping for something the brain's own lists don't see
 * (a first clone; the desktop writes the same file over exec for a move or copy).
 * Expires on its own so a crashed caller never keeps a machine awake.
 */
export function holdCloudBusy(adeHome: string, reason: string, ttlMs: number): () => void {
  const file = holdFile(adeHome, reason);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ reason, until: Date.now() + ttlMs }), { mode: 0o600 });
  } catch {
    // Without the hold the machine may sleep early; the clone still works when it wakes.
  }
  return () => {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Expires on its own.
    }
  };
}

/** Holds still in force; a stale one is removed so it can't keep the machine awake. */
export function cloudBusyHolds(adeHome: string, now: number = Date.now()): string[] {
  const dir = path.join(cloudKeepAwakePaths(adeHome).dir, "holds");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const reasons: string[] = [];
  for (const name of names) {
    try {
      const hold = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as { reason?: unknown; until?: unknown };
      if (typeof hold.reason === "string" && typeof hold.until === "number" && hold.until > now) {
        reasons.push(hold.reason);
        continue;
      }
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      // A hold ADE can't read is left for its own expiry.
    }
  }
  return reasons;
}

/**
 * The template's setup job is running (`$ADE_HOME/ready/job.sh`, which the entrypoint runs). Only an older
 * ADE's ready machines wrote one; ADE no longer does, so on a new computer this is false.
 * Remove after 2026-12-31, with the template's `ready/job.sh` hook
 * (`infra/ade-cloud/template/ade-entrypoint.sh`): by then no computer an older ADE prepared is left.
 */
export function cloudReadySetupRunning(adeHome: string): boolean {
  const dir = path.join(adeHome, "ready");
  return fs.existsSync(path.join(dir, "job.started")) && !fs.existsSync(path.join(dir, "job.exit"));
}
