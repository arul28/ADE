-- A fleet-wide daily ceiling on stored diagnostic reports.
--
-- The per-identity quota (5 a day, enforced against an R2 prefix listing) bounds
-- what ONE caller can store. It does not bound what the fleet can store, and
-- that stopped being a theoretical distinction the moment clients began sending
-- reports AUTOMATICALLY on failure: a bug that fires for every install at once
-- turns "five each" into "five times the install base", and the only thing
-- standing between that and an unbounded R2 bill is a number nobody chose.
--
-- This table is that number. The Worker is the sole writer of the bucket, so a
-- counter it must claim from before every `put` is not a heuristic — it is the
-- spend cap. `DIAGNOSTICS_DAILY_GLOBAL_LIMIT` (default 400) times the 512 KB
-- per-report cap times the bucket's 30-day expiry lifecycle is the entire
-- steady-state ceiling: ~6 GB, inside R2's free tier, with no path to exceed it
-- that does not go through this row.
--
-- One row per UTC day, claimed by a single upsert whose `where count < ?` makes
-- the increment and the check the same statement — the idiom
-- `device_approval_rate_limits` already uses, for the same reason: a read
-- followed by a write lets two concurrent uploads both observe the last free
-- slot. `changes === 1` is the whole proof, so no RETURNING is needed and the
-- statement stays portable across D1 versions.
--
-- The day key is the UTC date string (`2026-08-19`), not an epoch: it is what
-- the R2 key prefix already uses, it sorts lexicographically, and it makes both
-- the cron sweep's `day < ?` and a human reading the table trivial.
create table if not exists diagnostics_upload_days (
  day text primary key,
  count integer not null
);
