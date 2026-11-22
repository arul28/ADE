-- What uses each computer's disk, and when it last did work (src/cloud/diskUsage.ts).
-- The computer measures itself at its idle step, while awake, at most every
-- few hours, and sends it here; the dashboard reads it with the computer list,
-- so ADE never wakes a computer to show it. Additive only: apply this
-- migration first, then deploy the Worker.

-- JSON: { totalGb, items: [{ kind, label, gb, clearable }] }, kinds in `CLOUD_DISK_USAGE_KINDS`.
alter table cloud_computers add column disk_usage_json text;
-- When that measure was taken (ms).
alter table cloud_computers add column disk_measured_at integer;
-- JSON: { checkedAt, unpushed, prState }, its lane's work as it last read it (`CloudLaneWork`).
alter table cloud_computers add column lane_work_json text;
-- When the computer last did work (a chat turn, a command, a session), as it reported at its idle step (ms).
alter table cloud_computers add column last_active_at integer;
