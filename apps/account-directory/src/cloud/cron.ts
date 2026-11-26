import { carryLaunchMessagesForComputer, expireChatMessages } from "./chatMessages";
import { runLinearRenewalCron } from "./linearRenewal";
import { captureCloudDay, type CloudWaitUntil } from "./analytics";
import { cancelTimedWakes, type WakeBlock } from "./accountNotices";
import { forgetDeletedAccountComputers } from "./accountDeletion";
import { resolvePendingPhoneBeta } from "./phoneBeta";
import { enforcePhoneAllowance, runPhoneChecks, stopPhonesDue } from "./phones";
import { unsettledPhoneMilliByUser } from "./credits";
import { sendCloudEmail } from "./email";
import { warnHours } from "./hoursWarnings";
import { laneFactsStatement } from "./lanesWithoutComputer";
import { markRestedWithBackups } from "./laneBackups";
import { sweepLeftovers } from "./storageSweeps";
import type { CloudInstance } from "./contract";
import { refreshCostEstimate, runDailyCostReport } from "./costReport";
import { REVYL_COST_DAYS_BACK, recordRevylDayCosts } from "./phoneRevyl";
import { AWAKE_COMPUTER_CAP, DISK_COST_MICROS_PER_GB_DAY, cloudSizeFor, usesHours, computeCostMicrosFor, hoursMilliFor, isMeteredStatus, isRestingStatus, tierOf, utcDay } from "./plans";
import { CloudProviderError, TRY_AGAIN_CODE, createCloudProvider, type CloudProvider } from "./provider";
import { runPlanLimitChecks } from "./planCleanup";
import { enforceBlocksInTick } from "./safety";
import { computersJoiningLaunches } from "./launches";
import { computersInJobs } from "./jobs";
import { runCloudAutoUpdates, updateBootStatements } from "./updates";
import {
  PENDING_TIMEOUT_MS,
  adoptionStatements,
  deleteComputer,
  diskDayStatement,
  hasNoFreePlan,
  freeShareSql,
  goneFromProviderStatements,
  groupByUser,
  hoursState,
  isOutOfHours,
  isPendingId,
  MOVE_GRACE_MS,
  liveUsedMilli,
  logCloud,
  nameMachineAfterComputerStatement,
  planIdOf,
  reportCloudFailure,
  readSetting,
  readTimeSetting,
  restartStretchStatements,
  rollPeriodIfDue,
  statusChangeStatements,
  writeSetting,
  type AccountRow,
  type CloudEnv,
  type ComputerRow,
} from "./store";

/**
 * The minute cron for ADE Cloud (README, "ADE Cloud account"). One provider
 * list per tick, no writes unless something changed, nothing at all when no
 * computer exists. Daily and ten-minute work ride the same tick behind a
 * stored time.
 */

const NO_CHECK_IN_MS = 10 * 60_000;
/** A grow the provider hasn't reported yet is left alone this long, so the tick can't give its room away. */
const DISK_GROW_SETTLE_MS = 10 * 60_000;
/** Exec gets this long; the command gives itself 40 s. */
const PREPARE_STOP_TIMEOUT_MS = 45_000;
/** `ade brain update` puts the newer ADE on the disk (`$ADE_HOME/bin`), which the image's PATH doesn't reach. */
const PREPARE_STOP_COMMAND = 'PATH="$ADE_HOME/bin:$PATH" ade cloud prepare-stop --timeout 40 --json';
const ZERO_STOP_RETRY_GUARD_MS = 2 * 60_000;
const STOP_RETRIES = 3;
const STOP_RETRY_DELAY_MS = 3_000;
const GONE_CHECKS_PER_TICK = 5;
/** Daily work waits for the provider's compute meter to land. */
const DAILY_AFTER_HOUR_UTC = 2;
const RECONCILE_DAYS_BEHIND = 3;
/** Most accounts one tick starts a new period for; the rest wait for the next minute. */
const PERIOD_ROLLS_PER_TICK = 200;
/** How long a daily run holds its claim, so overlapping ticks don't both run it. */
const DAILY_CLAIM_MS = 15 * 60_000;
const OWNER_CHECK_INTERVAL_MS = 10 * 60_000;
const OWNER_ALERT_REPEAT_MS = 24 * 60 * 60_000;
const WALLET_ALERT_USD = 15;
const AWAKE_LIMIT_ALERT_FRACTION = 0.8;
const UNEXPLAINED_MINUTES = 15;

type TickComputer = ComputerRow & { last_seen_at: number | null };

