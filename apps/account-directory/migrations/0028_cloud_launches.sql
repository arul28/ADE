-- ADE Cloud launches started on the server, for a caller with no computer of
-- its own (web, phone, an automation on ADE Cloud): src/cloud/launches.ts.
-- Additive only: apply this migration first, then deploy the Worker.
--
-- One row per launch id. The caller writes the facts (the lane, the first
-- message, its settings and files); the server makes the computer and keeps
-- only the SHA-256 of the computer's one-time join code; the computer reads
-- the facts once it signed in and writes its stage progress. The minute cron
-- deletes a row (and its files in R2) once `expires_at` passed.
create table if not exists cloud_launches (
  launch_id text primary key,
  user_id text not null,
  -- 'draft' (files uploaded, no start yet), 'making', 'joining',
  -- 'needs_approval', 'joined', 'running', 'done', 'failed', 'cancelled'.
  state text not null,
  -- 'chat' or 'lane'; null on a draft.
  kind text,
  size_id text,
  project_origin text,
  lane_id text,
  lane_name text,
  -- The launch's own facts as the caller sent them (CloudServerLaunchRequest), JSON.
  request_json text,
  instance_id text,
  -- SHA-256 (hex) of the one-time join code in the computer's env. Never the code.
  join_hash text,
  join_expires_at integer,
  join_used_at integer,
  -- The device sign-in user code the computer joined with (not a secret: it
  -- only names a sign-in a signed-in person still has to approve).
  join_user_code text,
  -- The page a person opens to approve the join when the computer's own
  -- headless browser stopped on a confirm page.
  approval_url text,
  -- The computer's stage rows, JSON (ChatLaunchStage-like), and its own words for a failure.
  stages_json text,
  error text,
  session_id text,
  created_at integer not null,
  updated_at integer not null,
  expires_at integer not null
);

create index if not exists cloud_launches_user on cloud_launches (user_id, created_at);
create index if not exists cloud_launches_expires on cloud_launches (expires_at);

-- "Delete the cloud computers of one project" (C10, src/cloud/projectComputers.ts):
-- one row per computer a job named. The minute cron moves each row on (wake,
-- push its work, delete), a few at a time, and drops rows a week after the
-- job started. No job, no rows: the tick's read is one indexed lookup.
create table if not exists cloud_project_deletes (
  job_id text not null,
  instance_id text not null,
  user_id text not null,
  project_origin text not null,
  name text,
  -- 'pending', 'working', 'deleted', 'kept' (its work couldn't all be pushed), 'gone'.
  state text not null,
  reason text,
  claimed_at integer,
  created_at integer not null,
  updated_at integer not null,
  primary key (job_id, instance_id)
);

create index if not exists cloud_project_deletes_state on cloud_project_deletes (state, created_at);
create index if not exists cloud_project_deletes_user on cloud_project_deletes (user_id, job_id);
