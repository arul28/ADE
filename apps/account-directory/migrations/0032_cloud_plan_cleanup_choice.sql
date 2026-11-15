-- A downgrade asks first (src/cloud/planCleanup.ts, the owner's rules of
-- 2026-11-13): ADE never removes a computer on its own and there is no grace
-- period. The person picks the computers to free (and whether their work is
-- pushed to GitHub first); ADE frees exactly those, at once. Additive only:
-- apply this migration first, then deploy the Worker.

-- The person's pick, as JSON `{"planId","push","instanceIds","at"}`, while ADE
-- frees it; null when nothing was picked or the pick is finished.
alter table cloud_accounts add column plan_cleanup_choice_json text;
-- When the person was told the account is over the plan in force (new
-- computers are refused until it fits); null while it fits.
alter table cloud_accounts add column plan_over_told_at integer;
-- The minute cron reads the accounts with a pick: one indexed read when none.
create index if not exists cloud_accounts_plan_cleanup_choice on cloud_accounts (user_id) where plan_cleanup_choice_json is not null;

-- The grace design's due times and warned lists (migration 0027) are no
-- longer read: nothing is freed from them.
update cloud_accounts set plan_cleanup_due_at = null, plan_cleanup_warned_json = null
where plan_cleanup_due_at is not null or plan_cleanup_warned_json is not null;
