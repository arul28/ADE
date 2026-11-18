-- Anonymous Cursor ingest limits. A caller can register a secret and post
-- events without an account; these counters cap how many registrations one
-- address and the relay as a whole accept per UTC day, and how many events
-- anonymous secrets may store. Account-owned secrets are not counted here.
create table if not exists relay_daily_counts (
  scope text not null,
  day text not null,
  count integer not null default 0,
  primary key (scope, day)
);
