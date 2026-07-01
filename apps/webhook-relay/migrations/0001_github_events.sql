create table if not exists github_events (
  project_id text not null,
  event_id text not null,
  github_event text not null,
  github_delivery text,
  repository_full_name text,
  installation_id integer,
  summary text not null,
  payload_json text not null,
  received_at text not null,
  primary key(project_id, event_id)
);

create index if not exists idx_github_events_project_received
  on github_events(project_id, received_at desc, event_id desc);
