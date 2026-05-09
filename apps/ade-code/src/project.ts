import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { LaneSummary } from "../../desktop/src/shared/types/lanes";
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
