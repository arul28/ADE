-- Passwords: sealed items and the account's wrapped vault key.
--
-- Items are sealed on the person's device or cloud lane before they arrive;
-- `ciphertext` is opaque here and holds the site, username and value alike.
-- A deleted item keeps its row as a tombstone (empty ciphertext) so `since`
-- pulls see the removal.
create table if not exists password_items (
  user_id text not null,
  item_id text not null,
  ciphertext text not null,
  updated_at text not null,
  writer_device_id text,
  deleted integer not null default 0,
  primary key (user_id, item_id)
);

create index if not exists idx_password_items_user_updated
  on password_items(user_id, updated_at);

-- The vault key, wrapped by ade-password-key-service; this Worker cannot open
-- it alone. `epoch` advances on every reset, and items sealed under an older
-- epoch no longer open.
create table if not exists password_keys (
  user_id text primary key,
  wrapped_dek text not null,
  epoch integer not null,
  created_at text not null
);

-- Every time a vault key was handed out, for the person's Activity view.
create table if not exists password_key_releases (
  user_id text not null,
  device_id text not null,
  machine_kind text not null,
  released_at text not null
);

create index if not exists idx_password_key_releases_user
  on password_key_releases(user_id, released_at);
