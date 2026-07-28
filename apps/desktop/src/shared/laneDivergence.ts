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
 *
 * Deliberately built on `ahead`, not on head commits: no lane record in ADE
 * carries a head sha, so a rule that required one could never fire.
 */

export type MachineBranchState = {
  machineId: string;
  /**
   * Absolute machine name as shown to the user ("This Mac", "MacBook Pro (97)").
   * Never a relative word like "remote" — the user has to know *which* machine.
   */
  machineName: string;
  branchRef: string;
  /**
   * `null` when the machine's head commit is not known — which is the normal
   * case today, because no lane record in ADE carries a head sha. A known sha
   * only ever *silences* the guard (two machines sitting on the same commit
   * cannot strand each other); it is never required to raise one.
   */
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
 *
 * `headSha` is a separate, optional argument rather than a field read off the
 * lane, because no lane record carries one: `LaneSummary`, `LaneListSnapshot`,
 * and `lane_state_snapshots` all stop at `branchRef` + `dirty/ahead/behind`.
 * Reading a `lane.headSha` that does not exist is exactly what made this guard
 * unable to fire — every candidate came out with a null head and was skipped.
 * The guard therefore grounds itself in `ahead`, which every one of those
 * records really does have.
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
    headSha: args.headSha ?? null,
    ahead: safeCount(args.lane.status?.ahead),
    behind: safeCount(args.lane.status?.behind),
  };
}

/**
 * Returns a warning only when pushing can strand commits on another machine.
 *
 * The evidence is `ahead` — commits that machine holds which are *not* on the
 * branch's upstream. If another machine holds the same branch with `ahead > 0`,
 * those commits are by definition not in what you are about to push (you cannot
 * have someone else's unpushed commits), so moving the upstream tip makes their
 * copy diverge. That is the whole rule, and it is grounded in a field every
 * lane record actually has.
 *
 * Head shas are used only to *silence*: two machines proven to sit on the same
 * commit cannot strand each other. An unknown head is the normal case and never
 * suppresses a warning — this guards a destructive push, so the false-negative
 * direction is the expensive one.
 *
 * Stays silent when:
 * - no other machine holds the branch (the common path — short-circuits first),
 * - the current branch ref is empty (nothing to compare),
 * - the entry is this machine itself (ids are compared, never names),
 * - the other machine is on a different branch,
 * - the other machine is proven to sit at the same commit,
 * - the other machine has no unpushed commits (`ahead === 0`) — the push
 *   fast-forwards it, whether it is level or strictly behind.
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
  const currentHeadSha = current.headSha?.trim() || null;

  let worst: MachineBranchState | null = null;
  let worstAhead = 0;

  for (const other of others) {
    if (!other) continue;
    if (other.machineId === current.machineId) continue;
    if (normalizeBranchRef(other.branchRef) !== currentBranch) continue;

    const otherHeadSha = other.headSha?.trim() || null;
    // Same commit, proven: nothing to strand.
    if (currentHeadSha && otherHeadSha && otherHeadSha === currentHeadSha) continue;

    // No unpushed commits there: the push fast-forwards that machine.
    const otherAhead = safeCount(other.ahead);
    if (otherAhead === 0) continue;

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
