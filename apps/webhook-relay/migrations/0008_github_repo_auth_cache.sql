-- Durable GitHub repository authorization verdicts. Cloudflare isolates are
-- ephemeral, so the five-minute in-memory verdict map re-verified almost every
-- 30-second poll and burned the shared GitHub REST quota on pure permission
-- re-checks. Rows hold a SHA-256 token digest, never the credential itself.
--
-- Positive verdicts only. A denial is proof that the caller does NOT control
-- the token digest it just chose, so persisting denials would let an
-- unauthenticated client mint an unbounded number of rows; those stay in
-- isolate memory instead.
create table if not exists github_repo_auth_cache (
  cache_key text primary key,
  token_hash text not null,
  repository_key text not null,
  access_level text not null,
  repository_id integer,
  verified_at text not null,
  fresh_until text not null,
  stale_until text not null
);

-- A revoked token (GitHub 401) purges every repository verdict for its digest.
create index if not exists idx_github_repo_auth_cache_token
  on github_repo_auth_cache(token_hash);

create index if not exists idx_github_repo_auth_cache_stale
  on github_repo_auth_cache(stale_until);

-- Remembers when GitHub said a token is out of quota so the relay stops
-- spending verification calls on it until the documented reset passes.
create table if not exists github_token_rate_limits (
  token_hash text primary key,
  reset_at text not null,
  observed_at text not null
);

create index if not exists idx_github_token_rate_limits_reset
  on github_token_rate_limits(reset_at);
