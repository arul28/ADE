-- ADE Cloud jobs the server runs on its own, a step at a time (src/cloud/jobs.ts).
-- The first kind is a move: a computer to the other kind (Standard <-> Full),
-- its files copied into a new computer and the old one deleted
-- (src/cloud/moves.ts). Additive only: apply this migration first, then deploy
-- the Worker.
--
-- The minute cron runs each due job one or two short steps (every provider
-- call bounded), so no request ever holds a long one. A runner takes a job
-- with a lease (`lease_id`, `lease_until`): only that runner may write the
-- job until the lease ends, so a tick that died mid-step leaves the job for
-- a later tick, which runs the same step again (every step is safe to redo).
create table if not exists cloud_jobs (
  job_id text primary key,
  -- 'move'.
  kind text not null,
  user_id text not null,
  -- The computer the job works on, and its name and account key when it began.
  source_instance_id text,
  source_name text,
  source_machine_key text,
  -- A move's new computer, the server launch that made it, and its account key once it signed in.
  target_instance_id text,
  target_launch_id text,
  target_machine_key text,
  -- The kind's own input as JSON (a move: where to, the size, the timing, who asked).
  params_json text,
  -- What the caller reads: 'making', 'joining', 'needs_approval', 'copying',
  -- 'finishing', 'done', 'failed', 'cancelled'.
  state text not null,
  -- The step the runner runs next; 'end' once nothing is left to do.
  step text not null,
  -- One plain sentence for the caller, and the failure's own.
  message text,
  error text,
  -- While 'needs_approval': the target's sign-in page (a copy of its launch's).
  approval_url text,
  -- 1 once the old computer is gone, 0 when the move finished and it was kept; null before.
  source_deleted integer,
  -- The kind's own facts as JSON (a move: the projects, when the copy started, whether the old computer is paused).
  facts_json text,
  -- Tries of the current step that threw; reset by the next step.
  attempts integer not null default 0,
  step_started_at integer,
  next_at integer not null,
  lease_id text,
  lease_until integer,
  cancel_requested_at integer,
  created_at integer not null,
  updated_at integer not null,
  expires_at integer not null
);

create index if not exists cloud_jobs_due on cloud_jobs (state, next_at);
create index if not exists cloud_jobs_user on cloud_jobs (user_id, created_at);
create index if not exists cloud_jobs_expires on cloud_jobs (expires_at);
create index if not exists cloud_jobs_target on cloud_jobs (target_instance_id);
-- One live job per computer: two moves of one computer at once can't both start.
create unique index if not exists cloud_jobs_one_live on cloud_jobs (source_instance_id)
  where state not in ('done', 'failed', 'cancelled');
