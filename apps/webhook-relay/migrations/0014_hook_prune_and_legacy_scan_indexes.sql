-- The hook-event sweep deletes by `received_at` alone; without this index each
-- sweep read the whole table.
create index if not exists idx_custom_hook_events_received
  on custom_hook_events(received_at);

-- The legacy Cursor webhook scan reads the most recently polled registrations
-- that no account owns.
create index if not exists idx_cursor_webhook_secrets_unowned_polled
  on cursor_webhook_secrets(last_polled_at desc)
  where account_id is null and last_polled_at is not null;

-- ...and the most recently used signed-in ones. Rows are now one per secret
-- (one per computer), so this list is bounded too.
create index if not exists idx_cursor_webhook_secrets_owned_recent
  on cursor_webhook_secrets(max(updated_at, coalesce(last_polled_at, updated_at)) desc)
  where account_id is not null;
