import { sendCloudEmail } from "./email";
import type { CloudHoursState, CloudInstance } from "./contract";
import { hoursMilliFor, isMeteredStatus, isRestingStatus, utcDay } from "./plans";
import { CloudProviderError, TRY_AGAIN_CODE, createCloudProvider, type CloudProvider } from "./provider";
import {
  DELETION_WARNING_LATE_MS,
  PENDING_TIMEOUT_MS,
  adoptionStatements,
  deleteComputer,
  deletionDueAt,
  goneFromProviderStatements,
  groupByUser,
  hoursState,
  isOutOfHours,
  isPendingId,
  liveUsedMilli,
  logCloud,
  percentUsed,
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
const DELETION_BATCH = 25;
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

export async function runCloudMinuteCron(env: CloudEnv, options: { now?: number; provider?: CloudProvider } = {}): Promise<void> {
  const now = options.now ?? Date.now();
  const key = env.AGENT37_API_KEY?.trim();
  if (!key) return;
  const rows = await env.DB.prepare(`
    select c.*, m.last_seen_at as last_seen_at
    from cloud_computers c
    left join machines m on m.user_id = c.user_id and m.machine_key = c.machine_key
    where c.deleted_at is null
  `).all<TickComputer>();
  const computers = rows.results ?? [];
  if (computers.length === 0) return;

  const provider = options.provider ?? createCloudProvider(key);
  let instances: CloudInstance[];
  try {
    instances = await provider.listInstances();
  } catch (error) {
    logCloud("cloud.tick_list_failed", { code: error instanceof CloudProviderError ? error.code : "unknown" });
    return;
  }

  const byId = new Map(instances.map((instance) => [instance.id, instance]));
  const pendingStatements: D1PreparedStatement[] = [];
  const pendingDeletes: string[] = [];
  const live: TickComputer[] = [];
  const taken = new Set(computers.filter((computer) => !isPendingId(computer.instance_id)).map((computer) => computer.instance_id));
  for (const computer of computers) {
    if (isPendingId(computer.instance_id)) {
      adoptPending(env, computer, instances, taken, now, pendingStatements, pendingDeletes, live);
    } else {
      live.push(computer);
    }
  }
  if (pendingStatements.length) await env.DB.batch(pendingStatements);
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
    statements.push(...statusChangeStatements(env, computer, instance.status, now, "seen_by_tick"));
    if (instance.metadata.ade_machine_key && instance.metadata.ade_machine_key !== computer.machine_key) {
      computer.machine_key = instance.metadata.ade_machine_key;
      statements.push(env.DB.prepare("update cloud_computers set machine_key = ? where instance_id = ?").bind(computer.machine_key, computer.instance_id));
    }
    // At rest the provider's disk is the truth: a grow whose answer was lost leaves this row ahead, holding room in the shared limit.
    const disk = instance.resources?.disk;
    const growLanding = computer.disk_reserved_at != null && now - computer.disk_reserved_at < DISK_GROW_SETTLE_MS;
    if (disk && disk !== computer.disk_gb && isRestingStatus(instance.status) && !growLanding) {
      statements.push(env.DB.prepare("update cloud_computers set disk_gb = ? where instance_id = ? and disk_gb = ?").bind(disk, computer.instance_id, computer.disk_gb));
      computer.disk_gb = disk;
    }
  }
  if (statements.length) await env.DB.batch(statements);

  await confirmGone(env, provider, gone, live, now);
  await settleAccounts(env, provider, live, now);
  await sleepUnseen(env, provider, live, now);
  await runOwnerChecks(env, provider, instances, now);
  await runDaily(env, provider, live, now);
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
      logCloud("cloud.computer_gone", { instanceId: computer.instance_id });
    }
  }
}

async function accountsOf(env: CloudEnv, byUser: Map<string, unknown>): Promise<AccountRow[]> {
  const accounts = await env.DB.prepare("select * from cloud_accounts where user_id in (select value from json_each(?))")
    .bind(JSON.stringify([...byUser.keys()])).all<AccountRow>();
  return accounts.results ?? [];
}

/** Period rolls, the 80/95/zero warnings, and the 0-hours stop. */
async function settleAccounts(env: CloudEnv, provider: CloudProvider, computers: TickComputer[], now: number): Promise<void> {
  const byUser = groupByUser(computers);
  if (byUser.size === 0) return;
  const accounts = await accountsOf(env, byUser);
  let rolls = 0;
  const outOfHoursUsers: string[] = [];
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
      if (state === "zero") {
        outOfHoursUsers.push(account.user_id);
        await stopAtZero(env, provider, owned, now);
      }
    } catch (error) {
      // One account's failure must not cost every other account its tick.
      reportCloudFailure("cloud.tick_account_failed", { userId: row.user_id, message: error instanceof Error ? error.message : "unknown" });
    }
  }));
  // One query however many accounts are out. Scheduled work is refused at 0 hours: a timed wake wouldn't come back anyway.
  if (outOfHoursUsers.length) {
    await env.DB.prepare("delete from cloud_wakes where user_id in (select value from json_each(?))").bind(JSON.stringify(outOfHoursUsers)).run();
  }
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
  const percent = state === "zero" ? 100 : percentUsed(account, used);
  await sendCloudEmail(env, { userId: account.user_id, subject: warning.subject, text: warning.text, percentUsed: percent });
}

