-- Pricing v2 (docs/plans/pricing-v2-and-gravity.md, src/cloud/plans.ts).
-- Apply this migration right before the Worker that reads it, and deploy that
-- Worker at once: the Worker before it counts hours in Small-hours, the one
-- after in Medium-hours. In between, a stretch the old Worker settles is
-- charged in Small-hours on top of converted numbers (in the person's favor
-- for Small, against them for bigger sizes, for those few minutes).
--
-- Also in between, the old Worker writes old numbers this file never sees: a
-- computer it makes gets its old rate (Small 1000, Medium 2000, ...), and a
-- free account it makes or whose period it rolls gets the old 100,000 free
-- thousandths. Right after the Worker deploy, run this once (it is safe to
-- run again: every value is set, never divided):
--
--   update cloud_computers set multiplier_milli = case
--       when type = 'default' and cpu = 2 and memory_gb = 4 then 0
--       when type = 'default' and cpu = 4 and memory_gb = 8 then 1000
--       when type = 'default' and cpu = 4 and memory_gb = 16 then 1650
--       when type = 'default' and cpu = 4 and memory_gb = 32 then 2900
--       when type = 'vm' and cpu = 2 and memory_gb = 4 then 1250
--       when type = 'vm' and cpu = 4 and memory_gb = 8 then 2500
--       when type = 'vm' and cpu = 4 and memory_gb = 16 then 4000
--       when type = 'vm' and cpu = 4 and memory_gb = 32 then 7250
--     end
--   where (
--     (type = 'default' and cpu = 2 and memory_gb = 4) or (type = 'default' and cpu = 4 and memory_gb in (8, 16, 32))
--     or (type = 'vm' and cpu = 2 and memory_gb = 4) or (type = 'vm' and cpu = 4 and memory_gb in (8, 16, 32)));
--   update cloud_accounts set included_milli = 50000 where plan = 'free' and included_milli = 100000;
--
-- (Deleted computers too: the daily reconcile still settles their last days,
-- at the computer's rate when a day has no row. A computer of another shape
-- keeps its rate; only the eight sizes exist. A
-- paid period the old Worker rolled in those minutes keeps its old, larger
-- hours: in the person's favor, and left as it is.)
--
-- Hours were thousandths of a Small-hour (Small 1000, Medium 2000, ...). They
-- are now thousandths of a Medium-hour, and Small uses none: every rate is
-- half its old one, except Small, which is 0. The statements run in order;
-- the account step reads the day rows before the day step rewrites them.
-- SQLite divides integers as integers (rounded toward zero), so each halving
-- moves a number by at most one thousandth of an hour: down, in the person's
-- favor, except a negative correction, which shrinks toward zero.
-- Earned hours (referrals) stay as they are: a 20-hour reward is now 20
-- Medium-hours, on purpose.

-- 1. Accounts. This period's Small use comes off what was used, then the
-- rest is halved: `used_milli` is the settled meter plus the daily
-- reconcile's corrections, so Small's share is its day rows' metered and
-- corrected thousandths from the period's first UTC day on (a paid period
-- that began mid-day counts that whole day's Small use: in the person's
-- favor). The plan's hours of this period are halved too, so a period keeps
-- the share it had left.
--
-- The extra hours already reported to Stripe (`extra_reported_milli`, and the
-- owner report's `cloud_account_days` snapshot of it) stay as they are. Each
-- reported hour has a meter identifier `ade-extra:{sub}:{period_start}:{n}`,
-- n counted from `extra_reported_milli` (src/cloud/billing.ts), so halving it
-- would send hours Stripe already has under new identifiers and bill them
-- twice. Kept, it now counts twice the Medium-hours it billed: the person's
-- next extra hours are covered until the halved use passes it (in the
-- person's favor; it resets with the period). `extra_owed_milli` (what a
-- past-due period ended owing, billed later from the same counter) is halved
-- like used: what it still bills, `owed - reported`, can then only shrink,
-- never bill an old Small-hour as a Medium-hour.
--
-- A past-due account's saved paid period (`past_due_used_milli`, restored if
-- the same period is paid after all) loses its Small use the same way before
-- it is halved. No column keeps that period's start, only its end
-- (`past_due_period_end`), and a period is a month, so its Small days are
-- counted from 31 days before that end on, up to today: a few days before
-- the period and those after the payment failed come off too (in the
-- person's favor; it cannot go below 0).
update cloud_accounts set used_milli = max(0, used_milli - coalesce((
  select sum(d.metered_milli + coalesce(d.corrected_milli, 0)) from cloud_computer_days d
  where d.user_id = cloud_accounts.user_id and d.multiplier_milli = 1000
    and d.day >= strftime('%Y-%m-%d', cloud_accounts.period_start / 1000, 'unixepoch')
), 0)) / 2;

update cloud_accounts set past_due_used_milli = max(0, past_due_used_milli - coalesce((
  select sum(d.metered_milli + coalesce(d.corrected_milli, 0)) from cloud_computer_days d
  where d.user_id = cloud_accounts.user_id and d.multiplier_milli = 1000
    and d.day >= strftime('%Y-%m-%d', cloud_accounts.past_due_period_end / 1000, 'unixepoch', '-31 days')
), 0)) / 2
where past_due_used_milli is not null;

update cloud_accounts set
  included_milli = included_milli / 2,
  extra_owed_milli = extra_owed_milli / 2,
  past_due_included_milli = past_due_included_milli / 2;

-- 2. Day rows. Small rows use no hours; every other rate halves, and so does
-- what it metered and what the reconcile corrected. The reconcile corrects a
-- day by the provider's minutes at the ratio `metered_milli / metered_ms`
-- (or the row's rate when nothing was metered), so a Small day corrects by 0
-- and a halved day by half. A day a resize split between Small and a bigger
-- size is taken at the rate it ended on.
update cloud_computer_days set metered_milli = 0, corrected_milli = case when corrected_milli is null then null else 0 end, multiplier_milli = 0
where multiplier_milli = 1000;

update cloud_computer_days set
  metered_milli = metered_milli / 2,
  corrected_milli = corrected_milli / 2,
  multiplier_milli = multiplier_milli / 2
where multiplier_milli > 0;

-- 3. Computers, deleted ones too (the reconcile reads a deleted computer's
-- rate for a day with no row). Each rate by its shape; another shape halves,
-- like a day row. A stretch open when this runs is settled at the new rate
-- when it closes, the part before this included.
update cloud_computers set multiplier_milli = case
    when type = 'default' and cpu = 2 and memory_gb = 4 then 0
    when type = 'default' and cpu = 4 and memory_gb = 8 then 1000
    when type = 'default' and cpu = 4 and memory_gb = 16 then 1650
    when type = 'default' and cpu = 4 and memory_gb = 32 then 2900
    when type = 'vm' and cpu = 2 and memory_gb = 4 then 1250
    when type = 'vm' and cpu = 4 and memory_gb = 8 then 2500
    when type = 'vm' and cpu = 4 and memory_gb = 16 then 4000
    when type = 'vm' and cpu = 4 and memory_gb = 32 then 7250
    else multiplier_milli / 2
  end;

-- 4. The ADE Cloud iPhone's testers by email (src/cloud/phones.ts): an email
-- the owner added before any ADE account had it waits here, and the account
-- that first appears with it (a verified address in Clerk) moves onto
-- `cloud_phone_beta` (`claimPhoneBetaInvite` in src/cloud/store.ts). The
-- owner check asks Clerk again about each waiting email about hourly
-- (`resolvePendingPhoneBeta` in src/cloud/phones.ts); `checked_at` is its
-- last ask.
create table if not exists cloud_phone_beta_pending (
  email text primary key,
  added_at integer not null,
  checked_at integer
);
