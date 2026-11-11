/**
 * Lanes whose ADE Cloud computer is gone while the lane stays (migration
 * 0021). The lane lived on its computer, so with the computer gone only this
 * row says the lane exists: every ADE (desktop, phone, web) reads it here
 * with no wake. The lane's chats stay readable from the saved copy
 * (`chats.ts`), filed under the old computer's machine key.
 *
 * A row comes to exist when a person frees the computer ("Keep the lane on a
 * fresh computer": the desktop pushed the work first) or the 30-day rule
 * removes it. A new computer made for the same lane id ends it; so does the
 * person deleting the lane.
 */

import { CLOUD_LANE_METADATA, CLOUD_PATHS, type CloudLaneWithoutComputer } from "./contract";
import { fail, json } from "./http";
import type { CloudDb, ComputerRow } from "./store";

const LANE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const MAX_TEXT = 300;

type LaneRow = {
  lane_id: string;
  lane_name: string;
  project_origin: string | null;
  branch_ref: string | null;
  reason: string;
  type: string;
  cpu: number;
  memory_gb: number;
  former_instance_id: string;
  former_machine_key: string | null;
  created_at: number;
};

function clip(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, MAX_TEXT) : null;
}

/**
 * The statement that keeps a computer's lane when the computer goes, or null
 * when the computer was made for no lane (its metadata has no lane id and
 * name). `branchRef` from the caller wins over the metadata's: the desktop
 * read it from the lane just now.
 */
export function keepLaneStatement(
  env: CloudDb,
  computer: Pick<ComputerRow, "user_id" | "instance_id" | "machine_key" | "type" | "cpu" | "memory_gb">,
  metadata: Record<string, string> | null | undefined,
  args: { reason: CloudLaneWithoutComputer["reason"]; branchRef?: string | null },
  now: number,
): D1PreparedStatement | null {
  const laneId = clip(metadata?.[CLOUD_LANE_METADATA.laneId]);
  const laneName = clip(metadata?.[CLOUD_LANE_METADATA.laneName]);
  if (!laneId || !LANE_ID.test(laneId) || !laneName) return null;
  const branchRef = clip(args.branchRef) ?? clip(metadata?.[CLOUD_LANE_METADATA.branch]);
  return env.DB.prepare(`
    insert into cloud_lanes_without_computer
      (user_id, lane_id, lane_name, project_origin, branch_ref, reason, type, cpu, memory_gb, former_instance_id, former_machine_key, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (user_id, lane_id) do update set
      lane_name = excluded.lane_name, project_origin = excluded.project_origin,
      branch_ref = coalesce(excluded.branch_ref, cloud_lanes_without_computer.branch_ref),
      reason = excluded.reason, type = excluded.type, cpu = excluded.cpu, memory_gb = excluded.memory_gb,
      former_instance_id = excluded.former_instance_id, former_machine_key = excluded.former_machine_key,
      created_at = excluded.created_at
  `).bind(
    computer.user_id,
    laneId,
    laneName,
    clip(metadata?.[CLOUD_LANE_METADATA.projectOrigin]),
    branchRef,
    args.reason,
    computer.type === "vm" ? "vm" : "default",
    computer.cpu,
    computer.memory_gb,
    computer.instance_id,
    computer.machine_key,
    now,
  );
}

/** A new computer for the lane: the lane has a computer again. */
export async function endLaneWithoutComputer(env: CloudDb, userId: string, metadata: Record<string, string> | null | undefined): Promise<void> {
  const laneId = clip(metadata?.[CLOUD_LANE_METADATA.laneId]);
  if (!laneId) return;
  await env.DB.prepare("delete from cloud_lanes_without_computer where user_id = ? and lane_id = ?").bind(userId, laneId).run();
}

function toLane(row: LaneRow): CloudLaneWithoutComputer {
  return {
    laneId: row.lane_id,
    laneName: row.lane_name,
    projectOrigin: row.project_origin,
    branchRef: row.branch_ref,
    reason: row.reason === "inactive" ? "inactive" : "freed",
    type: row.type === "vm" ? "vm" : "default",
    cpu: row.cpu,
    memoryGb: row.memory_gb,
    formerInstanceId: row.former_instance_id,
    formerMachineKey: row.former_machine_key,
    since: row.created_at,
  };
}

export async function listLanesWithoutComputer(env: CloudDb, userId: string): Promise<CloudLaneWithoutComputer[]> {
  const rows = await env.DB.prepare(
    "select * from cloud_lanes_without_computer where user_id = ? order by created_at desc limit 200",
  ).bind(userId).all<LaneRow>();
  return (rows.results ?? []).map(toLane);
}

/** `GET /cloud/lanes/without-computer` and `DELETE /cloud/lanes/without-computer/:lane`. Needs no provider. */
export async function routeLanesWithoutComputer(request: Request, path: string, env: CloudDb, userId: string): Promise<Response> {
  const rest = path.slice(CLOUD_PATHS.lanesWithoutComputer.length).split("/").filter(Boolean);
  if (rest.length === 0) {
    return request.method === "GET" ? json({ lanes: await listLanesWithoutComputer(env, userId) }) : notFound();
  }
  let laneId = "";
  try {
    laneId = decodeURIComponent(rest[0] ?? "");
  } catch {
    laneId = "";
  }
  if (rest.length !== 1 || !LANE_ID.test(laneId) || request.method !== "DELETE") return notFound();
  const result = await env.DB.prepare("delete from cloud_lanes_without_computer where user_id = ? and lane_id = ?").bind(userId, laneId).run();
  return json({ forgotten: (result.meta?.changes ?? 0) > 0 });
}

function notFound(): Response {
  return fail("not_found", "ADE Cloud has no such lane.", 404);
}
