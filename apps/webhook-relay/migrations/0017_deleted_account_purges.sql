-- When this relay last purged each deleted account (src/accountPurge.ts), so
-- that a run purges only the accounts that passed a new repeat of the
-- directory's deletion since then, and an account a run skipped (the per-run
-- cap, an outage) is still due on the next run. A row goes 25 hours after its
-- last purge, after the account has left the directory's list.
create table if not exists deleted_account_purges (
  account_id text primary key,
  purged_at integer not null
);

create index if not exists idx_deleted_account_purges_purged
  on deleted_account_purges(purged_at);
