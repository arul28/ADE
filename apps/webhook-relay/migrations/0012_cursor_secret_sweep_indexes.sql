-- Follow-up to 0011, keeping every relay query an index seek and every
-- insert free of index writes no query reads.

-- The idle-secret sweep reads only the rows it deletes.
create index if not exists idx_cursor_webhook_secrets_idle
  on cursor_webhook_secrets(account_id, coalesce(last_polled_at, registered_at));

-- Signed Cursor webhooks are matched against secrets in use (owned or polled),
-- not every registration, so an unauthenticated POST cannot force a full read.
create index if not exists idx_cursor_webhook_secrets_active
  on cursor_webhook_secrets(id, webhook_secret, account_id)
  where account_id is not null or last_polled_at is not null;

-- Superseded by 0011's rowid-ordered repo indexes. No query orders a repo's
-- events by received_at, and each index is a billed row write per insert.
drop index if exists idx_github_events_repository_received;
drop index if exists idx_github_events_account_repository_received;
