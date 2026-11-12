-- The ADE GitHub App sign-in that belongs to the account (src/githubApp,
-- shapes in src/githubApp/contract.ts).
--
-- One grant per ADE account: the GitHub App user token chain this Worker
-- renews. Both tokens are sealed with GITHUB_APP_TOKEN_KEY (AES-GCM, bound to
-- the account id). The refresh token never leaves this Worker. A client gets
-- the access token with a relative deadline and asks again after it, so the
-- Worker refreshes only when no client still uses the old token.
--
-- One writer: a request that finds the token due takes `lease_id` with one
-- conditional update (`lease_until` 45 s), refreshes at GitHub, and saves the
-- new pair only while it still holds the lease. `generation` rises by one on
-- each refresh or new sign-in. A lease left past `lease_until` means the
-- holder died; the next request takes it.
create table if not exists github_app_grants (
  user_id text primary key,
  github_user_id integer not null,
  github_login text not null,
  access_token_sealed text not null,
  -- SHA-256 (hex) of the access token: matches a client's "this token was
  -- rejected" report and refuses a retire of the live token with no decrypt.
  access_token_sha256 text not null,
  access_expires_at integer not null,
  refresh_token_sealed text,
  refresh_expires_at integer,
  origin text not null check (origin in ('web_flow', 'adopted_device_flow')),
  state text not null check (state in ('active', 'needs_reauth')),
  state_reason text,
  generation integer not null,
  lease_id text,
  lease_until integer,
  refresh_not_before integer,
  refresh_failures integer not null default 0,
  last_rejected_check_at integer,
  created_at integer not null,
  updated_at integer not null
);

-- The daily keepalive: active grants whose refresh token ends soon.
create index if not exists github_app_grants_refresh_due on github_app_grants(state, refresh_expires_at);

-- One row per web-flow sign-in. The OAuth state is stored only as a hash and
-- is spent by one conditional update (`pending` -> `exchanging`), so a state
-- works once and for ten minutes. The PKCE verifier is sealed.
create table if not exists github_app_sign_ins (
  id text primary key,
  state_hash text not null unique,
  user_id text not null,
  code_verifier_sealed text not null,
  client_kind text not null check (client_kind in ('desktop', 'web', 'ios', 'cli')),
  return_to text,
  redirect_uri text not null,
  status text not null check (status in ('pending', 'exchanging', 'done', 'failed', 'expired')),
  result_code text,
  github_login text,
  created_at integer not null,
  expires_at integer not null
);

create index if not exists github_app_sign_ins_user on github_app_sign_ins(user_id, created_at);
create index if not exists github_app_sign_ins_created on github_app_sign_ins(created_at);

-- Per-account request counts for the route limits, one row per bucket and
-- window. The hourly cron deletes windows older than a day.
create table if not exists github_app_rate (
  user_id text not null,
  bucket text not null,
  window_start integer not null,
  count integer not null,
  primary key (user_id, bucket, window_start)
);

create index if not exists github_app_rate_window on github_app_rate(window_start);
