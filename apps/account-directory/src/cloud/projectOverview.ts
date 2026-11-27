import {
  CLOUD_OVERVIEW_MAX_LANES,
  type CloudComputerState,
  type CloudComputerTruth,
  type CloudLaneOverview,
  type CloudProjectOverview,
} from "./contract";
import { listSavedChats } from "./chats";
import { laneWorkOfRow, lastActiveAtOf } from "./diskUsage";
import { countsOf, listGitSummaries } from "./gitSummaries";
import { fail, json } from "./http";
import { githubOriginOf } from "./launches";
import { userKeys } from "./seal";
import { listSessionRows } from "./sessionCopies";
import type { CloudEnv, ComputerRow } from "./store";

/**
 * `GET /cloud/projects/overview?origin=`: one project's whole ADE Cloud view
 * with no computer awake, for the web, the phone and a desktop with no
 * computer. One fixed set of indexed reads (computers, lanes without a
 * computer, the first page of chats, sessions and Git summaries); no
 * provider call and no call per row, so it never wakes anything and costs
 * the same for one lane or two hundred. A computer's state comes from the
 * server's own row, the truth every client reads.
 */

const OVERVIEW_CHATS = 50;
const OVERVIEW_SESSIONS = 100;

/** A computer's state from its own row. A delete the idle cleanup claimed outranks the status. */
export function computerStateOf(computer: Pick<ComputerRow, "status" | "idle_deleting_at">): CloudComputerState {
  if (computer.idle_deleting_at != null) return "deleting";
  switch (computer.status) {
    case "running":
    case "restarting":
      return "awake";
    case "waking":
    case "starting":
    case "provisioning":
      return "waking";
    case "updating":
      return "updating";
    case "sleeping":
      return "asleep";
    default:
      return "stopped";
  }
}

export function computerTruthOf(computer: ComputerRow): CloudComputerTruth {
  return {
    instanceId: computer.instance_id,
    machineKey: computer.machine_key,
    laneId: computer.lane_id ?? null,
    state: computerStateOf(computer),
    stateAt: computer.status_changed_at,
    idleSaving: computer.idle_claimed_at != null,
    lastActiveAt: lastActiveAtOf(computer),
  };
}

/** The project identity every saved row uses (`github.com/owner/repo`, lower case). */
function projectKeyOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return githubOriginOf(raw) ?? (raw.trim().toLowerCase() || null);
}

type LaneKeptRow = {
  lane_id: string;
  lane_name: string;
  project_origin: string | null;
  branch_ref: string | null;
  reason: string;
  former_instance_id: string;
  former_machine_key: string | null;
  created_at: number;
};

export async function handleProjectOverview(url: URL, env: CloudEnv, userId: string, now: number): Promise<Response> {
  const origin = projectKeyOf(url.searchParams.get("origin"));
  if (!origin) return fail("bad_request", "Name the project's repository as `origin`.", 400);
  const keys = await userKeys(env, userId, now);
  if (!keys) return fail("unavailable", "Daex Cloud can't read this project right now. Try again soon.", 503);

  // Both lists are the account's own, indexed by user (`idx_cloud_computers_user`) and bounded.
  const [computers, kept, chats, sessions, git] = await Promise.all([
    env.DB.prepare("select * from cloud_computers where user_id = ? and deleted_at is null order by created_at desc limit 500").bind(userId).all<ComputerRow>(),
    env.DB.prepare("select * from cloud_lanes_without_computer where user_id = ? order by created_at desc limit 500").bind(userId).all<LaneKeptRow>(),
    listSavedChats(env, keys, userId, { project: origin, limit: OVERVIEW_CHATS }),
    listSessionRows(env, keys, userId, { project: origin, limit: OVERVIEW_SESSIONS }),
    listGitSummaries(env, keys, userId, origin),
  ]);

  const lanes: CloudLaneOverview[] = [];
  const seen = new Set<string>();
  for (const computer of computers.results ?? []) {
    if (!computer.lane_id || projectKeyOf(computer.lane_project_origin) !== origin || seen.has(computer.lane_id)) continue;
    seen.add(computer.lane_id);
    lanes.push({
      laneId: computer.lane_id,
      laneName: computer.lane_name ?? null,
      branch: computer.lane_branch ?? null,
      machineKey: computer.machine_key,
      computer: computerTruthOf(computer),
      withoutComputer: null,
      prState: laneWorkOfRow(computer)?.prState ?? null,
    });
  }
  for (const lane of kept.results ?? []) {
    if (projectKeyOf(lane.project_origin) !== origin || seen.has(lane.lane_id)) continue;
    seen.add(lane.lane_id);
    lanes.push({
      laneId: lane.lane_id,
      laneName: lane.lane_name,
      branch: lane.branch_ref,
      machineKey: lane.former_machine_key,
      computer: null,
      withoutComputer: {
        reason: lane.reason === "inactive" || lane.reason === "idle_cleanup" || lane.reason === "plan_limit" ? lane.reason : "freed",
        since: lane.created_at,
        formerInstanceId: lane.former_instance_id,
      },
      prState: null,
    });
  }

  const deletingSoon = (computers.results ?? [])
    .filter((computer) => computer.idle_warned_at != null && computer.idle_deletes_at != null && projectKeyOf(computer.lane_project_origin) === origin)
    .map((computer) => ({ instanceId: computer.instance_id, laneId: computer.lane_id ?? null, deletesAt: computer.idle_deletes_at! }))
    .sort((a, b) => a.deletesAt - b.deletesAt);

  return json({
    origin,
    lanes: lanes.slice(0, CLOUD_OVERVIEW_MAX_LANES),
    truncated: lanes.length > CLOUD_OVERVIEW_MAX_LANES,
    chats: chats.chats,
    nextChatCursor: chats.nextCursor,
    sessions: sessions.sessions,
    git: git.map(countsOf),
    deletingSoon,
    checkedAt: now,
  } satisfies CloudProjectOverview);
}
