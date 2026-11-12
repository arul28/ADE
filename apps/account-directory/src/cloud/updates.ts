import type { CloudInstance, CloudUpdateChannel, CloudUpdateCheck, CloudUpdateReason, CloudUpdateState } from "./contract";
import { isMeteredStatus } from "./plans";
import { CloudProviderError, type CloudProvider } from "./provider";
import {
  countedDiskGb,
  freePlanOverDisk,
  freeWakeStatements,
  isOutOfHours,
  listComputers,
  liveUsedMilli,
  loadAccount,
  logCloud,
  powerLogStatement,
  reportCloudFailure,
  settleStatements,
  statusChangeStatements,
  statusGuard,
  type CloudEnv,
  type ComputerRow,
} from "./store";

/**
 * Cloud computers update themselves (README, "Updates").
 *
 * The server keeps one image setting per channel (`template_version_stable`,
 * `template_version_beta`; `template_version` is the older single setting and
 * the fallback). A computer updates only when nothing runs on it: when its own
 * brain says it is idle (`reason: "idle"`), or after it has slept for a while
 * (`reason: "asleep"`, the minute cron). The brain reports in after it boots
 * (`POST .../booted`); an update with no report is rolled back once.
 *
 * Automatic updates go only to an image a passed template check named in
 * `auto_update_<channel>` (infra/ade-cloud/promote-template.mjs). A person's
 * "Update this computer" goes to the channel's image whatever that says.
 *
 * The minutes awake for an automatic update are free: they ride the same free
 * window as the push-work wake (`free_wake_started_at`/`free_wake_until`, with
 * `awake_since` held at its end), which the daily reconcile already leaves out.
 * The boot report closes the window, so the hours meter starts there.
 */

/** An update with no boot report this long after the computer came up has failed. */
export const UPDATE_BOOT_REPORT_MS = 15 * 60_000;
/** How long an automatic update's minutes stay free: the provider's update (up to 3 minutes), then the boot report's wait. */
const UPDATE_FREE_WINDOW_MS = UPDATE_BOOT_REPORT_MS + 5 * 60_000;
/** A computer must have slept this long before the cron updates it. */
const ASLEEP_BEFORE_UPDATE_MS = 10 * 60_000;
const AUTO_UPDATES_PER_TICK = 3;
/** Most computers one tick looks at for an automatic update (each may read its account); the rest wait a minute. */
const AUTO_UPDATE_TRIES_PER_TICK = 10;
/** Most timed-out updates one tick fails or rolls back (each may call the provider); the rest wait a minute. */
const UPDATE_TIMEOUTS_PER_TICK = 10;
/** An automatic update the provider refused is tried again after this long. */
const AUTO_RETRY_AFTER_MS = 60 * 60_000;

const AUTOMATIC_REASONS = new Set<CloudUpdateReason>(["idle", "asleep", "rollback"]);

const ROLLED_BACK = "It didn't start on the new version, so ADE put it back on the version before.";
const ROLLBACK_FAILED = "It didn't start on the new version, and going back to the version before didn't work either.";
const NO_EARLIER_VERSION = "It didn't start on the new version, and there was no earlier version to go back to.";

export type CloudUpdateTargets = {
  stable: string | null;
  beta: string | null;
  /** `template_version`: the setting before channels, and the fallback for both. */
  legacy: string | null;
  /** The image a passed check let each channel update to on its own, or "off". */
  autoStable: string | null;
  autoBeta: string | null;
};

const TARGET_KEYS = ["template_version", "template_version_stable", "template_version_beta", "auto_update_stable", "auto_update_beta"];

export async function readUpdateTargets(env: Pick<CloudEnv, "DB">): Promise<CloudUpdateTargets> {
  const rows = await env.DB.prepare("select key, value from cloud_settings where key in (select value from json_each(?))")
    .bind(JSON.stringify(TARGET_KEYS)).all<{ key: string; value: string }>();
  const value = new Map((rows.results ?? []).map((row) => [row.key, row.value?.trim() || null]));
  return {
    legacy: value.get("template_version") ?? null,
    stable: value.get("template_version_stable") ?? null,
    beta: value.get("template_version_beta") ?? null,
    autoStable: value.get("auto_update_stable") ?? null,
    autoBeta: value.get("auto_update_beta") ?? null,
  };
}

