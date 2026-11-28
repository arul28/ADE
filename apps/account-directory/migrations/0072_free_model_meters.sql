-- ADE Free Models' "no ads, no free tokens" meter (`src/cloud/freeModels.ts`), one row per
-- account (a script can make up chat ids): model calls and input tokens since the account's
-- last card request in a chat those models served (`src/cloud/gravity.ts`, any answer).
-- `slowed_at` and `paused_at` are when this stretch first crossed each line, for the owner's report.
create table if not exists cloud_free_model_meters (
  user_id text primary key,
  calls integer not null default 0,
  input_tokens integer not null default 0,
  since_at integer not null,
  slowed_at integer,
  paused_at integer,
  updated_at integer not null
);
