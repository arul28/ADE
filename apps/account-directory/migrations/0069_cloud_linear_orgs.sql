-- The Linear workspace each project's Linear connection belongs to, per
-- account, as Linear answered (src/cloud/eventWakes.ts
-- `topicsInOwnWorkspace`). `scope` is the project's vault scope
-- (`repo:<origin>`). A computer may listen to `linear-org:<id>` only for the
-- workspace of its own lane's project, so no account listens to another
-- team's workspace. A row counts for a week, then Linear is asked again at
-- the computer's next rest. Additive only: apply before the Worker that
-- reads it.
create table if not exists cloud_linear_orgs (
  user_id text not null,
  scope text not null,
  org_id text not null,
  checked_at integer not null,
  primary key (user_id, scope, org_id)
);
