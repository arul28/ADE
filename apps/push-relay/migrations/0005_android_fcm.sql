-- Android uses FCM HTTP v1. APNs routing remains intact for Apple devices,
-- while aps_environment becomes nullable for provider-neutral registrations.
-- The deployment reapplies schema/attention_triggers.sql after migrations;
-- remove the APNs-only ownership trigger before installing its FCM-aware v2.
drop trigger if exists attention_device_ownership_reject_stale;

alter table device_registrations rename to device_registrations_apns_v1;

create table device_registrations (
  machine_key text not null,
  device_id text not null,
  apns_token text,
  fcm_token text,
  push_to_start_token text,
  bundle_id text not null,
  aps_environment text check (aps_environment in ('sandbox', 'production')),
  platform text,
  device_name text,
  registered_at text not null,
  updated_at text not null,
  generation text,
  primary key(machine_key, device_id)
);

insert into device_registrations(
  machine_key, device_id, apns_token, push_to_start_token, bundle_id,
  aps_environment, platform, device_name, registered_at, updated_at, generation
)
select machine_key, device_id, apns_token, push_to_start_token, bundle_id,
       aps_environment, platform, device_name, registered_at, updated_at, generation
from device_registrations_apns_v1;

drop table device_registrations_apns_v1;
create index idx_device_registrations_machine
  on device_registrations(machine_key, updated_at desc);
create unique index idx_device_registrations_fcm_token
  on device_registrations(fcm_token) where fcm_token is not null;

alter table attention_devices rename to attention_devices_apns_v1;

create table attention_devices (
  user_id text not null,
  device_id text not null,
  source_machine_key text,
  apns_token text,
  fcm_token text,
  push_to_start_token text,
  bundle_id text not null,
  aps_environment text check (aps_environment in ('sandbox', 'production')),
  platform text,
  device_name text,
  preferences_json text not null,
  registered_at text not null,
  updated_at text not null,
  lease_expires_at text not null,
  generation text,
  primary key(user_id, device_id)
);

insert into attention_devices(
  user_id, device_id, source_machine_key, apns_token, push_to_start_token,
  bundle_id, aps_environment, platform, device_name, preferences_json,
  registered_at, updated_at, lease_expires_at, generation
)
select user_id, device_id, source_machine_key, apns_token, push_to_start_token,
       bundle_id, aps_environment, platform, device_name, preferences_json,
       registered_at, updated_at, lease_expires_at, generation
from attention_devices_apns_v1;

drop table attention_devices_apns_v1;
create index idx_attention_devices_user on attention_devices(user_id, updated_at desc);
create index idx_attention_devices_lease on attention_devices(lease_expires_at);
create index idx_attention_devices_apns_token on attention_devices(apns_token);
create index idx_attention_devices_fcm_token on attention_devices(fcm_token);
create unique index idx_attention_devices_unique_device on attention_devices(device_id);
create unique index idx_attention_devices_unique_apns_token
  on attention_devices(apns_token) where apns_token is not null;
create unique index idx_attention_devices_unique_fcm_token
  on attention_devices(fcm_token) where fcm_token is not null;

alter table attention_device_ownership add column fcm_token text;
create unique index idx_attention_device_ownership_fcm_token
  on attention_device_ownership(fcm_token) where fcm_token is not null;
