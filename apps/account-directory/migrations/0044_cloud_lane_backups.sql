-- Lane backups at rest (src/cloud/laneBackups.ts). Additive only: apply this
-- migration first, then deploy the Worker.
--
-- One row per lane and machine key: the lane's work that is not on GitHub
-- yet, as a sealed git bundle and a sealed patch in R2 (`CLOUD_CHATS`) under
-- `r2_prefix` (`backups/<user>/<machine>/<lane>/<upload>/`). A new upload
-- goes to a new prefix and replaces the row only at its commit, so the old
-- backup stays readable until the new one is complete.
create table if not exists cloud_lane_backups (
  user_id text not null,
  machine_key text not null,
  lane_id text not null,
  instance_id text,
  -- The committed backup; null before the first commit.
  upload_id text,
  r2_prefix text,
  fingerprint text,
  -- Sealed JSON CloudLaneBackupFacts (branch, lane name, repository, commits).
  facts_sealed text,
  bundle_bytes integer not null default 0,
  patch_bytes integer not null default 0,
  bundle_parts integer not null default 0,
  patch_parts integer not null default 0,
  saved_at integer,
  -- An upload in progress: its id, its declared sizes and when it started.
  pending_upload_id text,
  pending_bytes integer,
  pending_fingerprint text,
  pending_facts_sealed text,
  pending_at integer,
  -- A computer of the account applied it to its lane.
  restored_at integer,
  restored_by_machine_key text,
  updated_at integer not null,
  primary key (user_id, machine_key, lane_id)
);
-- A new computer finds the backups of its lane; a lane delete removes them.
create index if not exists cloud_lane_backups_lane on cloud_lane_backups (user_id, lane_id);

-- The computer's last backup report (`POST /cloud/backups/report`) and
-- whether it rests with it. `backup_rest_at` is set only when the computer
-- went to rest right after a report that said every lane was saved: its own
-- idle sleep naming that report, or the 0-hours stop after prepare-stop.
-- Any wake clears both, so a cleanup deletes a resting computer without a
-- start only while `backup_rest_at` is set.
alter table cloud_computers add column backup_report_id text;
alter table cloud_computers add column backup_report_state text;
alter table cloud_computers add column backup_report_at integer;
-- JSON CloudBackupProblem[]: the lanes ADE couldn't save, with why.
alter table cloud_computers add column backup_problems_json text;
alter table cloud_computers add column backup_rest_at integer;
