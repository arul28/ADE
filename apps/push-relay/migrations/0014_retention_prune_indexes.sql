-- The retention prune deletes tombstones by `deleted_at` and registrations by
-- `updated_at`. Neither column led an index, so every prune read the whole
-- table: on 2026-11-19 the tombstone delete alone read 36M rows in a day
-- (~2,400 per run), more than half of this database's reads, and the account
-- hit D1's "too much load" limit. Each table is written rarely next to how
-- often it is pruned, so one more index write per change is the cheap side.
create index if not exists idx_attention_tombstones_deleted
  on attention_tombstones(deleted_at);

create index if not exists idx_device_registrations_updated
  on device_registrations(updated_at);
