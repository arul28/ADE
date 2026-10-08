-- Every 30 s heartbeat moves machines.last_seen_at. With last_seen_at in this
-- index each heartbeat rewrote it (a billed row). The queries that order by
-- last_seen_at filter to one user's machines first, a handful of rows sorted in
-- memory, so the index keeps only user_id and an unchanged heartbeat is one row.
drop index if exists idx_machines_user;
create index if not exists idx_machines_user on machines(user_id);
