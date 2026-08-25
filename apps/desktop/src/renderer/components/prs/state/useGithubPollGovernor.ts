import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyGithubRequestBudget,
  githubPollPeriodMs,
  initialGithubPollGovernorState,
  isGithubPollPaused,
  noteGithubPollFailure,
  noteGithubPollSuccess,
  type GithubPollGovernorState,
} from "./githubPollGovernor";

/**
 * How often the renderer re-reads the runtime's GitHub request budget while the
 * PRs surface is active. The read is zero-network (it inspects in-memory
 * credential health), so this only bounds how stale the reserve signal can be;
 * a failed read refreshes it immediately rather than waiting for this tick.
 */
const GITHUB_REQUEST_BUDGET_REFRESH_MS = 60_000;

export type GithubPollGovernor = {
  /**
   * True while automatic GitHub reads must stand down — because a read failed,
   * or because the runtime's 500-request quota reserve is armed. User-initiated
   * actions deliberately do not check this, so the reserve stays available for
   * the work the user came to do.
   */
  isGithubPollStoodDown: () => boolean;
  /**
   * Records a failed automatic GitHub read. Called for ANY rejection — the
   * classified failure kind cannot ride on the error (both transports between
   * here and GitHub flatten it to a message) and arrives separately through the
   * runtime's request budget.
   */
  noteGithubReadFailure: () => void;
  /** Records a successful automatic GitHub read, clearing the ladder. */
  noteGithubReadSuccess: () => void;
  /**
   * Poll period an automatic PR read loop should use right now: its own base
   * cadence while GitHub is healthy, the governor's stand-down while it is not.
   */
  githubPollPeriodFor: (basePeriodMs: number) => number;
  /**
   * Bumped whenever the stand-down changes, so timer effects can depend on it
   * and rebuild their interval at the new cadence.
   */
  githubPollGeneration: number;
};

/**
 * One shared brake for every automatic PR read on the PRs surface — the
 * provider's own 60s detail refresh and the detail pane's adaptive checks and
 * mergeability loops — so they stand down together instead of each hammering a
 * GitHub that is already refusing.
 *
 * The state lives in a ref rather than React state because the loops read it
 * inside interval callbacks, where a stale closure would silently reinstate the
 * unbraked behaviour. `githubPollGeneration` is the only part rendered, and it
 * changes only when the stand-down does, so a bumped failure count cannot
 * re-render every PR consumer.
 *
 * See `githubPollGovernor.ts` for the incident this exists to prevent.
 */
export function useGithubPollGovernor(active: boolean): GithubPollGovernor {
  const stateRef = useRef<GithubPollGovernorState>(initialGithubPollGovernorState);
  const [githubPollGeneration, setGithubPollGeneration] = useState(0);

  const commit = useCallback((next: GithubPollGovernorState) => {
    const previous = stateRef.current;
    if (next === previous) return;
    stateRef.current = next;
    // Only a change in an actual stand-down can change a caller's cadence; a
    // bumped failure count on its own must not re-render every PR consumer.
    if (
      next.ladderPausedUntilMs !== previous.ladderPausedUntilMs
      || next.reservePausedUntilMs !== previous.reservePausedUntilMs
    ) {
      setGithubPollGeneration((value) => value + 1);
    }
  }, []);

  const refreshBudget = useCallback(async () => {
    // Optional on purpose: an older remote runtime has no budget action, and a
    // renderer that threw here would lose the local failure ladder too.
    const budget = await window.ade?.github?.getRequestBudget?.().catch(() => null);
    if (!budget) return;
    commit(applyGithubRequestBudget(stateRef.current, budget, Date.now()));
  }, [commit]);

  const noteGithubReadFailure = useCallback(() => {
    commit(noteGithubPollFailure(stateRef.current, Date.now()));
    // Pull the classified kind and the quota reserve from the process that made
    // the request; the rejection itself cannot carry them across IPC.
    void refreshBudget();
  }, [commit, refreshBudget]);

  const noteGithubReadSuccess = useCallback(() => {
    commit(noteGithubPollSuccess(stateRef.current, Date.now()));
  }, [commit]);

  const isGithubPollStoodDown = useCallback(
    () => isGithubPollPaused(stateRef.current, Date.now()),
    [],
  );

  const githubPollPeriodFor = useCallback(
    (basePeriodMs: number) => githubPollPeriodMs(stateRef.current, basePeriodMs, Date.now()),
    [],
  );

  useEffect(() => {
    if (!active) return undefined;
    void refreshBudget();
    const id = window.setInterval(() => {
      void refreshBudget();
    }, GITHUB_REQUEST_BUDGET_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [active, refreshBudget]);

  return {
    isGithubPollStoodDown,
    noteGithubReadFailure,
    noteGithubReadSuccess,
    githubPollPeriodFor,
    githubPollGeneration,
  };
}
