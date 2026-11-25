-- Accounts deleted in the last day (`src/accountErasure.ts`). A sign-in token
-- stays valid for a while after Clerk deletes the user, and this Worker checks
-- tokens offline, so a computer still signed in can write rows again. The
-- deletion runs again at each `next_run_at` (15 min, 75 min, 3 h and 24 h
-- after it), and the row goes after the last run. The webhook relay reads
-- this list to purge its own rows (`GET /cloud/internal/deleted-accounts`).
create table if not exists account_erasures (
  user_id text primary key,
  deleted_at integer not null,
  runs integer not null default 0,
  next_run_at integer,
  -- Failed runs in a row: each waits twice as long, up to 6 h; after 7 days the row goes with one report.
  failures integer not null default 0
);
create index if not exists idx_account_erasures_due on account_erasures (next_run_at) where next_run_at is not null;
create index if not exists idx_account_erasures_deleted on account_erasures (deleted_at);

-- The deletion removes these logs by account; without an index each one read the whole table.
create index if not exists idx_cloud_power_log_user on cloud_power_log (user_id);
create index if not exists idx_cloud_idle_cleanup_log_user on cloud_idle_cleanup_log (user_id);
