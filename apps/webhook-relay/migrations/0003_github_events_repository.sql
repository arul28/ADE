create index if not exists idx_github_events_repository_received
  on github_events(repository_full_name collate nocase, received_at desc, event_id desc);
