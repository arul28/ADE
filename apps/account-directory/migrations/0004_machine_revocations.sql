-- A removed machine keeps a valid account token and re-registers itself every
-- 30 seconds, so deleting its row is not a removal on its own. The revocation
-- outlives the row: registration is refused until the machine is deliberately
-- paired again (an explicit pairing request, or a reinstalled device id).
create table if not exists revoked_machines (
  user_id text not null,
  machine_key text not null,
  device_id text,
  revoked_at integer not null,
  primary key(user_id, machine_key)
);

create index if not exists idx_revoked_machines_revoked_at
  on revoked_machines(revoked_at);
