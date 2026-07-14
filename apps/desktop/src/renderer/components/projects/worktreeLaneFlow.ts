import type { ProjectPathInspection } from "../../../shared/types";
import { parseCodedErrorMessage } from "../../../shared/codedError";

function basename(input: string): string {
  const parts = input.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? input;
}

export function deriveLaneName(inspection: ProjectPathInspection): string {
  const fromBranch = inspection.branchRef?.trim();
  if (fromBranch) return fromBranch;
  return inspection.worktreeRoot ? basename(inspection.worktreeRoot) : "worktree";
}

export async function openWorktreeAsLane(
  inspection: ProjectPathInspection,
  deps: {
    switchProjectToPath: (
      rootPath: string,
      opts?: { skipWorktreeGate?: boolean },
    ) => Promise<unknown>;
    navigate: (path: string) => void | Promise<void>;
  },
): Promise<void> {
  const parent = inspection.parent;
  const worktreeRoot = inspection.worktreeRoot;
  if (!parent || !worktreeRoot) {
    throw new Error("This worktree does not have a resolved owning project.");
  }

  if (parent.existingLane) {
    await deps.switchProjectToPath(parent.rootPath, { skipWorktreeGate: true });
    await deps.navigate(`/lanes?laneId=${parent.existingLane.id}&focus=single`);
    return;
  }

  // A lane wraps a branch. A detached-HEAD worktree has none, so attach would
  // fall back to the owning project's base ref and either collide with the
  // primary lane ("Branch 'main' is already linked") or persist a lane pointing
  // at the wrong branch. Refuse it before switching projects.
  if (!inspection.branchRef?.trim()) {
    throw new Error(
      "This worktree has a detached HEAD, so it can't be added as a lane. Check out a branch in it, or open it as a separate project.",
    );
  }

  await deps.switchProjectToPath(parent.rootPath, { skipWorktreeGate: true });

  let laneId: string | null = null;
  try {
    const lane = await window.ade.lanes.attach({
      name: deriveLaneName(inspection),
      attachedPath: worktreeRoot,
    });
    laneId = lane.id;
  } catch (error) {
    if (parseCodedErrorMessage(error).code !== "lane_already_linked") {
      throw error;
    }

    try {
      const fresh = await window.ade.project.inspectPath(worktreeRoot, {
        fresh: true,
      });
      const existingLaneId = fresh.parent?.existingLane?.id;
      if (existingLaneId) laneId = existingLaneId;
    } catch {
      // Preserve the original attach error when recovery cannot resolve a lane.
    }
    if (!laneId) throw error;
  }
  await deps.navigate(`/lanes?laneId=${laneId}&focus=single`);
}
