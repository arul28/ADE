-- Removing a machine from the account is an explicit, account-level event: the
-- machine's rows are purged and tombstoned in one revision, and the machine is
-- recorded here so a still-signed-in install cannot publish itself back in.
-- Protocol 2 deltas never imply deletion, so the purge writes tombstones; this
-- table only stops the source stream from resurrecting them.
create table if not exists attention_revoked_machines (
  user_id text not null,
  machine_key text not null,
  revoked_at text not null,
  primary key(user_id, machine_key)
);

create index if not exists idx_attention_revoked_machines_revoked
  on attention_revoked_machines(revoked_at);
