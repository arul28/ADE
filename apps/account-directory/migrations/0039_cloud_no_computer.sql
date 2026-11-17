-- ADE without a computer: what the server keeps and does for cloud lanes so
-- they read with no computer awake. Additive only: apply this migration
-- first, then deploy the Worker. Every row is keyed by `user_id`; anything
-- that came from a person's work (message text, terminal output, file paths,
-- capsules) is sealed with the user's key (src/cloud/seal.ts).

-- Saved chats: the parent of a chat ADE started from another chat, and the
-- chat a fork restore moved here. `aad_machine_key` is the machine key the
-- chat's parts were sealed under; it stays when a move re-keys the row, so
-- the parts in R2 (`r2_key`) keep opening and nothing is uploaded again.
alter table cloud_chat_copies add column parent_chat_id text;
alter table cloud_chat_copies add column spawn_kind text;
alter table cloud_chat_copies add column forked_from_machine_key text;
alter table cloud_chat_copies add column forked_from_chat_id text;
alter table cloud_chat_copies add column aad_machine_key text;

-- The person's queue for an existing cloud chat (src/cloud/chatMessages.ts).
-- A message is sent at most once: a claim moves `queued` to `sending` with
-- the computer's claim id, and only that claim id may finish it.
create table if not exists cloud_chat_messages (
  user_id text not null,
  machine_key text not null,
  chat_id text not null,
  -- The client's `clientSendId`: the same id again is the same message.
  message_id text not null,
  -- The computer that claims it; null while the chat's computer is gone and
  -- a launch carries it (`launch_id`).
  instance_id text,
  launch_id text,
  -- 1: the launch delivers it (its first message, or one added before the
  -- launch's chat existed); the computer never claims it from this queue,
  -- and its state is the launch message's.
  via_launch integer not null default 0,
  seq integer not null,
  -- Sealed JSON { text, attachments }.
  body_sealed text not null,
  provider text,
  model_id text,
  -- 'queued', 'sending', 'waiting_for_sign_in', 'delivered', 'failed', 'cancelled'.
  state text not null,
  claim_id text,
  claimed_at integer,
  -- CloudLaunchSignIn JSON while `waiting_for_sign_in` (a link and a code, never a secret).
  sign_in_json text,
  session_id text,
  error text,
  created_at integer not null,
  updated_at integer not null,
  primary key (user_id, machine_key, chat_id, message_id)
);
create unique index if not exists cloud_chat_messages_seq on cloud_chat_messages (user_id, machine_key, chat_id, seq);
-- The computer's list of what to send.
create index if not exists cloud_chat_messages_instance on cloud_chat_messages (instance_id, state, seq);
create index if not exists cloud_chat_messages_launch on cloud_chat_messages (launch_id);
-- The per-account caps and the minute rate limit.
create index if not exists cloud_chat_messages_user on cloud_chat_messages (user_id, created_at);
-- The minute cron: queued rows past 24 h, final rows past 7 days.
create index if not exists cloud_chat_messages_state on cloud_chat_messages (state, updated_at);

-- CLI-session and shell copies (src/cloud/sessionCopies.ts). The copy itself
-- is one sealed R2 object at `r2_key`, replaced on each upload.
create table if not exists cloud_session_copies (
  user_id text not null,
  machine_key text not null,
  session_id text not null,
  instance_id text,
  project_key text,
  lane_id text,
  -- 'cli' or 'shell'.
  kind text not null,
  parent_chat_id text,
  -- Sealed JSON: title, lane name, tool type, project id, status, format.
  summary_sealed text,
  r2_key text not null,
  bytes integer not null default 0,
  line_count integer not null default 0,
  last_activity_at integer,
  updated_at integer not null,
  primary key (user_id, machine_key, session_id)
);
create index if not exists cloud_session_copies_user on cloud_session_copies (user_id, updated_at desc);
create index if not exists cloud_session_copies_project on cloud_session_copies (user_id, project_key, updated_at desc);
create index if not exists cloud_session_copies_lane on cloud_session_copies (user_id, machine_key, lane_id);
create index if not exists cloud_session_copies_instance on cloud_session_copies (instance_id, updated_at desc);

-- Git summaries saved at rest (src/cloud/gitSummaries.ts). File paths are
-- the person's: the whole summary is sealed; counts for the overview are
-- plain numbers.
create table if not exists cloud_git_summaries (
  user_id text not null,
  machine_key text not null,
  lane_id text not null,
  instance_id text,
  project_key text,
  sealed text not null,
  changed_count integer not null default 0,
  checked_at integer not null,
  updated_at integer not null,
  primary key (user_id, machine_key, lane_id)
);
create index if not exists cloud_git_summaries_project on cloud_git_summaries (user_id, project_key);

-- Fork capsules saved before a delete (src/cloud/forkCapsules.ts): sealed
-- parts in R2 under `r2_key`. `committed_at` null while its parts upload.
create table if not exists cloud_fork_capsules (
  user_id text not null,
  machine_key text not null,
  chat_id text not null,
  instance_id text,
  lane_id text,
  provider text,
  transport_kind text,
  -- 'chat' or 'cli'.
  session_kind text,
  parts integer not null default 0,
  bytes integer not null default 0,
  r2_key text not null,
  committed_at integer,
  created_at integer not null,
  updated_at integer not null,
  primary key (user_id, machine_key, chat_id)
);
create index if not exists cloud_fork_capsules_lane on cloud_fork_capsules (user_id, machine_key, lane_id);

-- The ADE version and features each computer last reported at brain start
-- (`POST .../booted`). `ade_features` is a comma list of
-- `CLOUD_COMPUTER_FEATURES`, null for an image that sends none: the queue
-- answers `update_needed` for a computer without `chat_queue`, and the
-- client wakes it and sends.
alter table cloud_computers add column ade_version text;
alter table cloud_computers add column ade_version_at integer;
alter table cloud_computers add column ade_features text;

-- Launches that continue an existing chat: one per (lane, chat).
alter table cloud_launches add column continue_machine_key text;
alter table cloud_launches add column continue_chat_id text;
create unique index if not exists cloud_launches_continue on cloud_launches (user_id, lane_id, continue_chat_id)
  where continue_chat_id is not null and state not in ('failed', 'cancelled', 'done');

-- The account lane index of every machine (src/accountLanes/): only names,
-- branches and PR numbers, for places that mention a lane. Plain text, like
-- `account_project_copies.root_path`.
create table if not exists account_lane_index (
  user_id text not null,
  machine_key text not null,
  lane_id text not null,
  project_id text,
  project_key text,
  name text not null,
  branch text,
  pr_number integer,
  is_primary integer not null default 0,
  updated_at integer not null,
  primary key (user_id, machine_key, lane_id)
);
create index if not exists account_lane_index_project on account_lane_index (user_id, project_id);
create index if not exists account_lane_index_project_key on account_lane_index (user_id, project_key);
create index if not exists account_lane_index_pr on account_lane_index (user_id, project_key, pr_number);

-- The hash of each machine's last published set: the same hash writes nothing.
create table if not exists account_lane_index_state (
  user_id text not null,
  machine_key text not null,
  hash text not null,
  lane_count integer not null default 0,
  updated_at integer not null,
  primary key (user_id, machine_key)
);
