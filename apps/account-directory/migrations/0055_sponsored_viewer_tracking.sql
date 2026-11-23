-- The iPhone app's App Tracking Transparency answer on the device a person
-- last watched a cloud chat from (src/cloud/gravity.ts). Additive only: apply
-- this migration first, then deploy the Worker.
--
-- An Index search sends the account's hashed email only when that device is
-- not an iPhone or iPad, or is one whose answer was "authorized". Null (desktop,
-- web, or an older iPhone app) on an iOS row means no hashed email.
alter table cloud_sponsored_viewers add column tracking text;

-- The prune (minutes 23 and 53) deletes rows a day old by `seen_at`.
create index if not exists idx_cloud_sponsored_viewers_seen on cloud_sponsored_viewers(seen_at);