/** A channel from a client: `stable`, or `beta` (an Alpha build counts as Beta). Null for anything else. */
export function readUpdateChannel(value: unknown): CloudUpdateChannel | null {
  if (value === "stable") return "stable";
  if (value === "beta" || value === "alpha") return "beta";
  return null;
}

export function channelOfComputer(computer: Pick<ComputerRow, "channel">): CloudUpdateChannel {
  return computer.channel === "beta" ? "beta" : "stable";
}

/** The image a computer on `channel` is made from, and that a person's update moves it to. */
export function channelTemplate(targets: CloudUpdateTargets, channel: CloudUpdateChannel): string | null {
  return (channel === "beta" ? targets.beta : targets.stable) ?? targets.legacy;
}

/** The channel's image, when a passed check let computers update to it on their own; else null. */
export function automaticTemplate(targets: CloudUpdateTargets, channel: CloudUpdateChannel): string | null {
  const target = channelTemplate(targets, channel);
  const allowed = channel === "beta" ? targets.autoBeta : targets.autoStable;
  return target && allowed === target ? target : null;
}

/** Whether the channel's computers update themselves at all: its marker is set and not `off`. */
export function automaticUpdatesOn(targets: CloudUpdateTargets, channel: CloudUpdateChannel): boolean {
  const marker = channel === "beta" ? targets.autoBeta : targets.autoStable;
  return marker != null && marker !== "off";
}

/**
 * Whether the computer should update itself now: behind an allowed image it
 * never failed on, with no update or rollback in flight, and not inside the
 * hour after an automatic try the provider refused (`update_started_at` is
 * set in all three; a settled update clears it). The idle step and the cron
 * both ask this, so neither retries a failing update every time it runs.
 */
export function isBehindAutomatic(
  computer: Pick<ComputerRow, "channel" | "template_version" | "update_failed_template" | "update_state" | "update_started_at">,
  targets: CloudUpdateTargets,
  now: number,
): boolean {
  const target = automaticTemplate(targets, channelOfComputer(computer));
  return target != null
    && computer.update_state !== "updating"
    && (computer.update_started_at == null || now - computer.update_started_at >= AUTO_RETRY_AFTER_MS)
    && computer.template_version !== target
    && computer.update_failed_template !== target;
}

function updateStateOf(computer: Pick<ComputerRow, "update_state">): CloudUpdateState | null {
  return computer.update_state === "updating" || computer.update_state === "failed" ? computer.update_state : null;
}

/** ADE's own update facts on a provider answer, for the client. */
export function withUpdateFacts(
  instance: CloudInstance,
  computer: Pick<ComputerRow, "channel" | "template_version" | "update_state" | "updated_at" | "update_error"> | null | undefined,
  targets: CloudUpdateTargets,
): CloudInstance {
  if (!computer) return instance;
  const channel = channelOfComputer(computer);
  return {
    ...instance,
    channel,
    templateVersion: computer.template_version,
    targetTemplate: channelTemplate(targets, channel),
    autoUpdate: automaticUpdatesOn(targets, channel),
    updateState: updateStateOf(computer),
    updatedAt: computer.updated_at ?? null,
    updateError: computer.update_state === "failed" ? computer.update_error ?? null : null,
  };
}

export function updateCheckOf(computer: ComputerRow, targets: CloudUpdateTargets, now: number): CloudUpdateCheck {
  const channel = channelOfComputer(computer);
  return {
    behind: isBehindAutomatic(computer, targets, now),
    channel,
    templateVersion: computer.template_version,
    targetTemplate: channelTemplate(targets, channel),
    updateState: updateStateOf(computer),
  };
}

