-- Automations whose home is ADE Cloud (C9): src/cloud/automations.ts.
-- Additive only: apply this migration first, then deploy the Worker.
--
-- One row per rule the account homed on ADE Cloud. The brain that saved the
-- cloud home registers it (`PUT /cloud/automations/:ruleId`) with a compiled
-- run spec; the server watches its trigger (a schedule in the minute cron, a
-- custom webhook forwarded by the webhook relay, or Run now) and starts each
-- run through the server launcher (`cloud_launches`).
create table if not exists cloud_automations (
  user_id text not null,
  rule_id text not null,
  -- 0: the rule is disabled, or paused by the storm stop (`paused_reason`).
  enabled integer not null default 1,
  -- 'github.com/owner/repo', as the launcher keeps it.
  project_origin text not null,
  name text not null,
  -- The compiled run spec (CloudAutomationSpec), JSON. Holds no secret.
  spec_json text not null,
  -- The account row's own time for the rule and its home: a registration
  -- older than the stored one is ignored, so a brain that hasn't synced
  -- can't put back an older rule.
  rule_version text not null,
  -- A digest of the spec: a registration with the same one writes nothing.
  spec_digest text not null,
  -- The schedule, when the rule has one: a 5-field cron in `timezone` (IANA).
  cron text,
  timezone text,
  -- The next fire time in UTC ms; null without a schedule.
  next_fire_at integer,
  -- No triggered run before this (a home that moved here from a computer
  -- waits out that computer's lease).
  starts_at integer not null default 0,
  -- The custom webhook the relay forwards here, and the random salt of its
  -- signing key (the key itself is derived, never stored here).
  hook_id text,
  hook_salt text,
  -- What the account's vault said when the rule was registered (read with the
  -- registering brain's own token): the agent limits, JSON, and whether a
  -- git-capable credential follows the account (1, 0, null for unknown).
  limits_json text,
  git_ok integer,
  -- 'public', 'private' or null (unknown), from GitHub's API without a token.
  repo_visibility text,
  -- The storm stop: most runs started in an hour.
  max_runs_per_hour integer not null default 6,
  -- 1: a run's computer stays after the run (default: freed, the lane kept).
  keep_computer integer not null default 0,
  paused_reason text,
  paused_at integer,
  -- The last email about this rule (at most one a day; the push goes every time).
  emailed_at integer,
  created_at integer not null,
  updated_at integer not null,
  primary key (user_id, rule_id)
);

-- The minute cron's one read: rules whose schedule is due.
create index if not exists idx_cloud_automations_due
  on cloud_automations(next_fire_at) where enabled = 1 and next_fire_at is not null;
-- The relay's forward names its hook. Unique per account only: the hook id is
-- in a public URL, so another account registering it first must not be able
-- to lock the owner out. A delivery finds its row by hook, rule and the
-- signature, whose key is derived with the account's own id.
create unique index if not exists idx_cloud_automations_hook
  on cloud_automations(user_id, hook_id) where hook_id is not null;
create index if not exists idx_cloud_automations_hook_rule
  on cloud_automations(hook_id, rule_id) where hook_id is not null;

-- One row per trigger the server saw for a cloud rule: a run, a queued run,
-- or a skipped one. The run id is the launch id.
create table if not exists cloud_automation_runs (
  run_id text primary key,
  user_id text not null,
  rule_id text not null,
  -- 'schedule', 'webhook' or 'manual'.
  trigger_kind text not null,
  trigger_summary text,
  -- The trigger's facts a queued run starts with (a webhook's body), JSON.
  trigger_json text,
  -- A webhook delivery's id: the relay retries until a 2xx, so a repeat is one run.
  delivery_id text,
  -- 'queued', 'starting', 'running', 'finishing', 'done', 'failed', 'skipped'.
  state text not null,
  reason text,
  -- While `finishing`: how the run itself ended, 'done' or 'failed'.
  outcome text,
  lane_id text,
  instance_id text,
  -- What happened to the run's computer: 'freed', 'kept' (with why in `reason`), or null.
  computer text,
  -- While `finishing`: when a tick took it (a claim older than 20 minutes was lost).
  claimed_at integer,
  -- While `queued`: not started before this (UTC ms); a delivery that came
  -- while the rule was moving here from a computer waits out that handover.
  -- Once it leaves the queue: when it started trying to start.
  not_before integer,
  started_at integer,
  ended_at integer,
  created_at integer not null,
  updated_at integer not null
);

create index if not exists idx_cloud_automation_runs_rule
  on cloud_automation_runs(user_id, rule_id, created_at);
-- The cron's other half: runs that still need the server (the same one read).
create index if not exists idx_cloud_automation_runs_open
  on cloud_automation_runs(updated_at) where state in ('queued', 'starting', 'running', 'finishing');
create unique index if not exists idx_cloud_automation_runs_delivery
  on cloud_automation_runs(user_id, rule_id, delivery_id) where delivery_id is not null;
