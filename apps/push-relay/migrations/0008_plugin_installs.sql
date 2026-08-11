-- Install counts for the plugin directory.
--
-- The Marketplace sorts by installs, and the only place that number can be
-- counted is where installs are reported. This table is deliberately the
-- smallest thing that can produce it: one row per (plugin, machine), so a
-- machine that reinstalls, upgrades, or retries a ping cannot inflate its own
-- contribution, and `count(*) group by plugin_id` is the whole aggregate.
--
-- What is NOT here is the point. No project, no user, no account, no repository,
-- no timestamps beyond first-seen and last-seen — nothing that would turn an
-- install count into a usage log. `machine_key` is already the relay's identity
-- for a machine (it is the key every signed route authenticates), so this adds
-- no identifier that did not already exist, and it never leaves the database:
-- the public read endpoint returns per-plugin totals only.
create table if not exists plugin_installs (
  plugin_id text not null,
  machine_key text not null,
  version text not null,
  first_seen_at text not null,
  updated_at text not null,
  primary key (plugin_id, machine_key)
);

-- Retention prune scans by recency. The (plugin_id, machine_key) primary key
-- already covers the aggregate read, so that direction needs no index of its own.
create index if not exists idx_plugin_installs_updated
  on plugin_installs(updated_at);
