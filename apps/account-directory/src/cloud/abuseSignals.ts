import type { CloudSustainedCpuReport } from "./contract";
import { workerKeyedHash } from "./freePlan";
import { logCloud, reportCloudFailure, type CloudEnv, type ComputerRow } from "./store";

/**
 * Two abuse signals for the owner's daily report (`costReport.ts`). No
 * PostHog alert: those slots are full.
 *
 * Mining-like use. The computer's brain is the only place that sees both its
 * CPU and whether a chat turn or an agent is working, so it decides: its
 * keep-awake check (once a minute) measures CPU over all cores from the OS
 * counters, and once it has stayed at or above its threshold for two hours
 * with no chat turn, agent CLI, setup, clone, move or copy running, it sends
 * `POST /cloud/instances/:id/cpu-report` (again every six hours while it
 * lasts). Limits: the computer reports on itself, so a brain someone changed
 * can stay quiet, and a long build or test run in a terminal can look the
 * same. The line is for a person to look at; nothing acts on it.
 *
 * Sign-up bursts. Clerk's `user.created` webhook carries the sign-up's
 * client IP (`event_attributes.http_request.client_ip`). Only an HMAC of it
 * under a key derived from `CLOUD_CHAT_MASTER_KEY` is stored (the way
 * `freePlan.ts` keys a computer id), one row per account, and rows go after
 * {@link SIGNUP_IP_KEEP_DAYS} days. The report counts sign-ups per hashed
 * address in any 60-minute window of its day.
 */

/** Sign-ups from one IP address within an hour at which the daily report raises an alarm. */
export const SIGNUP_BURST_PER_IP_HOUR = 5;
const SIGNUP_BURST_WINDOW_MS = 60 * 60_000;
/** Hashed sign-up addresses are kept this long: enough for the daily report and a week of looking back. */
export const SIGNUP_IP_KEEP_DAYS = 7;
const SIGNUP_IP_KEY_LABEL = "ade-cloud-signup-ip-hmac-v1";
/** The longest a computer can claim to have run hot (a report is about one stretch since its last boot). */
const CPU_REPORT_MAX_MINUTES = 31 * 24 * 60;
const DAY_MS = 24 * 60 * 60_000;

/* ---- Sustained CPU ---- */

/** The computer's report, or null when it isn't one. `since` may not be in the future. */
export function parseSustainedCpuReport(body: Record<string, unknown> | null, now: number): CloudSustainedCpuReport | null {
  if (!body) return null;
  const { since, minutes, cpuPercent } = body;
  if (typeof since !== "number" || !Number.isFinite(since) || since <= 0 || since > now + 60_000) return null;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0 || minutes > CPU_REPORT_MAX_MINUTES) return null;
  if (typeof cpuPercent !== "number" || !Number.isFinite(cpuPercent) || cpuPercent < 0 || cpuPercent > 100) return null;
  return { since: Math.round(since), minutes: Math.round(minutes), cpuPercent: Math.round(cpuPercent) };
}

export async function recordSustainedCpu(env: CloudEnv, computer: ComputerRow, report: CloudSustainedCpuReport, now: number): Promise<void> {
  // One row per computer and UTC day: the day's longest stretch stays, and the next day starts its own row.
  await env.DB.prepare(`
    insert into cloud_cpu_reports (instance_id, user_id, day, since, cpu_percent, minutes, reported_at) values (?, ?, ?, ?, ?, ?, ?)
    on conflict (instance_id, day) do update set
      since = case when excluded.minutes >= minutes then excluded.since else since end,
      cpu_percent = case when excluded.minutes >= minutes then excluded.cpu_percent else cpu_percent end,
      minutes = max(minutes, excluded.minutes),
      reported_at = excluded.reported_at
  `).bind(computer.instance_id, computer.user_id, new Date(now).toISOString().slice(0, 10), report.since, report.cpuPercent, report.minutes, now).run();
  logCloud("cloud.cpu_sustained_reported", { userId: computer.user_id, instanceId: computer.instance_id, minutes: report.minutes, cpuPercent: report.cpuPercent });
}

type CpuRow = { instance_id: string; user_id: string; plan: string | null; since: number; cpu_percent: number; minutes: number };

const hoursText = (minutes: number): string => `${Math.round((minutes / 60) * 10) / 10} hours`;
const utcTime = (at: number): string => new Date(at).toISOString().slice(11, 16);

