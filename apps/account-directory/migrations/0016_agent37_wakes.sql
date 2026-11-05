-- Timed wakes for Agent 37 machines: `PUT /agent37/wake` (README, "Agent 37
-- timed wakes").
--
-- A sleeping Agent 37 machine can't run its own timers, so before it sleeps
-- its ADE asks to be woken at its next scheduled wake-up or automation. The
-- minute cron requests the machine's public wake URL a little before that
-- time; any request to that URL wakes it. One row per account and machine, the
-- latest time wins. The URL is the machine's own Agent 37 address, checked
-- against `*.agent37.app`; nothing else about the machine is stored.
create table if not exists agent37_wakes (
  user_id text not null,
  instance_id text not null,
  wake_url text not null,
  wake_at integer not null,
  updated_at integer not null,
  primary key (user_id, instance_id)
);

create index if not exists agent37_wakes_due on agent37_wakes (wake_at);
