-- Cursor delivery ids are deduplicated per registered secret, not across the
-- whole relay. With one global key, one tenant's delivery id answered
-- "duplicate" for another tenant's real event, which was then never stored.
--
-- SQLite cannot change a primary key in place, so the table is rebuilt. Each
-- row keeps its rowid: clients page with `seq:<rowid>` cursors, and a renumbered
-- table would skip or repeat events for every client mid-stream.
create table if not exists cursor_events_scoped (
  event_id text not null,
  event_type text not null,
  status text not null,
  agent_id text not null,
  received_at text not null,
  body text not null,
  account_id text,
  secret_id text not null default '',
  primary key(secret_id, event_id)
);

insert or ignore into cursor_events_scoped(
  rowid, event_id, event_type, status, agent_id, received_at, body, account_id, secret_id
)
select rowid, event_id, event_type, status, agent_id, received_at, body, account_id, coalesce(secret_id, '')
  from cursor_events;

drop table cursor_events;

alter table cursor_events_scoped rename to cursor_events;

create index if not exists idx_cursor_events_received
  on cursor_events(received_at desc, event_id desc);

create index if not exists idx_cursor_events_account_received
  on cursor_events(account_id, received_at desc, event_id desc);

create index if not exists idx_cursor_events_secret_received
  on cursor_events(secret_id, received_at desc, event_id desc);
