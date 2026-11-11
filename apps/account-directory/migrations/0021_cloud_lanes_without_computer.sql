-- Lanes whose ADE Cloud computer is gone while the lane stays
-- (src/cloud/lanesWithoutComputer.ts). Additive only: apply this migration
-- first, then deploy the Worker.
--
-- A row comes to exist when a person frees a lane's computer ("Keep the lane
-- on a fresh computer") or the 30-day rule removes it. It goes when a new
-- computer is made for the same lane id, or the person deletes the lane.
create table if not exists cloud_lanes_without_computer (
  user_id text not null,
  lane_id text not null,
  lane_name text not null,
  project_origin text,
  branch_ref text,
  -- 'freed' or 'inactive'.
  reason text not null,
  -- The old computer's size: 'default' or 'vm', with its CPU and memory.
  type text not null,
  cpu integer not null,
  memory_gb integer not null,
  former_instance_id text not null,
  former_machine_key text,
  created_at integer not null,
  primary key (user_id, lane_id)
);
