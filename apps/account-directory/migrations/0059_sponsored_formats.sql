-- Where an account's sponsored cards show (src/cloud/gravity.ts
-- `sponsoredFormatOf`): `below_reply`, `above_prompt` or `inline`.
-- `source` `owner`: the owner chose it for this account
-- (src/cloud/ownerAccounts.ts `adFormat`); it holds whatever the switch says.
-- `source` `split`: the account's arm of the `gravity_format=split` A/B test,
-- written the first time ads reach it and kept, so a person never changes
-- arm (a later change of the split's weights moves only new accounts).
-- No row: the `gravity_format` switch decides. Additive only: apply before
-- the Worker that reads it.
create table if not exists cloud_sponsored_formats (
  user_id text primary key,
  format text not null,
  source text not null,
  set_at integer not null
);
create index if not exists idx_cloud_sponsored_formats_format on cloud_sponsored_formats(format, source);

-- The format a reply's card was asked in, and when the person hid it: the
-- A/B test counts hides per format once per reply (`POST /cloud/sponsored/hide`).
alter table cloud_sponsored_turns add column format text;
alter table cloud_sponsored_turns add column hidden_at integer;
