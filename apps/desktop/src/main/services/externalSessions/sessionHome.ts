import path from "node:path";
import type { ExternalSessionHome, LaneSummary } from "../../../shared/types";
import { pathContains, realishPath } from "./discoveryUtils";
import { pathComparisonKey, pathsEqual } from "../shared/pathCompare";

export type SessionHomeLane = Pick<LaneSummary, "id" | "name" | "branchRef" | "color" | "laneType" | "worktreePath">;

type IndexedLane = { lane: SessionHomeLane; root: string };

export type SessionHomeResolver = (cwd: string | null | undefined) => ExternalSessionHome | null;

const WORKTREES_SEGMENTS = [".ade", "worktrees"];

function startsWithWorktreesSegment(relative: string): boolean {
  const segments = relative.split(/[\\/]+/u).filter(Boolean);
  // Same case rule as the containment check that let this path in: on macOS
  // and Windows `.ADE/WORKTREES` is the same folder as `.ade/worktrees`.
  return WORKTREES_SEGMENTS.every((segment, index) =>
    segments[index] != null && pathComparisonKey(segments[index]) === pathComparisonKey(segment));
}

/**
 * Maps a provider-recorded folder to the lane that owns it.
 *
 * The primary lane's worktree is the project root, which also contains every
 * other lane under `.ade/worktrees/`. A folder under `.ade/worktrees/` that no
 * live lane claims is a removed lane, not the primary lane, so the deepest
 * match wins and a primary-lane match through `.ade/worktrees/` is rejected.
 */
export function createSessionHomeResolver(lanes: readonly SessionHomeLane[]): SessionHomeResolver {
  const indexed: IndexedLane[] = lanes
    .filter((lane) => lane.worktreePath?.trim())
    .map((lane) => ({ lane, root: realishPath(lane.worktreePath) }))
    .sort((left, right) => right.root.length - left.root.length);
  const memo = new Map<string, ExternalSessionHome | null>();

  return (cwd) => {
    const clean = cwd?.trim();
    if (!clean) return null;
    const cached = memo.get(clean);
    if (cached !== undefined) return cached;
    const resolved = realishPath(clean);
    let home: ExternalSessionHome = {
      kind: "outside",
      laneId: null,
      laneName: null,
      branchRef: null,
      color: null,
      laneType: null,
      atLaneRoot: false,
    };
    for (const { lane, root } of indexed) {
      if (!pathContains(root, resolved)) continue;
      const atLaneRoot = pathsEqual(root, resolved);
      if (!atLaneRoot && startsWithWorktreesSegment(path.relative(root, resolved))) {
        home = { ...home, kind: "removed-lane" };
        break;
      }
      home = {
        kind: "lane",
        laneId: lane.id,
        laneName: lane.name,
        branchRef: lane.branchRef ?? null,
        color: lane.color ?? null,
        laneType: lane.laneType ?? null,
        atLaneRoot,
      };
      break;
    }
    memo.set(clean, home);
    return home;
  };
}