/** Why the account's computers may not wake now (0 hours, or disk the free plan doesn't cover). The same test as the routes' `wakeBlocker`. */
export async function updateBlocked(env: CloudEnv, userId: string, now: number): Promise<"out_of_hours" | "over_plan_disk" | "account_deleted" | null> {
  const account = await loadAccount(env, userId, now);
  if (account.deleted_at != null) return "account_deleted";
  const computers = await listComputers(env, userId);
  if (isOutOfHours(account, liveUsedMilli(account, computers, now))) return "out_of_hours";
  return freePlanOverDisk(account, countedDiskGb(computers)) ? "over_plan_disk" : null;
}

/**
 * The free window for an automatic update: what ran metered so far is charged,
 * and the meter waits until the boot report (at most `UPDATE_FREE_WINDOW_MS`). A window already open (a rollback after an
 * automatic update) keeps its start, so its earlier minutes stay free too.
 * Asleep, the 30-day delete clock stays where it was: an update isn't use.
 */
function freeWindowStatements(env: CloudEnv, computer: ComputerRow, status: string, now: number, freeUntil = now + UPDATE_FREE_WINDOW_MS): D1PreparedStatement[] {
  const guard = statusGuard(computer);
  const meteredNow = computer.awake_since != null && computer.awake_since <= now;
  const windowOpen = computer.free_wake_started_at != null && computer.free_wake_until != null && computer.free_wake_until > now;
  const closing = [
    ...(meteredNow ? settleStatements(env, computer, now, guard) : []),
    // A window that already ended (the meter ran after it) is recorded before this one replaces it.
    ...(!windowOpen ? freeWakeStatements(env, computer, now, guard) : []),
  ];
  const freeStart = windowOpen ? computer.free_wake_started_at! : now;
  const lastAwakeAt = meteredNow ? now : computer.last_awake_at;
  computer.status = status;
  computer.status_changed_at = now;
  computer.awake_since = freeUntil;
  computer.free_wake_started_at = freeStart;
  computer.free_wake_until = freeUntil;
  computer.last_awake_at = lastAwakeAt;
  computer.cold_storage = 0;
  return [
    ...closing,
    env.DB.prepare(`
      update cloud_computers set status = ?, status_changed_at = ?, awake_since = ?, last_awake_at = ?,
        free_wake_started_at = ?, free_wake_until = ?, cold_storage = 0
      where instance_id = ?
    `).bind(status, now, freeUntil, lastAwakeAt, freeStart, freeUntil, computer.instance_id),
  ];
}

/**
 * The tick saw an asleep computer awake. When an automatic update left it
 * asleep ("it boots on its next wake") and the provider booted it inside the
 * update's window (Agent 37 does, about a minute later), that boot is the
 * update's: free until the boot report, as for an update of an awake computer,
 * and recorded in `free_ms` so the daily reconcile matches the provider. Null
 * for any other wake, which `statusChangeStatements` meters as usual.
 */
export function updateBootStatements(env: CloudEnv, computer: ComputerRow, status: string, now: number): D1PreparedStatement[] | null {
  if (computer.update_state !== "updating" || computer.update_started_at == null) return null;
  if (!computer.update_reason || !AUTOMATIC_REASONS.has(computer.update_reason as CloudUpdateReason)) return null;
  if (computer.awake_since != null || !isMeteredStatus(status)) return null;
  // The same end the boot report looks for, so the report closes this window too.
  const windowEnd = computer.update_started_at + UPDATE_FREE_WINDOW_MS;
  if (now >= windowEnd) return null;
  return [
    ...freeWindowStatements(env, computer, status, now, windowEnd),
    powerLogStatement(env, computer, "wake", "update_boot", now),
  ];
}

/** After the provider took the update: the status, the meter and the power log. */
function startedStatements(env: CloudEnv, computer: ComputerRow, status: string, reason: CloudUpdateReason, now: number): D1PreparedStatement[] {
  const log = powerLogStatement(env, computer, "update", `update_${reason}`, now);
  // A computer the provider left asleep with the new image boots on its next wake: the
  // tick opens the free window then, if that boot comes inside the update's window (`updateBootStatements`).
  if (AUTOMATIC_REASONS.has(reason) && isMeteredStatus(status)) return [...freeWindowStatements(env, computer, status, now), log];
  return [...statusChangeStatements(env, computer, status, now, "update"), log];
}

