import { CLOUD_SIGN_IN_END_GRACE_MS, cloudSignInWaitMsFor } from "./contract";
import { cloudSizeFor, cloudSizeForTier, usesHours } from "./plans";
import { logCloud, reportCloudFailure, settleStatements, stretchChargeEnd, type CloudEnv, type ComputerRow, type StatusGuard } from "./store";

/**
 * A launch's provider sign-in wait is free time on its computer: a launch
 * that ends in its sign-in step (a timeout, a cancel, a change to a free
 * model then a cancel) charges nothing for its computer. It is the same kind
 * of free time as an automatic update's window (`updates.ts`): the computer's
 * `free_wake_started_at` / `free_wake_until` hold it, `awake_since` waits at
 * its end, and the stretch's close records it in `free_ms`, so the stretch,
 * the day rows, the period roll and the daily reconcile all agree.
 *
 * - It opens on the computer's first `waiting_for_sign_in` report, from a
 *   brain that reports its terminals (its sign-in names `expiresAt`), on a
 *   size that uses credits, at most `SIGN_IN_FREE_WAITS_PER_DAY` times an
 *   account a UTC day. It starts at the computer's first awake moment: the
 *   join and the clone before the step are part of it.
 * - The sign-in finished (the chat starts, on its provider or on a free
 *   model): the whole wait is charged, as before (`chargeSignInWait`).
 * - Someone used the computer during it (a chat, a CLI, a terminal): the time
 *   from that report on is charged (`endSignInFreeAt`).
 * - It ends by itself at the wait's end: the computer's `expiresAt` (held to
 *   the server's own length, `cloudSignInWaitMsFor`: 30 minutes, a cloud Mac
 *   10) plus `CLOUD_SIGN_IN_END_GRACE_MS` for the failed report and the
 *   computer's delete, and never past `SIGN_IN_FREE_MAX_MS` from the
 *   computer's start. The meter runs again from there.
 */

/** Free sign-in waits an account gets a UTC day; later ones are charged as before, and the step says so. */
export const SIGN_IN_FREE_WAITS_PER_DAY = 3;
/** The longest free window from the computer's first awake moment, whatever the wait (`SIGN_IN_WAIT_MS` in launches.ts, the end for a computer gone silent). */
export const SIGN_IN_FREE_MAX_MS = 45 * 60_000;

export const SIGN_IN_FREE_SENTENCE = "Nothing is charged if you cancel here.";
export const SIGN_IN_ENDED_FREE_NOTE = "Nothing was charged for the wait.";
/** The wait was free until someone used the computer (`endSignInFreeAt`): the meter ran from then. */
export const SIGN_IN_ENDED_CUT_NOTE = "The wait was free until the computer was used, then it used credits.";
/** A wait with no free window (the day's free waits were used, an older computer) on a size that uses credits. */
export const SIGN_IN_ENDED_CHARGED_NOTE = "This wait used credits.";
/** A cloud Mac's size is called "Mac" (`plans.ts` on the Mac branch): "This Mac uses…", not "This Mac computer uses…". */
export const signInChargedSentence = (sizeLabel: string): string =>
  sizeLabel === "Mac" ? "This Mac uses credits while it waits." : `This ${sizeLabel} computer uses credits while it waits.`;

/** The launch row's free-wait columns (migration 0076). */
export type SignInWaitLaunch = {
  launch_id: string;
  user_id: string;
  instance_id: string | null;
  size_id: string | null;
  /** The launch's request (its `os` sets the wait's length, `cloudSignInWaitMsFor`). */
  request_json?: string | null;
  sign_in_free_at?: number | null;
  sign_in_free_opened_at?: number | null;
  sign_in_charged_at?: number | null;
  /** Someone used the computer during the wait (`endSignInFreeAt`): the step says it uses credits from then. */
  sign_in_used_at?: number | null;
};

/** The size's name for the step's line. */
function sizeLabelOf(launch: SignInWaitLaunch, computer: Pick<ComputerRow, "type" | "cpu" | "memory_gb"> | null): string {
  const size = (computer ? cloudSizeFor(computer.type, computer.cpu, computer.memory_gb) : null) ?? cloudSizeForTier(launch.size_id);
  return size?.label ?? "cloud";
}

