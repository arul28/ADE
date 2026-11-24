-- Where an account's sponsored cards show, when the owner chose it for that
-- account (src/cloud/ownerAccounts.ts `adFormat`, src/cloud/gravity.ts
-- `sponsoredFormatOf`): `below_reply`, `above_prompt` or `inline`. No row:
-- the `gravity_format` switch decides. Not a test: it stays until changed.
-- Additive only: apply before the Worker that reads it.
create table if not exists cloud_sponsored_formats (
  user_id text primary key,
  format text not null,
  set_at integer not null
);
