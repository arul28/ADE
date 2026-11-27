-- A build tool a cloud iPhone provider's build hosts were found without
-- (src/cloud/phoneRoute.ts `buildGaps`): `need` is a `CloudPhoneBuildNeed`
-- (`metal`, Apple's Metal Toolchain). A brain whose build failed for want of
-- it reports it on its own account's phone; for a day (`seen_at`), starts
-- that need it go to a provider that has it, then one tries this provider
-- again. One row per provider and need, shared by every account, with no
-- account in it (the report's log line names who). That shared row only
-- moves paid plans' starts (to a provider that has the tool); a free plan is
-- refused only on its own report, kept on its own phone's row
-- (`cloud_phones.build_gap`, its day from `build_gap_at`), so no account can
-- block another's builds.
-- Additive only: apply before the Worker that reads it.
create table if not exists cloud_phone_build_gaps (
  provider text not null,
  need text not null,
  seen_at integer not null,
  primary key (provider, need)
);
alter table cloud_phones add column build_gap text;
alter table cloud_phones add column build_gap_at integer;
