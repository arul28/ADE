import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AgentChatSessionSummary } from "../../../desktop/src/shared/types/chat";
import type { LaneSummary } from "../../../desktop/src/shared/types/lanes";
import type { ProjectLaunchContext } from "./types";

function normalizeRoot(value: string): string {
  return path.resolve(value);
}

function findGitRoot(cwd: string): string | null {
  try {
    const stdout = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const root = stdout.trim();
    return root ? path.resolve(root) : null;
  } catch {
    return null;
  }
}

function findAdeWorktreeContext(cwd: string): Pick<ProjectLaunchContext, "projectRoot" | "workspaceRoot" | "laneHint"> | null {
  const resolved = path.resolve(cwd);
  const parts = resolved.split(path.sep);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i] !== ".ade" || parts[i + 1] !== "worktrees" || !parts[i + 2]) continue;
    const rootParts = parts.slice(0, i);
    const projectRoot = rootParts.length === 0 ? path.sep : rootParts.join(path.sep);
    const laneHint = parts[i + 2] ?? null;
    const workspaceRoot = findGitRoot(resolved) ?? path.join(projectRoot, ".ade", "worktrees", laneHint ?? "");
    return {
      projectRoot: normalizeRoot(projectRoot),
      workspaceRoot: normalizeRoot(workspaceRoot),
      laneHint,
    };
  }
  return null;
}

export function detectProjectLaunchContext(args: {
  cwd?: string;
  projectRoot?: string | null;
  workspaceRoot?: string | null;
} = {}): ProjectLaunchContext {
  const launchCwd = normalizeRoot(args.cwd ?? process.cwd());
  const explicitProjectRoot = args.projectRoot?.trim();
  const explicitWorkspaceRoot = args.workspaceRoot?.trim();
  const worktree = findAdeWorktreeContext(launchCwd);
  const gitRoot = findGitRoot(launchCwd);

  const projectRoot = normalizeRoot(
    explicitProjectRoot
      ?? worktree?.projectRoot
      ?? gitRoot
      ?? launchCwd,
  );
  const workspaceRoot = normalizeRoot(
    explicitWorkspaceRoot
      ?? worktree?.workspaceRoot
      ?? gitRoot
      ?? projectRoot,
  );

  if (!fs.existsSync(projectRoot)) {
    throw new Error(`Project root does not exist: ${projectRoot}`);
  }
  if (!fs.existsSync(workspaceRoot)) {
    throw new Error(`Workspace root does not exist: ${workspaceRoot}`);
  }

  return {
    launchCwd,
    projectRoot,
    workspaceRoot,
    laneHint: worktree?.laneHint ?? null,
  };
}

export function chooseInitialLane(
  lanes: LaneSummary[],
  context: Pick<ProjectLaunchContext, "workspaceRoot" | "laneHint">,
): LaneSummary | null {
  if (!lanes.length) return null;
  const hint = context.laneHint?.trim();
  if (hint) {
    const byHint = lanes.find((lane) => (
      lane.id === hint
      || lane.name === hint
      || lane.branchRef === hint
      || path.basename(lane.worktreePath) === hint
    ));
    if (byHint) return byHint;
  }

  const workspaceRoot = normalizeRoot(context.workspaceRoot);
  const byPath = [...lanes]
    .sort((left, right) => normalizeRoot(right.worktreePath).length - normalizeRoot(left.worktreePath).length)
    .find((lane) => {
      const worktreePath = normalizeRoot(lane.worktreePath);
      const attachedRootPath = lane.attachedRootPath ? normalizeRoot(lane.attachedRootPath) : null;
      return (
        workspaceRoot === worktreePath
        || workspaceRoot.startsWith(`${worktreePath}${path.sep}`)
        || (attachedRootPath !== null
          && (workspaceRoot === attachedRootPath || workspaceRoot.startsWith(`${attachedRootPath}${path.sep}`)))
      );
    });
  if (byPath) return byPath;

  return lanes.find((lane) => lane.laneType === "primary") ?? lanes[0] ?? null;
}

export function isWorkspaceInsideLane(lane: LaneSummary | null | undefined, workspaceRoot: string): boolean {
  if (!lane?.worktreePath) return false;
  const workspace = normalizeRoot(workspaceRoot);
  const worktree = normalizeRoot(lane.worktreePath);
  const attached = lane.attachedRootPath ? normalizeRoot(lane.attachedRootPath) : null;
  return (
    workspace === worktree
    || workspace.startsWith(`${worktree}${path.sep}`)
    || (attached !== null && (workspace === attached || workspace.startsWith(`${attached}${path.sep}`)))
  );
}

