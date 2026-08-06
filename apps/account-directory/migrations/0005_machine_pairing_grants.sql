-- Second, independent proof that a `pairing: true` registration is backed by a
-- FRESH interactive sign-in.
--
-- The first proof is a claim on the caller's own token (`auth_time` / `fva`),
-- and it fails closed: a token that carries neither claim can never re-pair.
-- Clerk documents `fva` for SESSION tokens; the ADE brain authenticates with an
-- OAuth access token, whose documented default claim set does not list either
-- one. If those tokens turn out to carry neither, claim-only freshness would
-- make an account removal permanent for everyone — the exact Blocker the
-- revocation work was fixing, inverted.
--
-- So the directory also mints a grant at the one interactive sign-in it
-- actually observes: the `/device/*` flow it runs end to end. The grant is
-- short-lived, single-use, and bound to BOTH the signing-in user and the
-- machine key that started the device authorization, so it proves the same
-- thing the claim does — a human just authenticated, on this machine — without
-- depending on a claim that may not exist.
--
-- Only the hash is stored: the plaintext is handed to the machine once, at
-- `/device/token`, and a directory-database leak must not yield usable grants.
create table if not exists machine_pairing_grants (
  grant_hash text primary key,
  user_id text not null,
  machine_key text not null,
  created_at integer not null,
  expires_at integer not null
);

create index if not exists idx_machine_pairing_grants_expiry
  on machine_pairing_grants(expires_at);

-- Which machine started this device authorization, so the grant minted when the
-- sign-in completes can be bound to it. Nullable: an older CLI (and any
-- non-machine device login) simply gets no grant and falls back to the claim.
alter table device_authorizations add column machine_key text;
