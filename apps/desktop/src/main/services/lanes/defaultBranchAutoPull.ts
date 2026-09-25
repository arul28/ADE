import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logging/logger";
import { normalizeBranchName } from "../shared/utils";

/**
 * Auto-pull the default (primary) branch so a clean checkout stays current
 * without a manual pull prompt.
 *
 * Ported in spirit from t3code's `VcsAutoPullPolicy` / `projects.auto-pull`
 * (pingdotgg/t3code #9277): the trigger is project startup plus a background
 * refresh, the pull is **fast-forward only**, and every gate below has to pass
 * or the run is a silent no-op. ADE has no opt-in setting for it; the desired
 * outcome is "main stays up to date", so the safety gates carry the risk
 * instead of a toggle.
 *
 * Nothing here mutates anything on its own — `evaluateDefaultBranchAutoPull`
 * is pure, and `createDefaultBranchAutoPullService` drives it through injected
 * git primitives so the decision is testable without a repository.
 */

export type BranchSyncState = {
  hasUpstream: boolean;
  /** Commits HEAD has that the upstream does not. */
  ahead: number;
  /** Commits the upstream has that HEAD does not. */
  behind: number;
};

/**
 * Which side of the fetch a decision is being made.
 *
 * `pre-fetch` cannot judge `behind` — the remote-tracking ref is only as fresh
 * as the last fetch, so a repo that is actually behind reads as up-to-date.
 * The pre-fetch phase therefore judges only the local safety gates, and the
 * `behind`/diverged judgement is deferred until after the fetch.
 */
export type AutoPullPhase = "pre-fetch" | "post-fetch";

export type AutoPullSkipReason =
  | "no-primary-lane"
  | "not-on-default-branch"
  | "detached-head"
  | "dirty-worktree"
  | "git-operation-in-progress"
  | "worktree-locked"
  | "no-upstream"
  | "up-to-date"
  | "diverged"
  | "fetch-failed"
  | "pull-failed";

export type AutoPullDecision =
  | { pull: true; reason: "eligible" }
  | { pull: false; reason: AutoPullSkipReason | "not-evaluated" };

export type AutoPullEligibilityInput = {
  /** The lane is the project's primary checkout. Only it is auto-pulled. */
  isPrimary: boolean;
  /** The live HEAD branch, or null when HEAD is detached. */
  headBranchRef: string | null;
  /** The lane's recorded default branch, e.g. `main`. */
  defaultBranchRef: string;
  /** Tracked changes in the index. Untracked files do not block a fast-forward. */
  staged: number;
  /** Tracked changes in the worktree. */
  unstaged: number;
  /** `rebase` / `merge` / `cherry-pick` / `revert` / `bisect`, or null. */
  inProgressOperation: string | null;
  /** Another operation holds the worktree lease. */
  worktreeLocked: boolean;
  /** Upstream tracked state at the phase's freshness. */
  sync: BranchSyncState;
  phase: AutoPullPhase;
};

function sameBranch(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  return normalizeBranchName(left).trim().toLowerCase() === normalizeBranchName(right).trim().toLowerCase();
}

const NON_BLOCKING_OPS = new Set(["bisect"]);

/**
 * The one decision: may the default branch be pulled, and if not, why not.
 *
 * Order matters — the cheap local gates are checked before the network-shaped
 * ones, and `dirty-worktree` deliberately reads only TRACKED changes. An
 * untracked file is never lost by a fast-forward (git itself refuses if the
 * pull would overwrite one), and treating `node_modules` or a stray scratch
 * file as "dirty" would mean the auto-pull almost never fires.
 */
export function evaluateDefaultBranchAutoPull(input: AutoPullEligibilityInput): AutoPullDecision {
  if (!input.isPrimary) return { pull: false, reason: "no-primary-lane" };
  if (input.inProgressOperation && !NON_BLOCKING_OPS.has(input.inProgressOperation)) {
    return { pull: false, reason: "git-operation-in-progress" };
  }
  if (!input.headBranchRef) return { pull: false, reason: "detached-head" };
  if (!sameBranch(input.headBranchRef, input.defaultBranchRef)) {
    return { pull: false, reason: "not-on-default-branch" };
  }
  if (input.staged > 0 || input.unstaged > 0) return { pull: false, reason: "dirty-worktree" };
  if (input.worktreeLocked) return { pull: false, reason: "worktree-locked" };
  if (!input.sync.hasUpstream) return { pull: false, reason: "no-upstream" };
  if (input.phase === "pre-fetch") return { pull: true, reason: "eligible" };
  // Post-fetch: the remote-tracking ref is fresh, so this is the real answer.
  if (input.sync.ahead > 0 && input.sync.behind > 0) return { pull: false, reason: "diverged" };
  if (input.sync.behind === 0) return { pull: false, reason: "up-to-date" };
  return { pull: true, reason: "eligible" };
}

const IN_PROGRESS_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
];

/** The git operation this worktree is mid-way through, or null when it is idle. */
export function detectInProgressGitOperation(gitDir: string): string | null {
  for (const [marker, label] of IN_PROGRESS_MARKERS) {
    try {
      if (fs.existsSync(path.join(gitDir, marker))) return label;
    } catch {
      // An unreadable git dir is treated as idle; the status read is the gate.
    }
  }
  return null;
}

export type AutoPullPrimaryLane = {
  laneId: string;
  worktreePath: string;
  /** The lane's recorded branch, i.e. the project's default branch. */
  branchRef: string;
};

export type AutoPullWorktreeStatus = {
  staged: number;
  unstaged: number;
  headBranchRef: string | null;
};

