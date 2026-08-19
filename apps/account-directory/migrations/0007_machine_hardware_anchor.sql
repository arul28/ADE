-- A machine identifier that survives a full `~/.ade` wipe.
--
-- Supersede-by-device dedup (0006's index, and the register path that uses it)
-- assumed the device id outlives a reinstall. It does not: `sync-device-id`
-- lives in `~/.ade/secrets` next to the machine key, so the user who deletes
-- `~/.ade` and signs in again mints BOTH halves fresh. There is then nothing to
-- match on, and the account keeps a row for a computer the user owns once.
--
-- `hardware_id` is the client's per-account hash of an OS-level machine
-- identifier — `IOPlatformUUID`, `MachineGuid`, `/etc/machine-id` — that no ADE
-- uninstall can remove. It is HASHED WITH THE ACCOUNT ID, so the same physical
-- machine registered under two accounts stores two unrelated values and this
-- column cannot be used to correlate users.
--
-- Nullable and never backfilled. Rows written before this shipped, and rows
-- from clients that cannot read an anchor, simply keep matching on device id —
-- which is still the common case for an in-place reinstall.
alter table machines add column hardware_id text;

-- Serves the second half of the supersede predicate. Same shape and reasoning
-- as `idx_machines_user_device`: the register path selects duplicate rows for
-- one (user, anchor) pair, and the (user_id, last_seen_at) index does not serve
-- that. Rows with a null anchor are still indexed by SQLite but are never
-- matched, because `hardware_id = null` is never true.
create index if not exists idx_machines_user_hardware
  on machines(user_id, hardware_id);
