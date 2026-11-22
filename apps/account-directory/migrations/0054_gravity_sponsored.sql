-- Sponsored cards and the Index on the ADE Cloud Free plan (src/cloud/gravity.ts,
-- docs/plans/pricing-v2-and-gravity.md). Additive only: apply this migration
-- first, then deploy the Worker. Nothing reads these tables while the
-- GRAVITY_ADS switch is off.

-- The account's answer to the one-time question, on every machine. A grant
-- keeps the SHA-256 of the account's email at that moment (Gravity's
-- `hashed_email`); never the email itself.
create table if not exists cloud_sponsored_consent (
  user_id text primary key,
  consent text not null check (consent in ('granted', 'declined')),
  email_hash text,
  decided_at integer not null
);

-- Who sees sponsored cards while GRAVITY_ADS is `testers`: the owner adds
-- rows by hand. Removed with the account.
create table if not exists cloud_sponsored_testers (
  user_id text primary key,
  added_at integer not null
);

-- A person has a chat or terminal of this ADE Cloud computer open: the last
-- time a client of theirs said so, with the address and device Gravity needs.
-- The Index answers only while someone watches (`seen_at` recent). Rewritten
-- in place; removed with the account.
create table if not exists cloud_sponsored_viewers (
  user_id text not null,
  instance_id text not null,
  ip text,
  ua text,
  device_type text not null,
  os text not null,
  os_version text,
  country text,
  seen_at integer not null,
  primary key (user_id, instance_id)
);

-- One answer per finished reply: asking again for the same turn reads this
-- row and never asks Gravity twice. Only the card's own fields, never the
-- chat's text. Rows older than a day are pruned as new ones are written.
create table if not exists cloud_sponsored_turns (
  user_id text not null,
  chat_id text not null,
  turn_id text not null,
  ad_json text,
  reason text,
  created_at integer not null,
  primary key (user_id, chat_id, turn_id)
);
create index if not exists idx_cloud_sponsored_turns_created on cloud_sponsored_turns(created_at);

-- Counts per UTC day for the owner's report and the daily limits: ad
-- requests, fills, Index searches and picks, all accounts together (`user_id`
-- '*') and per account. No content, no identifiers beyond the account id.
create table if not exists cloud_sponsored_days (
  day text not null,
  user_id text not null,
  kind text not null,
  count integer not null default 0,
  primary key (day, user_id, kind)
);
