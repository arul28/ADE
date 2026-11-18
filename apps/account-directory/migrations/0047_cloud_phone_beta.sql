-- The ADE Cloud iPhone's beta list (src/cloud/phones.ts): the accounts the
-- owner let in with `POST /cloud/owner/phone-beta`. Everyone else reads
-- "coming soon". `email` is only what the owner typed, for the owner's own
-- reading of the list; access is by `user_id`. Additive: apply before the
-- Worker that reads it.
create table if not exists cloud_phone_beta (
  user_id text primary key,
  email text,
  added_at integer not null
);
