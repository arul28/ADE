/**
 * Push-time divergence guard.
 *
 * The same git branch can exist as a lane on more than one machine. ADE does
 * not lock or arbitrate those lanes — two lanes on one branch are just two
 * lanes. There is exactly one moment where work can actually be lost: pushing a
 * branch that another machine also holds at a different commit. This module is
 * the whole decision for that moment.
 *
 * Pure by design: no IPC, no git calls, no React. Callers feed it branch state
 * the renderer already has (`LaneSummary.branchRef` + `LaneStatus.ahead/behind`
 * from `lane_state_snapshots` / `LaneListSnapshot`) and it answers a single
 * question — is this push about to strand commits on another machine?
 */

export type MachineBranchState = {
  machineId: string;
  /**
   * Absolute machine name as shown to the user ("This Mac", "MacBook Pro (97)").
   * Never a relative word like "remote" — the user has to know *which* machine.
   */
  machineName: string;
  branchRef: string;
  /** `null` when the machine's head commit is not known. Never grounds a warning. */
  headSha: string | null;
  /** Commits ahead of the branch's upstream. */
  ahead: number;
  /** Commits behind the branch's upstream. */
  behind: number;
};

export type DivergenceWarning = {
  machineName: string;
  aheadBy: number;
  branchRef: string;
} | null;

/**
 * Minimal shape shared by `LaneSummary` and `LaneListSnapshot["lane"]`, so a
 * caller with either can build a `MachineBranchState` without reshaping first.
 */
export type LaneBranchStateLike = {
  branchRef: string;
  headSha?: string | null;
  status?: { ahead?: number | null; behind?: number | null } | null;
};

const EMPTY_MACHINE_BRANCH_STATES: readonly MachineBranchState[] = Object.freeze([]);

export { EMPTY_MACHINE_BRANCH_STATES };

/** `refs/heads/feature/x`, `feature/x`, and `  feature/x  ` are the same branch. */
function normalizeBranchRef(branchRef: string): string {
  const trimmed = typeof branchRef === "string" ? branchRef.trim() : "";
  if (!trimmed) return "";
  return trimmed.replace(/^refs\/heads\//, "");
}

/** Missing / malformed counters are treated as "no commits", never as evidence. */
function safeCount(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/**
 * Builds a `MachineBranchState` from lane-shaped data the renderer already has.
 * `headSha` is optional because `LaneSummary` does not carry one today — an
 * unknown head simply falls back to the ahead/behind comparison.
 */
export function toMachineBranchState(args: {
  machineId: string;
  machineName: string;
  lane: LaneBranchStateLike;
  headSha?: string | null;
}): MachineBranchState {
  return {
    machineId: args.machineId,
    machineName: args.machineName,
    branchRef: args.lane.branchRef,
    headSha: args.headSha ?? args.lane.headSha ?? null,
    ahead: safeCount(args.lane.status?.ahead),
    behind: safeCount(args.lane.status?.behind),
  };
}

/**
 * Returns a warning only when pushing can strand commits on another machine.
 *
 * Warns when another machine holds the same branch at a different commit and is
 * ahead of what is about to be pushed. Stays silent when:
 * - no other machine holds the branch (the common path — short-circuits first),
 * - the other machine sits at the same commit,
 * - the other machine is strictly behind (the push fast-forwards it),
 * - the other machine's head commit is unknown. An unknown state is not
 *   evidence of divergence, and a false alarm here trains users to click
 *   through the one dialog that matters.
 */
export function detectPushDivergence(args: {
  current: MachineBranchState;
  others: readonly MachineBranchState[];
}): DivergenceWarning {
  const { current, others } = args;
  // Common path: nobody else has this branch. Cost stops here.
  if (!others || others.length === 0) return null;

  const currentBranch = normalizeBranchRef(current.branchRef);
  if (!currentBranch) return null;
  const currentAhead = safeCount(current.ahead);
  const currentHeadSha = current.headSha?.trim() || null;

  let worst: MachineBranchState | null = null;
  let worstAhead = 0;

  for (const other of others) {
    if (!other) continue;
    if (other.machineId === current.machineId) continue;
    if (normalizeBranchRef(other.branchRef) !== currentBranch) continue;

    const otherHeadSha = other.headSha?.trim() || null;
    // Unknown head: no evidence, no interruption.
    if (!otherHeadSha) continue;
    // Same commit: nothing to strand.
    if (currentHeadSha && otherHeadSha === currentHeadSha) continue;

    const otherAhead = safeCount(other.ahead);
    const shaDiffers = currentHeadSha != null && otherHeadSha !== currentHeadSha;
    const aheadOfCurrent = otherAhead > currentAhead;
    // Ahead of us, or holding unpushed commits at a different sha.
    if (!aheadOfCurrent && !(shaDiffers && otherAhead > 0)) continue;

    if (!worst || otherAhead > worstAhead) {
      worst = other;
      worstAhead = otherAhead;
    }
  }

  if (!worst) return null;
  return {
    machineName: worst.machineName,
    aheadBy: worstAhead,
    branchRef: normalizeBranchRef(worst.branchRef),
  };
}

/** Dialog title: names the machine, so the user knows which one to go look at. */
export function formatPushDivergenceTitle(warning: NonNullable<DivergenceWarning>): string {
  return `${warning.machineName} also has this branch`;
}

/** Dialog body: what is true now, and what pushing will do to it. */
export function formatPushDivergenceMessage(warning: NonNullable<DivergenceWarning>): string {
  const commits = warning.aheadBy === 1 ? "1 commit" : `${warning.aheadBy} commits`;
  return `${warning.machineName} is ${commits} ahead of what you are about to push on ${warning.branchRef}. Pushing now makes that machine's copy diverge.`;
}
