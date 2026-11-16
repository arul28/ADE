-- ADE Cloud launches that size themselves (src/cloud/launches.ts,
-- `CLOUD_AUTO_SIZE`; README "A launch that needs more memory"). Additive only:
-- the Worker before this change reads rows with `select *` and ignores the new
-- column, so apply this migration first, then deploy the Worker.

-- Why a launch's computer is bigger than the size it asked for: 'remembered'
-- (it started at Medium because this repository's setup needed it before) or
-- 'setup_memory' (its own setup ran out of memory on a Small and ADE moved the
-- computer to Medium). Null while it is the size it asked for.
alter table cloud_launches add column auto_size text;

-- Repositories whose lane setup needed more memory than a Small has, per
-- account: a later launch of the same repository and lane template whose size
-- was ADE's default starts at `size_id` directly. Written only once a resize
-- really started (a refused one writes nothing). `setup_key` is the launch's
-- lane template id, or '' for the project's default setup. Read only for
-- `recorded_at` within CLOUD_AUTO_SIZE_MEMORY_MS, so a repository whose setup
-- got lighter tries Small again. Deleted with the account.
create table if not exists cloud_repo_sizes (
  user_id text not null,
  project_origin text not null,
  setup_key text not null default '',
  size_id text not null,
  -- The launch whose setup needed it (for support; its record goes after a week).
  launch_id text,
  recorded_at integer not null,
  primary key (user_id, project_origin, setup_key)
);
