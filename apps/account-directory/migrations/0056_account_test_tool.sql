-- The account test tool (src/cloud/ownerAccounts.ts, scripts/cloud-owner.mjs)
-- and instant server switches (src/cloud/settings.ts). Additive only: apply
-- this migration first, then deploy the Worker.

-- An account acting as another plan, or with other limits, for testing. The
-- limits, the hours meter, the computer limit and sponsored cards read these;
-- billing never does (Stripe, extra hours and the period stay the real plan's).
-- All null: the real plan. Cleared by the minute tick once `test_until` passes.
alter table cloud_accounts add column test_plan text;
alter table cloud_accounts add column test_computers integer;
alter table cloud_accounts add column test_hours_milli integer;
alter table cloud_accounts add column test_until integer;
alter table cloud_accounts add column test_note text;
create index if not exists idx_cloud_accounts_test_until on cloud_accounts(test_until) where test_until is not null;

-- Instant switches live in `cloud_settings` (migration 0018) beside the
-- server's own keys: `gravity_ads`, `gravity_live`, `free_small_needs_ads`.
-- A missing row reads off. Switches with a deploy variable are held under it
-- (the variable is a hard off). Why one changed goes to `cloud_owner_log`.

-- Every switch flip and account test change, for the owner's reading.
create table if not exists cloud_owner_log (
  id integer primary key autoincrement,
  at integer not null,
  action text not null,
  user_id text,
  detail text
);
create index if not exists idx_cloud_owner_log_user on cloud_owner_log(user_id, at);
