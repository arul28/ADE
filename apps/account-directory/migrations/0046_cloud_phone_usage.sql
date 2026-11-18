-- The ADE Cloud iPhone at launch (src/cloud/phones.ts, phoneBilling.ts): every
-- phone an account started, its minutes and cost as NoMac billed them, the
-- extra-minutes switch, and the minutes warnings. Additive only: apply before
-- the Worker that reads it.

-- One row per NoMac phone. `state` is `live` (queued, starting or ready) or
-- `ended`, and never goes back from `ended` (a late delivery can't revive
-- one). `billed_seconds` is NoMac's (whole minutes, one at least) and
-- `cost_micros` what NoMac charged ADE; both only grow. `free` is whether the
-- account was on free-plan rules when the phone started, for the owner's
-- free-use cost cap. Kept (user id re-keyed) when the account is deleted, for
-- the cost report. `stop_at` is when the account stops paying for a live
-- phone (its minutes can shrink while it runs, and NoMac can't lower a running
-- phone's limit): the minute tick stops it then.
create table if not exists cloud_phones (
  phone_id text primary key,
  user_id text not null,
  device text,
  state text not null,
  created_at integer not null,
  ready_at integer,
  ended_at integer,
  billed_seconds integer not null default 0,
  cost_micros integer not null default 0,
  end_reason text,
  free integer not null default 0,
  stop_at integer,
  updated_at integer not null
);
create index if not exists idx_cloud_phones_user_created on cloud_phones (user_id, created_at);
create index if not exists idx_cloud_phones_live on cloud_phones (state) where state = 'live';
create index if not exists idx_cloud_phones_created on cloud_phones (created_at);
create index if not exists idx_cloud_phones_updated on cloud_phones (updated_at);

-- NoMac webhook deliveries already taken, by their id (NoMac may deliver one
-- more than once). Kept 30 days.
create table if not exists cloud_nomac_deliveries (
  id text primary key,
  received_at integer not null
);
create index if not exists idx_cloud_nomac_deliveries_received on cloud_nomac_deliveries (received_at);

-- Extra iPhone minutes past a paid plan: the switch, the monthly limit (null:
-- none), and for the period `phone_extra_period_start` names, the minutes
-- already sent to Stripe and the minutes owed when the switch went off. A
-- different period than the account's own means none of either yet.
alter table cloud_accounts add column phone_extra_enabled integer not null default 0;
alter table cloud_accounts add column phone_extra_limit_cents integer;
alter table cloud_accounts add column phone_extra_reported_minutes integer not null default 0;
alter table cloud_accounts add column phone_extra_owed_minutes integer not null default 0;
alter table cloud_accounts add column phone_extra_period_start integer;
-- The plan's iPhone minutes in that period, so it is billed after it ends at its own plan's minutes.
alter table cloud_accounts add column phone_extra_included integer;

-- The 80% and out-of-minutes emails, once each a period (`phone_warned_period_start`).
alter table cloud_accounts add column phone_warned_80_at integer;
alter table cloud_accounts add column phone_warned_zero_at integer;
alter table cloud_accounts add column phone_warned_period_start integer;
