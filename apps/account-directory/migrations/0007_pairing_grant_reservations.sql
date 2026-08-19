-- Two-phase redemption for pairing grants.
--
-- Redemption used to be a single DELETE: the grant was destroyed BEFORE the
-- activity relay was asked to lift the machine's publish block, and it was
-- deliberately not put back when that hand-off failed. The reasoning was sound
-- as far as it went — restoring a deleted grant means either a non-atomic
-- read-then-write (two concurrent registrations each see it unspent) or
-- re-issuing it with a fresh expiry (an attacker who can force relay failures
-- keeps one alive indefinitely) — but the cost landed on real users: a relay
-- outage during a re-pair burned the only credential a reinstalled machine had,
-- and the account token it still held could not mint another. That is the
-- lockout the revocation work was supposed to have removed.
--
-- `reserved_at` splits the spend in two so neither horn of that dilemma
-- applies. Phase one is an atomic UPDATE that claims the grant — same single
-- statement, same `changes === 1` proof, so concurrency is unchanged and no
-- second registration can hold it at the same time. Phase two either deletes
-- the row (relay agreed) or clears `reserved_at` back to null (relay failed).
--
-- The release restores the row EXACTLY as it was: `expires_at` is never
-- rewritten, so forcing relay failures buys an attacker nothing beyond the
-- original TTL the grant was minted with.
--
-- A null `reserved_at` means unheld. A reservation older than the worker's
-- crash-safety bound also counts as unheld, so a worker that dies mid-relay
-- strands the grant for at most that long rather than until it expires; the
-- bound lives in the worker (`PAIRING_GRANT_RESERVATION_MS`) because it is a
-- property of one relay round trip, not of the schema.
--
-- Additive and backfill-free: every existing row reads as unheld, which is what
-- an unspent grant already was.
alter table machine_pairing_grants add column reserved_at integer;

-- The register path already selects duplicate rows for one (user, device) pair
-- when a proven re-pair supersedes a rotated machine key. The existing index is
-- (user_id, last_seen_at), which does not serve that predicate.
create index if not exists idx_machines_user_device
  on machines(user_id, device_id);
