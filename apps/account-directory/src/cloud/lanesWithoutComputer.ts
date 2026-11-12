/**
 * Lanes whose ADE Cloud computer is gone while the lane stays (migration
 * 0021). The lane lived on its computer, so with the computer gone only this
 * row says the lane exists: every ADE (desktop, phone, web) reads it here
 * with no wake. The lane's chats stay readable from the saved copy
 * (`chats.ts`), filed under the old computer's machine key.
 *
 * A row comes to exist when a person frees the computer ("Keep the lane on a
 * fresh computer": the desktop pushed the work first), the 30-day rule
 * removes it, or a cheaper plan's limits free it (`planCleanup.ts`: the
 * computer pushed the work first). A new computer made for the same lane id ends it; so does the
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

/** The lane a computer holds, as the server keeps it on the computer's row (migration 0021). */
export type CloudLaneFacts = {
  laneId: string | null;
  laneName: string | null;
  projectOrigin: string | null;
  branch: string | null;
};

type LaneColumns = Pick<ComputerRow, "lane_id" | "lane_name" | "lane_project_origin" | "lane_branch">;

/** The lane facts in an instance's metadata; each one null when missing or unreadable. */
export function laneFactsOf(metadata: Record<string, string> | null | undefined): CloudLaneFacts {
  const laneId = clip(metadata?.[CLOUD_LANE_METADATA.laneId]);
  return {
    laneId: laneId && LANE_ID.test(laneId) ? laneId : null,
    laneName: clip(metadata?.[CLOUD_LANE_METADATA.laneName]),
    projectOrigin: clip(metadata?.[CLOUD_LANE_METADATA.projectOrigin]),
    branch: clip(metadata?.[CLOUD_LANE_METADATA.branch]),
  };
}

/** The row's lane facts. */
export function laneFactsOfRow(computer: Partial<LaneColumns>): CloudLaneFacts {
  return {
    laneId: computer.lane_id ?? null,
    laneName: computer.lane_name ?? null,
    projectOrigin: computer.lane_project_origin ?? null,
    branch: computer.lane_branch ?? null,
  };
}

/** `first`'s facts, with `second` filling what `first` lacks. */
export function mergeLaneFacts(first: CloudLaneFacts, second: CloudLaneFacts): CloudLaneFacts {
  return {
    laneId: first.laneId ?? second.laneId,
    laneName: first.laneName ?? second.laneName,
    projectOrigin: first.projectOrigin ?? second.projectOrigin,
    branch: first.branch ?? second.branch,
  };
}

/** Whether the facts name a lane: the row a kept lane needs has an id and a name. */
export const namesLane = (facts: CloudLaneFacts): boolean => facts.laneId != null && facts.laneName != null;

/**
 * Brings the row's lane facts up to what the instance's metadata says, or null
 * when nothing would change. A fact the metadata lacks keeps the row's value
 * (a read that comes back without it never erases what the server knew).
 * Updates `computer` in place.
 */
export function laneFactsStatement(
  env: CloudDb,
  instanceId: string,
  computer: Partial<LaneColumns>,
  metadata: Record<string, string> | null | undefined,
): D1PreparedStatement | null {
  const next = laneFactsOf(metadata);
  const changed = (next.laneId != null && next.laneId !== computer.lane_id)
    || (next.laneName != null && next.laneName !== computer.lane_name)
    || (next.projectOrigin != null && next.projectOrigin !== computer.lane_project_origin)
    || (next.branch != null && next.branch !== computer.lane_branch);
  if (!changed) return null;
  computer.lane_id = next.laneId ?? computer.lane_id ?? null;
  computer.lane_name = next.laneName ?? computer.lane_name ?? null;
  computer.lane_project_origin = next.projectOrigin ?? computer.lane_project_origin ?? null;
  computer.lane_branch = next.branch ?? computer.lane_branch ?? null;
  return env.DB.prepare(`
    update cloud_computers set lane_id = coalesce(?, lane_id), lane_name = coalesce(?, lane_name),
      lane_project_origin = coalesce(?, lane_project_origin), lane_branch = coalesce(?, lane_branch)
    where instance_id = ? and deleted_at is null
  `).bind(next.laneId, next.laneName, next.projectOrigin, next.branch, instanceId);
}

