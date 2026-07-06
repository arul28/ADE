-- Machines self-register with an unguessable machine key and a relay secret;
-- every later call is HMAC-signed with that secret. The secret is scoped to
-- push publishing only and never grants access to project data.
create table if not exists machines (
  machine_key text primary key,
  secret text not null,
  created_at text not null,
  last_seen_at text not null
);

-- One row per (machine, device). A device may hold an alert-push token, a
-- Live Activity push-to-start token, or both. aps_environment routes the send
-- to the APNs sandbox or production host per build variant.
create table if not exists device_registrations (
  machine_key text not null,
  device_id text not null,
  apns_token text,
  push_to_start_token text,
  bundle_id text not null,
  aps_environment text not null check (aps_environment in ('sandbox', 'production')),
  platform text,
  device_name text,
  registered_at text not null,
  updated_at text not null,
  primary key(machine_key, device_id)
);

create index if not exists idx_device_registrations_machine
  on device_registrations(machine_key, updated_at desc);

-- Per-activity update tokens reported by the phone after an activity starts.
-- Updates and end events target these; start events target push_to_start_token.
create table if not exists live_activity_tokens (
  machine_key text not null,
  device_id text not null,
  activity_id text not null,
  token text not null,
  updated_at text not null,
  primary key(machine_key, device_id, activity_id)
);

-- Redundant-update suppression: a publish carrying a dedupe key is skipped
-- when the previous publish for the same key had the same content hash.
create table if not exists publish_suppression (
  machine_key text not null,
  suppression_key text not null,
  content_hash text not null,
  published_at text not null,
  primary key(machine_key, suppression_key)
);

create index if not exists idx_publish_suppression_published
  on publish_suppression(published_at);
