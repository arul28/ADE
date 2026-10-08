-- Indexes for the relay's hottest queries, which were scanning whole tables
-- (68B D1 rows read in one billing cycle). See the queries in src/relay.ts.

-- Cursor poll auth: point lookup by the bearer secret instead of a full read.
create index if not exists idx_cursor_webhook_secrets_secret
  on cursor_webhook_secrets(webhook_secret);

-- Lets the relay sweep unowned secrets that stopped polling.
alter table cursor_webhook_secrets add column last_polled_at text;

create index if not exists idx_cursor_events_secret_received
  on cursor_events(secret_id, received_at desc, event_id desc);

-- Retention deletes (`where received_at < ?`).
create index if not exists idx_github_events_received
  on github_events(received_at);
create index if not exists idx_linear_events_received
  on linear_events(received_at);

-- Webhook diagnostics: latest `ping` / `meta` delivery.
create index if not exists idx_github_events_event_received
  on github_events(github_event, received_at desc);

-- Repo event drains page by rowid (`rowid > ? order by rowid`). An index whose
-- last key column is the repo name ends in rowid, so the cursor is a seek.
create index if not exists idx_github_events_account_repository_seq
  on github_events(account_id, repository_full_name collate nocase);
create index if not exists idx_github_events_repository_seq
  on github_events(repository_full_name collate nocase);
