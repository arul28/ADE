create table if not exists linear_organizations (
  org_id text primary key,
  webhook_secret text not null,
  registered_at text not null,
  updated_at text not null
);

create table if not exists linear_events (
  org_id text not null,
  event_id text not null,
  event_type text not null,
  action text not null,
  received_at text not null,
  body text not null,
  primary key(org_id, event_id)
);

create index if not exists idx_linear_events_org_received
  on linear_events(org_id, received_at desc, event_id desc);
