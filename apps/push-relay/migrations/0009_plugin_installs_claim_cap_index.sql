-- The daily claim-cap check in handlePluginInstall runs on every NEW plugin
-- install ping:
--
--   select count(*) from plugin_installs where machine_key = ? and first_seen_at >= ?
--
-- Neither existing index serves it: the primary key is (plugin_id, machine_key)
-- — plugin-first, so it cannot narrow by machine_key alone without a scan of
-- every plugin — and idx_plugin_installs_updated is keyed on updated_at, a
-- different column entirely. Without this, the cap check that exists
-- specifically to bound one machine's write volume is itself a full-table
-- scan on every insert, growing with total installs across every plugin and
-- every machine on the account, not just this machine's own rows.
create index if not exists idx_plugin_installs_machine_first_seen
  on plugin_installs(machine_key, first_seen_at);
