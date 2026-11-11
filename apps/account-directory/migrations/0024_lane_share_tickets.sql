-- Lane share connection tickets: how a guest proves a grant to the host
-- machine without ever sending the host its ADE account token
-- (src/laneShares/routes.ts, README "Lane sharing").
--
-- The receiver of an ACTIVE grant asks `POST /lane-shares/:id/connect` with
-- its own account token (that token goes to this directory only). The answer
-- carries a ticket: 32 random bytes, returned once. The guest's hello to the
-- host carries only the ticket and a DPoP proof. The host redeems the ticket
-- here with ITS owner's account token (`POST /lane-shares/host/redeem`) and
-- admits the user id this table names, never one the guest sends.
--
-- Only the SHA-256 of the ticket is stored, so a read of this table opens
-- nothing. A ticket is bound to:
--   - one grant and its receiver, as they were at mint time;
--   - one machine (`machine_key`): the grant's machine at mint time. A
--     redeem by any other machine, or after the lane moved, finds no row;
--   - one DPoP key (`dpop_thumbprint`, the RFC 7638 SHA-256 thumbprint of
--     the guest's P-256 public key, base64url): the host compares it with
--     the key that signed the hello, so a copied ticket is useless without
--     the guest's private key.
--
-- A ticket lives about two minutes (`expires_at`) and is used once: the
-- redeem is one conditional UPDATE of `used_at`, so of two redeems at once
-- only one wins. That UPDATE also requires the grant to be active, with the
-- same receiver and machine, at that moment on the server clock, so a revoke
-- between mint and redeem refuses the ticket.
--
-- Mints are capped per grant per hour by counting the rows of the last hour
-- (the insert carries the count, so concurrent mints cannot pass the cap
-- together). The cron deletes rows older than that window.
create table if not exists lane_share_tickets (
  ticket_hash text primary key,
  grant_id text not null,
  receiver_user_id text not null,
  machine_key text not null,
  dpop_thumbprint text not null,
  created_at integer not null,
  expires_at integer not null,
  used_at integer
);

-- The per-grant mint cap.
create index if not exists idx_lane_share_tickets_grant_created
  on lane_share_tickets(grant_id, created_at);

-- The cron sweep.
create index if not exists idx_lane_share_tickets_created
  on lane_share_tickets(created_at);
