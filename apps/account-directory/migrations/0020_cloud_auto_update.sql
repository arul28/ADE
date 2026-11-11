-- Cloud computers update themselves (src/cloud/updates.ts). Additive only:
-- the Worker before this change reads rows with `select *` and ignores the new
-- columns, so apply this migration first, then deploy the Worker.

-- One image setting per update channel. Both start at the one setting there
-- was. Code reads the channel's key, then `template_version`; a move of the
-- stable key also writes `template_version`, so older code and scripts agree.
insert into cloud_settings (key, value, updated_at)
  select 'template_version_stable', value, updated_at from cloud_settings where key = 'template_version'
  on conflict (key) do nothing;
insert into cloud_settings (key, value, updated_at)
  select 'template_version_beta', value, updated_at from cloud_settings where key = 'template_version'
  on conflict (key) do nothing;
-- `auto_update_stable` and `auto_update_beta` are not seeded: a computer
-- updates itself only to the image a passed template check named there
-- (infra/ade-cloud/promote-template.mjs writes it with the channel's key).
-- 'off' there stops automatic updates for that channel.

-- The channel a computer follows, picked by the app that made it: 'stable' or 'beta'.
alter table cloud_computers add column channel text not null default 'stable';
-- The image it ran before its last update, for the rollback.
alter table cloud_computers add column previous_template text;
-- null, 'updating' (waiting for the computer to report in) or 'failed'.
alter table cloud_computers add column update_state text;
-- When the last update (or rollback) started; null once it is settled.
alter table cloud_computers add column update_started_at integer;
-- 'manual', 'idle', 'asleep' or 'rollback'.
alter table cloud_computers add column update_reason text;
-- When the computer last reported in on a new image.
alter table cloud_computers add column updated_at integer;
-- An image this computer failed to start on: never tried again on its own.
alter table cloud_computers add column update_failed_template text;
-- What went wrong, one plain sentence.
alter table cloud_computers add column update_error text;

create index if not exists idx_cloud_computers_updating on cloud_computers (update_started_at) where update_started_at is not null;