export class CloudUpdateInProgressError extends Error {
  constructor() {
    super("This computer is already updating. Try again in a few minutes.");
    this.name = "CloudUpdateInProgressError";
  }
}

/**
 * Moves a computer to `target`. The old image goes to `previous_template`
 * first, and one update at a time: a second one while this computer waits for
 * its boot report throws `CloudUpdateInProgressError`. A provider failure puts
 * the row back and throws; an automatic one is tried again an hour later.
 * `expectsReport`: the target is an image a passed check allowed (it sends a
 * boot report), as the settings read now. Saved on the row, so the rollback
 * decision can't change with a setting moved during the wait.
 */
export async function startCloudUpdate(
  env: CloudEnv,
  provider: Pick<CloudProvider, "updateInstance">,
  computer: ComputerRow,
  args: { reason: Exclude<CloudUpdateReason, "rollback">; target: string; expectsReport: boolean; now: number },
): Promise<{ status: string; templateVersion: string }> {
  const { reason, target, now } = args;
  const expects = args.expectsReport ? 1 : 0;
  const claimed = await env.DB.prepare(`
    update cloud_computers set previous_template = template_version, template_version = ?, update_state = 'updating',
      update_started_at = ?, update_reason = ?, update_error = null, update_expects_report = ?
    where instance_id = ? and deleted_at is null and (update_state is null or update_state <> 'updating')
  `).bind(target, now, reason, expects, computer.instance_id).run();
  if (claimed.meta.changes !== 1) throw new CloudUpdateInProgressError();
  let status: string;
  try {
    status = await provider.updateInstance(computer.instance_id, target);
  } catch (error) {
    // Nothing moved: the row reads as before, except that an automatic try
    // waits an hour (its start time), and a finished rollback's reason gives
    // way to this try's, so the time can't read as a rollback in flight.
    const automatic = reason !== "manual";
    await env.DB.prepare(`
      update cloud_computers set template_version = ?, previous_template = ?, update_state = ?, update_started_at = ?,
        update_reason = ?, update_error = ?, update_expects_report = ?
      where instance_id = ? and update_state = 'updating' and update_started_at = ?
    `).bind(
      computer.template_version, computer.previous_template, computer.update_state,
      automatic ? now : computer.update_started_at,
      automatic && computer.update_reason === "rollback" ? reason : computer.update_reason,
      computer.update_error, computer.update_expects_report ?? null,
      computer.instance_id, now,
    ).run();
    if (automatic) {
      reportCloudFailure("cloud.auto_update_start_failed", { instanceId: computer.instance_id, reason, code: error instanceof CloudProviderError ? error.code : "unknown" });
    }
    throw error;
  }
  computer.previous_template = computer.template_version;
  computer.template_version = target;
  computer.update_state = "updating";
  computer.update_started_at = now;
  computer.update_reason = reason;
  computer.update_error = null;
  computer.update_expects_report = expects;
  await env.DB.batch(startedStatements(env, computer, status, reason, now));
  logCloud("cloud.update_started", { instanceId: computer.instance_id, reason, target });
  return { status, templateVersion: target };
}

/**
 * The computer's brain started (every brain start reports). It settles a
 * waiting update (success) or a rollback in flight, and closes the free
 * window of an automatic one. `sleepWhenIdle`: it woke only for an update, so
 * it may sleep at its first idle check instead of after three minutes.
 */
