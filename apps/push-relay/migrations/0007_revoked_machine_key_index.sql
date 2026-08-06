-- The legacy machine-signed routes (`/machines/<key>/publish`,
-- `/machines/<key>/live-activity-tokens`) authenticate a machine signature and
-- have no account id, so their revocation check looks a machine key up across
-- every account. The table's primary key is (user_id, machine_key), whose
-- leading column is useless for that lookup — without this index the check is a
-- full scan on the hottest write path in the relay.
create index if not exists idx_attention_revoked_machines_key
  on attention_revoked_machines(machine_key);
