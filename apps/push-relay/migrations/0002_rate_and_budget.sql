-- Generic fixed-window counter table backing two controls:
--   * per-IP rate limits  (bucket `ip:<ip>` and `claim:<ip>`) — abuse gate on
--     the unauthenticated /claim write path and all routes generally;
--   * the global daily spend cap (bucket `budget:<YYYY-MM-DD>`) — a hard
--     ceiling on total requests/day, since Cloudflare has no native billing cap.
-- Rows are ephemeral: rate windows are pruned after minutes, budget rows after
-- a couple of days (see pruneRelayState).
create table if not exists rate_counters (
  bucket text primary key,
  window_start integer not null,
  count integer not null,
  updated_at text not null
);

create index if not exists idx_rate_counters_updated
  on rate_counters(updated_at);
