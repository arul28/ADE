create table if not exists github_app_repositories (
  repository_key text primary key,
  repository_full_name text not null,
  owner text not null,
  name text not null,
  installation_id integer,
  repository_selection text,
  installed integer not null default 1,
  last_seen_at text not null,
  removed_at text,
  source_event text not null
);

create index if not exists idx_github_app_repositories_installation
  on github_app_repositories(installation_id, installed);
