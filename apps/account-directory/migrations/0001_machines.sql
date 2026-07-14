create table if not exists machines (
  user_id text not null,
  machine_key text not null,
  device_id text,
  name text,
  platform text,
  device_type text,
  pubkey text,
  reachable_endpoints text,
  last_seen_at integer,
  created_at integer,
  primary key(user_id, machine_key)
);

create index if not exists idx_machines_user
  on machines(user_id, last_seen_at desc);

-- Hosted runtimes remain an additive seam: nullable always-on metadata and a
-- hosted endpoint can be added later without changing the existing record shape.
