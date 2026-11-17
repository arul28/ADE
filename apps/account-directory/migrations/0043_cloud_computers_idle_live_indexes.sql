-- The minute tick and idle cleanup read cloud_computers by a predicate that
-- no index served. Rows are kept after a delete, so every tick scanned every
-- computer the service ever created. These partial indexes hold only the rows
-- each read can match.

-- The tick's live-computer read (src/cloud/cron.ts).
create index if not exists idx_cloud_computers_live
  on cloud_computers (user_id) where deleted_at is null;

-- The idle candidate read (src/cloud/idleCleanup.ts).
create index if not exists idx_cloud_computers_idle
  on cloud_computers (coalesce(last_awake_at, created_at))
  where deleted_at is null and awake_since is null;

-- clearMovedPast's warned-or-kept read (src/cloud/idleCleanup.ts).
create index if not exists idx_cloud_computers_idle_flags
  on cloud_computers (user_id)
  where deleted_at is null and (idle_warned_at is not null or idle_held_at is not null);
