import type { ProjectPathInspection } from "../../../shared/types";

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

  // Every git worktree is a lane, so there is nothing to attach — but the row
  // is created by the reconcile inside `lanes.list`, and nothing else triggers
  // it. `project.inspectPath` only reads the parent project's database from
  // disk, so without this call it can look before the row exists. The reconcile
  // runs ahead of the lane-list cache check, so a cache hit still adopts, and
  // `includeStatus: false` skips per-lane git status for a cheap round trip.
  // It targets the bound runtime, hence after the switch.
  await deps.switchProjectToPath(parent.rootPath, { skipWorktreeGate: true });
  await window.ade.lanes.list({ includeStatus: false });

  const fresh = await window.ade.project.inspectPath(worktreeRoot, { fresh: true });
  const laneId = fresh.parent?.existingLane?.id;
  if (!laneId) {
    // A lane wraps a branch, so a detached-HEAD worktree is the one case that
    // predictably has no lane. Name it rather than reporting a generic miss.
    throw new Error(
      inspection.branchRef?.trim()
        ? "ADE could not open this worktree as a lane. Open its owning project and check the Lanes tab."
        : "This worktree has a detached HEAD, so it can't be opened as a lane. Check out a branch in it, or open it as a separate project.",
    );
  }
  await deps.navigate(`/lanes?laneId=${laneId}&focus=single`);
}