/** Asks each awake computer to save and interrupt its work, then stops it; a sleeper just stops. */
async function stopAtZero(env: CloudEnv, provider: CloudProvider, computers: TickComputer[], now: number): Promise<void> {
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
        logCloud("cloud.prepare_stop_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
      }
    }
    await stopWithRetry(env, provider, computer, now);
  }));
}

async function stopWithRetry(env: CloudEnv, provider: CloudProvider, computer: TickComputer, now: number): Promise<void> {
  for (let attempt = 0; attempt < STOP_RETRIES; attempt += 1) {
    try {
      const status = await provider.stopInstance(computer.instance_id);
      const statements = statusChangeStatements(env, computer, status, now, "out_of_hours");
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

/** Awake with no check-in for 10 minutes, or never checked in at all: sleep it. */
async function sleepUnseen(env: CloudEnv, provider: CloudProvider, computers: TickComputer[], now: number): Promise<void> {
  await Promise.all(computers.filter((computer) => {
    if (computer.status !== "running" || computer.awake_since == null) return false;
    if (computer.free_wake_until != null && computer.free_wake_until > now) return false;
    const lastSign = Math.max(computer.last_seen_at ?? 0, computer.awake_since);
    return now - lastSign > NO_CHECK_IN_MS;
  }).map(async (computer) => {
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

async function runOwnerChecks(env: CloudEnv, provider: CloudProvider, instances: CloudInstance[], now: number): Promise<void> {
  const last = await readTimeSetting(env, "owner_check_at");
  if (now - last < OWNER_CHECK_INTERVAL_MS) return;
  await writeSetting(env, "owner_check_at", String(now), now);
  let billing;
  try {
    billing = await provider.billing();
  } catch (error) {
    logCloud("cloud.billing_read_failed", { code: error instanceof CloudProviderError ? error.code : "unknown" });
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
  if (alerts.length === 0) return;
  const lastAlert = await readTimeSetting(env, "owner_alert_at");
  logCloud("cloud.owner_alert", { alerts });
  if (now - lastAlert < OWNER_ALERT_REPEAT_MS) return;
  await writeSetting(env, "owner_alert_at", String(now), now);
  await sendCloudEmail(env, { owner: true, subject: "ADE Cloud needs attention", text: alerts.join("\n") });
}

async function runDaily(env: CloudEnv, provider: CloudProvider, computers: TickComputer[], now: number): Promise<void> {
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
    logCloud("cloud.reconcile_unexplained", { count: unexplained.length });
    await sendCloudEmail(env, { owner: true, subject: "ADE Cloud minutes the power log can't explain", text: lines.join("\n") });
  }
  await sweepInactive(env, provider, computers, now);
  await writeSetting(env, "last_daily_day", today, now);
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
      logCloud("cloud.reconcile_read_failed", { day, code: error instanceof CloudProviderError ? error.code : "unknown" });
      continue;
    }
    if (usage.instances.length === 0) continue;
    const ids = usage.instances.map((entry) => entry.id);
    const rows = await env.DB.prepare(`
      select c.instance_id, c.user_id, c.multiplier_milli as computer_mult, d.metered_ms, d.metered_milli, d.multiplier_milli, d.free_ms, d.reconciled_at, a.period_start
      from cloud_computers c
      left join cloud_computer_days d on d.instance_id = c.instance_id and d.day = ?
      left join cloud_accounts a on a.user_id = c.user_id
      where c.instance_id in (select value from json_each(?))
    `).bind(day, JSON.stringify(ids)).all<ReconcileRow & { computer_mult: number }>();
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
      const inPeriod = row.period_start != null && Date.parse(`${day}T00:00:00Z`) >= row.period_start - 86_400_000;
      // First: it reads the mark the next statement sets, so a repeat of this day charges once.
      if (inPeriod && delta !== 0) {
        statements.push(env.DB.prepare(`
          update cloud_accounts set used_milli = max(0, used_milli + ?), updated_at = ?
          where user_id = ? and not exists (select 1 from cloud_computer_days where instance_id = ? and day = ? and reconciled_at is not null)
        `).bind(delta, now, row.user_id, entry.id, day));
      }
      statements.push(env.DB.prepare(`
        insert into cloud_computer_days (instance_id, day, user_id, multiplier_milli, provider_minutes, corrected_milli, reconciled_at)
        values (?, ?, ?, ?, ?, ?, ?)
        on conflict (instance_id, day) do update set provider_minutes = excluded.provider_minutes,
          corrected_milli = excluded.corrected_milli, reconciled_at = excluded.reconciled_at
      `).bind(entry.id, day, row.user_id, multiplier, entry.awakeMinutes, inPeriod ? delta : 0, now));
      const minutes = entry.awakeMinutes - Math.ceil((meteredMs + freeMs) / 60_000);
      if (minutes > UNEXPLAINED_MINUTES) unexplained.push({ instanceId: entry.id, day, minutes });
    }
    if (statements.length) await env.DB.batch(statements);
  }
  return unexplained;
}

/** The 30-day rule: warned at 7 days and 1 day, then deleted, reading its history first. */
async function sweepInactive(env: CloudEnv, provider: CloudProvider, computers: TickComputer[], now: number): Promise<void> {
  const byUser = groupByUser(computers);
  if (byUser.size === 0) return;
  const accounts = await accountsOf(env, byUser);
  let deletions = 0;
  for (const account of accounts) {
    if (account.deleted_at != null) continue;
    const owned = byUser.get(account.user_id) ?? [];
    const used = liveUsedMilli(account, owned, now);
    if (isOutOfHours(account, used)) continue;
    for (const computer of owned) {
      const due = deletionDueAt(computer, account, used);
      if (due == null) continue;
      const remaining = due - now;
      const warnedLate = computer.delete_warned_7d_at != null;
      if (remaining <= DELETION_WARNING_LATE_MS && !warnedLate) {
        await warnDeletion(env, computer, "delete_warned_7d_at", 7, now);
        computer.delete_warned_7d_at = now;
        continue;
      }
      const dayMs = 24 * 60 * 60_000;
      if (remaining <= dayMs && computer.delete_warned_1d_at == null) {
        await warnDeletion(env, computer, "delete_warned_1d_at", 1, now);
        computer.delete_warned_1d_at = now;
        continue;
      }
      if (remaining > 0) continue;
      // Both warnings must have had time to reach the person, even if the cron stalled.
      if (computer.delete_warned_1d_at == null || now - computer.delete_warned_1d_at < 23 * 60 * 60_000) continue;
      if (deletions >= DELETION_BATCH) continue;
      deletions += 1;
      await deleteInactive(env, provider, computer, now);
    }
  }
}

async function warnDeletion(env: CloudEnv, computer: TickComputer, column: "delete_warned_7d_at" | "delete_warned_1d_at", days: number, now: number): Promise<void> {
  await env.DB.prepare(`update cloud_computers set ${column} = ? where instance_id = ?`).bind(now, computer.instance_id).run();
  const label = computer.name ?? "A computer";
  await sendCloudEmail(env, {
    userId: computer.user_id,
    subject: `${label} will be deleted in ${days === 1 ? "1 day" : `${days} days`}`,
    text: `${label} hasn't been used in a while, so ADE Cloud will delete it. Open ADE and choose "Push all work to GitHub" to save its work first. Using it keeps it.`,
  });
}

async function deleteInactive(env: CloudEnv, provider: CloudProvider, computer: TickComputer, now: number): Promise<void> {
  // The list and row are from the start of the tick: someone may have opened it since.
  try {
    const current = await provider.getInstance(computer.instance_id);
    if (!isRestingStatus(current.status)) return;
  } catch (error) {
    if (!(error instanceof CloudProviderError && error.status === 404)) {
      logCloud("cloud.delete_inactive_check_failed", { instanceId: computer.instance_id, code: error instanceof CloudProviderError ? error.code : "unknown" });
      return;
    }
  }
  const fresh = await env.DB.prepare("select awake_since, last_awake_at, deleted_at from cloud_computers where instance_id = ?")
    .bind(computer.instance_id).first<Pick<ComputerRow, "awake_since" | "last_awake_at" | "deleted_at">>();
  if (!fresh || fresh.deleted_at != null || fresh.awake_since != null || fresh.last_awake_at !== computer.last_awake_at) return;
  try {
    await deleteComputer(env, provider, computer, { who: "system", reason: "inactive_30_days" }, now);
  } catch (error) {
    if (!(error instanceof CloudProviderError)) throw error;
    reportCloudFailure("cloud.delete_inactive_failed", { instanceId: computer.instance_id });
    return;
  }
  logCloud("cloud.deleted_inactive", { instanceId: computer.instance_id });
}
