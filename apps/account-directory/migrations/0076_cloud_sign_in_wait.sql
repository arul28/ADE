-- A launch's provider sign-in wait is free time on its computer
-- (`src/cloud/signInWait.ts`), the same kind as an automatic update's window
-- (`free_wake_started_at` / `free_wake_until`, `free_ms` in the day rows).
-- `sign_in_free_at`: the start of that window (the computer's first awake
-- moment), naming it among the computer's free windows.
-- `sign_in_free_opened_at`: when it opened (the daily limit counts these).
-- `sign_in_charged_at`: the wait was charged after all (the sign-in finished).
-- `sign_in_used_at`: someone used the computer during it; the meter runs from
-- then. Only adds: the live Worker and older apps read nothing here.
alter table cloud_launches add column sign_in_free_at integer;
alter table cloud_launches add column sign_in_free_opened_at integer;
alter table cloud_launches add column sign_in_charged_at integer;
alter table cloud_launches add column sign_in_used_at integer;
create index if not exists idx_cloud_launches_sign_in_free on cloud_launches (user_id, sign_in_free_opened_at) where sign_in_free_opened_at is not null;

-- Codes pasted into one sign-in job on one computer (`src/cloud/signIns.ts`):
-- at most `CLOUD_SIGN_IN_MAX_CODES` in an hour. A row is per computer and job;
-- the window restarts an hour after its first code.
create table if not exists cloud_sign_in_codes (
  instance_id text not null,
  job_id text not null,
  count integer not null,
  window_start integer not null,
  primary key (instance_id, job_id)
);
