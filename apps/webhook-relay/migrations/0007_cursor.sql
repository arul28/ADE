create table if not exists cursor_webhook_secrets (
  id text primary key,
  webhook_secret text not null,
  account_id text,
  registered_at text not null,
  updated_at text not null,
  unlinked_account_id text
);

create table if not exists cursor_events (
  event_id text primary key,
  event_type text not null,
  status text not null,
  agent_id text not null,
  received_at text not null,
  body text not null,
  account_id text,
  secret_id text
);

create index if not exists idx_cursor_webhook_secrets_account
  on cursor_webhook_secrets(account_id, id);

create index if not exists idx_cursor_events_received
  on cursor_events(received_at desc, event_id desc);

create index if not exists idx_cursor_events_account_received
  on cursor_events(account_id, received_at desc, event_id desc);
