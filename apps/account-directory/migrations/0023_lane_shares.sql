-- Lane sharing: one ADE account (the giver) gives another account (the
-- receiver) limited access to ONE lane on one of the giver's machines
-- (src/laneShares, shapes in src/laneShares/contract.ts).
--
-- This table is the index and the revocation list, nothing more. It holds no
-- detailed rights and it never opens a machine by itself: the host machine
-- keeps the rights and decides each request, and it asks this table (the host
-- read) on every guest connection whether the grant is still live. A revoke
-- is therefore one UPDATE here, and the next host read no longer lists it.
--
-- `id` is 128 random bits (`ls_` + 32 hex). It is the address in the invite
-- link, so it must not be guessable, but it is only an address: every route
-- still checks the caller's user id (or, for a pending invite, a VERIFIED
-- email of the caller read from Clerk) against the row.
--
-- `receiver_email` is trimmed and lowercased. `receiver_user_id` is null until
-- accept; after accept the grant belongs to that user id, so the receiver
-- removing the address later does not end it.
--
-- `repo_key` is exactly what `accountRepoScopeKey` returns on the desktop,
-- `repo:` prefix included (`repo:github.com/owner/name`), so a client sends
-- the value it already computes and nothing is converted on either side.
--
-- `state` is what was last written. Two states are also derived from the
-- clock and applied lazily: a `pending` row at or past `invite_expires_at`
-- reads as `expired`, and a `pending` or `active` row at or past `ends_at`
-- reads as `ended`. Every read derives them (server epoch ms only), and the
-- writes that depend on them (invite, accept) first persist them for the
-- lane, which is what keeps the two partial unique indexes below honest.
--
-- `version` goes up by one on every write to the row, so a host or a list can
-- tell a changed grant from an unchanged one without comparing fields.
--
-- `invite_email_count` and `last_invite_email_at` bound re-sends of one
-- invite; the per-account and per-recipient daily caps live in
-- `lane_share_invite_days` below.
create table if not exists lane_shares (
  id text primary key,
  giver_user_id text not null,
  receiver_user_id text,
  receiver_email text not null,
  repo_key text not null,
  machine_key text not null,
  lane_id text not null,
  giver_label text,
  project_label text,
  lane_label text,
  preset text not null check (preset in ('watch', 'comment', 'suggest', 'collaborate')),
  risk text not null check (risk in ('low', 'medium', 'high')),
  state text not null check (state in ('pending', 'active', 'revoked', 'left', 'expired', 'ended')),
  closed_reason text,
  invite_expires_at integer not null,
  ends_at integer,
  version integer not null default 1,
  invite_email_count integer not null default 0,
  last_invite_email_at integer,
  created_at integer not null,
  updated_at integer not null,
  accepted_at integer,
  closed_at integer
);

-- One live invite per address per lane: a second invite to the same address
-- refreshes this row instead of making another, and two concurrent invites
-- cannot both insert.
create unique index if not exists idx_lane_shares_pending_email
  on lane_shares(giver_user_id, lane_id, receiver_email) where state = 'pending';

-- One active grant per person per lane, whatever address each invite used.
-- Two accepts of two invites by one account cannot both win.
create unique index if not exists idx_lane_shares_active_receiver
  on lane_shares(giver_user_id, lane_id, receiver_user_id) where state = 'active';

-- The host read (giver + machine) and the "Shared by me" list.
create index if not exists idx_lane_shares_giver_machine
  on lane_shares(giver_user_id, machine_key, state);
create index if not exists idx_lane_shares_giver_created
  on lane_shares(giver_user_id, created_at desc);

-- "Shared with me": by user id after accept, by address while pending.
create index if not exists idx_lane_shares_receiver
  on lane_shares(receiver_user_id, state);
create index if not exists idx_lane_shares_receiver_email
  on lane_shares(receiver_email, state);

-- The cron sweep of long-closed rows.
create index if not exists idx_lane_shares_closed_at
  on lane_shares(closed_at) where closed_at is not null;

-- Invite email budget, so the invite route cannot be used to send spam. One
-- row per UTC day and subject: `giver:<user id>` counts the invites and
-- re-sends one account made that day, `to:<sha256 of the address>` counts the
-- invite emails one address received from every account that day (the hash
-- keeps a second copy of the address out of this table). The claim is one
-- upsert whose `where count < ?` is the cap, as in `jev_bonus_days`, so two
-- concurrent invites cannot both take the last slot. The cron drops rows
-- older than a week.
create table if not exists lane_share_invite_days (
  day text not null,
  subject text not null,
  count integer not null,
  primary key (day, subject)
);