/** The guard of a statement that acts on this launch's free window only while the computer still holds it. */
function windowGuard(instanceId: string, start: number): StatusGuard {
  return {
    sql: "exists (select 1 from cloud_computers where instance_id = ? and free_wake_started_at = ? and deleted_at is null)",
    binds: [instanceId, start],
  };
}

/** The wait has had a free window, and nothing charged or cut it. */
const stillFree = (launch: SignInWaitLaunch): boolean =>
  launch.sign_in_free_at != null && launch.sign_in_charged_at == null && launch.sign_in_used_at == null;

/**
 * The line under the step, from what the server knows: free, charged (with
 * the size), or nothing for a size that uses no credits.
 */
export function signInChargeOf(launch: SignInWaitLaunch, computer: Pick<ComputerRow, "multiplier_milli" | "type" | "cpu" | "memory_gb"> | null): { free: boolean; sentence: string } | null {
  if (!computer || !usesHours(computer.multiplier_milli)) return null;
  if (stillFree(launch)) return { free: true, sentence: SIGN_IN_FREE_SENTENCE };
  return { free: false, sentence: signInChargedSentence(sizeLabelOf(launch, computer)) };
}

/**
 * A launch that ended in its sign-in step: what its card says at the end about
 * the wait's cost, from the launch alone. A wait still free, or one cut by use.
 * A wait that never had a free window needs its computer's rate
 * (`signInChargedEndNoteOf`). A sign-in that finished charged its wait and
 * says nothing here.
 */
export function signInEndNoteOf(launch: SignInWaitLaunch & { state: string }): string | null {
  if (launch.state !== "failed" && launch.state !== "cancelled") return null;
  if (stillFree(launch)) return SIGN_IN_ENDED_FREE_NOTE;
  if (launch.sign_in_free_at != null && launch.sign_in_used_at != null && launch.sign_in_charged_at == null) return SIGN_IN_ENDED_CUT_NOTE;
  return null;
}

/**
 * An ended launch whose wait had no free window: "This wait used credits." when
 * it reached its sign-in step (`reachedSignIn`, its computer reported the step),
 * nothing charged or opened it, and its computer's rate uses credits, the same
 * rule as the step's own line (`signInChargeOf`).
 */
export function signInChargedEndNoteOf(
  launch: SignInWaitLaunch & { state: string },
  reachedSignIn: boolean,
  computer: Pick<ComputerRow, "multiplier_milli"> | null,
): string | null {
  if (launch.state !== "failed" && launch.state !== "cancelled") return null;
  if (!reachedSignIn || launch.sign_in_free_at != null || launch.sign_in_charged_at != null) return null;
  return computer && usesHours(computer.multiplier_milli) ? SIGN_IN_ENDED_CHARGED_NOTE : null;
}

/**
 * Opens the free window, once per launch. Nothing when the size uses no
 * credits, the computer isn't metered now, another free window is open (an
 * update's), or the account had its free waits today. Never fails the report.
 */
/** The wait's length for this launch, from its request (`cloudSignInWaitMsFor`). */
export function signInWaitMsOf(launch: Pick<SignInWaitLaunch, "request_json">): number {
  try {
    return cloudSignInWaitMsFor(launch.request_json ? JSON.parse(launch.request_json) as unknown : null);
  } catch {
    return cloudSignInWaitMsFor(null);
  }
}

