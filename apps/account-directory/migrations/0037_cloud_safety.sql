-- ADE Cloud safety (src/cloud/safety.ts; README "ADE Cloud safety"): the
-- owner's block list, abuse events, one free unlock per card, owner alert
-- de-duplication, and free use counted apart from paid use for the owner's
-- cost cap. Additive only: the Worker before this change reads rows with
-- `select *` and ignores the new columns, so apply this migration first,
-- then deploy the Worker.

-- The owner's block list. A row blocks an ADE account (`user_id`), a GitHub
-- account (`github_user_id`) or a card (`card_fingerprint`, Stripe's card
-- fingerprint); a block of an account also stores its GitHub id and card when
-- known, so they can't come back on a new account. Unblocking an account
-- deletes its rows. Kept (user id re-keyed to a hash) when the account is deleted.
create table if not exists cloud_blocks (
  id integer primary key autoincrement,
  user_id text,
  github_user_id integer,
  card_fingerprint text,
  reason text not null,
  created_at integer not null
);
create index if not exists idx_cloud_blocks_user on cloud_blocks (user_id) where user_id is not null;
create index if not exists idx_cloud_blocks_github on cloud_blocks (github_user_id) where github_user_id is not null;
create index if not exists idx_cloud_blocks_card on cloud_blocks (card_fingerprint) where card_fingerprint is not null;
create index if not exists idx_cloud_blocks_time on cloud_blocks (created_at);

-- What `reportCloudAbuse` saw, per account: a block, a card used again, a
-- blocked GitHub account or card back on a new account, a sign-up burst, a
-- rate limit hit. `detail_json` holds counts and closed codes, never a
-- secret. Re-keyed to a hash when the account is deleted.
create table if not exists cloud_abuse_events (
  id integer primary key autoincrement,
  user_id text,
  kind text not null,
  detail_json text,
  created_at integer not null
);
create index if not exists idx_cloud_abuse_events_user on cloud_abuse_events (user_id, created_at);
create index if not exists idx_cloud_abuse_events_time on cloud_abuse_events (created_at);

-- One card unlocks the free hours on one account (`billing.ts`
-- `createFreeUnlockUrl`). The primary key makes two accounts racing with one
-- card settle to one claim. Kept (re-keyed to a hash) when the account is
-- deleted, so a re-made account can't use the card again.
create table if not exists cloud_free_card_claims (
  card_fingerprint text primary key,
  user_id text not null,
  claimed_at integer not null
);
create index if not exists idx_cloud_free_card_claims_user on cloud_free_card_claims (user_id);

-- One row per owner alert sent: the key names the event (`signup_burst:<ip
-- hash>:<hour>`, `free_cap:<month>:<cap>:<percent>`, ...), so one event sends one
-- email. The daily report counts the day's rows.
create table if not exists cloud_owner_alerts (
  alert_key text primary key,
  kind text not null,
  user_id text,
  created_at integer not null,
  sent_at integer
);
create index if not exists idx_cloud_owner_alerts_time on cloud_owner_alerts (created_at);

-- The part of a computer-day's cost run while its account was on free-plan
-- rules (stamped with each stretch), for the owner's cap on free use.
alter table cloud_computer_days add column free_cost_micros integer not null default 0;
-- 1 when the account was on free-plan rules at every write of that disk-day.
alter table cloud_disk_days add column free integer not null default 0;
-- When a block's deny-all network policy landed on the computer (`safety.ts`);
-- null until it did, and again after an unblock. The minute tick retries a
-- blocked account's computers until it is set, stopped ones too.
alter table cloud_computers add column network_denied_at integer;
-- The last try at that policy, landed or not: a stopped computer's try is
-- repeated at most hourly, so a provider that keeps refusing isn't asked
-- (and reported) every minute.
alter table cloud_computers add column network_deny_tried_at integer;
-- When the account's first saved cloud chat part arrived (once, for analytics).
alter table cloud_accounts add column first_chat_at integer;

-- This month so far: days of accounts on free-plan rules now count as free.
update cloud_computer_days set free_cost_micros = cost_micros
where day >= strftime('%Y-%m-01', 'now')
  and user_id not in (select user_id from cloud_accounts where plan = 'paid' and coalesce(stripe_status, '') <> 'past_due');
update cloud_disk_days set free = 1
where day >= strftime('%Y-%m-01', 'now')
  and user_id not in (select user_id from cloud_accounts where plan = 'paid' and coalesce(stripe_status, '') <> 'past_due');
-- Accounts that already saved a chat: their first chat is behind them.
update cloud_accounts set first_chat_at = coalesce(created_at, 0)
where exists (select 1 from cloud_chat_copies c where c.user_id = cloud_accounts.user_id);
