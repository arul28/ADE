-- ADE Cloud without a computer, server edge (src/cloud/eventWakes.ts,
-- src/cloud/integrations.ts). Additive only: apply this migration first, then
-- deploy the Worker.

-- What wakes a resting cloud computer besides the clock: the event topics it
-- listens to (a Linear organization, the account's machine-homed webhooks).
-- The computer replaces its whole list when it goes to rest
-- (`PUT /cloud/instances/:id/event-wakes`); the webhook relay names a topic
-- after it stores a delivery (`POST /cloud/internal/event-wake`). A topic is
-- an id, never a lane name or event text.
create table if not exists cloud_event_wakes (
  instance_id text not null,
  topic text not null,
  user_id text not null,
  updated_at integer not null,
  primary key (instance_id, topic)
);

create index if not exists cloud_event_wakes_topic on cloud_event_wakes (topic);
create index if not exists cloud_event_wakes_user on cloud_event_wakes (user_id);

-- The last event wake of each computer: at most one every 5 minutes, and the
-- outcome for the person's view and for support ('woken', 'refused:<code>',
-- 'failed').
create table if not exists cloud_event_wake_state (
  instance_id text primary key,
  user_id text not null,
  last_woken_at integer not null,
  last_status text not null
);

create index if not exists cloud_event_wake_state_user on cloud_event_wake_state (user_id);

-- Requests per account per minute for routes that call another service with
-- the account's own credentials (Linear, Jira). One row per account and
-- bucket; a new minute resets the count.
create table if not exists cloud_request_windows (
  user_id text not null,
  bucket text not null,
  window_start integer not null,
  count integer not null,
  primary key (user_id, bucket)
);
