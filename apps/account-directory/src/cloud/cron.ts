import { captureCloudDay, type CloudWaitUntil } from "./analytics";
import { cancelTimedWakes, type WakeBlock } from "./accountNotices";
import { checkExtraDiskLimits, reportExtraDiskDays, type ExtraDiskOverLimit } from "./billing";
import { sendCloudEmail } from "./email";
import { laneFactsStatement } from "./lanesWithoutComputer";
import type { CloudHoursState, CloudInstance } from "./contract";
import { refreshCostEstimate, runDailyCostReport } from "./costReport";
import { AWAKE_COMPUTER_CAP, cloudSizeFor, computeCostMicrosFor, hoursMilliFor, isMeteredStatus, isRestingStatus, tierOf, utcDay } from "./plans";
import { CloudProviderError, TRY_AGAIN_CODE, createCloudProvider, type CloudProvider } from "./provider";
import { runPlanLimitChecks } from "./planCleanup";
import { computersJoiningLaunches } from "./launches";
import { runCloudAutoUpdates, updateBootStatements } from "./updates";
import {
  PENDING_TIMEOUT_MS,
  adoptionStatements,
  countedDiskGb,
  deleteComputer,
  diskDayStatement,
  freePlanOverDisk,
  goneFromProviderStatements,
  groupByUser,
  hoursState,
  isOutOfHours,
  isPendingId,
  MOVE_GRACE_MS,
  liveUsedMilli,
  logCloud,
  allowancePercentUsed,
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
const PREPARE_STOP_COMMAND = 'PATH="$ADE_HOME/bin:$PATH" ade cloud prepare-stop --timeout 40';
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
  for (const computer of live) {
    const instance = byId.get(computer.instance_id);
    if (!instance) {
      gone.push(computer);
      continue;
    }
    statements.push(...(updateBootStatements(env, computer, instance.status, now) ?? statusChangeStatements(env, computer, instance.status, now, "seen_by_tick")));
    if (instance.metadata.ade_machine_key && instance.metadata.ade_machine_key !== computer.machine_key) {
      computer.machine_key = instance.metadata.ade_machine_key;
      statements.push(env.DB.prepare("update cloud_computers set machine_key = ? where instance_id = ?").bind(computer.machine_key, computer.instance_id));
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
  }
  statements.push(...await diskDayStatements(env, diskConfirmed, now));
  if (statements.length) await env.DB.batch(statements);

  await confirmGone(env, provider, gone, live, now);
  const blockedUsers = await settleAccounts(env, provider, live, now);
  // Rollbacks for updates that never reported in, then a few asleep computers onto their channel's image.
  try {
    await runCloudAutoUpdates(env, provider, live, blockedUsers, now);
  } catch (error) {
    reportCloudFailure("cloud.auto_updates_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
  await sleepUnseen(env, provider, live, now);
  await runOwnerChecks(env, provider, instances, live, now);
  await runDaily(env, provider, live, now, waitUntil);
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

/** Period rolls, the 80/95/zero warnings, and the 0-hours stop. Answers the accounts whose computers may not wake. */
async function settleAccounts(env: CloudEnv, provider: CloudProvider, computers: TickComputer[], now: number): Promise<Set<string>> {
  const byUser = groupByUser(computers);
  if (byUser.size === 0) return new Set();
  const accounts = await accountsOf(env, byUser);
  let rolls = 0;
  /** Accounts whose computers may not wake now (0 hours, or the free plan above its disk), and why. */
  const blockedWhy = new Map<string, WakeBlock>();
  await Promise.all(accounts.map(async (row) => {
    // Most accounts roll at once on the 1st: a tick does its share and leaves the rest due.
    if (row.deleted_at == null && row.period_end <= now && ++rolls > PERIOD_ROLLS_PER_TICK) return;
    try {
      if (row.deleted_at != null) {
        // A create that was still running when the account was deleted lands here once adopted.
        for (const computer of byUser.get(row.user_id) ?? []) {
          await deleteComputer(env, provider, computer, { who: "system", reason: "account_deleted" }, now);
        }
        return;
      }
      const account = await rollPeriodIfDue(env, row, now);
      const owned = byUser.get(account.user_id) ?? [];
      // A roll restarted the open stretches at this instant (see startFreshPeriod).
      if (account !== row) {
        for (const computer of owned) if (computer.awake_since != null && computer.awake_since <= now) computer.awake_since = now;
      }
      const used = liveUsedMilli(account, owned, now);
      const state = hoursState(account, used);
      await warnHours(env, account, state, used, now);
      // Disk nobody pays for (the free plan above its disk) stops the computers as 0 hours does.
      const blocked = state === "zero" ? "out_of_hours"
        : freePlanOverDisk(account, countedDiskGb(owned)) ? "over_plan_disk"
        : null;
      if (blocked) {
        blockedWhy.set(account.user_id, blocked);
        await stopAll(env, provider, owned, now, blocked);
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

const HOURS_WARNINGS: Record<Exclude<CloudHoursState, "none">, {
  column: "warned_zero_at" | "warned_95_at" | "warned_80_at";
  subject: string;
  text: string;
}> = {
  zero: { column: "warned_zero_at", subject: "You're out of ADE Cloud hours", text: "Your ADE Cloud computers have stopped. You can add hours, or wait for your hours to reset." },
  warn95: { column: "warned_95_at", subject: "You've used 95% of your ADE Cloud hours", text: "You're almost out. When your hours run out, your computers stop until you add hours or they reset." },
  warn80: { column: "warned_80_at", subject: "You've used 80% of your ADE Cloud hours", text: "Your computers keep working for now. When your hours run out, they stop until you add hours or they reset." },
};

async function warnHours(env: CloudEnv, account: AccountRow, state: CloudHoursState, used: number, now: number): Promise<void> {
  if (state === "none") return;
  const warning = HOURS_WARNINGS[state];
  if (account[warning.column] != null) return;
  await env.DB.prepare(`update cloud_accounts set ${warning.column} = ?, updated_at = ? where user_id = ?`).bind(now, now, account.user_id).run();
  // Of everything the period may use (plan and earned hours), as the warning itself counts.
  const percent = state === "zero" ? 100 : allowancePercentUsed(account, used);
  await sendCloudEmail(env, { userId: account.user_id, subject: warning.subject, text: warning.text, percentUsed: percent });
}

/**
 * Asks each awake computer to save and interrupt its work, then stops it; a
 * sleeper just stops. For an account whose wakes are refused (0 hours, or
 * disk the free plan doesn't cover); the short push-work wake runs out first.
 */
async function stopAll(env: CloudEnv, provider: CloudProvider, computers: TickComputer[], now: number, reason: WakeBlock): Promise<void> {
  await Promise.all(computers.map(async (computer) => {
    if (computer.cold_storage === 1) return;
    if (computer.free_wake_until != null && computer.free_wake_until > now) return;
    const stoppable = isMeteredStatus(computer.status) || computer.status === "sleeping" || computer.status === "waking" || computer.status === "starting";
    if (!stoppable) return;
    if (computer.zero_stop_started_at != null && now - computer.zero_stop_started_at < ZERO_STOP_RETRY_GUARD_MS) return;
    await env.DB.prepare("update cloud_computers set zero_stop_started_at = ? where instance_id = ?").bind(now, computer.instance_id).run();
    computer.zero_stop_started_at = now;
    if (isMeteredStatus(computer.status)) {
      try {
        const result = await provider.exec(computer.instance_id, PREPARE_STOP_COMMAND, PREPARE_STOP_TIMEOUT_MS);
        logCloud("cloud.prepare_stop_done", { instanceId: computer.instance_id, exitCode: result.exitCode });
      } catch (error) {
        reportCloudFailure("cloud.prepare_stop_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
      }
    }
    await stopWithRetry(env, provider, computer, now, reason);
  }));
}

async function stopWithRetry(env: CloudEnv, provider: CloudProvider, computer: TickComputer, now: number, reason: string): Promise<void> {
  for (let attempt = 0; attempt < STOP_RETRIES; attempt += 1) {
    try {
      const status = await provider.stopInstance(computer.instance_id);
      const statements = statusChangeStatements(env, computer, status, now, reason);
      if (statements.length) await env.DB.batch(statements);
      return;
    } catch (error) {
      if (error instanceof CloudProviderError && error.status === 400) {
        // Cold storage: a stop can't apply. If something wakes it, a later tick stops it.
        await env.DB.prepare("update cloud_computers set cold_storage = 1 where instance_id = ?").bind(computer.instance_id).run();
        computer.cold_storage = 1;
        return;
      }
      if (!(error instanceof CloudProviderError && error.code === TRY_AGAIN_CODE)) {
        reportCloudFailure("cloud.stop_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
        return;
      }
      if (attempt < STOP_RETRIES - 1) await new Promise((resolve) => setTimeout(resolve, STOP_RETRY_DELAY_MS));
    }
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
  const sleeps = (computer: TickComputer) => (joining ? !joining.has(computer.instance_id) : computer.last_seen_at != null);
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
  // Finished days of extra disk, every ten minutes, so a failed send is retried inside Stripe's dedupe window.
  try {
    await reportExtraDiskDays(env, now);
  } catch (error) {
    reportCloudFailure("cloud.disk_report_failed", { message: error instanceof Error ? error.message : "unknown" });
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
 * `MOVE_GRACE_MS` counts toward the disk again, with the new computer: the
 * plan's limits hold, extra disk is billed from today's row, and the owner's
 * report lists a paid account over its disk.
 */
async function endMoves(env: CloudEnv, now: number): Promise<void> {
  const rows = await env.DB.prepare(`
    select m.instance_id, m.user_id, (m.deleted_at is null and s.instance_id is not null) as source_left
    from cloud_computers m
    left join cloud_computers s on s.instance_id = m.moving_from and s.deleted_at is null
    where m.moving_from is not null and (m.deleted_at is not null or s.instance_id is null or m.created_at <= ?)
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
  let overLimit: ExtraDiskOverLimit[] = [];
  await step("extra_disk_limits", async () => {
    overLimit = await checkExtraDiskLimits(env, now);
  });
  await step("cost_report", () => runDailyCostReport(env, yesterday, overLimit));
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
      select c.instance_id, c.user_id, c.multiplier_milli as computer_mult, c.type, c.cpu, c.memory_gb,
        d.metered_ms, d.metered_milli, d.multiplier_milli, d.free_ms, d.reconciled_at, d.cost_micros, a.period_start
      from cloud_computers c
      left join cloud_computer_days d on d.instance_id = c.instance_id and d.day = ?
      left join cloud_accounts a on a.user_id = c.user_id
      where c.instance_id in (select value from json_each(?))
    `).bind(day, JSON.stringify(ids)).all<ReconcileRow & { computer_mult: number; type: string; cpu: number; memory_gb: number; cost_micros: number | null }>();
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
      const providerMilli = meteredMs > 0 && meteredMilli > 0
        ? Math.round((providerBillableMs * meteredMilli) / meteredMs)
        : hoursMilliFor(providerBillableMs, multiplier);
      const delta = providerMilli - meteredMilli;
      // The provider charges every awake minute, free push-work time too, at the rate the day ran at.
      const providerAwakeMs = entry.awakeMinutes * 60_000;
      const meteredCost = row.cost_micros ?? 0;
      const providerCost = meteredMs > 0 && meteredCost > 0
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
      statements.push(env.DB.prepare(`
        insert into cloud_computer_days (instance_id, day, user_id, multiplier_milli, provider_minutes, corrected_milli, reconciled_at, cost_micros)
        values (?, ?, ?, ?, ?, ?, ?, ?)
        on conflict (instance_id, day) do update set provider_minutes = excluded.provider_minutes,
          corrected_milli = excluded.corrected_milli, reconciled_at = excluded.reconciled_at, cost_micros = excluded.cost_micros
      `).bind(entry.id, day, row.user_id, multiplier, entry.awakeMinutes, inPeriod ? delta : 0, now, providerCost));
      const minutes = entry.awakeMinutes - Math.ceil((meteredMs + freeMs) / 60_000);
      if (minutes > UNEXPLAINED_MINUTES) unexplained.push({ instanceId: entry.id, day, minutes });
    }
    if (statements.length) await env.DB.batch(statements);
  }
  return unexplained;
}
