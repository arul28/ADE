-- The ADE Cloud iPhone on more than one provider (src/cloud/phones.ts,
-- phoneRevyl.ts). Additive only: apply before the Worker that reads it.

-- Who runs each phone (`nomac` or `revyl`), and the provider's own second id
-- for it when it has one (Revyl's workflow run, which its device calls name).
-- Every phone before this was NoMac's.
alter table cloud_phones add column provider text not null default 'nomac';
alter table cloud_phones add column provider_ref text;
-- The recording running on the phone when its provider names one only at its
-- start (Revyl): any brain of the account can stop it.
alter table cloud_phones add column recording_ref text;

-- The owner's per-account choice of provider for a tester on the beta list
-- (null: the server's `CLOUD_PHONE_PROVIDER`).
alter table cloud_phone_beta add column provider text;

-- An account's Revyl workspace: Revyl made it for ADE's partner key under
-- `external_id` (never an email), and `app_id` is the app its builds go to.
-- No credential is kept: the server mints a short session credential when it
-- needs one. Removed (and the workspace disconnected) when the account is
-- deleted.
create table if not exists cloud_phone_revyl (
  user_id text primary key,
  external_id text not null,
  app_id text,
  created_at integer not null,
  updated_at integer not null
);
