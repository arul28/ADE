-- The account's project list (src/accountProjects, shapes in
-- src/accountProjects/contract.ts).
--
-- A project is a GitHub repository on one account. Its identity is the GitHub
-- host plus the repository's numeric id (`repo_id`), which GitHub keeps
-- through a rename or a transfer. A machine does not always know that id (no
-- credential, no network, a private repository its credential cannot read),
-- so a project can also be found by an address alone: `repo_key` is exactly
-- what `accountRepoScopeKey` returns on the desktop (`repo:github.com/o/n`).
-- One project has many addresses (`account_project_aliases`), and when the id
-- of an address arrives later and another row already has that id, the two
-- rows merge into the one with the id: the other row keeps its id as a
-- tombstone with `merged_into` set, so a client that holds it can follow it.
--
-- Removing a project keeps its row with `removed_at` set (a tombstone), so a
-- machine that publishes it again does not bring it back. Only an explicit add
-- clears it (`last_explicit_add_at`).
--
-- `change_seq` is the account's change counter (`account_project_state.seq`)
-- at the project's last change, including a change to its aliases or copies.
-- A client reads `?since=<cursor>` and gets every project whose `change_seq`
-- is higher. When old tombstones are purged to keep the account under its
-- limits, `floor_seq` rises, and a client with an older cursor gets the whole
-- list instead of a delta.
create table if not exists account_project_state (
  user_id text primary key,
  seq integer not null default 0,
  floor_seq integer not null default 0,
  updated_at integer not null
);

create table if not exists account_projects (
  id text primary key,
  user_id text not null,
  host text not null,
  repo_id integer,
  repo_key text not null,
  owner text not null,
  name text not null,
  default_branch text,
  added_at integer not null,
  last_explicit_add_at integer,
  removed_at integer,
  merged_into text,
  change_seq integer not null,
  updated_at integer not null
);

-- One live row per repository id. Merged rows step out of it.
create unique index if not exists account_projects_repo_id
  on account_projects(user_id, host, repo_id)
  where repo_id is not null and merged_into is null;

create index if not exists account_projects_user_seq
  on account_projects(user_id, change_seq);

-- One address names one project of an account (many addresses to one project).
create table if not exists account_project_aliases (
  user_id text not null,
  repo_key text not null,
  project_id text not null,
  created_at integer not null,
  primary key (user_id, repo_key)
);

create index if not exists account_project_aliases_project
  on account_project_aliases(project_id);

-- One folder of a project on one machine. `checkout_id` is the machine's
-- registry id of the folder (a hash of its path), so two clones of one
-- repository on one machine are two rows. `root_path` is the owner's own
-- folder path; it is returned only to the same account. At most one row per
-- (user, machine, project) has `is_main = 1`; the Worker keeps that rule.
create table if not exists account_project_copies (
  user_id text not null,
  machine_key text not null,
  checkout_id text not null,
  project_id text not null,
  root_path text not null,
  is_main integer not null default 0,
  last_seen_at integer not null,
  primary key (user_id, machine_key, checkout_id)
);

create index if not exists account_project_copies_project
  on account_project_copies(project_id);
