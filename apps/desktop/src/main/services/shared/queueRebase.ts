import type { AdeDb } from "../state/kvDb";
import { runGit, runGitOrThrow } from "../git/git";
import { normalizeBranchName } from "./utils";

type QueueMembershipRow = {
  group_id: string;
  position: number;
  group_name: string | null;
  target_branch: string | null;
};

type QueueMemberRow = {
  lane_id: string;
  pr_id: string | null;
  position: number;
  pr_state: string | null;
};

type QueueLandingStateRow = {
  entries_json: string | null;
};

type QueueLandingEntryState = {
  prId: string;
  state: string;
};

export type QueueRebaseOverride = {
  comparisonRef: string;
  displayBaseBranch: string;
  groupContext: string;
  baseLabel: string;
  queueGroupId: string;
  queuePosition: number;
};

function parseLandingEntries(raw: string | null | undefined): QueueLandingEntryState[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const prId = typeof (entry as { prId?: unknown }).prId === "string" ? (entry as { prId: string }).prId.trim() : "";
        const state = typeof (entry as { state?: unknown }).state === "string" ? (entry as { state: string }).state.trim() : "";
        if (!prId || !state) return null;
        return { prId, state };
      })
      .filter((entry): entry is QueueLandingEntryState => Boolean(entry));
  } catch {
    return [];
  }
}

function isQueueMemberCompleted(args: { prState: string | null; queueEntryState: string | null }): boolean {
  if (args.queueEntryState === "landed" || args.queueEntryState === "skipped") return true;
  return args.prState === "merged";
}

async function resolveRemoteAwareTargetRef(args: {
  projectRoot: string;
  targetBranch: string;
}): Promise<string> {
  const branch = normalizeBranchName(args.targetBranch).trim();
  if (!branch) return args.targetBranch;
  const remoteTrackingRef = `refs/remotes/origin/${branch}`;
  const remoteCheck = await runGit(
    ["rev-parse", "--verify", remoteTrackingRef],
    { cwd: args.projectRoot, timeoutMs: 10_000 },
  );
  if (remoteCheck.exitCode === 0 && remoteCheck.stdout.trim()) {
    return `origin/${branch}`;
  }
  return branch;
}

export async function resolveQueueRebaseOverride(args: {
  db: AdeDb;
  projectId: string;
  projectRoot: string;
  laneId: string;
}): Promise<QueueRebaseOverride | null> {
  const memberships = args.db.all<QueueMembershipRow>(
    `
      select m.group_id, m.position, g.name as group_name, g.target_branch
      from pr_group_members m
      join pr_groups g on g.id = m.group_id
      where m.lane_id = ?
        and g.project_id = ?
        and g.group_type = 'queue'
      order by g.created_at desc, m.position asc
    `,
    [args.laneId, args.projectId],
  );

  for (const membership of memberships) {
    const targetBranch = normalizeBranchName(String(membership.target_branch ?? "").trim());
    if (!targetBranch) continue;

    const members = args.db.all<QueueMemberRow>(
      `
        select m.lane_id, m.pr_id, m.position, pr.state as pr_state
        from pr_group_members m
        join pr_groups g on g.id = m.group_id
        left join pull_requests pr on pr.id = m.pr_id and pr.project_id = g.project_id
        where m.group_id = ?
          and g.project_id = ?
        order by m.position asc
      `,
      [membership.group_id, args.projectId],
    );
    if (members.length === 0) continue;

    const queueStateRow = args.db.get<QueueLandingStateRow>(
      `
        select entries_json
        from queue_landing_state
        where group_id = ?
          and project_id = ?
        order by started_at desc
        limit 1
      `,
      [membership.group_id, args.projectId],
    );
    const queueEntryStateByPrId = new Map<string, string>();
    for (const entry of parseLandingEntries(queueStateRow?.entries_json ?? null)) {
      queueEntryStateByPrId.set(entry.prId, entry.state);
    }

    // Landed queue members are removed from `pr_group_members`, so preserve their
    // original prefix by looking at the lowest remaining queue position.
    let landedPrefixCount = Math.max(0, Number(members[0]?.position ?? 0));
    for (const member of members) {
      const queueEntryState = member.pr_id ? (queueEntryStateByPrId.get(member.pr_id) ?? null) : null;
      const isCompleted = isQueueMemberCompleted({ prState: member.pr_state, queueEntryState });
      if (isCompleted) {
        landedPrefixCount += 1;
        continue;
      }
      break;
    }

    if (landedPrefixCount === 0) continue;

    const targetMember = members.find((member) => member.lane_id === args.laneId) ?? null;
    if (!targetMember) continue;
    const targetQueueEntryState = targetMember.pr_id ? (queueEntryStateByPrId.get(targetMember.pr_id) ?? null) : null;
    const targetCompleted = isQueueMemberCompleted({
      prState: targetMember.pr_state,
      queueEntryState: targetQueueEntryState,
    });
    if (targetCompleted) continue;

    const comparisonRef = await resolveRemoteAwareTargetRef({
      projectRoot: args.projectRoot,
      targetBranch,
    });
    const groupContext = membership.group_name?.trim() ? membership.group_name.trim() : membership.group_id;
    return {
      comparisonRef,
      displayBaseBranch: targetBranch,
      groupContext,
      baseLabel: `queue target ${targetBranch}`,
      queueGroupId: membership.group_id,
      queuePosition: Number(targetMember.position),
    };
  }

  return null;
}

export async function fetchRemoteTrackingBranch(args: {
  projectRoot: string;
  targetBranch: string | null | undefined;
}): Promise<boolean> {
  const branch = normalizeBranchName(String(args.targetBranch ?? "").trim());
  if (!branch) return false;
  try {
    await runGitOrThrow(
      ["fetch", "--prune", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { cwd: args.projectRoot, timeoutMs: 120_000 },
    );
    return true;
  } catch {
    const fallback = await runGit(["fetch", "--prune", "origin"], {
      cwd: args.projectRoot,
      timeoutMs: 120_000,
    });
    return fallback.exitCode === 0;
  }
}

export async function fetchQueueTargetTrackingBranches(args: {
  db: AdeDb;
  projectId: string;
  projectRoot: string;
}): Promise<void> {
  const rows = args.db.all<{ target_branch: string | null }>(
    `
      select distinct g.target_branch
      from pr_groups g
      where g.project_id = ?
        and g.group_type = 'queue'
        and exists (
          select 1
          from pr_group_members m
          where m.group_id = g.id
        )
    `,
    [args.projectId],
  );

  const branches = new Set<string>();
  for (const row of rows) {
    const branch = normalizeBranchName(String(row.target_branch ?? "").trim());
    if (branch) branches.add(branch);
  }

  for (const branch of branches) {
    await fetchRemoteTrackingBranch({
      projectRoot: args.projectRoot,
      targetBranch: branch,
    }).catch(() => {
      // Best-effort refresh only. Rebase scans can still proceed against the
      // existing local tracking ref if fetch is unavailable.
    });
  }
}
