-- ADE Cloud abuse rules (src/cloud/freePlanGithub.ts, src/cloud/abuseSignals.ts;
-- README "Referrals and the free plan"). Additive only: the Worker before this
-- change reads rows with `select *` and ignores the new columns, so apply this
-- migration first, then deploy the Worker.

-- Why the free plan's hours are held at 0 for this account, from the GitHub
-- rules: 'no_github' (no GitHub connected), 'github_too_new' (the GitHub
-- account is younger than 30 days and no card unlocked it), 'github_used'
-- (that GitHub account already gives another ADE account its free plan),
-- 'github_checking' (GitHub couldn't be asked yet; tried again with a
-- backoff). Null while nothing is held. Paid plans, earned hours and extra
-- hours are untouched, as with `free_refused_at`.
alter table cloud_accounts add column free_github_hold text;
-- 1 for an account that used ADE Cloud before these rules shipped: it keeps
-- its free plan without the GitHub rules (it still claims its GitHub account
-- when it has one, so that GitHub account can't feed a new free plan).
alter table cloud_accounts add column free_github_exempt integer not null default 0;
-- When a card saved with no charge (Stripe Checkout in setup mode) unlocked
-- the free hours for a GitHub account younger than 30 days. Kept when the
-- card is removed later.
alter table cloud_accounts add column free_card_unlocked_at integer;

-- Grandfathering: every account that already used ADE Cloud (any computer
-- ever, any hours used, a computer's free-plan claim, or a paid plan).
update cloud_accounts set free_github_exempt = 1
where used_milli > 0
  or earned_used_milli > 0
  or stripe_subscription_id is not null
  or plan = 'paid'
  or exists (select 1 from cloud_computers c where c.user_id = cloud_accounts.user_id)
  or exists (select 1 from cloud_free_plan_claims f where f.user_id = cloud_accounts.user_id);

-- One free plan per GitHub account, beside one per computer
-- (cloud_free_plan_claims). Both keys are unique: a GitHub account gives its
-- free plan to one ADE account, and an ADE account claims one GitHub account,
-- so switching GitHub accounts never lets one feed two free plans. Kept (re-keyed
-- to a hash) when the ADE account is deleted.
create table if not exists cloud_free_github_claims (
  github_user_id integer primary key,
  user_id text not null unique,
  claimed_at integer not null
);

-- When each GitHub account was made (GitHub's `created_at` from `GET /user`),
-- read once: it never changes. Until it is known, `next_check_at` spaces the
-- tries out after a failure (`failures` doubles the wait, up to six hours).
create table if not exists github_account_ages (
  github_user_id integer primary key,
  github_created_at integer,
  checked_at integer,
  next_check_at integer,
  failures integer not null default 0
);

-- Sign-ups by IP address, for the daily report's burst alarm. Only a keyed
-- HMAC of the address is stored (never the address), and rows go after
-- seven days. One row per account, so a retried webhook counts once.
create table if not exists cloud_signup_ips (
  user_id text primary key,
  ip_hash text not null,
  signed_up_at integer not null
);
create index if not exists idx_cloud_signup_ips_time on cloud_signup_ips (signed_up_at);

-- The computer's own report that it has run near full CPU for hours with no
-- chat turn or agent working (the brain's keep-awake check). The daily report
-- lists computers that reported in its day: one row per computer and UTC day,
-- so a report after midnight never replaces the day before. Kept 7 days.
create table if not exists cloud_cpu_reports (
  instance_id text not null,
  user_id text not null,
  day text not null,
  since integer not null,
  cpu_percent integer not null,
  minutes integer not null,
  reported_at integer not null,
  primary key (instance_id, day)
);
create index if not exists idx_cloud_cpu_reports_day on cloud_cpu_reports (day);
