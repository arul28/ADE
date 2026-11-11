-- ADE Cloud referrals, earned hours and one free plan per computer
-- (src/cloud/referrals.ts, src/cloud/freePlan.ts; README "Referrals and the
-- free plan"). Additive only: the Worker before this change reads rows with
-- `select *` and ignores the new columns, so apply this migration first, then
-- deploy the Worker.

-- Each account's one invite code (`https://ade-app.dev/invite/<code>`), made
-- the first time the account's referral summary is built. Eight characters of
-- an alphabet with no 0/O/1/I/L; unique across accounts.
create table if not exists cloud_invite_codes (
  user_id text primary key,
  code text not null unique,
  created_at integer not null
);

-- Who invited whom. One row per friend, never changed: the primary key is what
-- makes "one referrer per account" hold under two redeems at once.
-- `state`: 'pending' until the friend's first chat runs on an ADE Cloud
-- computer, then 'rewarded' or 'refused' (`reason` says why).
-- `reward_token` names the one request that moved it out of 'pending', so the
-- grants below are written by exactly that request.
-- `referrer_rewarded`: 1 when the referrer got their 20 hours too (0 past their cap of 10).
create table if not exists cloud_referrals (
  friend_user_id text primary key,
  referrer_user_id text not null,
  entered_at integer not null,
  state text not null default 'pending',
  reason text,
  decided_at integer,
  rewarded_at integer,
  reward_token text,
  referrer_rewarded integer not null default 0
);
create index if not exists idx_cloud_referrals_referrer on cloud_referrals (referrer_user_id, state);

-- Earned hours, append-only. A grant is never removed and never expires.
-- (user_id, reason, reference) is unique, so one event grants once however
-- often it is retried: a referral's reference is the friend's account.
-- `milli` is in thousandths of a Small-hour, like every other hour column.
create table if not exists cloud_earned_hours (
  id integer primary key autoincrement,
  user_id text not null,
  milli integer not null,
  reason text not null,
  reference text not null,
  created_at integer not null,
  unique (user_id, reason, reference)
);

-- The account's earned-hours balance, kept on its row so every hours check
-- (the minute tick, the extra-hours report) reads it with the account:
-- `earned_granted_milli` is recomputed from the grants above in the batch that
-- adds one; `earned_used_milli` is what past periods drew, added when a period
-- ends (plan hours first, then earned, then paid extra hours).
alter table cloud_accounts add column earned_granted_milli integer not null default 0;
alter table cloud_accounts add column earned_used_milli integer not null default 0;
-- What the period cut short by a failed payment drew from earned hours; a
-- paid invoice inside that period gives it back with the hours it restores.
alter table cloud_accounts add column past_due_earned_milli integer;
-- When this account was refused the free plan because its computer already
-- gave another account its free hours. While set, the free plan's hours are 0
-- (paid plans, earned hours and extra hours are untouched). Cleared when the
-- account claims a computer of its own.
alter table cloud_accounts add column free_refused_at integer;
-- When the ADE account was created (Clerk), read once for the 30-day window to
-- enter an invite code.
alter table cloud_accounts add column account_created_at integer;

-- One free plan per physical computer. `computer_hash` is the server's HMAC
-- of the client's hash of the OS machine id (never the id itself, never the
-- per-account `hardware_id` of 0008). Both keys are unique: a computer gives
-- its free plan to one account, and an account claims one computer. Kept when
-- the account is deleted, so a delete-and-recreate doesn't get the hours again.
create table if not exists cloud_free_plan_claims (
  computer_hash text primary key,
  user_id text not null unique,
  claimed_at integer not null,
  platform text
);

-- Every computer an account was seen on (the same HMAC), for the referral
-- rule "no reward when both accounts share a computer" and the abuse signals.
-- Deleted with the account.
create table if not exists cloud_account_computers (
  user_id text not null,
  computer_hash text not null,
  first_seen_at integer not null,
  platform text,
  primary key (user_id, computer_hash)
);
create index if not exists idx_cloud_account_computers_hash on cloud_account_computers (computer_hash);
