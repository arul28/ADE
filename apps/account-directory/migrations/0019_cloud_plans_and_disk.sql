-- ADE Cloud plans, tiers, disk and owner cost protection
-- (docs/plans/ade-cloud-plans-and-disk.md). Additive only: the Worker before
-- this change reads rows with `select *` and ignores the new columns, so apply
-- this migration first, then deploy the Worker.

-- Which paid plan (`plan` stays 'free' or 'paid'). Every paid account before
-- this was Plus.
alter table cloud_accounts add column paid_plan text not null default 'plus';
-- A downgrade to Plus waits for the next period: `paid_plan` stays 'pro'
-- (its hours and limits) and this says what the next period will be.
alter table cloud_accounts add column paid_plan_next text;
-- Extra disk: 'off' (never decided), 'asked' (turned down) or 'on' inside
-- `extra_disk_limit_cents` a period.
alter table cloud_accounts add column extra_disk_state text not null default 'off';
alter table cloud_accounts add column extra_disk_limit_cents integer;
alter table cloud_accounts add column extra_disk_asked_at integer;
-- Set when the person was told that their extra disk, kept a full month,
-- passes the monthly limit they set; cleared once it fits again.
alter table cloud_accounts add column extra_disk_over_limit_at integer;

-- What the provider charges for the awake time of each computer-day, in
-- millionths of a dollar. Corrected with the provider's minutes by the daily
-- reconcile, like the hours.
alter table cloud_computer_days add column cost_micros integer not null default 0;

-- The most disk an account held on each UTC day, the bought plan's disk then
-- (the most it was that day), and whether the day may be billed (a paid plan
-- in good standing with extra disk on, all day). Written when disk or the
-- plan changes; extra disk is billed from these rows only, on
-- `peak_gb - plan_gb`.
-- Reporting: `send_started_at` is the first meter send (a resend inside
-- Stripe's dedupe window is safe); `billed_gb` and `reported_at` are set
-- once it went through (or there was nothing to bill). A send never
-- confirmed inside the window gets `unconfirmed_at` and goes to the owner,
-- never sent again.
create table if not exists cloud_disk_days (
  user_id text not null,
  day text not null,
  peak_gb integer not null,
  plan_gb integer not null,
  billable integer not null default 0,
  send_started_at integer,
  billed_gb integer,
  reported_at integer,
  unconfirmed_at integer,
  primary key (user_id, day)
);
create index if not exists idx_cloud_disk_days_unreported on cloud_disk_days (day) where reported_at is null and unconfirmed_at is null;

-- The owner's daily report: what each account cost and paid on each UTC day.
-- `extra_reported_milli` is the extra hours reported by then, so the next
-- day's income is the difference.
create table if not exists cloud_account_days (
  user_id text not null,
  day text not null,
  plan_id text not null,
  cost_micros integer not null,
  income_micros integer not null,
  extra_reported_milli integer not null default 0,
  period_start integer,
  primary key (user_id, day)
);
create index if not exists idx_cloud_account_days_day on cloud_account_days (day);

-- The daily run counts each account's wakes and sleeps of the day before
-- (one `ade_cloud_day` event each) by time, which the instance index can't serve.
create index if not exists idx_cloud_power_log_created on cloud_power_log (created_at);

-- X-Large (full 4 CPU, 16 GB) now uses 8x hours, not 8.2x. A stretch open
-- when this runs is charged at the new rate, in the person's favor.
update cloud_computers set multiplier_milli = 8000
where type = 'vm' and cpu = 4 and memory_gb = 16 and multiplier_milli = 8200;
