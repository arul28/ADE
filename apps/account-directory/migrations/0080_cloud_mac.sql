-- The DAEX Cloud Mac (src/cloud/macProvider.ts, macNomac.ts, macSwitch.ts).
-- Additive only: apply before the Worker that reads it. Every row before this
-- is an Agent 37 Linux computer, which the null defaults say.

-- Who runs the computer (null: Agent 37) and what it runs (null: linux).
alter table cloud_computers add column provider text;
alter table cloud_computers add column os text;
-- A Mac exists only while it runs: the provider session it has now (null
-- while it is stopped with only its drive), and the label its drive is kept
-- under (`adem:<instance_id>`).
alter table cloud_computers add column mac_session_id text;
alter table cloud_computers add column mac_label text;
-- `CloudMacStateName`, when it entered it, and why the last start ended
-- with no Mac (`queue_expired`, `unavailable`, `drive_lost`).
alter table cloud_computers add column mac_state text;
alter table cloud_computers add column mac_state_at integer;
alter table cloud_computers add column mac_start_failed text;
-- The boot job ran on the session it names (one boot per session).
alter table cloud_computers add column mac_booted_session text;
-- The provider's time limit for the running session (ms), so the tick extends it while the account has credits.
alter table cloud_computers add column mac_hard_deadline_at integer;
-- The drive as its last save left it.
alter table cloud_computers add column mac_drive_used_bytes integer;
alter table cloud_computers add column mac_drive_saved_at integer;
-- When its last session ended (the 30-day drive rule counts from here).
alter table cloud_computers add column mac_last_session_at integer;
-- What the provider has no place for: the metadata ADE keeps on a computer
-- (`ade_machine_key`, the lane's facts), and the launch env the boot job
-- passes (never the join code, which is computed again from the launch).
alter table cloud_computers add column mac_metadata_json text;
alter table cloud_computers add column mac_boot_env_json text;
-- When the account server last ran a command on the running Mac for its busy
-- brain (`/use`): NoMac's own idle stop counts commands, not a background service.
alter table cloud_computers add column mac_touched_at integer;
-- The start that holds the row now (`startMac`); a stop clears it, so a start
-- whose answer comes after the stop writes nothing and stops what it got.
alter table cloud_computers add column mac_start_token text;
-- The boot job still running when its first answer came (`bootMac`): read on the
-- next tick, so a boot that then fails is seen. And the session's failed boots:
-- at the third the Mac is stopped, never left billed.
alter table cloud_computers add column mac_boot_job_id text;
alter table cloud_computers add column mac_boot_failures integer not null default 0;
create index if not exists idx_cloud_computers_provider_live on cloud_computers (provider) where deleted_at is null and provider is not null;

-- Each Mac session, for the owner's cost report and the daily check against
-- the provider's own minutes. A session is one start: queued, ready, ended.
create table if not exists cloud_mac_sessions (
  session_id text primary key,
  instance_id text not null,
  user_id text not null,
  created_at integer not null,
  ready_at integer,
  ended_at integer,
  end_reason text,
  billed_seconds integer not null default 0,
  cost_micros integer not null default 0,
  -- 1: started by ADE to keep its drive (the 30-day rule), not the person's use.
  upkeep integer not null default 0
);
create index if not exists idx_cloud_mac_sessions_instance on cloud_mac_sessions (instance_id, created_at);
create index if not exists idx_cloud_mac_sessions_open on cloud_mac_sessions (created_at) where ended_at is null;

-- Who may use a Mac while `mac_computers` is `testers`, in the iPhone beta's
-- shape and mechanism (`handleOwnerTesterList`, `claimTesterInvites`): the
-- accounts on the list, and the emails the owner added before any account had
-- them (claimed at sign-up, asked of Clerk again about hourly).
create table if not exists cloud_mac_testers (
  user_id text primary key,
  email text,
  added_at integer not null
);
create table if not exists cloud_mac_testers_pending (
  email text primary key,
  added_at integer not null,
  checked_at integer
);
