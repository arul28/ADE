-- Wrangler applies remote migrations through D1's query endpoint, whose
-- multi-statement parser cannot preserve trigger-body semicolons. This
-- idempotent sidecar is installed through D1's SQL file ingestion endpoint.
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

-- Version the trigger name so existing deployments install the FCM-aware body
-- even when the APNs-only v1 trigger already exists.
create trigger if not exists attention_device_ownership_reject_stale_v2
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
    or (
      new.fcm_token is not null
      and current.fcm_token = new.fcm_token
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