export async function recordBootReport(env: CloudEnv, computer: ComputerRow, adeVersion: string | null, now: number): Promise<{ sleepWhenIdle: boolean }> {
  const updating = computer.update_state === "updating";
  const rollingBack = computer.update_state === "failed" && computer.update_reason === "rollback" && computer.update_started_at != null;
  if (!updating && !rollingBack) return { sleepWhenIdle: false };
  const automatic = computer.update_reason != null && AUTOMATIC_REASONS.has(computer.update_reason as CloudUpdateReason);
  const statements: D1PreparedStatement[] = [
    updating
      ? env.DB.prepare(`
          update cloud_computers set update_state = null, update_started_at = null, update_error = null,
            update_failed_template = null, updated_at = ?
          where instance_id = ? and update_state = 'updating' and update_started_at = ?
        `).bind(now, computer.instance_id, computer.update_started_at)
      : env.DB.prepare("update cloud_computers set update_started_at = null where instance_id = ? and update_started_at = ?")
        .bind(computer.instance_id, computer.update_started_at),
  ];
  if (automatic) {
    // The meter starts now. Only the window this update (or rollback) set,
    // which ends exactly `UPDATE_FREE_WINDOW_MS` after its start; a push-work
    // wake's window ends elsewhere and is left alone.
    statements.push(env.DB.prepare(`
      update cloud_computers set awake_since = ?, free_wake_until = ?
      where instance_id = ? and awake_since > ? and free_wake_until = ?
    `).bind(now, now, computer.instance_id, now, computer.update_started_at! + UPDATE_FREE_WINDOW_MS));
  }
  await env.DB.batch(statements);
  logCloud("cloud.update_booted", { instanceId: computer.instance_id, reason: computer.update_reason, adeVersion, rollback: rollingBack });
  return { sleepWhenIdle: automatic && computer.update_reason !== "idle" };
}

/**
 * Whether the update in flight's image sends a boot report: as saved when it
 * started. An update started before that was saved falls back to the
 * channel's allowed image as it reads now (the only thing there was).
 */
function expectsBootReport(computer: ComputerRow, targets: CloudUpdateTargets): boolean {
  const failed = computer.template_version;
  if (failed == null) return false;
  if (computer.update_expects_report != null) return computer.update_expects_report === 1;
  return automaticTemplate(targets, channelOfComputer(computer)) === failed;
}

/**
 * No boot report: roll back once to the image before. An image no passed
 * check let computers update to (one older than boot reports, while this
 * rolls out) can't report, so its update is only settled, never undone.
 * Either way the state lets a later image be tried: a settled update leaves
 * the computer on its image with nothing in flight, and a failed one names its
 * image in `update_failed_template`, which is never tried again on its own.
 */
