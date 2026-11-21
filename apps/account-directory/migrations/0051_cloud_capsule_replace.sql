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
