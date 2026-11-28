-- A cloud computer's own Clerk sign-in, expected right after its join
-- (src/newDeviceEmail.ts): Clerk's "new device" email for it is not sent.
-- `address` is where the join came from (an IPv4 address, or an IPv6 /64);
-- one row quiets one email, inside `expires_at`. A spent row keeps the email
-- id, so Clerk delivering that email again stays quiet; spent and expired
-- rows are deleted after a few days. Additive only.
create table if not exists cloud_quiet_sign_ins (
  id integer primary key autoincrement,
  user_id text not null,
  address text not null,
  created_at integer not null,
  expires_at integer not null,
  used_at integer,
  email_id text
);
create index if not exists cloud_quiet_sign_ins_user on cloud_quiet_sign_ins (user_id, expires_at);
create index if not exists cloud_quiet_sign_ins_email on cloud_quiet_sign_ins (email_id);
