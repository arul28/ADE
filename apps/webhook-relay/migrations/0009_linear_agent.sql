-- Linear agent (actor=app): per-workspace app install, the people who routed
-- their Linear identity to an ADE account, and one row per agent session.

create table if not exists linear_agent_installs (
  org_id text primary key,
  org_name text,
  app_user_id text not null,
  -- AES-GCM ciphertext (LINEAR_AGENT_TOKEN_KEY). Null once the grant is dead
  -- (invalid_grant on refresh), which the status route reports as not installed.
  access_token_enc text,
  refresh_token_enc text,
  expires_at text,
  installed_by_account_id text,
  installed_by_linear_user_id text,
  fallback_mode text not null default 'reply' check (fallback_mode in ('reply', 'runner')),
  runner_account_id text,
  installed_at text not null,
  updated_at text not null
);

create table if not exists linear_agent_members (
  org_id text not null,
  linear_user_id text not null,
  account_id text not null,
  display_name text,
  registered_at text not null,
  last_seen_at text not null,
  primary key (org_id, linear_user_id)
);

create index if not exists idx_linear_agent_members_org_account
  on linear_agent_members(org_id, account_id);

create table if not exists linear_agent_sessions (
  session_id text primary key,
  org_id text not null,
  issue_id text,
  issue_identifier text,
  creator_linear_user_id text,
  routed_account_id text,
  route_reason text check (route_reason in ('member', 'runner', 'unrouted')),
  claimed_by_machine_id text,
  claimed_at text,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_linear_agent_sessions_updated
  on linear_agent_sessions(updated_at);

alter table linear_events add column routed_account_id text;

create index if not exists idx_linear_events_routed_account_org
  on linear_events(routed_account_id, org_id);
