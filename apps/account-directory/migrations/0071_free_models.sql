-- ADE Free Models (`src/cloud/freeModels.ts`): Gravity's hosted models, paid
-- for by the sponsored cards in the chats that use them, on any plan.

-- The person's answer to the one-time sheet. Separate from the Free plan's
-- sponsored-card answer (`cloud_sponsored_consent`): a paid account agrees
-- here only to cards in the chats that use these models.
create table if not exists cloud_free_model_consent (
  user_id text primary key,
  consent text not null check (consent in ('granted', 'declined')),
  email_hash text,
  decided_at integer not null,
  country text,
  region text,
  gpc integer not null default 0,
  terms_version integer not null default 1
);

-- A person has an ADE Free Models chat open, on this device, from here.
-- Inference runs only while a fresh row exists, with this person's address
-- (never the address of the computer the chat runs on). Pruned after a day.
create table if not exists cloud_free_model_viewers (
  user_id text not null,
  chat_id text not null,
  ip text not null,
  ua text,
  device_type text,
  os text,
  os_version text,
  tracking text,
  country text,
  region text,
  seen_at integer not null,
  primary key (user_id, chat_id)
);
create index if not exists cloud_free_model_viewers_seen on cloud_free_model_viewers (seen_at);

-- The chats the proxy served: cards show in these on any machine and plan,
-- and the last model call's usage rides on the next card request.
create table if not exists cloud_free_model_chats (
  user_id text not null,
  chat_id text not null,
  first_at integer not null,
  last_at integer not null,
  requests integer not null default 0,
  input_tokens integer not null default 0,
  cached_input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  last_model text,
  last_usage_json text,
  last_usage_at integer,
  primary key (user_id, chat_id)
);
create index if not exists cloud_free_model_chats_last on cloud_free_model_chats (last_at);
