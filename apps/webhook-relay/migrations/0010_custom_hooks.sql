-- Custom webhook "doorbells": any sender can POST to /hooks/:hookId/:token.
-- The relay stores only a hash of the token, holds each delivery until the
-- owning ADE account drains it, and never sees the signing secret (ADE checks
-- signatures on the machine that runs the automation).
create table if not exists custom_hooks (
  hook_id text primary key,
  account_id text not null,
  token_hash text not null,
  label text,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_custom_hooks_account
  on custom_hooks(account_id, hook_id);

-- `seq` is AUTOINCREMENT on purpose: draining deletes acknowledged rows, and a
-- plain rowid would be reused once the newest row is gone, putting the next
-- delivery behind the client's cursor.
create table if not exists custom_hook_events (
  seq integer primary key autoincrement,
  event_id text not null unique,
  hook_id text not null,
  account_id text not null,
  method text not null,
  query text not null default '',
  headers_json text not null,
  body text not null,
  body_encoding text not null default 'utf8',
  received_at text not null
);

create index if not exists idx_custom_hook_events_account
  on custom_hook_events(account_id, received_at desc);

create index if not exists idx_custom_hook_events_hook
  on custom_hook_events(hook_id, received_at desc);
