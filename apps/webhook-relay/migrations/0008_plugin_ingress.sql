create table if not exists plugin_webhook_secrets (
  id text primary key,
  plugin_id text not null,
  webhook_secret text not null,
  account_id text,
  registered_at text not null,
  updated_at text not null,
  unlinked_account_id text
);

create table if not exists plugin_events (
  event_id text primary key,
  plugin_id text not null,
  channel text not null,
  event_type text not null,
  received_at text not null,
  headers text not null,
  body text not null,
  account_id text,
  secret_id text
);

create index if not exists idx_plugin_webhook_secrets_plugin on plugin_webhook_secrets(plugin_id, id);
create index if not exists idx_plugin_webhook_secrets_account on plugin_webhook_secrets(account_id, plugin_id);
create index if not exists idx_plugin_events_plugin_received on plugin_events(plugin_id, received_at desc, event_id desc);
create index if not exists idx_plugin_events_account on plugin_events(account_id, plugin_id, received_at desc);
