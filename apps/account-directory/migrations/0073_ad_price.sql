-- Pricing v3: the ad price (`src/cloud/adPrice.ts`). Only adds: the live
-- Worker and older apps read nothing here, and with the `pricing_v3` setting
-- off nothing writes it.

-- The account saw the ads notice (one answer on every device): no ad before it.
alter table cloud_sponsored_consent add column notice_seen_at integer;

-- Each proof that a person uses a chat (a message sent, a finished reply's ad
-- request), counted once per (account, chat, turn or message). Pruned after two
-- days (`pruneSponsored`), and with the account.
create table if not exists cloud_ad_proofs (
  user_id text not null,
  chat_id text not null,
  turn_id text not null,
  kind text not null check (kind in ('reply', 'sent')),
  instance_id text,
  phone_id text,
  at integer not null,
  primary key (user_id, chat_id, turn_id)
);
create index if not exists idx_cloud_ad_proofs_at on cloud_ad_proofs (at);

-- What decides one computer's (or one cloud iPhone's) price: its last proof
-- under the ads switch (`proof_at`), its last proof from an ADE Free Models
-- chat (`fm_proof_at`, which holds with ads off: that chat shows its ad), its
-- last request that didn't count, and the full-price work its brain reported.
-- `target` is the instance id, or `phone:<phone id>`.
create table if not exists cloud_ad_targets (
  target text primary key,
  user_id text not null,
  proof_at integer,
  fm_proof_at integer,
  unverified_at integer,
  full_work text,
  full_work_at integer,
  -- An outside agent (ADE MCP) sent a message to one of its chats through the
  -- account server; cleared when its brain next reports it idle.
  outside_at integer,
  updated_at integer not null
);
create index if not exists idx_cloud_ad_targets_user on cloud_ad_targets (user_id);

-- A computer on the ad price holds its full rate here (null on the full
-- price): the settle counts the discount for the owner's report.
alter table cloud_computers add column ad_full_milli integer;
alter table cloud_computer_days add column ad_discount_milli integer not null default 0;
alter table cloud_computer_days add column ad_ms integer not null default 0;

-- A cloud iPhone under Pricing v3: its full rate a minute (null: 1,000, the
-- rate before), the credits its minutes at the ad price took off, and the
-- start of its running ad minutes (null on the full price).
alter table cloud_phones add column rate_milli integer;
alter table cloud_phones add column ad_saved_milli integer not null default 0;
alter table cloud_phones add column ad_mark_at integer;
