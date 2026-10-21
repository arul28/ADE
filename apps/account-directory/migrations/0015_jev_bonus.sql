-- The ADE bonus for Jev: `POST /jev/systemone` forwards a signed-in ADE
-- user's Jev question to TypeSafe with ADE's key (README, "Jev bonus").
--
-- One row per UTC day and account: how many calls that account made that day.
-- The claim is one upsert whose `where count < ?` is the per-account cap, so
-- two concurrent calls cannot both take the last slot. The `__all__` row on
-- the same table is the fleet-wide ceiling. Rows older than a week are swept
-- by the cron. Counts only: no question, answer or prompt text is stored.
create table if not exists jev_bonus_days (
  day text not null,
  user_id text not null,
  count integer not null,
  primary key (day, user_id)
);
