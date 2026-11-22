-- What a cloud lane's status menu reads when it opens (src/cloud/computerStatus.ts).
-- Additive only: apply this migration first, then deploy the Worker.

-- Every status change the provider sends (its signed `instance.status.updated`
-- webhook), for the account's computers only. It fills what the minute tick
-- can't see: a sleep, wake or restart the provider did on its own, between two
-- ticks. Events can arrive out of order, so readers order by `at` (the time of
-- the change, not of the send). `delivery_id` is the webhook's `webhook-id`,
-- the same on every try of one event, so a repeat is taken once. Rows older
-- than `INSTANCE_EVENT_KEEP_MS` are dropped as new ones arrive for the computer.
create table if not exists cloud_instance_events (
  delivery_id text primary key,
  instance_id text not null,
  status text not null,
  previous_status text,
  at integer not null,
  -- The provider's status_reason code, when it gave one (why it failed).
  reason text,
  -- On a change to running: the provider's restart count just after it, so a
  -- later read can tell restarts since then (its count also counts wakes).
  restart_count integer,
  received_at integer not null
);
create index if not exists idx_cloud_instance_events_instance on cloud_instance_events (instance_id, at desc);

-- The computer's own last word on its work, sent by its brain when that
-- changes (`POST /cloud/instances/:id/activity`): working or idle, since when,
-- and how many agents run. One row per computer; an older report never
-- replaces a newer one.
create table if not exists cloud_computer_activity (
  instance_id text primary key,
  busy integer not null,
  idle_since integer,
  sleeps_at integer,
  running_agents integer not null,
  reported_at integer not null
);
