-- Daily usage research reports: one compact report per ADE install per local
-- day, kept so the owner can study how to build a model router.
--
-- This database also holds machines, device authorizations and pairing grants,
-- so research data must never be able to fill it: a full D1 database refuses
-- EVERY write, and sign-in and machine heartbeats would be the first casualty.
-- Everything below exists to keep that from happening. The arithmetic is in the
-- README, "Usage research reports".
--
-- `(install_id, day)` is the primary key, so a re-send REPLACES the row and a
-- day can never be stored twice. `received_at` is the first arrival and is never
-- overwritten; `updated_at` is the latest. `report` is the client's object
-- re-serialized compactly; the Worker never interprets it. `bytes` is its UTF-8
-- length plus a fixed 256 bytes for the key, the envelope columns and the day
-- index, kept so both the storage ceiling and a human can reason about size
-- without reading the report. A replace is a compare-and-swap on `bytes`.
-- WITHOUT ROWID keeps the row in the primary-key B-tree instead of paying for
-- a second rowid key.
create table if not exists usage_research_daily (
  install_id text not null,
  day text not null,
  schema_version integer not null,
  app_version text,
  platform text,
  arch text,
  utc_offset_minutes integer,
  report text not null,
  bytes integer not null,
  received_at integer not null,
  updated_at integer not null,
  primary key (install_id, day)
) without rowid;

-- The retention sweep deletes by `day`, oldest first, in bounded batches.
create index if not exists usage_research_daily_by_day on usage_research_daily(day);

-- Fleet-wide write budget, one row per UTC day of RECEIPT (not the report's
-- day). Claimed by a single upsert whose `where writes < ?` makes the check and
-- the increment one statement, exactly like `diagnostics_upload_days`. Only
-- writes that change a row count; an identical re-send writes nothing and
-- claims nothing. Pruned after seven days.
create table if not exists usage_research_days (
  day text primary key,
  writes integer not null
);

-- Per-caller write quota for the current UTC day. `identity` is a day-salted
-- SHA-256 of the caller's address (an IPv6 address cut to its /64), never the
-- address itself, and rows are deleted as soon as their day is over, because
-- only today's row is ever read.
create table if not exists usage_research_identity_days (
  day text not null,
  identity text not null,
  writes integer not null,
  primary key (day, identity)
) without rowid;

-- Running total of `usage_research_daily.bytes`, one row. The storage ceiling
-- (`USAGE_RESEARCH_STORAGE_CEILING_MB`) is claimed against it before every write
-- that grows the table, and the retention sweep subtracts what it deletes in the
-- same transaction as the delete. A write that loses a race to another write
-- of the same install and day matches no row and gives its claim back, so the
-- total stays equal to `sum(bytes)`. The one way it drifts is a refund lost to
-- a D1 error, and that errs UPWARD: the ceiling trips early, never late.
-- Resync by hand with:
--   update usage_research_totals
--   set bytes = (select coalesce(sum(bytes), 0) from usage_research_daily)
--   where id = 1;
create table if not exists usage_research_totals (
  id integer primary key check (id = 1),
  bytes integer not null
);

insert or ignore into usage_research_totals (id, bytes) values (1, 0);
