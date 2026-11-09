-- ADE Cloud accounts and the computers they own (README, "ADE Cloud account").
-- Everything the server needs to hold the provider key, meter hours and take
-- payment. Stripe and saved chats are written by other routes; their tables
-- live here so one migration creates all of it.

-- Every computer ADE made for an account. `instance_id` is `pending:<uuid>`
-- from the moment a create or copy reserves its slot until the provider
-- answers; the reservation is what makes the limits hold under concurrent
-- calls. Rows are kept after a delete (`deleted_at`) so usage and the delete
-- log stay readable. `awake_since` opens a running stretch; it can lie in the
-- future while a free push-work wake runs (metering starts when it ends).
create table if not exists cloud_computers (
  instance_id text primary key,
  user_id text not null,
  -- Tag on the provider's instance; the cron adopts a create the Worker lost.
  request_id text,
  type text not null,
  cpu integer not null,
  memory_gb integer not null,
  disk_gb integer not null,
  multiplier_milli integer not null,
  template_version text,
  machine_key text,
  name text,
  status text not null,
  status_changed_at integer not null,
  awake_since integer,
  last_awake_at integer,
  created_at integer not null,
  deleted_at integer,
  -- A sleeper in cold storage answers stop with a refusal: leave it alone.
  cold_storage integer not null default 0,
  -- The one free wake to push work at 0 hours.
  free_wake_started_at integer,
  free_wake_until integer,
  free_wake_used_at integer,
  -- A stop in progress at 0 hours, so overlapping ticks don't repeat it.
  zero_stop_started_at integer,
  delete_warned_7d_at integer,
  delete_warned_1d_at integer
);
create index if not exists idx_cloud_computers_user on cloud_computers (user_id, deleted_at);
create index if not exists idx_cloud_computers_request on cloud_computers (request_id);

-- Every delete, automatic ones included. `who` is the device or chat the
-- caller named. `events_json` is the provider's start/sleep history, read
-- first because a delete erases it.
create table if not exists cloud_delete_log (
  id integer primary key autoincrement,
  instance_id text not null,
  user_id text not null,
  who text,
  reason text not null,
  events_json text,
  created_at integer not null
);
create index if not exists idx_cloud_delete_log_instance on cloud_delete_log (instance_id);
create index if not exists idx_cloud_delete_log_user on cloud_delete_log (user_id, created_at desc);

-- Each power change: action is wake, sleep, stop or start. Written by the
-- routes and by the cron when it sees a change it didn't cause.
create table if not exists cloud_power_log (
  id integer primary key autoincrement,
  instance_id text not null,
  user_id text not null,
  action text not null,
  reason text not null,
  created_at integer not null
);
create index if not exists idx_cloud_power_log_instance on cloud_power_log (instance_id, created_at desc);

-- One row per account, made on first use. Hours are integer thousandths of a
-- Small-hour (`used_milli`, `included_milli`), never floats. `used_milli` is
-- what is settled; live hours add the running stretches in `cloud_computers`.
-- Paid accounts reset on the billing date (Stripe drives `period_end`);
-- free accounts on the 1st of the month UTC.
create table if not exists cloud_accounts (
  user_id text primary key,
  plan text not null default 'free',
  included_milli integer not null,
  used_milli integer not null default 0,
  period_start integer not null,
  period_end integer not null,
  stripe_customer_id text,
  stripe_subscription_id text,
  -- Stripe's status as last told by the webhook. `past_due` puts the account on free rules.
  stripe_status text,
  cancel_at_period_end integer not null default 0,
  -- Extra hours: paid only, off by default; charged in thousandths reported to the meter.
  extra_enabled integer not null default 0,
  extra_reported_milli integer not null default 0,
  -- What the account had used when `past_due` began, restored by a later paid invoice.
  past_due_used_milli integer,
  past_due_period_end integer,
  warned_80_at integer,
  warned_95_at integer,
  warned_zero_at integer,
  -- When hours came back after running out: the 30-day delete clock waits for this.
  hours_restored_at integer,
  created_at integer not null,
  updated_at integer not null
);
create index if not exists idx_cloud_accounts_period on cloud_accounts (period_end);
create index if not exists idx_cloud_accounts_stripe_customer on cloud_accounts (stripe_customer_id);

-- One row per computer and UTC day: what the meter charged and, after the
-- daily reconcile, the provider's own `awake_minutes` for it. `free_ms` is the
-- free push-work time so reconcile doesn't charge it.
create table if not exists cloud_computer_days (
  instance_id text not null,
  day text not null,
  user_id text not null,
  metered_ms integer not null default 0,
  metered_milli integer not null default 0,
  multiplier_milli integer not null,
  free_ms integer not null default 0,
  provider_minutes integer,
  corrected_milli integer,
  reconciled_at integer,
  primary key (instance_id, day)
);
create index if not exists idx_cloud_computer_days_day on cloud_computer_days (day);

-- Stripe event ids already applied, so a webhook delivered twice runs once.
create table if not exists cloud_stripe_events (
  event_id text primary key,
  type text,
  received_at integer not null
);

-- Operator settings, keyed: `template_version` (exact `ade@N`; never bare `ade`),
-- and each background job's last run.
create table if not exists cloud_settings (
  key text primary key,
  value text not null,
  updated_at integer not null
);

-- The saved copy of each chat, one row per chat. The transcript itself lives
-- in R2 under `r2_key`; this index is what the chat list reads, so nothing has
-- to wake to list a sleeping computer's chats.
create table if not exists cloud_chat_copies (
  user_id text not null,
  machine_key text not null,
  chat_id text not null,
  title text,
  status text,
  r2_key text not null,
  updated_at integer not null,
  bytes integer not null default 0,
  primary key (user_id, machine_key, chat_id)
);
create index if not exists idx_cloud_chat_copies_user on cloud_chat_copies (user_id, updated_at desc);

-- One key per user for the saved chats, sealed with CLOUD_CHAT_MASTER_KEY
-- and kept apart from the chats themselves.
create table if not exists cloud_user_keys (
  user_id text primary key,
  sealed_key text not null,
  created_at integer not null,
  rotated_at integer
);
