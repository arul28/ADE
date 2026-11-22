-- ADE Cloud launches that start at the disk their setup needed before
-- (src/cloud/launches.ts `rememberedSetupDiskGb`, routes.ts `createComputer`;
-- docs/features/ade-cloud/README.md "Setup that fills the disk"). Additive
-- only: the Worker before this change never reads the table, and this Worker
-- reads and writes it best effort (a missing table starts at 4 GB as before),
-- but apply this migration first, then deploy the Worker.

-- The disk a repository's lane setup grew its computer to, per account:
-- every size starts at 4 GB, and a big repository's install fills it, grows
-- it (the computer restarts) and runs its setup again, once per step. A later
-- launch of the same repository and lane template starts at `disk_gb`, only
-- inside the plan's included disk (never extra disk) and the size's limit.
-- Written only after a grow the provider made, during a launch's setup (the
-- agent not started yet). `setup_key` is the launch's lane template id, or ''
-- for the project's default setup. Read only for `recorded_at` within
-- CLOUD_AUTO_SIZE_MEMORY_MS, so a repository whose setup got lighter starts
-- small again. Deleted with the account.
create table if not exists cloud_repo_disks (
  user_id text not null,
  project_origin text not null,
  setup_key text not null default '',
  disk_gb integer not null,
  -- The launch whose setup grew it (for support; its record goes after a week).
  launch_id text,
  recorded_at integer not null,
  primary key (user_id, project_origin, setup_key)
);
