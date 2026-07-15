create table if not exists device_authorizations (
  device_code text primary key,
  user_code text not null unique,
  device_secret_hash text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'consumed', 'expired', 'error')),
  code_verifier text,
  oauth_state_hash text unique,
  access_token text,
  refresh_token text,
  token_type text,
  expires_in integer,
  error_message text,
  poll_interval_seconds integer not null,
  last_polled_at integer,
  created_at integer not null,
  expires_at integer not null,
  approved_at integer,
  consumed_at integer
);

create index if not exists idx_device_authorizations_user_code
  on device_authorizations(user_code);

create index if not exists idx_device_authorizations_state
  on device_authorizations(oauth_state_hash);

create table if not exists device_approval_rate_limits (
  client_hash text primary key,
  window_started_at integer not null,
  attempts integer not null
);
