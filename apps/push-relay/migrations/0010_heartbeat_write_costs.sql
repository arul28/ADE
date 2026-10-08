-- The presence heartbeat updates attention_machine_links.last_seen_at every
-- 30 s per machine. With last_seen_at in this index every heartbeat was two
-- billed row writes; no query orders by it (online status filters in memory),
-- so the index keeps only user_id and a heartbeat is one row.
drop index if exists idx_attention_machine_links_user;
create index if not exists idx_attention_machine_links_user
  on attention_machine_links(user_id);
