-- Idle cleanup (src/cloud/idleCleanup.ts, the owner's rules for Cloud 7): it
-- replaces the 30-day delete of unused computers. Free: warned at 2 days idle,
-- deleted at 3. Paid: warned at 7, deleted at 10. Before the delete the
-- computer commits and pushes its work to the lane's own branch; a push that
-- doesn't go through keeps it. Additive only: apply this migration first,
-- then deploy the Worker.

-- The first warning (email and in-app), and the delete time it announced. A
-- deadline once announced never moves earlier. Void once the computer is
-- used, kept or its hours come back after it (the idle clock restarts).
alter table cloud_computers add column idle_warned_at integer;
alter table cloud_computers add column idle_deletes_at integer;
-- The last warning email (the first or a follow-up), claimed before it is sent.
alter table cloud_computers add column idle_emailed_at integer;
-- The person pressed "Keep it": the idle clock restarts with no wake.
alter table cloud_computers add column idle_kept_at integer;
-- A save-and-delete run holds this while it works, so overlapping ticks run it once.
alter table cloud_computers add column idle_claimed_at integer;
-- The save didn't go through, so the computer was kept: when, and why in one sentence.
alter table cloud_computers add column idle_held_at integer;
alter table cloud_computers add column idle_held_reason text;
-- Files git ignores that a delete would lose, as the computer last reported
-- them at its idle step (`{"checkedAt","paths","more"}`).
alter table cloud_computers add column ignored_files_json text;

-- One row per step, for the owner's daily report and for looking back.
create table if not exists cloud_idle_cleanup_log (
  instance_id text not null,
  user_id text not null,
  step text not null,
  detail text,
  created_at integer not null
);
create index if not exists cloud_idle_cleanup_log_created on cloud_idle_cleanup_log (created_at);
