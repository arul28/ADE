-- Pricing v2 (docs/plans/pricing-v2-and-gravity.md, src/cloud/plans.ts).
-- Apply this migration right before the Worker that reads it, and deploy that
-- Worker at once: the Worker before it counts hours in Small-hours, the one
-- after in Medium-hours. In between, a stretch the old Worker settles is
-- charged in Small-hours on top of converted numbers (in the person's favor
-- for Small, against them for bigger sizes, for those few minutes).
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
-- favor). The plan's hours of this period and the extra hours already
-- reported or owed are halved too, so a period keeps the share it had left.
update cloud_accounts set used_milli = max(0, used_milli - coalesce((
  select sum(d.metered_milli + coalesce(d.corrected_milli, 0)) from cloud_computer_days d
  where d.user_id = cloud_accounts.user_id and d.multiplier_milli = 1000
    and d.day >= strftime('%Y-%m-%d', cloud_accounts.period_start / 1000, 'unixepoch')
), 0)) / 2;

update cloud_accounts set
  included_milli = included_milli / 2,
  extra_reported_milli = extra_reported_milli / 2,
  extra_owed_milli = extra_owed_milli / 2,
  past_due_included_milli = past_due_included_milli / 2,
  past_due_used_milli = past_due_used_milli / 2;

-- The owner's daily report reads the next day's extra-hours income as the
-- difference from these snapshots: they move to the same unit.
update cloud_account_days set extra_reported_milli = extra_reported_milli / 2;

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

-- 3. Computers. Each rate by its shape. A stretch open when this runs is
-- settled at the new rate when it closes, the part before this included.
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
  end
where deleted_at is null;

-- 4. The ADE Cloud iPhone's testers by email (src/cloud/phones.ts): an email
-- the owner added before any ADE account had it waits here, and the account
-- that first appears with it (a verified address in Clerk) moves onto
-- `cloud_phone_beta` (`claimPhoneBetaInvite` in src/cloud/store.ts).
create table if not exists cloud_phone_beta_pending (
  email text primary key,
  added_at integer not null
);
