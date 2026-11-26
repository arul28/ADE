-- The Linear workspaces an account's own Linear connections belong to, as
-- Linear answered (src/cloud/eventWakes.ts `topicsInOwnWorkspace`). A
-- computer may listen to `linear-org:<id>` only for one of these, so no
-- account listens to another team's workspace. A row counts for a week,
-- then Linear is asked again at the computer's next rest. Additive only:
-- apply before the Worker that reads it.
create table if not exists cloud_linear_orgs (
  user_id text not null,
  org_id text not null,
  checked_at integer not null,
  primary key (user_id, org_id)
);
