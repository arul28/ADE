alter table machines add column account_user_id text;

create table if not exists attention_revisions (
  user_id text primary key,
  revision integer not null default 0,
  updated_at text not null
);

create table if not exists attention_machine_links (
  machine_key text primary key,
  user_id text not null,
  machine_name text,
  last_seen_at text not null,
  linked_at text not null,
  legacy_devices_imported_at text
);

create index if not exists idx_attention_machine_links_user
  on attention_machine_links(user_id, last_seen_at desc);

create table if not exists attention_items (
  user_id text not null,
  item_id text not null,
  machine_key text not null,
  source_revision integer not null,
  account_revision integer not null,
  fingerprint text not null,
  event_kind text not null,
  phase text not null,
  payload_json text not null,
  seen_at text,
  dismissed_at text,
  expires_at text,
  updated_at text not null,
  primary key(user_id, item_id)
);

create index if not exists idx_attention_items_user_revision
  on attention_items(user_id, account_revision);

create index if not exists idx_attention_items_expiry
  on attention_items(expires_at);

create table if not exists attention_tombstones (
  user_id text not null,
  item_id text not null,
  source_revision integer not null,
  account_revision integer not null,
  deleted_at text not null,
  primary key(user_id, item_id)
);

create index if not exists idx_attention_tombstones_user_revision
  on attention_tombstones(user_id, account_revision);

create table if not exists attention_devices (
  user_id text not null,
  device_id text not null,
  source_machine_key text,
  apns_token text,
  push_to_start_token text,
  bundle_id text not null,
  aps_environment text not null check (aps_environment in ('sandbox', 'production')),
  platform text,
  device_name text,
  preferences_json text not null,
  registered_at text not null,
  updated_at text not null,
  lease_expires_at text not null,
  primary key(user_id, device_id)
);

create index if not exists idx_attention_devices_user
  on attention_devices(user_id, updated_at desc);

create index if not exists idx_attention_devices_lease
  on attention_devices(lease_expires_at);

create index if not exists idx_attention_devices_apns_token
  on attention_devices(apns_token);

create unique index if not exists idx_attention_devices_unique_device
  on attention_devices(device_id);

create unique index if not exists idx_attention_devices_unique_apns_token
  on attention_devices(apns_token)
  where apns_token is not null;

create trigger if not exists attention_devices_enforce_user_limit
before insert on attention_devices
when not exists (
  select 1
  from attention_devices
  where user_id = new.user_id and device_id = new.device_id
)
and (
  select count(*)
  from attention_devices
  where user_id = new.user_id
) >= 32
begin
  select raise(abort, 'attention account device limit reached');
end;

-- Durable ownership survives attention_devices deletion so delayed requests
-- from a previous account cannot reclaim or remove a switched installation.
create table if not exists attention_device_ownership (
  device_id text primary key,
  user_id text not null,
  ownership_epoch integer not null check (ownership_epoch > 0),
  apns_token text,
  active integer not null check (active in (0, 1)),
  updated_at text not null
);

create unique index if not exists idx_attention_device_ownership_apns_token
  on attention_device_ownership(apns_token)
  where apns_token is not null;

create trigger if not exists attention_device_ownership_reject_stale
before insert on attention_device_ownership
when exists (
  select 1
  from attention_device_ownership as current
  where (
    current.device_id = new.device_id
    or (
      new.apns_token is not null
      and current.apns_token = new.apns_token
    )
  )
  and (
    current.ownership_epoch > new.ownership_epoch
    or (
      current.ownership_epoch = new.ownership_epoch
      and current.user_id <> new.user_id
    )
  )
)
begin
  select raise(abort, 'stale attention device ownership');
end;

create table if not exists attention_activity_tokens (
  user_id text not null,
  device_id text not null,
  activity_id text not null,
  token text not null,
  updated_at text not null,
  primary key(user_id, device_id, activity_id)
);

create table if not exists attention_activity_state (
  user_id text not null,
  device_id text not null,
  activity_id text not null,
  started integer not null default 0,
  fingerprint text,
  updated_at text not null,
  primary key(user_id, device_id, activity_id)
);

create table if not exists attention_presence (
  user_id text not null,
  device_id text not null,
  payload_json text not null,
  observed_at text not null,
  primary key(user_id, device_id)
);

create index if not exists idx_attention_presence_user
  on attention_presence(user_id, observed_at desc);

create table if not exists attention_preferences (
  user_id text primary key,
  payload_json text not null,
  updated_at text not null
);

create table if not exists attention_delivery_receipts (
  user_id text not null,
  item_id text not null,
  device_id text not null,
  state text not null,
  delivered_at text not null,
  primary key(user_id, item_id, device_id, state)
);

create index if not exists idx_attention_delivery_receipts_user_item
  on attention_delivery_receipts(user_id, item_id);
