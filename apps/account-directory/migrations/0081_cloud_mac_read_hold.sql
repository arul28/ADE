-- When a client's read last asked NoMac for this Mac's session (`syncMac` in
-- src/cloud/macProvider.ts): every app's poll on every device reads the same
-- Mac, and only one of them in each 10 s reaches NoMac.
alter table cloud_computers add column mac_read_at integer;
