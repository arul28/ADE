-- The directory's Linear renewals (src/cloud/linearRenewal.ts): one row for
-- each project grant the directory holds the renewal lease of. A row in state
-- `publish` holds the renewed grant, sealed with the user's key, until the
-- account vault has it; it is the only copy of a rotated refresh token while
-- the publish fails, so the minute cron retries it.
create table if not exists cloud_linear_renewals (
  user_id text not null,
  scope text not null,
  -- claimed | exchanging | publish
  state text not null,
  -- The vault revision the lease was taken at (the claim, or the directory's own last publish).
  lease_revision text not null,
  claimed_at integer not null,
  attempt_at integer,
  failures integer not null default 0,
  sealed_grant text,
  updated_at integer not null,
  primary key (user_id, scope)
);

create index if not exists cloud_linear_renewals_state on cloud_linear_renewals (state, updated_at);
