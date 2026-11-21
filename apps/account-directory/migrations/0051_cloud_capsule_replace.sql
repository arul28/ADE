-- A fork capsule's replacement uploads beside the committed one
-- (src/cloud/forkCapsules.ts). Additive only: apply this migration first,
-- then deploy the Worker.
--
-- The committed capsule (`r2_key`, `parts`, `bytes`, `committed_at`) stays
-- readable while a new upload runs. The new upload writes its parts under
-- its own prefix (`pending_r2_key`); its commit switches the row to it in one
-- write, and only then are the older parts deleted. An upload that fails or
-- stops part way leaves the committed capsule as it was.
alter table cloud_fork_capsules add column pending_r2_key text;
alter table cloud_fork_capsules add column pending_parts integer not null default 0;
alter table cloud_fork_capsules add column pending_bytes integer not null default 0;
alter table cloud_fork_capsules add column pending_instance_id text;

-- Saved storage no row reads any more (src/cloud/storageSweeps.ts): a chat
-- copy's prefix, a capsule upload's parts, a CLI copy's object. Written in
-- the same write that lets go of it, removed only once its objects are gone,
-- so a delete that fails part way is finished by the minute tick. Each saved
-- row has its own prefix or key, so a sweep never reaches a newer row's
-- objects. `exact` = 1 names one object; else every object under a prefix.
-- `retry_at`: when the minute tick may sweep it. `claimed` = 1: the tick
-- took it, so an upload it names can no longer be published.
create table if not exists cloud_storage_sweeps (
  r2_key text primary key,
  user_id text not null,
  exact integer not null default 0,
  created_at integer not null,
  retry_at integer not null,
  claimed integer not null default 0
);
create index if not exists cloud_storage_sweeps_retry on cloud_storage_sweeps (retry_at);