/** `expiresAt`: when the computer said its wait ends; held to the server's own length from now. */
export async function openSignInFreeWait(env: CloudEnv, launch: SignInWaitLaunch, computer: ComputerRow | null, now: number, expiresAt: number): Promise<boolean> {
  try {
    if (!computer || launch.sign_in_free_opened_at != null) return false;
    if (!usesHours(computer.multiplier_milli)) return false;
    const start = computer.awake_since;
    if (start == null || start > now) return false;
    if (computer.free_wake_started_at != null || computer.free_wake_until != null) return false;
    const dayStart = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
    const used = await env.DB.prepare(`
      select count(*) as n from cloud_launches where user_id = ? and sign_in_free_opened_at >= ?
    `).bind(launch.user_id, dayStart).first<{ n: number }>();
    if ((used?.n ?? 0) >= SIGN_IN_FREE_WAITS_PER_DAY) return false;
    // The claim counts the day's waits again in its own write: two computers that report their first wait
    // together can't both open one past the allowance.
    const waitEnds = Math.min(expiresAt, now + signInWaitMsOf(launch));
    const until = Math.min(start + SIGN_IN_FREE_MAX_MS, waitEnds + CLOUD_SIGN_IN_END_GRACE_MS);
    if (until <= now) return false;
    // The launch claims its one window first; the computer's write holds only while its meter is the one read.
    const [claimed, opened] = await env.DB.batch([
      env.DB.prepare(`
        update cloud_launches set sign_in_free_at = ?, sign_in_free_opened_at = ?
        where launch_id = ? and sign_in_free_opened_at is null
          and (select count(*) from cloud_launches where user_id = ? and sign_in_free_opened_at >= ?) < ?
          and exists (select 1 from cloud_computers where instance_id = ? and awake_since = ? and free_wake_started_at is null and free_wake_until is null and deleted_at is null)
      `).bind(start, now, launch.launch_id, launch.user_id, dayStart, SIGN_IN_FREE_WAITS_PER_DAY, computer.instance_id, start),
      env.DB.prepare(`
        update cloud_computers set awake_since = ?, free_wake_started_at = ?, free_wake_until = ?
        where instance_id = ? and awake_since = ? and free_wake_started_at is null and free_wake_until is null and deleted_at is null
          and exists (select 1 from cloud_launches where launch_id = ? and sign_in_free_at = ? and sign_in_free_opened_at = ?)
      `).bind(until, start, until, computer.instance_id, start, launch.launch_id, start, now),
    ]);
    const ok = (claimed?.meta?.changes ?? 0) === 1 && (opened?.meta?.changes ?? 0) === 1;
    if (ok) {
      computer.awake_since = until;
      computer.free_wake_started_at = start;
      computer.free_wake_until = until;
      launch.sign_in_free_at = start;
      launch.sign_in_free_opened_at = now;
      logCloud("cloud.sign_in_wait_free", { launchId: launch.launch_id, instanceId: computer.instance_id });
    }
    return ok;
  } catch (error) {
    reportCloudFailure("cloud.sign_in_wait_free_failed", { launchId: launch.launch_id, message: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}

/**
 * Charges the free part of the wait, as if it had never been free: the
 * sign-in finished and the chat starts. The free part is charged at the
 * computer's rate now; the meter after it (a window that ended, or that
 * `endSignInFreeAt` cut) is already in the stretch and is never charged
 * twice. Never fails the report.
 */
export async function chargeSignInWait(env: CloudEnv, launch: SignInWaitLaunch, now: number): Promise<void> {
  const start = launch.sign_in_free_at;
  if (start == null || launch.sign_in_charged_at != null || !launch.instance_id) return;
  try {
    const computer = await env.DB.prepare("select * from cloud_computers where instance_id = ? and deleted_at is null").bind(launch.instance_id).first<ComputerRow>();
    if (!computer || computer.free_wake_started_at !== start || computer.free_wake_until == null) return;
    const freeEnd = Math.min(now, computer.free_wake_until);
    const guard = windowGuard(computer.instance_id, start);
    const stillOpen = computer.awake_since != null && computer.awake_since > now;
    // A cloud Mac bills by the whole minute: the charge ends on the last whole minute of the wait,
    // and the open stretch starts there, so its part minute is charged once (`stretchChargeEnd`).
    const chargedEnd = stretchChargeEnd({ ...computer, awake_since: start }, freeEnd, true);
    await env.DB.batch([
      env.DB.prepare("update cloud_launches set sign_in_charged_at = ? where launch_id = ? and sign_in_charged_at is null and sign_in_free_at = ?")
        .bind(now, launch.launch_id, start),
      ...settleStatements(env, { ...computer, awake_since: start }, freeEnd, guard, { partial: true }),
      // Last: the writes above read the window through the guard. The open stretch starts where the
      // charge ended (`chargedEnd`, which is `freeEnd` except a Mac's part minute): for a window still open
      // (its `awake_since` waits at the window's end) or one cut by use (its stretch began at the cut,
      // `endSignInFreeAt`); nothing is charged twice.
      env.DB.prepare(`
        update cloud_computers set awake_since = case when awake_since > ? or awake_since = ? then ? else awake_since end,
          free_wake_started_at = null, free_wake_until = null
        where instance_id = ? and free_wake_started_at = ?
      `).bind(now, freeEnd, chargedEnd, computer.instance_id, start),
    ]);
    launch.sign_in_charged_at = now;
    logCloud("cloud.sign_in_wait_charged", { launchId: launch.launch_id, instanceId: computer.instance_id, why: "signed_in", open: stillOpen });
  } catch (error) {
    reportCloudFailure("cloud.sign_in_wait_charge_failed", { launchId: launch.launch_id, message: error instanceof Error ? error.name : "unknown" });
  }
}

/**
 * Someone used the computer during the wait (its brain's `/use` at the first
 * remote work, or its activity report naming a chat, a CLI or a terminal):
 * the meter runs from `at`. What came before stays free, recorded in
 * `free_ms` when the stretch closes, unless the sign-in still finishes
 * (`chargeSignInWait` charges it then). Never fails the report.
 */
export async function endSignInFreeAt(env: CloudEnv, computer: ComputerRow, at: number): Promise<void> {
  const start = computer.free_wake_started_at;
  if (start == null || computer.awake_since == null || computer.awake_since <= at) return;
  try {
    const launch = await env.DB.prepare(`
      select launch_id from cloud_launches where instance_id = ? and sign_in_free_at = ? and sign_in_charged_at is null
    `).bind(computer.instance_id, start).first<{ launch_id: string }>();
    if (!launch) return;
    // Only the window is cut: a sign-in that still finishes charges the part before `at` too (`chargeSignInWait`).
    // The launch notes the use, so its step says it uses credits now. Both hold only while the window is open.
    const [cut] = await env.DB.batch([
      env.DB.prepare(`
        update cloud_computers set awake_since = ?, free_wake_until = ?
        where instance_id = ? and free_wake_started_at = ? and awake_since > ?
      `).bind(at, at, computer.instance_id, start, at),
      env.DB.prepare(`
        update cloud_launches set sign_in_used_at = ? where launch_id = ? and sign_in_used_at is null
          and exists (select 1 from cloud_computers where instance_id = ? and free_wake_started_at = ? and free_wake_until = ?)
      `).bind(at, launch.launch_id, computer.instance_id, start, at),
    ]);
    if ((cut?.meta?.changes ?? 0) === 1) {
      computer.awake_since = at;
      computer.free_wake_until = at;
      logCloud("cloud.sign_in_wait_used", { launchId: launch.launch_id, instanceId: computer.instance_id });
    }
  } catch (error) {
    reportCloudFailure("cloud.sign_in_wait_charge_failed", { instanceId: computer.instance_id, message: error instanceof Error ? error.name : "unknown" });
  }
}

/** Whether a brain's activity report names work a person started (anything but the launch's own wait). */
export function reportNamesWork(report: { runningAgents?: unknown; fullPriceWork?: unknown; openTerminals?: unknown }): boolean {
  const agents = typeof report.runningAgents === "number" ? report.runningAgents : 0;
  const work = Array.isArray(report.fullPriceWork) ? report.fullPriceWork.length : 0;
  const terminals = typeof report.openTerminals === "number" ? report.openTerminals : 0;
  return agents > 0 || work > 0 || terminals > 0;
}

const IOS_APP_AGENT = /^(?:DAEX|ADE)-iOS\//;

/** Which screen sent a person's request, for the step's events: the iPhone app, a browser, or the desktop app. */
export function signInClientOf(request: Request): "desktop" | "web" | "ios" {
  const agent = request.headers.get("user-agent")?.trim() ?? "";
  if (IOS_APP_AGENT.test(agent)) return "ios";
  if (/Mozilla\//.test(agent) && !/Electron\//.test(agent)) return "web";
  return "desktop";
}
