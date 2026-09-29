-- The model registry: one snapshot a day of Artificial Analysis model and
-- coding-agent data plus models.dev prices, served at `GET /router/registry`
-- to signed-in ADE machines for the model router (README, "Model registry").
--
-- `body` is the whole snapshot as compact JSON, about 0.52 MB; the Worker
-- refuses to store one over 1.9 MB, under D1's 2 MB row cap. `bytes` is its
-- UTF-8 length. `etag` is the quoted hash the route answers `If-None-Match`
-- with, stored so a 304 never reads the body. The refresh deletes all but the
-- newest seven rows in the same batch as its insert, so the table stays under
-- about 4 MB. Newest is the highest `id`. `body` is the LAST column on purpose:
-- SQLite stores a row's columns in order, and reading a column after a 0.5 MB
-- value walks that value's overflow pages first.
create table if not exists model_registry_snapshots (
  id integer primary key,
  generated_at integer not null,
  bytes integer not null,
  etag text not null,
  body text not null
);

-- One row: who holds the refresh, and until when. The cron claims it with an
-- upsert that only overwrites an expired claim, so two ticks never refresh at
-- once. A refresh that stored nothing keeps the claim for ten more minutes,
-- which is the retry wait; a stored one releases it.
create table if not exists model_registry_refresh_claim (
  id integer primary key check (id = 1),
  claimed_at integer not null,
  expires_at integer not null
);
