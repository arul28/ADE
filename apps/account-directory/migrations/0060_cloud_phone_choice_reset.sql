-- The cloud iPhone's provider is no longer set by the owner (migration 0057's
-- `provider` locks). Every account starts on the fixed order (NoMac, then Revyl
-- on a paid plan); a tester picks their own from an ADE beta build or
-- `ade cloud phone-provider`, which writes this column again.
update cloud_phone_beta set provider = null where provider is not null;
update cloud_phone_beta_pending set provider = null where provider is not null;

-- What the account's latest phone start decided about billing (credits or iPhone
-- minutes) and when, written with the start's claim: a phone found later with
-- no row (its start's answer was lost) is billed as its start decided.
alter table cloud_accounts add column phone_start_credits integer;
alter table cloud_accounts add column phone_start_credits_at integer;