/** The report's lines for computers that reported hours near full CPU with no chat turn during `day`. */
export async function sustainedCpuAlarms(env: CloudEnv, day: string): Promise<string[]> {
  const rows = await env.DB.prepare(`
    select r.instance_id, r.user_id, a.plan, r.since, r.cpu_percent, r.minutes
    from cloud_cpu_reports r left join cloud_accounts a on a.user_id = r.user_id
    where r.day = ?
    order by r.minutes desc
  `).bind(day).all<CpuRow>();
  return (rows.results ?? []).map((row) =>
    `Computer ${row.instance_id} of account ${row.user_id} (${row.plan ?? "free"}) ran at ${row.cpu_percent}% CPU or more for ${hoursText(row.minutes)} from ${utcTime(row.since)} UTC with no chat turn or agent working. That looks like mining.`);
}

/* ---- Sign-up bursts ---- */

/** The sign-up's client IP from Clerk's webhook, or null when Clerk didn't send one. */
export function signupClientIp(payload: unknown): string | null {
  const attributes = (payload as { event_attributes?: { http_request?: { client_ip?: unknown } } } | null)?.event_attributes;
  const ip = attributes?.http_request?.client_ip;
  return typeof ip === "string" && ip.trim() && ip.length <= 64 ? ip.trim().toLowerCase() : null;
}

/** Stores the sign-up's hashed address, once per account. Never throws: a failure is reported and the webhook goes on. */
export async function recordSignupIp(env: Pick<CloudEnv, "DB" | "CLOUD_CHAT_MASTER_KEY">, userId: string, ip: string | null, signedUpAt: number): Promise<void> {
  if (!ip) {
    logCloud("cloud.signup_ip_missing", { userId });
    return;
  }
  try {
    const hash = await workerKeyedHash(env, SIGNUP_IP_KEY_LABEL, ip);
    await env.DB.prepare("insert into cloud_signup_ips (user_id, ip_hash, signed_up_at) values (?, ?, ?) on conflict (user_id) do nothing")
      .bind(userId, hash, signedUpAt).run();
  } catch (error) {
    reportCloudFailure("cloud.signup_ip_record_failed", { userId, message: error instanceof Error ? error.message : "unknown" });
  }
}

/** Deletes hashed sign-up addresses older than {@link SIGNUP_IP_KEEP_DAYS} days. */
export async function pruneSignupIps(env: CloudEnv, now: number): Promise<void> {
  await env.DB.prepare("delete from cloud_signup_ips where signed_up_at < ?").bind(now - SIGNUP_IP_KEEP_DAYS * DAY_MS).run();
  // CPU reports go after the same days.
  await env.DB.prepare("delete from cloud_cpu_reports where day < ?").bind(new Date(now - SIGNUP_IP_KEEP_DAYS * DAY_MS).toISOString().slice(0, 10)).run();
}

/**
 * The report's lines for addresses with at least {@link SIGNUP_BURST_PER_IP_HOUR}
 * sign-ups inside one 60-minute window that starts during `day`, one line per
 * address (its busiest window).
 */
export async function signupBurstAlarms(env: CloudEnv, day: string): Promise<string[]> {
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  const rows = await env.DB.prepare(`
    select user_id, ip_hash, signed_up_at from cloud_signup_ips
    where signed_up_at >= ? and signed_up_at < ? order by ip_hash, signed_up_at
  `).bind(dayStart, dayStart + DAY_MS + SIGNUP_BURST_WINDOW_MS).all<{ user_id: string; ip_hash: string; signed_up_at: number }>();
  const byAddress = new Map<string, Array<{ user_id: string; signed_up_at: number }>>();
  for (const row of rows.results ?? []) {
    const list = byAddress.get(row.ip_hash) ?? [];
    list.push(row);
    byAddress.set(row.ip_hash, list);
  }
  const lines: string[] = [];
  for (const signups of byAddress.values()) {
    let best: { from: number; count: number; end: number } | null = null;
    let end = 0;
    for (let start = 0; start < signups.length; start += 1) {
      const from = signups[start]!.signed_up_at;
      if (from >= dayStart + DAY_MS) break;
      if (end < start) end = start;
      while (end + 1 < signups.length && signups[end + 1]!.signed_up_at < from + SIGNUP_BURST_WINDOW_MS) end += 1;
      const count = end - start + 1;
      if (count >= SIGNUP_BURST_PER_IP_HOUR && (!best || count > best.count)) best = { from: start, count, end };
    }
    if (!best) continue;
    const accounts = signups.slice(best.from, best.end + 1).map((signup) => signup.user_id);
    const shown = accounts.slice(0, 10).join(", ");
    lines.push(`${best.count} sign-ups from one IP address within an hour from ${utcTime(signups[best.from]!.signed_up_at)} UTC: ${shown}${accounts.length > 10 ? `, and ${accounts.length - 10} more` : ""}.`);
  }
  return lines;
}