async function failUpdate(env: CloudEnv, provider: Pick<CloudProvider, "updateInstance">, computer: ComputerRow, targets: CloudUpdateTargets, now: number): Promise<void> {
  const failed = computer.template_version;
  const startedAt = computer.update_started_at!;
  const canReport = expectsBootReport(computer, targets);
  if (!canReport) {
    await env.DB.prepare("update cloud_computers set update_state = null, update_started_at = null where instance_id = ? and update_state = 'updating' and update_started_at = ?")
      .bind(computer.instance_id, startedAt).run();
    logCloud("cloud.update_settled_unreported", { instanceId: computer.instance_id, template: failed });
    return;
  }
  const previous = computer.previous_template;
  if (!previous || previous === failed) {
    await env.DB.prepare(`
      update cloud_computers set update_state = 'failed', update_started_at = null, update_failed_template = ?, update_error = ?
      where instance_id = ? and update_state = 'updating' and update_started_at = ?
    `).bind(failed, NO_EARLIER_VERSION, computer.instance_id, startedAt).run();
    reportCloudFailure("cloud.update_failed_no_rollback", { instanceId: computer.instance_id, template: failed });
    return;
  }
  const claimed = await env.DB.prepare(`
    update cloud_computers set update_state = 'failed', update_reason = 'rollback', update_failed_template = ?,
      template_version = ?, update_started_at = ?, update_error = ?
    where instance_id = ? and update_state = 'updating' and update_started_at = ?
  `).bind(failed, previous, now, ROLLED_BACK, computer.instance_id, startedAt).run();
  if (claimed.meta.changes !== 1) return;
  reportCloudFailure("cloud.update_failed_rolling_back", { instanceId: computer.instance_id, template: failed });
  computer.update_state = "failed";
  computer.update_reason = "rollback";
  computer.update_failed_template = failed;
  computer.template_version = previous;
  computer.update_started_at = now;
  computer.update_error = ROLLED_BACK;
  try {
    const status = await provider.updateInstance(computer.instance_id, previous);
    await env.DB.batch(startedStatements(env, computer, status, "rollback", now));
  } catch (error) {
    // Still on the failed image; the next tick leaves it alone (no start time).
    await env.DB.prepare("update cloud_computers set template_version = ?, update_started_at = null, update_error = ? where instance_id = ? and update_started_at = ?")
      .bind(failed, ROLLBACK_FAILED, computer.instance_id, now).run();
    reportCloudFailure("cloud.update_rollback_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
  }
}

/** Since when a computer had the chance to report: the update's start, or its last wake after that. */
function reportClockStart(computer: ComputerRow): number {
  return Math.max(computer.update_started_at ?? 0, computer.status_changed_at);
}

/**
 * The minute cron's part. `computers` are the live rows with this tick's
 * statuses; `blockedUsers` are accounts whose computers may not wake.
 * 1. An update awake 15 minutes with no boot report fails and rolls back once;
 *    a rollback with no report is left failed and never looped on.
 * 2. Up to three computers asleep for 10 minutes and behind their channel's
 *    allowed image update, unless their account can't wake them.
 */
export async function runCloudAutoUpdates(
  env: CloudEnv,
  provider: Pick<CloudProvider, "updateInstance">,
  computers: ComputerRow[],
  blockedUsers: ReadonlySet<string>,
  now: number,
): Promise<void> {
  if (computers.length === 0) return;
  const waiting = computers.filter((computer) => computer.update_started_at != null
    && (computer.update_state === "updating" || (computer.update_state === "failed" && computer.update_reason === "rollback")));
  const targets = await readUpdateTargets(env);

  // Asleep or stopped: it reports when it next boots.
  const timedOut = waiting.filter((computer) => isMeteredStatus(computer.status) && now - reportClockStart(computer) >= UPDATE_BOOT_REPORT_MS);
  for (const computer of timedOut.slice(0, UPDATE_TIMEOUTS_PER_TICK)) {
    try {
      if (computer.update_state === "updating") {
        await failUpdate(env, provider, computer, targets, now);
      } else if (computer.update_reason === "rollback") {
        await env.DB.prepare("update cloud_computers set update_started_at = null, update_error = ? where instance_id = ? and update_started_at = ?")
          .bind(ROLLBACK_FAILED, computer.instance_id, computer.update_started_at).run();
        reportCloudFailure("cloud.update_rollback_unreported", { instanceId: computer.instance_id });
      }
    } catch (error) {
      reportCloudFailure("cloud.update_check_failed", { instanceId: computer.instance_id, message: error instanceof Error ? error.message : "unknown" });
    }
  }

  if (!targets.autoStable && !targets.autoBeta) return;
  // A move's source and its new computer are left alone until the move ends.
  const moving = new Set(computers.flatMap((computer) => (computer.moving_from ? [computer.moving_from, computer.instance_id] : [])));
  const due = computers.filter((computer) =>
    computer.status === "sleeping"
    && now - computer.status_changed_at >= ASLEEP_BEFORE_UPDATE_MS
    && computer.cold_storage !== 1
    && !moving.has(computer.instance_id)
    && !blockedUsers.has(computer.user_id)
    && !(computer.free_wake_until != null && computer.free_wake_until > now)
    && isBehindAutomatic(computer, targets, now));
  let started = 0;
  for (const computer of due.slice(0, AUTO_UPDATE_TRIES_PER_TICK)) {
    if (started >= AUTO_UPDATES_PER_TICK) break;
    const target = automaticTemplate(targets, channelOfComputer(computer));
    if (!target) continue;
    try {
      if (await updateBlocked(env, computer.user_id, now)) continue;
      started += 1;
      await startCloudUpdate(env, provider, computer, { reason: "asleep", target, expectsReport: true, now });
    } catch (error) {
      if (error instanceof CloudUpdateInProgressError) continue;
      // Reported inside, and retried after `AUTO_RETRY_AFTER_MS`.
      logCloud("cloud.auto_update_skipped", { instanceId: computer.instance_id, message: error instanceof Error ? error.message : "unknown" });
    }
  }
}
