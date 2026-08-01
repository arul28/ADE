alter table attention_items add column content_fingerprint text;
alter table attention_items add column alert_fingerprint text;
alter table attention_items add column activity_tier text;
alter table attention_items add column roster_epoch integer not null default 0;

update attention_items
set content_fingerprint = fingerprint, alert_fingerprint = fingerprint
where content_fingerprint is null;

create index if not exists idx_attention_items_user_machine_epoch
  on attention_items(user_id, machine_key, roster_epoch);

create index if not exists idx_attention_items_user_alertable
  on attention_items(user_id, activity_tier, seen_at, dismissed_at);

create table if not exists attention_alert_log (
  user_id text not null,
  alert_fingerprint text not null,
  device_id text not null,
  delivered_at text not null,
  primary key(user_id, alert_fingerprint, device_id)
);

create index if not exists idx_attention_alert_log_delivered
  on attention_alert_log(delivered_at);

create index if not exists idx_attention_delivery_receipts_delivered
  on attention_delivery_receipts(delivered_at);
