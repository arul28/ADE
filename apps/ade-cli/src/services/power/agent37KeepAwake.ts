/**
 * Keeps an Agent 37 machine awake exactly while ADE is doing something on it.
 *
 * Agent 37 sleeps a machine with auto-sleep once nothing has moved through any
 * of its URLs for the idle timeout. It counts only that traffic, so a brain
 * working through its outbound relay connection looks idle to it. While this
 * brain has work (a chat turn, a running terminal command, an agent CLI, a
 * ready machine's setup, a scheduled wake-up due soon), it requests its own
 * wake URL once a minute: a public port ADE made for the machine, which counts
 * as traffic. Measured on a real box (2026-11-05): pings kept it awake past
 * the timer, and it slept 312 s after they stopped with a 300 s timeout.
 *
 * The sleeping itself is Agent 37's, so it happens even when every ADE window
 * on the account is closed. ADE writes the URL to `$ADE_HOME/agent37/wake.json`
 * when it makes the machine (with the machine's id: a copy of the disk on
 * another machine must not keep this one awake), and turns auto-sleep on only once this brain has
 * written `keep-awake.json`, so an older brain that never pings is never put
 * to sleep under its work.
 */

import fs from "node:fs";
import path from "node:path";

/** One ping a minute: a 5-minute timeout (Agent 37's shortest) survives four missed pings. */
export const AGENT37_KEEP_AWAKE_INTERVAL_MS = 60_000;
/**
 * A timer (a scheduled wake-up, an automation) this close keeps the machine
 * awake. A later one is sent to ADE's account server, which wakes the machine
 * two minutes before it; while that can't be sent, the machine stays awake for
 * any timer within the hour instead.
 */
export const AGENT37_KEEP_AWAKE_SCHEDULE_WINDOW_MS = 5 * 60_000;
export const AGENT37_KEEP_AWAKE_UNSENT_SCHEDULE_WINDOW_MS = 60 * 60_000;
const PING_TIMEOUT_MS = 10_000;

export type Agent37KeepAwakeBusy = {
  busy: boolean;
  /** What is running, for the state file and logs: "chat", "terminal", "agent_cli", "setup", "schedule". */
  reasons: string[];
  /** When the machine's next timer is due (a scheduled wake-up, an automation), or null. */
  nextWakeAt?: number | null;
};

/** What the account server is asked to do: wake this machine at `at`, or nothing. */
export type Agent37TimedWake = { instanceId: string; url: string; at: number } | { instanceId: string; clear: true };

export type Agent37KeepAwakeOptions = {
  env?: NodeJS.ProcessEnv;
  adeHome: string;
  readBusy: () => Promise<Agent37KeepAwakeBusy>;
  /** Sends the next timer to ADE's account server (it wakes the machine then). Rejects when it couldn't. */
  sendTimedWake?: (wake: Agent37TimedWake) => Promise<void>;
  fetch?: (url: string, init: { method: string; signal: AbortSignal }) => Promise<{ status: number }>;
  logger?: {
    info(event: string, data?: unknown): void;
    warn(event: string, data?: unknown): void;
  };
  intervalMs?: number;
  now?: () => number;
};

export type Agent37KeepAwake = {
  start(): void;
  dispose(): void;
  /** One check now (tests, and a host that knows work just started). */
  tick(): Promise<void>;
};

/** The files this brain and ADE share under `$ADE_HOME/agent37`. */
export function agent37KeepAwakePaths(adeHome: string) {
  const dir = path.join(adeHome, "agent37");
  return { dir, wakeUrl: path.join(dir, "wake.json"), state: path.join(dir, "keep-awake.json") };
}

