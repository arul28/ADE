-- Recent use (`recentUsedMilli`, src/cloud/diskUsage.ts) reads one account's
-- days. This table's keys start at instance_id, so the day index walked every
-- account's rows in the window and tested user_id once per row.
create index if not exists idx_cloud_computer_days_user on cloud_computer_days (user_id, day);
