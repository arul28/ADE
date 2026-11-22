-- The day-2 getting-started email (src/welcomeEmail.ts). Additive only: apply
-- this migration first, then deploy the Worker.
--
-- Clerk's `user.created` webhook writes one row per new account (never an
-- internal one); the minute cron sends it once `due_at` passes. A row is
-- finished once: `finished_at` and `outcome` (sent, skipped_*, failed) are set
-- in the write that ends it, and nothing reads a finished row again.
-- `claimed_at` keeps two overlapping ticks from both sending.
create table if not exists welcome_emails (
  user_id text primary key,
  signed_up_at integer not null,
  due_at integer not null,
  claimed_at integer,
  attempts integer not null default 0,
  finished_at integer,
  outcome text
);

create index if not exists idx_welcome_emails_due
  on welcome_emails(due_at) where finished_at is null;

-- An account that unsubscribed from ADE's getting-started email. Read before
-- every send; removed with the account (`user.deleted`).
create table if not exists email_opt_outs (
  user_id text primary key,
  opted_out_at integer not null
);