/** Whether this brain runs on an Agent 37 machine (Agent 37 sets the variable on every instance). */
export function isAgent37Machine(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^[a-z0-9]{10}$/.test(env.AGENT37_INSTANCE_ID?.trim() ?? "");
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

export function createAgent37KeepAwake(options: Agent37KeepAwakeOptions): Agent37KeepAwake {
  const env = options.env ?? process.env;
  const enabled = isAgent37Machine(env);
  const instanceId = env.AGENT37_INSTANCE_ID?.trim() ?? "";
  const paths = agent37KeepAwakePaths(options.adeHome);
  const intervalMs = Math.max(1_000, options.intervalMs ?? AGENT37_KEEP_AWAKE_INTERVAL_MS);
  const now = options.now ?? Date.now;
  const fetcher = options.fetch ?? ((url, init) => fetch(url, { ...init, redirect: "manual" }));
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;
  let disposed = false;
  /** busy, reasons and wake-URL presence as last written, so the file changes only when they do. */
  let lastState: string | null = null;
  let lastPingAt: number | null = null;
  let lastPingOk: boolean | null = null;
  let warnedNoUrl = false;
  /** What the account server holds for this machine, as last sent: `none`, `<url>|<at>`, or null before the first send. */
  let sentWake: string | null = null;

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
      options.logger?.warn("agent37.timed_wake_send_failed", { error: error instanceof Error ? error.message : String(error) });
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
      options.logger?.warn("agent37.keep_awake_state_write_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const ping = async (url: string): Promise<boolean> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    try {
      // Any answer counts: nothing listens on the port, so Agent 37's edge
      // answers 502, and the request still reaches the machine and resets its
      // idle timer.
      await fetcher(url, { method: "GET", signal: controller.signal });
      return true;
    } catch (error) {
      options.logger?.warn("agent37.keep_awake_ping_failed", { error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      clearTimeout(timeout);
    }
  };

  const tick = async (): Promise<void> => {
    if (!enabled || ticking || disposed) return;
    ticking = true;
    try {
      const url = readWakeUrl(paths.wakeUrl, instanceId);
      let state: Agent37KeepAwakeBusy;
      try {
        state = await options.readBusy();
      } catch (error) {
        // Unknown is busy: a failed read must never let the machine sleep under its work.
        options.logger?.warn("agent37.keep_awake_read_failed", { error: error instanceof Error ? error.message : String(error) });
        state = { busy: true, reasons: ["unknown"] };
      }
      const nextWakeAt = state.nextWakeAt ?? null;
      // An overdue timer fires on this awake machine on its own; only a future one is sent.
      const serverHolds = await syncTimedWake(url, nextWakeAt != null && nextWakeAt > now() ? nextWakeAt : null);
      if (nextWakeAt != null) {
        const window = serverHolds ? AGENT37_KEEP_AWAKE_SCHEDULE_WINDOW_MS : AGENT37_KEEP_AWAKE_UNSENT_SCHEDULE_WINDOW_MS;
        if (nextWakeAt - now() < window && !state.reasons.includes("schedule")) {
          state = { ...state, busy: true, reasons: [...state.reasons, "schedule"] };
        }
      }
      if (state.busy && url) {
        lastPingOk = await ping(url);
        lastPingAt = now();
      }
      if (!url && state.busy && !warnedNoUrl) {
        warnedNoUrl = true;
        options.logger?.info("agent37.keep_awake_no_wake_url", {});
      }
      const key = `${state.busy}|${state.reasons.join(",")}|${url != null}`;
      if (key !== lastState) {
        options.logger?.info("agent37.keep_awake_state", { busy: state.busy, reasons: state.reasons, hasWakeUrl: url != null });
        lastState = key;
        writeState(state.busy, state.reasons, url != null);
      }
    } finally {
      ticking = false;
    }
  };

  return {
    start() {
      if (!enabled || timer || disposed) return;
      // Written at once: ADE reads this file to know the brain keeps the machine
      // awake, and only then lets Agent 37 sleep it.
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
    tick,
  };
}

/** The ready machine's setup job is running (agent37ReadyMachines.ts writes it, the entrypoint runs it). */
export function agent37ReadySetupRunning(adeHome: string): boolean {
  const dir = path.join(adeHome, "ready");
  return fs.existsSync(path.join(dir, "job.started")) && !fs.existsSync(path.join(dir, "job.exit"));
}
