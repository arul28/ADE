import fs from "node:fs";
import { getModelById } from "../../../shared/modelRegistry";
import type {
  AgentChatPermissionMode,
  AiPermissionMode,
  LaneSummary,
  RebaseResolutionStartArgs,
  RebaseResolutionStartResult,
} from "../../../shared/types";
import { runGit } from "../git/git";
import type { createLaneService } from "../lanes/laneService";
import type { createAgentChatService } from "../chat/agentChatService";
import type { createSessionService } from "../sessions/sessionService";
import type { createConflictService } from "../conflicts/conflictService";

export type RebaseResolutionLaunchDeps = {
  laneService: Pick<ReturnType<typeof createLaneService>, "list" | "getLaneBaseAndBranch">;
  agentChatService: Pick<ReturnType<typeof createAgentChatService>, "createSession" | "sendMessage">;
  sessionService: Pick<ReturnType<typeof createSessionService>, "updateMeta">;
  conflictService: Pick<ReturnType<typeof createConflictService>, "getRebaseNeed">;
};

function mapPermissionMode(mode: AiPermissionMode | undefined): AgentChatPermissionMode {
  if (mode === "full_edit") return "full-auto";
  if (mode === "read_only") return "plan";
  return "edit";
}

async function readRecentCommits(worktreePath: string, count: number): Promise<Array<{ sha: string; subject: string }>> {
  const result = await runGit(["log", "--format=%H%x09%s", "-n", String(count)], { cwd: worktreePath, timeoutMs: 10_000 });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ...subjectParts] = line.split("\t");
      return { sha: (sha ?? "").trim(), subject: subjectParts.join("\t").trim() };
    })
    .filter((entry) => entry.sha.length > 0 && entry.subject.length > 0);
}

function buildRebaseResolutionPrompt(args: {
  lane: LaneSummary;
  baseBranch: string;
  behindBy: number;
  conflictPredicted: boolean;
  conflictingFiles: string[];
  laneCommits: Array<{ sha: string; subject: string }>;
  baseCommits: Array<{ sha: string; subject: string }>;
}): string {
  const sections: string[] = [
    "You are resolving a rebase conflict inside ADE (Autonomous Development Environment).",
    "A local lane (feature branch) has fallen behind its base branch and needs to be rebased.",
    "",
    "Lane context",
    `- Lane name: ${args.lane.name}`,
    `- Lane branch: ${args.lane.branchRef}`,
    `- Base branch: ${args.baseBranch}`,
    `- Behind by: ${args.behindBy} commit${args.behindBy !== 1 ? "s" : ""}`,
    `- Conflict predicted: ${args.conflictPredicted ? "YES" : "NO"}`,
    `- Worktree: ${args.lane.worktreePath}`,
  ];

  if (args.conflictingFiles.length > 0) {
    sections.push(
      "",
      "Files modified in both branches (likely conflict sources)",
      ...args.conflictingFiles.map((f) => `- ${f}`),
    );
  }

  if (args.baseCommits.length > 0) {
    sections.push(
      "",
      `Recent commits on ${args.baseBranch} (the new upstream commits)`,
      ...args.baseCommits.map((c) => `- ${c.sha.slice(0, 7)} ${c.subject}`),
    );
  }

  if (args.laneCommits.length > 0) {
    sections.push(
      "",
      "Recent commits on this lane",
      ...args.laneCommits.map((c) => `- ${c.sha.slice(0, 7)} ${c.subject}`),
    );
  }

  sections.push(
    "",
    "Goal",
    "Rebase this lane onto the latest base branch, resolving any merge conflicts that arise.",
    "",
    "Instructions",
    "1. Navigate to the lane worktree directory.",
    "2. Fetch the latest changes and perform `git rebase` onto the base branch.",
    "3. If conflicts occur, examine each conflicting file carefully:",
    "   - Understand the intent of both the upstream changes and the lane's changes.",
    "   - Resolve conflicts by preserving the correct behavior from both sides.",
    "   - Do NOT blindly accept one side — merge intelligently.",
    "4. After resolving all conflicts, continue the rebase until complete.",
    "5. Run any relevant tests or type checks to verify the rebase didn't break anything.",
    "6. If the rebase is clean and tests pass, report success.",
    "7. Do NOT push — the user will review and push when ready.",
    "",
    "Requirements",
    "- Use parallel agents when they will materially speed up independent work.",
    "- If you encounter a conflict you cannot resolve confidently, explain the conflict clearly and ask for guidance.",
    "- Watch for regressions — if resolving a conflict changes behavior, verify with tests.",
    "- Be thorough: resolve ALL conflicts, not just the first one.",
  );

  return sections.join("\n");
}

export async function launchRebaseResolutionChat(
  deps: RebaseResolutionLaunchDeps,
  args: RebaseResolutionStartArgs,
): Promise<RebaseResolutionStartResult> {
  const descriptor = getModelById(args.modelId);
  if (!descriptor) {
    throw new Error(`Unknown model '${args.modelId}'.`);
  }

  const lanes = await deps.laneService.list({ includeArchived: false });
  const lane = lanes.find((l) => l.id === args.laneId) ?? null;
  if (!lane) {
    throw new Error(`Lane not found: ${args.laneId}`);
  }
  if (!fs.existsSync(lane.worktreePath)) {
    throw new Error(`Lane worktree is missing on disk: ${lane.worktreePath}`);
  }

  // Get rebase need data
  const rebaseNeed = await deps.conflictService.getRebaseNeed(args.laneId);
  if (!rebaseNeed) {
    throw new Error("No rebase need found for this lane. It may already be up to date.");
  }

  // Get recent commits on both the lane and the parent
  const parentLane = lane.parentLaneId ? lanes.find((l) => l.id === lane.parentLaneId) ?? null : null;
  const [laneCommits, baseCommits] = await Promise.all([
    readRecentCommits(lane.worktreePath, 8),
    parentLane?.worktreePath ? readRecentCommits(parentLane.worktreePath, rebaseNeed.behindBy) : Promise.resolve([]),
  ]);

  const prompt = buildRebaseResolutionPrompt({
    lane,
    baseBranch: rebaseNeed.baseBranch,
    behindBy: rebaseNeed.behindBy,
    conflictPredicted: rebaseNeed.conflictPredicted,
    conflictingFiles: rebaseNeed.conflictingFiles,
    laneCommits,
    baseCommits,
  });

  const title = `Rebase ${lane.name} onto ${rebaseNeed.baseBranch}`;
  const reasoningEffort = args.reasoning?.trim() || undefined;

  const session = await deps.agentChatService.createSession({
    laneId: lane.id,
    provider: "unified",
    model: descriptor.id,
    modelId: descriptor.id,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    permissionMode: mapPermissionMode(args.permissionMode),
    surface: "work",
    sessionProfile: "workflow",
  });

  deps.sessionService.updateMeta({ sessionId: session.id, title });

  await deps.agentChatService.sendMessage({
    sessionId: session.id,
    text: prompt,
    displayText: title,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  });

  return {
    sessionId: session.id,
    laneId: lane.id,
    href: `/work?laneId=${encodeURIComponent(lane.id)}&sessionId=${encodeURIComponent(session.id)}`,
  };
}
