-- The bytes of files a draft launch holds (src/cloud/launches.ts
-- `handlePutFile`), so an account's open drafts stay under one total
-- (`CLOUD_LAUNCH_MAX_DRAFT_BYTES_PER_ACCOUNT`). An upload reserves its size
-- here before its body is read and settles it to the file's real size after.
-- Drafts made before this column count 0. Additive only: apply before the
-- Worker that reads it.
alter table cloud_launches add column draft_bytes integer not null default 0;
