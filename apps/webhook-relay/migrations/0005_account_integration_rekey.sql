alter table github_app_repositories add column account_id text;
alter table github_events add column account_id text;
alter table linear_organizations add column account_id text;
alter table linear_events add column account_id text;

create index if not exists idx_github_app_repositories_account
  on github_app_repositories(account_id, repository_key);

create index if not exists idx_github_events_account_repository_received
  on github_events(account_id, repository_full_name collate nocase, received_at desc, event_id desc);

create index if not exists idx_linear_organizations_account
  on linear_organizations(account_id, org_id);

create index if not exists idx_linear_events_account_org_received
  on linear_events(account_id, org_id, received_at desc, event_id desc);
