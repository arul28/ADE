-- Account-scoped ADE settings: the store that makes one sign-in carry a user's
-- configuration to every machine.
--
-- One row per setting, NOT one JSON blob per account. The merge rule is last
-- writer wins *per key*, and a single blob cannot express that: a machine that
-- was offline would send back a whole document and silently revert every key it
-- had not seen, which is the bug this table exists to avoid rather than a
-- storage detail.
--
-- `scope_key` carries the repo half of ADE's two-axis scope model
-- ("account, all projects" vs "account, this repo"). Machine-scoped settings
-- never reach this table at all — a value that names a path, a port, or a piece
-- of hardware is meaningless on another computer, so it stays local by design.
--
-- `updated_at` is stamped by the Worker, never by the client. Client clocks
-- disagree, and ADE has already been bitten once by trusting a peer's clock for
-- ordering. `changed_at` keeps what the writer claimed, for diagnostics only,
-- so a skewed machine is visible without being authoritative.
create table if not exists account_settings (
  user_id text not null,
  scope_key text not null,
  setting_key text not null,
  value_json text not null,
  updated_at text not null,
  changed_at text,
  writer_device_id text,
  primary key (user_id, scope_key, setting_key)
);

-- Pulls ride the existing 30-second heartbeat and ask "what changed since I
-- last looked", so the read path is (user, updated_at) ordered rather than a
-- full-table scan per beat.
create index if not exists idx_account_settings_user_updated
  on account_settings(user_id, updated_at);
