-- What Revyl charged each account's workspace in a day beyond its phones'
-- own time (app builds, mostly), read from Revyl's partner usage by the daily
-- job (src/cloud/phoneRevyl.ts `recordRevylDayCosts`). The phones' time stays
-- in `cloud_phones.cost_micros`. `free` is whether the account was on
-- free-plan rules when the day was read, so the free-use cap counts it on the
-- right side. Additive only: apply before the Worker that reads it.
create table if not exists cloud_revyl_days (
  user_id text not null,
  day text not null,
  cost_micros integer not null,
  free integer not null default 0,
  read_at integer not null,
  primary key (user_id, day)
);
