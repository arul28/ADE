/**
 * Credits: one balance for everything ADE Cloud runs.
 *
 * A credit is the old hour renamed: the plan's hours (`includedMilli`), the
 * earned ones and the extra ones keep every number, and a Medium computer
 * still uses one an hour. The ADE Cloud iPhone draws from the same balance
 * at one credit a minute: there is no separate iPhone balance, and an extra
 * iPhone minute is one extra credit, on the extra-hours switch.
 *
 * A phone counts in credits when its row says so (`cloud_phones.credits`,
 * migration 0059): every phone saved since does. Rows from before credits
 * (`credits = 0`) are history only and charge nothing. A phone's credits go
 * into `used_milli` as its provider settles its billed minutes
 * (`phoneCreditStatements` in `phones.ts`), so every rule that reads hours
 * (the limits, extra hours, earned hours, the period's end) counts them.
 */

import { CLOUD_PHONE_MAX_MINUTES } from "../../../desktop/src/shared/cloudPhone";
import type { PhoneRow } from "./phones";
import { liveUsedMilli, type AccountRow, type CloudEnv, type ComputerRow } from "./store";

/** What a running iPhone uses: one credit (a thousand thousandths) a minute. */
export const PHONE_CREDIT_MILLI_PER_MINUTE = 1000;

/** A credits phone's row, as the balance reads it. */
type CreditPhone = Pick<PhoneRow, "user_id" | "billed_seconds" | "ready_at" | "credited_milli" | "created_at" | "state">;

/** The running credits phones (the partial index on live phones keeps this a short read). */
const LIVE_CREDIT_PHONES_SQL = "select user_id, billed_seconds, ready_at, credited_milli, created_at, state from cloud_phones where state = 'live' and credits = 1";

/**
 * A credits phone's use so far (thousandths): its provider's billed minutes,
 * or while it runs its time so far (whole minutes, up; never past one phone's
 * longest), whichever is more.
 */
export function phoneCreditMilliOf(row: Pick<PhoneRow, "billed_seconds" | "ready_at" | "state">, now: number): number {
  const billed = Math.ceil(row.billed_seconds / 60);
  const running = row.state === "live" && row.ready_at != null
    ? Math.min(CLOUD_PHONE_MAX_MINUTES, Math.ceil(Math.max(0, now - row.ready_at) / 60_000))
    : 0;
  return Math.max(billed, running) * PHONE_CREDIT_MILLI_PER_MINUTE;
}

/**
 * Per account: what its running credits phones used that isn't in
 * `used_milli` yet (their time past `credited_milli`). Only phones of the
 * account's current period: one from before the turn was settled into that
 * period (`startFreshPeriod`). An account with a running credits phone is in
 * the map even at 0.
 */
function unsettledOf(rows: readonly CreditPhone[], accounts: readonly Pick<AccountRow, "user_id" | "period_start">[], now: number): Map<string, number> {
  const starts = new Map(accounts.map((account) => [account.user_id, account.period_start]));
  const unsettled = new Map<string, number>();
  for (const row of rows) {
    const start = starts.get(row.user_id);
    if (start == null || row.created_at < start) continue;
    unsettled.set(row.user_id, (unsettled.get(row.user_id) ?? 0) + Math.max(0, phoneCreditMilliOf(row, now) - row.credited_milli));
  }
  return unsettled;
}

/**
 * The running credits phones' unsettled use, per account: every rule that
 * reads the balance (`liveUsedMilli`) adds it, so a computer can't spend
 * credits a phone already used before its provider bills them.
 */
export async function unsettledPhoneMilliByUser(env: Pick<CloudEnv, "DB">, accounts: readonly Pick<AccountRow, "user_id" | "period_start">[], now: number): Promise<Map<string, number>> {
  if (accounts.length === 0) return new Map();
  const rows = await env.DB.prepare(`${LIVE_CREDIT_PHONES_SQL} and user_id in (select value from json_each(?))`)
    .bind(JSON.stringify(accounts.map((account) => account.user_id))).all<CreditPhone>();
  return unsettledOf(rows.results ?? [], accounts, now);
}

/**
 * The account's hours used now: `used_milli`, the computers' running
 * stretches and its running credits phones' unsettled use, all from one read
 * (`accountWithUnsettledPhones`), so a computer's or a phone's save between
 * two reads is counted once. `account` is the caller's (already loaded and
 * rolled), used only if its row is gone.
 */
export async function liveUsedWithPhones(env: Pick<CloudEnv, "DB">, account: AccountRow, now: number): Promise<number> {
  return (await accountWithUnsettledPhones(env, account.user_id, now)).liveUsedMilli ?? liveUsedMilli(account, [], now);
}

/** One account's `unsettledPhoneMilliByUser`. */
export async function unsettledPhoneMilli(env: Pick<CloudEnv, "DB">, account: Pick<AccountRow, "user_id" | "period_start">, now: number): Promise<number> {
  return (await unsettledPhoneMilliByUser(env, [account], now)).get(account.user_id) ?? 0;
}

/**
 * The account row, its computers and its running credits phones from one
 * read, and the hours used now from them (`liveUsedMilli` plus the phones'
 * unsettled use). A computer's or phone's save between separate reads would
 * count its time twice: once in `used_milli`, once as running or unsettled.
 * Null `liveUsedMilli` when the account row is gone.
 */
export async function accountWithUnsettledPhones(env: Pick<CloudEnv, "DB">, userId: string, now: number): Promise<{ account: AccountRow | null; liveUsedMilli: number | null }> {
  const [accounts, computers, phones] = await env.DB.batch([
    env.DB.prepare("select * from cloud_accounts where user_id = ?").bind(userId),
    env.DB.prepare("select * from cloud_computers where user_id = ? and deleted_at is null").bind(userId),
    env.DB.prepare(`${LIVE_CREDIT_PHONES_SQL} and user_id = ?`).bind(userId),
  ]);
  const account = (accounts?.results?.[0] as AccountRow | undefined) ?? null;
  if (!account) return { account: null, liveUsedMilli: null };
  const unsettled = unsettledOf((phones?.results ?? []) as CreditPhone[], [account], now).get(userId) ?? 0;
  return { account, liveUsedMilli: liveUsedMilli(account, (computers?.results ?? []) as ComputerRow[], now) + unsettled };
}

/**
 * SQL for one credits phone row's use so far, in thousandths, at `?` (now):
 * `phoneCreditMilliOf` in SQL, for the period's turn (`startFreshPeriod`).
 */
export const PHONE_CREDIT_MILLI_AT_SQL = `(max((billed_seconds + 59) / 60,
  case when state = 'live' and ready_at is not null then min(${CLOUD_PHONE_MAX_MINUTES}, (max(0, cast(? as integer) - ready_at) + 59999) / 60000) else 0 end) * ${PHONE_CREDIT_MILLI_PER_MINUTE})`;
