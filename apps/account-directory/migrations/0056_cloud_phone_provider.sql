-- The ADE Cloud iPhone on more than one provider (src/cloud/phones.ts, phoneRoute.ts,
-- phoneRevyl.ts). Additive only: apply before the Worker that reads it.

-- Who runs each phone (`nomac` or `revyl`), and the provider's own second id
-- for it when it has one (Revyl's workflow run, which its device calls name).
-- Every phone before this was NoMac's.
alter table cloud_phones add column provider text not null default 'nomac';
alter table cloud_phones add column provider_ref text;
-- The recording running on the phone when its provider names one only at its
-- start (Revyl): any brain of the account can stop it.
alter table cloud_phones add column recording_ref text;
-- The build running for the phone on its provider's runners (Revyl bills them
-- by the hour): one at a time, freed when the build finishes or the phone
-- ends (a claim that never got Revyl's answer lapses after 15 minutes).
alter table cloud_phones add column build_started_at integer;
alter table cloud_phones add column build_job text;

-- The owner's lock of a tester on the beta list to one provider (`nomac` or
-- `revyl`; null or `both`: the router), and the same for an email still
-- waiting for its account, which carries it over when the account appears.
alter table cloud_phone_beta add column provider text;
alter table cloud_phone_beta_pending add column provider text;

-- One phone start per account at a time, across providers and machines: the
-- start's time while it runs (null when none is), lapsing after 2 minutes.
alter table cloud_accounts add column phone_start_claim integer;

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