/**
 * Marks the computer's lane to be kept when its row closes, with the facts it
 * keeps (`facts`, already merged from the row and a live read). Written before
 * the provider's delete, so a close after a crash (the tick finding the
 * computer gone) still keeps the lane. Updates `computer` in place.
 */
export function markKeepLaneStatement(
  env: CloudDb,
  computer: Pick<ComputerRow, "instance_id"> & Partial<LaneColumns & Pick<ComputerRow, "lane_keep_reason">>,
  facts: CloudLaneFacts,
  reason: CloudLaneWithoutComputer["reason"],
): D1PreparedStatement {
  computer.lane_id = facts.laneId;
  computer.lane_name = facts.laneName;
  computer.lane_project_origin = facts.projectOrigin;
  computer.lane_branch = facts.branch;
  computer.lane_keep_reason = reason;
  return env.DB.prepare(`
    update cloud_computers set lane_id = ?, lane_name = ?, lane_project_origin = ?, lane_branch = ?, lane_keep_reason = ?
    where instance_id = ? and deleted_at is null
  `).bind(facts.laneId, facts.laneName, facts.projectOrigin, facts.branch, reason, computer.instance_id);
}

/** Takes the mark back after a delete that didn't happen. */
export function unmarkKeepLaneStatement(env: CloudDb, instanceId: string): D1PreparedStatement {
  return env.DB.prepare("update cloud_computers set lane_keep_reason = null where instance_id = ? and deleted_at is null").bind(instanceId);
}

/**
 * The statement that keeps a computer's lane as its row closes, from the row
 * itself: it writes only when the row was marked (`lane_keep_reason`) and
 * names a lane, and no other live computer of the account holds that lane (a
 * move's new computer does: then the lane still has a computer). It must run
 * before the close clears the row's lane facts.
 */
export function keepLaneStatement(env: CloudDb, instanceId: string, now: number): D1PreparedStatement {
  return env.DB.prepare(`
    insert into cloud_lanes_without_computer
      (user_id, lane_id, lane_name, project_origin, branch_ref, reason, type, cpu, memory_gb, former_instance_id, former_machine_key, created_at)
    select c.user_id, c.lane_id, c.lane_name, c.lane_project_origin, c.lane_branch, c.lane_keep_reason,
      case when c.type = 'vm' then 'vm' else 'default' end, c.cpu, c.memory_gb, c.instance_id, c.machine_key, ?
    from cloud_computers c
    where c.instance_id = ? and c.deleted_at is null and c.lane_keep_reason in ('freed', 'inactive', 'plan_limit')
      and c.lane_id is not null and c.lane_name is not null
      and not exists (
        select 1 from cloud_computers o
        where o.user_id = c.user_id and o.lane_id = c.lane_id and o.deleted_at is null and o.instance_id <> c.instance_id
      )
    on conflict (user_id, lane_id) do update set
      lane_name = excluded.lane_name, project_origin = excluded.project_origin,
      branch_ref = coalesce(excluded.branch_ref, cloud_lanes_without_computer.branch_ref),
      reason = excluded.reason, type = excluded.type, cpu = excluded.cpu, memory_gb = excluded.memory_gb,
      former_instance_id = excluded.former_instance_id, former_machine_key = excluded.former_machine_key,
      created_at = excluded.created_at
  `).bind(now, instanceId);
}

/** A computer for the lane again: its row here ends. Null when there is no lane. */
export function endLaneStatement(env: CloudDb, userId: string, laneId: string | null | undefined): D1PreparedStatement | null {
  if (!laneId) return null;
  return env.DB.prepare("delete from cloud_lanes_without_computer where user_id = ? and lane_id = ?").bind(userId, laneId);
}

function toLane(row: LaneRow): CloudLaneWithoutComputer {
  return {
    laneId: row.lane_id,
    laneName: row.lane_name,
    projectOrigin: row.project_origin,
    branchRef: row.branch_ref,
    reason: row.reason === "inactive" || row.reason === "plan_limit" ? row.reason : "freed",
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