export function chooseTuiLaunchLane(
  lanes: LaneSummary[],
  context: Pick<ProjectLaunchContext, "workspaceRoot" | "laneHint">,
  lastLaneId: string | null,
): LaneSummary | null {
  const contextLane = chooseInitialLane(lanes, context);
  const contextLaneIsExplicit = Boolean(context.laneHint)
    || (contextLane?.laneType !== "primary" && isWorkspaceInsideLane(contextLane, context.workspaceRoot));
  if (contextLaneIsExplicit && contextLane) return contextLane;
  const persistedLane = lastLaneId ? lanes.find((lane) => lane.id === lastLaneId) ?? null : null;
  return persistedLane ?? contextLane;
}

export function chooseMostRecentSessionLane(
  lanes: LaneSummary[],
  sessions: AgentChatSessionSummary[],
): LaneSummary | null {
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const newest = newestChatSession(sessions.filter((session) => laneIds.has(session.laneId)));
  return newest ? lanes.find((lane) => lane.id === newest.laneId) ?? null : null;
}

function newestChatSession(sessions: AgentChatSessionSummary[]): AgentChatSessionSummary | null {
  return [...sessions].sort((left, right) => {
    const rightMs = Date.parse(right.lastActivityAt ?? right.startedAt);
    const leftMs = Date.parse(left.lastActivityAt ?? left.startedAt);
    return (Number.isFinite(rightMs) ? rightMs : 0) - (Number.isFinite(leftMs) ? leftMs : 0);
  })[0] ?? null;
}

export function resolveTuiChatRefreshTarget(args: {
  lanes: LaneSummary[];
  sessions: AgentChatSessionSummary[];
  context: Pick<ProjectLaunchContext, "workspaceRoot" | "laneHint">;
  lastLaneId: string | null;
  activeLaneId: string | null;
  activeSessionId: string | null;
  draftChatActive: boolean;
  initialNewChatPreview: boolean;
  newChatPreviewLaneId: string | null;
  selectedDrawerChatAction: "new-chat" | null;
  drawerLaneId: string | null;
}): {
  lane: LaneSummary | null;
  laneId: string | null;
  session: AgentChatSessionSummary | null;
  seedSession: AgentChatSessionSummary | null;
  launchToNewChatPreview: boolean;
  previewMode: boolean;
} {
  const launchToNewChatPreview = args.initialNewChatPreview
    && args.activeSessionId == null
    && !args.draftChatActive;
  const socketRecentLane = launchToNewChatPreview
    ? chooseMostRecentSessionLane(args.lanes, args.sessions)
    : null;
  const previewLane = args.newChatPreviewLaneId
    ? args.lanes.find((lane) => lane.id === args.newChatPreviewLaneId) ?? null
    : null;
  const activeLane = args.lanes.find((entry) => entry.id === args.activeLaneId) ?? null;
  const contextLaunchLane = chooseTuiLaunchLane(args.lanes, args.context, args.lastLaneId);
  const fallbackLane = activeLane
    ?? socketRecentLane
    ?? previewLane
    ?? contextLaunchLane;
  const lane = launchToNewChatPreview
    ? socketRecentLane ?? activeLane ?? previewLane ?? contextLaunchLane
    : fallbackLane;
  const laneId = lane?.id ?? null;
  const laneSessions = args.sessions.filter((session) => session.laneId === laneId);
  const keepNewChatPreview = !args.draftChatActive
    && (args.drawerLaneId ?? laneId) === laneId
    && args.activeSessionId == null
    && (
      args.newChatPreviewLaneId === laneId
      || args.selectedDrawerChatAction === "new-chat"
    );
  const previewMode = launchToNewChatPreview || keepNewChatPreview;
  const seedSession = args.draftChatActive || previewMode ? newestChatSession(laneSessions) : null;
  const session = args.draftChatActive || previewMode
    ? null
    : args.sessions.find((entry) => entry.sessionId === args.activeSessionId)
      ?? newestChatSession(laneSessions);
  return {
    lane,
    laneId,
    session,
    seedSession,
    launchToNewChatPreview,
    previewMode,
  };
}
