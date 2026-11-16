-- ADE Cloud launches from the web and the phone (src/cloud/launches.ts):
-- the messages a person sends before the chat exists, and the provider
-- sign-in a launch waits on. Additive only: apply this migration first,
-- then deploy the Worker.

-- While a launch is `waiting_for_sign_in`: what the person needs to sign the
-- provider in (CloudLaunchSignIn, JSON). A device code and a link, never a
-- secret. Cleared when the launch moves on.
alter table cloud_launches add column sign_in_json text;

-- The launch's messages, in order. Row 1 is the first message (the start's
-- `chat.prompt`); the computer starts the chat with it. Later rows are
-- messages sent while the computer was still being made or signed in; the
-- computer claims each one, sends it to the chat and says so. A message is
-- sent at most once: a claim moves `queued` to `sending` with the
-- computer's claim id, and only that claim id may finish it.
create table if not exists cloud_launch_messages (
  launch_id text not null,
  -- The client's id for this message: the same id again is the same message.
  message_id text not null,
  user_id text not null,
  seq integer not null,
  text text not null,
  provider text,
  model_id text,
  -- 'queued', 'sending', 'delivered', 'failed'.
  state text not null,
  claim_id text,
  claimed_at integer,
  session_id text,
  error text,
  created_at integer not null,
  updated_at integer not null,
  primary key (launch_id, message_id)
);

create unique index if not exists cloud_launch_messages_seq on cloud_launch_messages (launch_id, seq);
create index if not exists cloud_launch_messages_user on cloud_launch_messages (user_id);
