-- Live Activity tokens now expire a day after their last refresh (iOS ends an
-- activity within 12 hours), and each machine keeps at most its newest rows.
-- The sweep reads by `updated_at` alone, so it needs its own index.
create index if not exists idx_live_activity_tokens_updated
  on live_activity_tokens(updated_at);
