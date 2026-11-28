-- The `@` menu an ADE Cloud computer saves when it rests
-- (src/cloud/mentionSnapshots.ts), one per (computer, project), so a chat's
-- menu reads the same while the computer sleeps: its chats, lanes,
-- terminals, PRs, MCP servers, people and each lane's file names. `sealed`
-- is the copy gzipped, then sealed with the account's key (names and paths
-- are the person's); `saved_at` is the computer's own time, so an older save
-- never replaces a newer one. `machine_key` matches in any case, so a path
-- that names the computer in another case reads and deletes the same copy.
-- Deleted with the lane and with the account.
-- Additive only: apply before the Worker that reads it.
create table if not exists cloud_mention_snapshots (
  user_id text not null,
  machine_key text not null collate nocase,
  project_key text not null,
  instance_id text,
  sealed text not null,
  saved_at integer not null,
  updated_at integer not null,
  primary key (user_id, machine_key, project_key)
);