export type DefaultBranchAutoPullDeps = {
  logger?: Pick<Logger, "info" | "warn" | "debug"> | null;
  /** The project's primary lane, or null when this project has none yet. */
  getPrimaryLane: () => AutoPullPrimaryLane | null;
  readWorktreeStatus: (worktreePath: string) => Promise<AutoPullWorktreeStatus | null>;
  detectInProgressOperation: (worktreePath: string) => Promise<string | null>;
  isWorktreeLocked: (laneId: string) => boolean;
  readSyncStatus: (laneId: string) => Promise<BranchSyncState>;
  fetch: (laneId: string) => Promise<void>;
  pullFastForward: (laneId: string) => Promise<void>;
  /** How often the background refresh runs. */
  intervalMs?: number;
  /** How long after `start()` the first (startup) run happens. */
  startDelayMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
};

export type AutoPullRunResult = {
  pulled: boolean;
  reason: AutoPullDecision["reason"];
  behind?: number;
};

export type DefaultBranchAutoPullService = {
  /** One decision-and-maybe-pull pass. Never throws. */
  runOnce: () => Promise<AutoPullRunResult>;
  start: () => void;
  stop: () => void;
  isStarted: () => boolean;
};

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_START_DELAY_MS = 20_000;

export function createDefaultBranchAutoPullService(
  deps: DefaultBranchAutoPullDeps,
): DefaultBranchAutoPullService {
  const intervalMs = Math.max(30_000, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  const startDelayMs = Math.max(0, deps.startDelayMs ?? DEFAULT_START_DELAY_MS);
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let started = false;
  let disposed = false;

  const log = (level: "info" | "warn" | "debug", event: string, data: Record<string, unknown>) => {
    deps.logger?.[level]?.(event, data);
  };

  const runOnce = async (): Promise<AutoPullRunResult> => {
    if (running) return { pulled: false, reason: "not-evaluated" };
    running = true;
    try {
      const primary = deps.getPrimaryLane();
      if (!primary) return { pulled: false, reason: "no-primary-lane" };

      const [status, inProgressOperation] = await Promise.all([
        deps.readWorktreeStatus(primary.worktreePath).catch(() => null),
        deps.detectInProgressOperation(primary.worktreePath).catch(() => null),
      ]);
      const worktreeLocked = deps.isWorktreeLocked(primary.laneId);
      const preSync = await deps.readSyncStatus(primary.laneId).catch(() => null);
      if (!preSync) return { pulled: false, reason: "not-evaluated" };

      const preDecision = evaluateDefaultBranchAutoPull({
        isPrimary: true,
        headBranchRef: status?.headBranchRef ?? null,
        defaultBranchRef: primary.branchRef,
        staged: status?.staged ?? 0,
        unstaged: status?.unstaged ?? 0,
        inProgressOperation,
        worktreeLocked,
        sync: preSync,
        phase: "pre-fetch",
      });
      if (!preDecision.pull) {
        log("debug", "git.auto_pull_skipped", { laneId: primary.laneId, reason: preDecision.reason });
        return { pulled: false, reason: preDecision.reason };
      }

      // Offline / auth / no remote: the fetch is where that surfaces. It is a
      // silent skip, never a surfaced error — this runs on a background timer.
      try {
        await deps.fetch(primary.laneId);
      } catch (error) {
        log("debug", "git.auto_pull_fetch_failed", {
          laneId: primary.laneId,
          error: error instanceof Error ? error.message : String(error),
        });
        return { pulled: false, reason: "fetch-failed" };
      }

      const postSync = await deps.readSyncStatus(primary.laneId).catch(() => null);
      if (!postSync) return { pulled: false, reason: "not-evaluated" };
      const postDecision = evaluateDefaultBranchAutoPull({
        isPrimary: true,
        headBranchRef: status?.headBranchRef ?? null,
        defaultBranchRef: primary.branchRef,
        staged: status?.staged ?? 0,
        unstaged: status?.unstaged ?? 0,
        inProgressOperation,
        worktreeLocked,
        sync: postSync,
        phase: "post-fetch",
      });
      if (!postDecision.pull) {
        log("debug", "git.auto_pull_skipped", { laneId: primary.laneId, reason: postDecision.reason });
        return { pulled: false, reason: postDecision.reason, behind: postSync.behind };
      }

      try {
        await deps.pullFastForward(primary.laneId);
      } catch (error) {
        // A race between the status read and the pull, or a remote that moved
        // again, is a warning for the log only.
        log("warn", "git.auto_pull_failed", {
          laneId: primary.laneId,
          behind: postSync.behind,
          error: error instanceof Error ? error.message : String(error),
        });
        return { pulled: false, reason: "pull-failed", behind: postSync.behind };
      }

      log("info", "git.auto_pull_pulled", { laneId: primary.laneId, behind: postSync.behind });
      return { pulled: true, reason: "eligible", behind: postSync.behind };
    } catch (error) {
      log("warn", "git.auto_pull_error", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { pulled: false, reason: "not-evaluated" };
    } finally {
      running = false;
    }
  };

  const schedule = (delayMs: number) => {
    if (disposed) return;
    timer = setTimer(() => {
      timer = null;
      void runOnce().finally(() => {
        if (started && !disposed) schedule(intervalMs);
      });
    }, delayMs);
    // Never let a background poll hold the process open.
    (timer as { unref?: () => void }).unref?.();
  };

  return {
    runOnce,
    start() {
      if (started || disposed) return;
      started = true;
      schedule(startDelayMs);
    },
    stop() {
      started = false;
      if (timer) clearTimer(timer);
      timer = null;
    },
    isStarted() {
      return started;
    },
  };
}