export async function runCloudMinuteCron(env: CloudEnv, options: { now?: number; provider?: CloudProvider; waitUntil?: CloudWaitUntil } = {}): Promise<void> {
  const now = options.now ?? Date.now();
  const waitUntil = options.waitUntil;
  // Rows only, no provider: a queued message never arrives days late, and final rows don't pile up.
  await expireChatMessages(env, now).catch((error: unknown) => {
    reportCloudFailure("cloud.chat_messages_sweep_failed", { message: error instanceof Error ? error.message : "unknown" });
  });
  // Saved storage a request let go of but didn't finish deleting (`storageSweeps.ts`).
  await sweepLeftovers(env, now).catch((error: unknown) => {
    reportCloudFailure("cloud.storage_sweeps_failed", { message: error instanceof Error ? error.message : "unknown" });
  });
  // No provider either: a renewed Linear grant whose publish failed during the request is published here, so it is not lost.
  await runLinearRenewalCron(env, now).catch((error: unknown) => {
    reportCloudFailure("cloud.linear_renewal_cron_failed", { message: error instanceof Error ? error.message : "unknown" });
  });
  // NoMac only: a cloud iPhone whose paid-for minutes ran out stops on the minute (`phones.ts`).
  await stopPhonesDue(env, now).catch((error: unknown) => {
    reportCloudFailure("cloud.phone_stops_failed", { message: error instanceof Error ? error.message : "unknown" });
  });
  const key = env.AGENT37_API_KEY?.trim();
  if (!key) return;
  const rows = await env.DB.prepare(`
    select c.*, m.last_seen_at as last_seen_at
    from cloud_computers c
    left join machines m on m.user_id = c.user_id and m.machine_key = c.machine_key
    where c.deleted_at is null
  `).all<TickComputer>();
  const computers = rows.results ?? [];
  const provider = options.provider ?? createCloudProvider(key);
  // The account jobs (disk days to bill, the month's cost against the owner's limit) run with no computer left too.
  if (computers.length === 0) {
    await runOwnerChecks(env, provider, [], [], now);
    await runDaily(env, provider, [], now, waitUntil);
    return;
  }

  let instances: CloudInstance[];
  try {
    instances = await provider.listInstances();
  } catch (error) {
    reportCloudFailure("cloud.tick_list_failed", { code: error instanceof CloudProviderError ? error.code : "unknown" });
    await runOwnerChecks(env, provider, [], computers, now);
    return;
  }

  const byId = new Map(instances.map((instance) => [instance.id, instance]));
  const pendingStatements: D1PreparedStatement[] = [];
  const pendingDeletes: string[] = [];
  const live: TickComputer[] = [];
  // Accounts whose disk the provider just confirmed (a lost create or copy adopted, a lost grow settled): today's disk row follows.
  const diskConfirmed = new Map<string, true>();
  const taken = new Set(computers.filter((computer) => !isPendingId(computer.instance_id)).map((computer) => computer.instance_id));
  for (const computer of computers) {
    if (isPendingId(computer.instance_id)) {
      adoptPending(env, computer, instances, taken, now, pendingStatements, pendingDeletes, live);
      if (!isPendingId(computer.instance_id)) diskConfirmed.set(computer.user_id, true);
    } else {
      live.push(computer);
    }
  }
  if (pendingStatements.length) await env.DB.batch([...pendingStatements, ...await diskDayStatements(env, diskConfirmed, now)]);
  diskConfirmed.clear();
  if (pendingDeletes.length) {
    await env.DB.batch(pendingDeletes.map((id) => env.DB.prepare("delete from cloud_computers where instance_id = ?").bind(id)));
  }

  const statements: D1PreparedStatement[] = [];
  const gone: TickComputer[] = [];
  const keyed: string[] = [];
  for (const computer of live) {
    const instance = byId.get(computer.instance_id);
    if (!instance) {
      gone.push(computer);
      continue;
    }
    statements.push(...(updateBootStatements(env, computer, instance.status, now) ?? statusChangeStatements(env, computer, instance.status, now, "seen_by_tick")));
    if (instance.metadata.ade_machine_key && instance.metadata.ade_machine_key !== computer.machine_key) {
      computer.machine_key = instance.metadata.ade_machine_key;
      keyed.push(computer.instance_id);
      statements.push(env.DB.prepare("update cloud_computers set machine_key = ? where instance_id = ?").bind(computer.machine_key, computer.instance_id));
      const named = nameMachineAfterComputerStatement(env, computer, computer.machine_key);
      if (named) statements.push(named);
    }
    // The lane it holds, kept on its row so the 30-day rule and a freed lane never depend on a live read.
    const lane = laneFactsStatement(env, computer.instance_id, computer, instance.metadata);
    if (lane) statements.push(lane);
    // The provider's disk is the truth. A grow whose answer was lost settles from it, running or not: at once when
    // it shows the new size, or after the settle window (then the room goes back); a grow that landed is billed
    // from today's row. With no grow waiting, a row ahead of a resting computer comes back down.
    const disk = instance.resources?.disk;
    const pending = computer.disk_reserved_at != null;
    const settles = pending
      ? disk != null && disk > 0 && (disk >= computer.disk_gb || now - computer.disk_reserved_at! >= DISK_GROW_SETTLE_MS)
      : disk != null && disk > 0 && disk !== computer.disk_gb && isRestingStatus(instance.status);
    if (settles && disk) {
      statements.push(env.DB.prepare("update cloud_computers set disk_gb = ?, disk_reserved_at = null, disk_confirmed_gb = null where instance_id = ? and disk_gb = ? and disk_reserved_at is ?")
        .bind(disk, computer.instance_id, computer.disk_gb, computer.disk_reserved_at));
      if (pending) diskConfirmed.set(computer.user_id, true);
      computer.disk_gb = disk;
      computer.disk_reserved_at = null;
      computer.disk_confirmed_gb = null;
    }
    statements.push(...shapeFromProviderStatements(env, computer, instance, now));
  }
  statements.push(...await diskDayStatements(env, diskConfirmed, now));
  if (statements.length) await env.DB.batch(statements);
  // A chat launch's follow-ups that waited for the computer's key join its chat.
  for (const instanceId of keyed) await carryLaunchMessagesForComputer(env, instanceId, now);

  await confirmGone(env, provider, gone, live, now);
  // The owner's block list: a computer of a blocked account that isn't stopped (one a launch finished after the block) is stopped now.
  try {
    await enforceBlocksInTick(env, provider, live, now);
  } catch (error) {
    reportCloudFailure("cloud.block_tick_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
  await settleAccounts(env, provider, live, now);
  // Rollbacks for updates that never reported in. A resting computer is never updated here (that would wake it).
  try {
    await runCloudAutoUpdates(env, provider, live, now);
  } catch (error) {
    reportCloudFailure("cloud.auto_updates_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
  await sleepUnseen(env, provider, live, now);
  await runOwnerChecks(env, provider, instances, live, now);
  await runDaily(env, provider, live, now, waitUntil);
}

/**
 * The provider's CPU and memory are the truth too. A resize the computer asked
 * for restarts it, which drops that request, and the Worker keeps its writes
 * alive for only 30 s after a disconnect: one the provider took longer over
 * leaves the row at the old size, shown and billed as it. The time so far is
 * charged at the old size and the new size starts its stretch here, guarded
 * so a resize that did finish its own writes meanwhile is not charged twice.
 */
function shapeFromProviderStatements(env: CloudEnv, computer: TickComputer, instance: CloudInstance, now: number): D1PreparedStatement[] {
  const cpu = instance.resources?.cpu;
  const memory = instance.resources?.memory;
  if (!cpu || !memory || instance.status === "updating") return [];
  if (cpu === computer.cpu && memory === computer.memory_gb) return [];
  const size = cloudSizeFor(computer.type, cpu, memory);
  if (!size) return [];
  logCloud("cloud.shape_from_provider", { instanceId: computer.instance_id, from: { cpu: computer.cpu, memory: computer.memory_gb }, to: { cpu, memory } });
  const statements: D1PreparedStatement[] = [];
  if (size.multiplierMilli !== computer.multiplier_milli && computer.awake_since != null && computer.awake_since <= now) {
    statements.push(...restartStretchStatements(env, computer, now));
  }
  statements.push(env.DB.prepare("update cloud_computers set cpu = ?, memory_gb = ?, multiplier_milli = ? where instance_id = ? and cpu = ? and memory_gb = ?")
    .bind(size.cpu, size.memoryGb, size.multiplierMilli, computer.instance_id, computer.cpu, computer.memory_gb));
  computer.cpu = size.cpu;
  computer.memory_gb = size.memoryGb;
  computer.multiplier_milli = size.multiplierMilli;
  return statements;
}

/** A reservation the Worker didn't finish: adopted by its request tag, or given up on. */
function adoptPending(
  env: CloudEnv,
  computer: TickComputer,
  instances: CloudInstance[],
  taken: Set<string>,
  now: number,
  statements: D1PreparedStatement[],
  deletes: string[],
  live: TickComputer[],
): void {
  // The tag comes from the client: one that matches a computer already in a row
  // adopts nothing, and that reservation times out like any other.
  const instance = computer.request_id
    ? instances.find((entry) => entry.metadata.ade_request_id === computer.request_id && !taken.has(entry.id))
    : undefined;
  if (instance) {
    taken.add(instance.id);
    const machineKey = instance.metadata.ade_machine_key ?? null;
    statements.push(...adoptionStatements(env, { pendingId: computer.instance_id, instance, machineKey, now, reason: "adopted_by_tick" }));
    computer.instance_id = instance.id;
    computer.machine_key = machineKey ?? computer.machine_key;
    computer.status = instance.status;
    computer.status_changed_at = now;
    computer.awake_since = isMeteredStatus(instance.status) ? now : null;
    computer.last_awake_at = now;
    live.push(computer);
    return;
  }
  if (now - computer.created_at > PENDING_TIMEOUT_MS) deletes.push(computer.instance_id);
}

/** A computer missing from the list is confirmed by id before its row is closed. */
async function confirmGone(env: CloudEnv, provider: CloudProvider, gone: TickComputer[], live: TickComputer[], now: number): Promise<void> {
  for (const computer of gone.slice(0, GONE_CHECKS_PER_TICK)) {
    try {
      await provider.getInstance(computer.instance_id);
    } catch (error) {
      if (!(error instanceof CloudProviderError && error.status === 404)) continue;
      await env.DB.batch(goneFromProviderStatements(env, computer, now));
      live.splice(live.indexOf(computer), 1);
      // Nobody here deleted it: worth a look every time.
      reportCloudFailure("cloud.computer_gone", { instanceId: computer.instance_id });
    }
  }
}

async function accountsOf(env: CloudEnv, byUser: Map<string, unknown>): Promise<AccountRow[]> {
  const accounts = await env.DB.prepare("select * from cloud_accounts where user_id in (select value from json_each(?))")
    .bind(JSON.stringify([...byUser.keys()])).all<AccountRow>();
  return accounts.results ?? [];
}

/**
 * Period rolls, the 80/95/zero warnings, and the 0-hours stop. At 0 hours
 * only the computers whose size uses hours stop and lose their timed wakes:
 * a Small computer keeps working (Pricing v2), except on an account with no
 * free plan (`hasNoFreePlan`), which runs nothing once it is out. Answers the
 * accounts with computers that may not wake.
 */
async function settleAccounts(env: CloudEnv, provider: CloudProvider, computers: TickComputer[], now: number): Promise<Set<string>> {
  const byUser = groupByUser(computers);
  if (byUser.size === 0) return new Set();
  const accounts = await accountsOf(env, byUser);
  let rolls = 0;
  /** Accounts with computers that may not wake now (0 hours), why, and the Small ones that still may. */
  const blockedWhy = new Map<string, { reason: WakeBlock; keep: string[] }>();
  // Running credits phones' minutes their provider hasn't billed yet: spent already, as the limits count them.
  // Read for the period before a roll; a phone of a rolled account is settled into its old period by the roll.
  const phones = await unsettledPhoneMilliByUser(env, accounts.filter((row) => row.deleted_at == null), now);
  await Promise.all(accounts.map(async (row) => {
    // Most accounts roll at once on the 1st: a tick does its share and leaves the rest due.
    if (row.deleted_at == null && row.period_end <= now && ++rolls > PERIOD_ROLLS_PER_TICK) return;
    try {
      if (row.deleted_at != null) {
        // A create that was still running when the account was deleted lands here once adopted.
        for (const computer of byUser.get(row.user_id) ?? []) {
          await deleteComputer(env, provider, computer, { who: "system", reason: "account_deleted" }, now);
        }
        await forgetDeletedAccountComputers(env, row.user_id);
        return;
      }
      const account = await rollPeriodIfDue(env, row, now);
      const owned = byUser.get(account.user_id) ?? [];
      // A roll restarted the open stretches at this instant (see startFreshPeriod).
      if (account !== row) {
        for (const computer of owned) if (computer.awake_since != null && computer.awake_since <= now) computer.awake_since = now;
      }
      const used = liveUsedMilli(account, owned, now) + (account === row ? phones.get(account.user_id) ?? 0 : 0);
      const state = hoursState(account, used);
      const runsNothing = hasNoFreePlan(account);
      await warnHours(env, account, state, used, now, runsNothing);
      if (state === "zero") {
        const stopped = runsNothing ? owned : owned.filter((computer) => usesHours(computer.multiplier_milli));
        blockedWhy.set(account.user_id, {
          reason: "out_of_hours",
          keep: owned.filter((computer) => !stopped.includes(computer)).map((computer) => computer.instance_id),
        });
        await stopAll(env, provider, stopped, now, "out_of_hours");
        // A credits phone uses the same balance: held to it now, not at its next check.
        if (phones.has(account.user_id)) await enforcePhoneAllowance(env, account.user_id, now);
      }
    } catch (error) {
      // One account's failure must not cost every other account its tick.
      reportCloudFailure("cloud.tick_account_failed", { userId: row.user_id, message: error instanceof Error ? error.message : "unknown" });
    }
  }));
  // One query however many accounts are blocked. Scheduled work is refused while wakes are: a timed
  // wake reaches only a sleeping computer, and these are stopped.
  // The person hears once a period that their timed wake-ups were cancelled (`accountNotices.ts`).
  await cancelTimedWakes(env, blockedWhy, now);
  return new Set(blockedWhy.keys());
}

/**
 * Asks each awake computer to interrupt its work and save it (its chats and
 * each lane's backup, `prepare-stop`), then stops it; a sleeper just stops.
 * For the computers whose wakes are refused at 0 hours: the sizes that use
 * hours, or every one on an account with no free plan. A computer whose prepare-stop reported current backups
 * rests with them (`markRestedWithBackups`), so a cleanup can delete it later
 * with no wake. Nothing wakes it again for free.
 */
async function stopAll(env: CloudEnv, provider: CloudProvider, computers: TickComputer[], now: number, reason: WakeBlock): Promise<void> {
  // A server move in flight finishes first (it is bounded): stopped mid-copy, both computers would be left half-moved.
  const inJobs = await computersInJobs(env);
  await Promise.all(computers.map(async (computer) => {
    if (computer.cold_storage === 1) return;
    if (inJobs.has(computer.instance_id)) return;
    if (computer.free_wake_until != null && computer.free_wake_until > now) return;
    const stoppable = isMeteredStatus(computer.status) || computer.status === "sleeping" || computer.status === "waking" || computer.status === "starting";
    if (!stoppable) return;
    if (computer.zero_stop_started_at != null && now - computer.zero_stop_started_at < ZERO_STOP_RETRY_GUARD_MS) return;
    await env.DB.prepare("update cloud_computers set zero_stop_started_at = ? where instance_id = ?").bind(now, computer.instance_id).run();
    computer.zero_stop_started_at = now;
    let backupReportId: string | null = null;
    if (isMeteredStatus(computer.status)) {
      try {
        const result = await provider.exec(computer.instance_id, PREPARE_STOP_COMMAND, PREPARE_STOP_TIMEOUT_MS);
        backupReportId = result.exitCode === 0 ? prepareStopBackupReportId(result.stdout) : null;
        logCloud("cloud.prepare_stop_done", { instanceId: computer.instance_id, exitCode: result.exitCode, backups: backupReportId != null });
      } catch (error) {
        reportCloudFailure("cloud.prepare_stop_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
      }
    }
    if (await stopWithRetry(env, provider, computer, now, reason)) {
      await markRestedWithBackups(env, computer.instance_id, backupReportId, now);
    }
  }));
}

/** True when the computer is stopped now. */
async function stopWithRetry(env: CloudEnv, provider: CloudProvider, computer: TickComputer, now: number, reason: string): Promise<boolean> {
  for (let attempt = 0; attempt < STOP_RETRIES; attempt += 1) {
    try {
      const status = await provider.stopInstance(computer.instance_id);
      const statements = statusChangeStatements(env, computer, status, now, reason);
      if (statements.length) await env.DB.batch(statements);
      return true;
    } catch (error) {
      if (error instanceof CloudProviderError && error.status === 400) {
        // Cold storage: a stop can't apply. If something wakes it, a later tick stops it.
        await env.DB.prepare("update cloud_computers set cold_storage = 1 where instance_id = ?").bind(computer.instance_id).run();
        computer.cold_storage = 1;
        return false;
      }
      if (!(error instanceof CloudProviderError && error.code === TRY_AGAIN_CODE)) {
        reportCloudFailure("cloud.stop_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
        return false;
      }
      if (attempt < STOP_RETRIES - 1) await new Promise((resolve) => setTimeout(resolve, STOP_RETRY_DELAY_MS));
    }
  }
  return false;
}

/** `ade cloud prepare-stop --json`: the backup report its save made, when it says every lane is saved. */
export function prepareStopBackupReportId(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown> | null;
    const result = (parsed?.result && typeof parsed.result === "object" ? parsed.result : parsed) as Record<string, unknown> | null;
    // Only a stop that was really prepared: a turn still running (or a chat not saved) can write after the save.
    if (!result || result.stillRunning !== 0 || result.chatsNotUploaded !== 0 || result.timedOut !== false) return null;
    const backups = result.backups as Record<string, unknown> | null | undefined;
    return backups && backups.state === "current" && typeof backups.reportId === "string" ? backups.reportId : null;
  } catch {
    return null;
  }
}

/**
 * Awake with no check-in for 10 minutes, or never checked in at all: sleep it.
 * A server launch's new computer has no machine row to check in with until it
 * signed in, and a person may take a while to tap Approve: it stays awake
 * while its launch is joining, up to the join window's end.
 */
async function sleepUnseen(env: CloudEnv, provider: CloudProvider, computers: TickComputer[], now: number): Promise<void> {
  const unseen = computers.filter((computer) => {
    if (computer.status !== "running" || computer.awake_since == null) return false;
    if (computer.free_wake_until != null && computer.free_wake_until > now) return false;
    const lastSign = Math.max(computer.last_seen_at ?? 0, computer.awake_since);
    return now - lastSign > NO_CHECK_IN_MS;
  });
  if (unseen.length === 0) return;
  // Unread, any computer that never checked in may be a launch's still joining: those wait for a tick that reads.
  const joining = await computersJoiningLaunches(env, now).catch((error: unknown) => {
    reportCloudFailure("cloud.launch_joining_read_failed", { message: error instanceof Error ? error.message : "unknown" });
    return null;
  });
  // A server move pauses its old computer's ADE (no check-ins) and waits on the new one: both stay awake until it ends.
  const inJobs = await computersInJobs(env).catch((error: unknown) => {
    reportCloudFailure("cloud.jobs_read_failed", { message: error instanceof Error ? error.message : "unknown" });
    return null;
  });
  const sleeps = (computer: TickComputer) => (inJobs ? !inJobs.has(computer.instance_id) : computer.last_seen_at != null)
    && (joining ? !joining.has(computer.instance_id) : computer.last_seen_at != null);
  await Promise.all(unseen.filter(sleeps).map(async (computer) => {
    try {
      const status = await provider.sleepInstance(computer.instance_id);
      const statements = statusChangeStatements(env, computer, status, now, "no_check_in");
      if (statements.length) await env.DB.batch(statements);
      logCloud("cloud.slept_no_check_in", { instanceId: computer.instance_id });
    } catch (error) {
      reportCloudFailure("cloud.backstop_sleep_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
    }
  }));
}

async function runOwnerChecks(env: CloudEnv, provider: CloudProvider, instances: CloudInstance[], computers: TickComputer[], now: number): Promise<void> {
  const last = await readTimeSetting(env, "owner_check_at");
  if (now - last < OWNER_CHECK_INTERVAL_MS) return;
  await writeSetting(env, "owner_check_at", String(now), now);
  // This month's estimated cost, for the owner's hard limit (D1 only).
  try {
    await refreshCostEstimate(env, computers, now);
  } catch (error) {
    reportCloudFailure("cloud.cost_estimate_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
  try {
    await endMoves(env, now);
  } catch (error) {
    reportCloudFailure("cloud.move_end_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
  // The ADE Cloud iPhone: live phones read again and held to their credits, and the balance's warnings.
  try {
    await runPhoneChecks(env, now);
  } catch (error) {
    reportCloudFailure("cloud.phone_checks_failed", { step: "checks", message: error instanceof Error ? error.message : "unknown" });
  }
  // Tester emails the owner added before their account had them: asked of Clerk again, each about hourly.
  try {
    await resolvePendingPhoneBeta(env, now);
  } catch (error) {
    reportCloudFailure("cloud.phone_checks_failed", { step: "beta_pending", message: error instanceof Error ? error.message : "unknown" });
  }
  // A cheaper plan's limits: an account over the plan in force is told once (new computers are refused). Nothing is freed here.
  try {
    await runPlanLimitChecks(env, computers, now);
  } catch (error) {
    reportCloudFailure("cloud.plan_cleanup_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
  // The hidden awake cap: a wake through ADE waits or is refused at it, but a request
  // straight to a computer wakes it too, so an account past it is reported here.
  const awakeByUser = new Map<string, number>();
  for (const computer of computers) if (isMeteredStatus(computer.status)) awakeByUser.set(computer.user_id, (awakeByUser.get(computer.user_id) ?? 0) + 1);
  const pastCap = [...awakeByUser].filter(([, count]) => count > AWAKE_COMPUTER_CAP);
  for (const [userId, count] of pastCap) reportCloudFailure("cloud.awake_cap_passed", { userId, awake: count, cap: AWAKE_COMPUTER_CAP });
  let billing;
  try {
    billing = await provider.billing();
  } catch (error) {
    reportCloudFailure("cloud.billing_read_failed", { code: error instanceof CloudProviderError ? error.code : "unknown" });
    return;
  }
  const alerts: string[] = [];
  if (billing.balanceUsd != null && billing.balanceUsd < WALLET_ALERT_USD) {
    alerts.push(`The Agent 37 wallet is at $${billing.balanceUsd.toFixed(2)}, under $${WALLET_ALERT_USD}.`);
  }
  if (!billing.autoTopUpEnabled) alerts.push("Automatic top-up is off on the Agent 37 wallet.");
  const awake = instances.filter((instance) => instance.status === "running").length;
  if (billing.instanceLimit != null && awake >= billing.instanceLimit * AWAKE_LIMIT_ALERT_FRACTION) {
    alerts.push(`${awake} computers are awake, against a limit of ${billing.instanceLimit}.`);
  }
  for (const [userId, count] of pastCap) alerts.push(`Account ${userId} has ${count} computers awake, past the cap of ${AWAKE_COMPUTER_CAP}.`);
  if (alerts.length === 0) return;
  const lastAlert = await readTimeSetting(env, "owner_alert_at");
  logCloud("cloud.owner_alert", { alerts });
  if (now - lastAlert < OWNER_ALERT_REPEAT_MS) return;
  await writeSetting(env, "owner_alert_at", String(now), now);
  await sendCloudEmail(env, { owner: true, subject: "ADE Cloud needs attention", text: alerts.join("\n") });
}

/**
 * Ends the moves that are over: the source was deleted (the move worked) or
 * the new computer was (it failed). A source still there after
 * `MOVE_GRACE_MS` counts again, with the new computer: toward the computer
 * limit (`accountComputerCountSql`) and today's disk row.
 */
async function endMoves(env: CloudEnv, now: number): Promise<void> {
  const rows = await env.DB.prepare(`
    select m.instance_id, m.user_id, (m.deleted_at is null and s.instance_id is not null) as source_left
    from cloud_computers m
    left join cloud_computers s on s.instance_id = m.moving_from and s.deleted_at is null
    where m.moving_from is not null and (m.deleted_at is not null or s.instance_id is null or (m.created_at <= ?
      -- A server move still running holds its grace until it ends (it is bounded by its own limits).
      and not exists (select 1 from cloud_jobs j where j.target_instance_id = m.instance_id and j.state not in ('done', 'failed', 'cancelled'))))
  `).bind(now - MOVE_GRACE_MS).all<{ instance_id: string; user_id: string; source_left: number }>();
  const ended = rows.results ?? [];
  if (ended.length === 0) return;
  const statements = ended.map((row) => env.DB.prepare("update cloud_computers set moving_from = null where instance_id = ?").bind(row.instance_id));
  const left = new Map(ended.filter((row) => row.source_left).map((row) => [row.user_id, true]));
  if (left.size) {
    // The desktop didn't finish the move (closed, or the delete failed): both computers count now.
    reportCloudFailure("cloud.move_source_left", { count: left.size });
    statements.push(...await diskDayStatements(env, left, now));
  }
  await env.DB.batch(statements);
}

/** Today's disk row for each account in `users` (not deleted), to run after the writes that changed its disk. */
async function diskDayStatements(env: CloudEnv, users: Map<string, unknown>, now: number): Promise<D1PreparedStatement[]> {
  if (users.size === 0) return [];
  return (await accountsOf(env, users)).filter((account) => account.deleted_at == null).map((account) => diskDayStatement(env, account, now));
}

async function runDaily(env: CloudEnv, provider: CloudProvider, computers: TickComputer[], now: number, waitUntil: CloudWaitUntil): Promise<void> {
  if (new Date(now).getUTCHours() < DAILY_AFTER_HOUR_UTC) return;
  const today = utcDay(now);
  const last = await readSetting(env, "last_daily_day");
  if (last === today) return;
  // The day is only marked done at the end, so a run that dies is tried again.
  const claimedAt = await readTimeSetting(env, "daily_claim_at");
  if (now - claimedAt < DAILY_CLAIM_MS) return;
  await writeSetting(env, "daily_claim_at", String(now), now);

  await settleOpenStretches(env, computers, now);
  const unexplained = await reconcileDays(env, provider, last, today, now);
  if (unexplained.length) {
    const lines = unexplained.map((entry) => `${entry.instanceId} on ${entry.day}: ${entry.minutes} minutes`);
    // A billing mismatch: the provider counted awake time ADE didn't.
    reportCloudFailure("cloud.reconcile_unexplained", { count: unexplained.length });
    await sendCloudEmail(env, { owner: true, subject: "ADE Cloud minutes the power log can't explain", text: lines.join("\n") });
  }
  const yesterday = utcDay(Date.parse(`${today}T00:00:00Z`) - 86_400_000);
  // Each step stands alone: one failing must not cost the others or the day's mark.
  const step = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      reportCloudFailure(`cloud.daily_${name}_failed`, { message: error instanceof Error ? error.message : "unknown" });
    }
  };
  await step("disk_baseline", () => writeDiskBaseline(env, computers, now));
  // Revyl's builds for the last few days (a day that failed or filled in late is read again), before the report reads them.
  const revylDays = Array.from({ length: REVYL_COST_DAYS_BACK }, (_, index) => utcDay(Date.parse(`${today}T00:00:00Z`) - (REVYL_COST_DAYS_BACK - index) * 86_400_000));
  await step("revyl_day_costs", () => recordRevylDayCosts(env, revylDays, now));
  await step("cost_report", () => runDailyCostReport(env, yesterday));
  await step("analytics", () => captureDailyAnalytics(env, waitUntil, computers, yesterday));
  await writeSetting(env, "last_daily_day", today, now);
}

/** Today's starting disk for each account with computers, so a day with no change still has its row. */
async function writeDiskBaseline(env: CloudEnv, computers: TickComputer[], now: number): Promise<void> {
  const statements = await diskDayStatements(env, groupByUser(computers), now);
  if (statements.length) await env.DB.batch(statements);
}

/** One `ade_cloud_day` per account with power changes on `day`, counted from the power log. */
async function captureDailyAnalytics(env: CloudEnv, waitUntil: CloudWaitUntil, computers: TickComputer[], day: string): Promise<void> {
  if (!env.POSTHOG_PROJECT_TOKEN?.trim()) return;
  const start = Date.parse(`${day}T00:00:00Z`);
  const rows = await env.DB.prepare(`
    select user_id, action, count(*) as n from cloud_power_log
    where created_at >= ? and created_at < ? group by user_id, action
  `).bind(start, start + 86_400_000).all<{ user_id: string; action: string; n: number }>();
  const counts = new Map<string, { wakes: number; sleeps: number; stops: number; starts: number }>();
  for (const row of rows.results ?? []) {
    const entry = counts.get(row.user_id) ?? { wakes: 0, sleeps: 0, stops: 0, starts: 0 };
    if (row.action === "wake") entry.wakes += row.n;
    else if (row.action === "sleep") entry.sleeps += row.n;
    else if (row.action === "stop") entry.stops += row.n;
    else if (row.action === "start") entry.starts += row.n;
    counts.set(row.user_id, entry);
  }
  if (counts.size === 0) return;
  const accounts = await accountsOf(env, counts);
  const owned = groupByUser(computers);
  for (const account of accounts) {
    const entry = counts.get(account.user_id);
    if (!entry) continue;
    captureCloudDay(env, waitUntil, account.user_id, day, planIdOf(account), { ...entry, computers: owned.get(account.user_id)?.length ?? 0 });
  }
}

async function settleOpenStretches(env: CloudEnv, computers: TickComputer[], now: number): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const computer of computers) {
    if (computer.awake_since == null || computer.awake_since > now) continue;
    // Guarded: a sleep since this tick read the row has already charged this stretch.
    statements.push(...restartStretchStatements(env, computer, now));
  }
  if (statements.length) await env.DB.batch(statements);
}

type ReconcileRow = {
  instance_id: string;
  user_id: string;
  metered_ms: number;
  metered_milli: number;
  multiplier_milli: number;
  free_ms: number;
  reconciled_at: number | null;
  period_start: number | null;
};

/** One `GET /v1/usage` per day missed; corrects each computer-day to the provider's awake minutes. */
async function reconcileDays(env: CloudEnv, provider: CloudProvider, last: string | null, today: string, now: number): Promise<Array<{ instanceId: string; day: string; minutes: number }>> {
  const days: string[] = [];
  for (let back = RECONCILE_DAYS_BEHIND; back >= 1; back -= 1) {
    const day = utcDay(Date.parse(`${today}T00:00:00Z`) - back * 86_400_000);
    if (!last || day >= last) days.push(day);
  }
  const unexplained: Array<{ instanceId: string; day: string; minutes: number }> = [];
  for (const day of days) {
    let usage;
    try {
      usage = await provider.usage({ from: day, to: day });
    } catch (error) {
      reportCloudFailure("cloud.reconcile_read_failed", { day, code: error instanceof CloudProviderError ? error.code : "unknown" });
      continue;
    }
    if (usage.instances.length === 0) continue;
    const ids = usage.instances.map((entry) => entry.id);
    const rows = await env.DB.prepare(`
      select c.instance_id, c.user_id, c.multiplier_milli as computer_mult, c.type, c.cpu, c.memory_gb, c.disk_gb,
        (select peak_gb from cloud_disk_days dd where dd.user_id = c.user_id and dd.day = ?) as day_disk_gb,
        d.metered_ms, d.metered_milli, d.multiplier_milli, d.free_ms, d.reconciled_at, d.cost_micros, a.period_start
      from cloud_computers c
      left join cloud_computer_days d on d.instance_id = c.instance_id and d.day = ?
      left join cloud_accounts a on a.user_id = c.user_id
      where c.instance_id in (select value from json_each(?))
    `).bind(day, day, JSON.stringify(ids)).all<ReconcileRow & { computer_mult: number; type: string; cpu: number; memory_gb: number; disk_gb: number; day_disk_gb: number | null; cost_micros: number | null }>();
    const known = new Map((rows.results ?? []).map((row) => [row.instance_id, row]));
    const statements: D1PreparedStatement[] = [];
    for (const entry of usage.instances) {
      const row = known.get(entry.id);
      if (!row || row.reconciled_at != null) continue;
      const meteredMs = row.metered_ms ?? 0;
      const meteredMilli = row.metered_milli ?? 0;
      const multiplier = row.multiplier_milli ?? row.computer_mult;
      const freeMs = row.free_ms ?? 0;
      const providerBillableMs = Math.max(0, entry.awakeMinutes * 60_000 - freeMs);
      // A resize changes the rate mid-day, so correct at the rate the day really ran at.
      // A day metered at 0 (Small without hours) stays 0, even if the rate changed late in it.
      const providerMilli = meteredMs > 0
        ? Math.round((providerBillableMs * meteredMilli) / meteredMs)
        : hoursMilliFor(providerBillableMs, multiplier);
      const delta = providerMilli - meteredMilli;
      // The provider charges every awake minute, an update's free time too, at the rate the day ran at.
      const providerAwakeMs = entry.awakeMinutes * 60_000;
      const meteredCost = row.cost_micros ?? 0;
      // What Agent 37 billed for the day when it says, less the disk that day's `cloud_disk_days` counted
      // (never more than the account's peak that day, so a later grow doesn't eat the day's compute);
      // otherwise its public price for the awake minutes.
      const countedDiskGb = Math.min(row.disk_gb, row.day_disk_gb ?? 0);
      const providerCost = entry.costMicros != null
        ? Math.max(0, Math.round(entry.costMicros - countedDiskGb * DISK_COST_MICROS_PER_GB_DAY))
        : meteredMs > 0 && meteredCost > 0
          ? Math.round((providerAwakeMs * meteredCost) / meteredMs)
          : computeCostMicrosFor(providerAwakeMs, { type: row.type, cpu: row.cpu, memoryGb: row.memory_gb });
      // A day that ended by the time the period began belongs to the one before.
      const inPeriod = row.period_start != null && Date.parse(`${day}T00:00:00Z`) + 86_400_000 > row.period_start;
      // First: it reads the mark the next statement sets, so a repeat of this day charges once.
      if (inPeriod && delta !== 0) {
        statements.push(env.DB.prepare(`
          update cloud_accounts set used_milli = max(0, used_milli + ?), updated_at = ?
          where user_id = ? and not exists (select 1 from cloud_computer_days where instance_id = ? and day = ? and reconciled_at is not null)
        `).bind(delta, now, row.user_id, entry.id, day));
      }
      // The free share of the day's cost follows the correction in proportion; a day with no metered cost takes the plan the account is on now.
      statements.push(env.DB.prepare(`
        insert into cloud_computer_days (instance_id, day, user_id, multiplier_milli, provider_minutes, corrected_milli, reconciled_at, cost_micros, free_cost_micros)
        select ?, ?, ?, ?, ?, ?, ?, ?, ${freeShareSql("?", "?")}
        where 1
        on conflict (instance_id, day) do update set provider_minutes = excluded.provider_minutes,
          corrected_milli = excluded.corrected_milli, reconciled_at = excluded.reconciled_at, cost_micros = excluded.cost_micros,
          free_cost_micros = case when cost_micros > 0 then cast(round(free_cost_micros * 1.0 * excluded.cost_micros / cost_micros) as integer) else excluded.free_cost_micros end
      `).bind(entry.id, day, row.user_id, multiplier, entry.awakeMinutes, inPeriod ? delta : 0, now, providerCost, row.user_id, providerCost));
      const minutes = entry.awakeMinutes - Math.ceil((meteredMs + freeMs) / 60_000);
      if (minutes > UNEXPLAINED_MINUTES) unexplained.push({ instanceId: entry.id, day, minutes });
    }
    if (statements.length) await env.DB.batch(statements);
  }
  return unexplained;
}
