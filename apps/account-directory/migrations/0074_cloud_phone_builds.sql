-- A cloud iPhone build on a provider's build runners (Revyl's), with or
-- without a phone up (src/cloud/phoneRevyl.ts `routeRevylBuild`). A build
-- belongs to the account, not to a phone: `ade apple build` and the first half
-- of `ade apple launch` run here before any phone starts, so a failed build
-- costs no phone minutes.
--
-- One running build per account (the runners bill ADE): a start claims it in
-- one write, as `job = 'unknown'` (it asks the runner next, so a build may run
-- from then on). A refused start deletes its claim; an answered one names its
-- job (the runner's build job id). A claim with no job is held a while, then
-- lapses; a job holds until the runner says it ended, or two hours at most.
-- `seconds` is what the build ran, for the paid plan's limit at the provider
-- (`revylSpentMicros`); a running one counts until now. `phone_id` is the live
-- phone at the start, or null.
--
-- Replaces the claim on `cloud_phones.build_started_at` / `build_job`
-- (migration 0057), which tied a build to a live phone; those columns stay
-- unused. Additive only: apply before the Worker that reads it.
create table if not exists cloud_phone_builds (
  id text primary key,
  user_id text not null,
  provider text not null,
  job text,
  started_at integer not null,
  ended_at integer,
  status text,
  seconds integer not null default 0,
  phone_id text
);
create index if not exists cloud_phone_builds_user on cloud_phone_builds (user_id, started_at);
