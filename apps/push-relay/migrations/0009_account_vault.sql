-- The vault: secrets, provider API keys, and integration credentials that
-- follow a user to every machine they sign in on.
--
-- Separate from `account_settings` on purpose. They share a transport and an
-- account, and nothing else. A settings row is readable plaintext JSON that any
-- surface may show; a vault row is ciphertext the Worker never has a reason to
-- look inside. Keeping them in one table would mean one query, one permission,
-- and one accident away from rendering a key in a settings list.
--
-- `ciphertext` is sealed before it leaves the machine and is opaque here. The
-- Worker stores and returns bytes; it does not decrypt, and there is no route
-- that would let it.
--
-- `kind` and `refresh_owner` exist from the first migration rather than being
-- added later, because the credentials ADE will want to carry next are not all
-- the same shape:
--   * `secret`         — a user's project secret. Opaque bearer.
--   * `provider_key`   — an AI provider API key. Opaque bearer.
--   * `integration`    — an OAuth credential for an integration such as Linear.
--
-- `refresh_owner` names the machine allowed to exchange a rotating credential,
-- or is null for one that never rotates. Nothing rotating is stored here yet —
-- Linear's token is a long-lived bearer ADE never exchanges — but the column is
-- what lets a rotating credential join without a migration, and without
-- repeating the mistake that produced this repository's only real sign-out bug:
-- two machines holding one single-use refresh token and both spending it.
create table if not exists account_vault_items (
  user_id text not null,
  scope_key text not null,
  item_kind text not null,
  item_key text not null,
  ciphertext text not null,
  updated_at text not null,
  writer_device_id text,
  refresh_owner text,
  primary key (user_id, scope_key, item_kind, item_key)
);

create index if not exists idx_account_vault_user_updated
  on account_vault_items(user_id, updated_at);
