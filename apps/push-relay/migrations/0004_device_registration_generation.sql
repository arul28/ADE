-- A registration generation prevents an APNs response that began before an
-- explicit clear/re-registration from recreating suppression state afterward.
alter table device_registrations add column generation text;

update device_registrations
set generation = lower(hex(randomblob(16)))
where generation is null;

alter table attention_devices add column generation text;

update attention_devices
set generation = lower(hex(randomblob(16)))
where generation is null;
