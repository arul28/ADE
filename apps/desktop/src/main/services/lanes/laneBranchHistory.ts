import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import { runGit } from "../git/git";
import { normalizeBranchName } from "../shared/utils";

/**
 * Branch history: the branches a lane's worktree used besides the one the lane
 * records.
 *
 * Agents often cut a follow-up branch inside the same worktree
 * (`git checkout -B <new> origin/main`) and open a PR from it. The lane record
 * keeps its branch — that is what branch drift reports, and only the user
 * decides to switch back or keep HEAD — but the PRs opened from those branches
 * are still the lane's work. They are recorded as branch profiles, which is
 * what the lane's branch list already shows, and the PR service links their
 * PRs to the lane.
 */

/** One branch the worktree's HEAD moved onto, from its reflog. */
export type ReflogBranchVisit = {
  branchRef: string;
  /** When the checkout happened, in epoch milliseconds. */
  atMs: number;
};

const REFLOG_CHECKOUT = /^checkout: moving from (.+) to (.+)$/;
const REFLOG_RENAME = /^Branch: renamed refs\/heads\/(.+) to refs\/heads\/(.+)$/;
const REFLOG_SELECTOR_TIME = /^HEAD@\{(\d+)\}$/;

/**
 * Parse `git reflog show --date=unix --format=%gd%x09%gs HEAD`.
 *
 * A linked worktree keeps its own HEAD reflog, so this lists the branches that
 * one lane's checkout visited — including ones it left again before any lane
 * status refresh saw them. Names are returned verbatim: a detached checkout
 * (`origin/main`, a SHA) is filtered later against the real local branches,
 * not guessed at here.
 */
export function parseReflogBranchVisits(stdout: string): ReflogBranchVisit[] {
  const visits: ReflogBranchVisit[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const timeMatch = REFLOG_SELECTOR_TIME.exec(line.slice(0, tab).trim());
    if (!timeMatch) continue;
    const atMs = Number(timeMatch[1]) * 1000;
    if (!Number.isFinite(atMs)) continue;
    const subject = line.slice(tab + 1).trim();
    const checkout = REFLOG_CHECKOUT.exec(subject);
    if (checkout) {
      // Both ends were checked out here at some point; the "from" side matters
      // when the entry that moved onto it is older than the read window.
      visits.push({ branchRef: checkout[2]!.trim(), atMs });
      visits.push({ branchRef: checkout[1]!.trim(), atMs });
      continue;
    }
    const rename = REFLOG_RENAME.exec(subject);
    if (rename) visits.push({ branchRef: rename[2]!.trim(), atMs });
  }
  return visits;
}

/**
 * The branches a lane's worktree used, besides the one the lane records.
 *
 * Only real local branches count, so a detached checkout of `origin/main` or a
 * SHA never becomes a lane branch. Visits from before the lane existed are
 * ignored (an adopted worktree brings its whole past with it), and so are the
 * base branches and any branch another lane records as its own.
 */
export function selectLaneHistoryBranches(args: {
  visits: readonly ReflogBranchVisit[];
  laneCreatedAtMs: number;
  localBranches: ReadonlySet<string>;
  excludedBranches: ReadonlySet<string>;
}): Array<{ branchRef: string; lastVisitedAtMs: number }> {
  const latest = new Map<string, number>();
  for (const visit of args.visits) {
    const branchRef = visit.branchRef;
    if (!branchRef || !args.localBranches.has(branchRef)) continue;
    if (args.excludedBranches.has(branchRef)) continue;
    if (Number.isFinite(args.laneCreatedAtMs) && visit.atMs < args.laneCreatedAtMs) continue;
    const seen = latest.get(branchRef);
    if (seen === undefined || visit.atMs > seen) latest.set(branchRef, visit.atMs);
  }
  return [...latest.entries()]
    .map(([branchRef, lastVisitedAtMs]) => ({ branchRef, lastVisitedAtMs }))
    .sort((left, right) => right.lastVisitedAtMs - left.lastVisitedAtMs);
}

/** The lane columns the observer reads. */
export type BranchHistoryLaneRow = {
  id: string;
  lane_type: string;
  status: string;
  archived_at: string | null;
  worktree_path: string;
  branch_ref: string;
  base_ref: string;
  created_at: string;
};

const RESCAN_MS = 10 * 60_000;
const REFLOG_LIMIT = 200;
// The first lane list after startup sees every lane at once. Scans queue
// behind a small limit instead of starting two git processes per lane.
const SCAN_CONCURRENCY = 2;
// Local branches live in the repository's common git dir, so one listing
// answers for every lane worktree. Shared for a short window so a burst of
// scans does not list them once per lane.
const LOCAL_BRANCHES_CACHE_MS = 30_000;

const normalizeBranchKey = (ref: string): string => normalizeBranchName(ref).trim();

export function createLaneBranchHistoryObserver<Row extends BranchHistoryLaneRow>(deps: {
  db: AdeDb;
  projectId: string;
  projectRoot: string;
  defaultBaseRef: string;
  logger: Logger;
  getLaneRow: (laneId: string) => Row | null | undefined;
  hasBranchProfile: (laneId: string, branchRef: string) => boolean;
  recordBranchProfile: (row: Row, visit: { branchRef: string; lastVisitedAtMs: number }) => void;
}): {
  /** Called with each lane's live HEAD from the lane status refresh. */
  observe: (row: Row, headBranchRef: string | null | undefined) => void;
  setOnObserved: (hook: ((args: { laneId: string; branchRefs: string[] }) => void) | null) => void;
} {
  const observedByLaneId = new Map<string, { headBranchRef: string; atMs: number }>();
  const scansInFlight = new Set<string>();
  const reportedByLaneId = new Map<string, Set<string>>();
  let onObserved: ((args: { laneId: string; branchRefs: string[] }) => void) | null = null;

  let scansRunning = 0;
  const scanQueue: Array<() => void> = [];
  const withScanSlot = async <T>(task: () => Promise<T>): Promise<T> => {
    if (scansRunning < SCAN_CONCURRENCY) {
      scansRunning += 1;
    } else {
      // The finishing scan hands its slot straight to this one, so the count
      // never dips and lets a newcomer past the limit.
      await new Promise<void>((resolve) => scanQueue.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = scanQueue.shift();
      if (next) next();
      else scansRunning -= 1;
    }
  };

  let localBranchesCache: { atMs: number; branches: Promise<Set<string> | null> } | null = null;
  const readLocalBranches = (): Promise<Set<string> | null> => {
    const nowMs = Date.now();
    if (localBranchesCache && nowMs - localBranchesCache.atMs < LOCAL_BRANCHES_CACHE_MS) {
      return localBranchesCache.branches;
    }
    const branches = runGit(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], {
      cwd: deps.projectRoot,
      timeoutMs: 5_000,
    }).then((result) => {
      // A truncated or failed listing would read as "this branch is gone".
      if (result.exitCode !== 0 || result.stdoutTruncated) return null;
      return new Set(result.stdout.split("\n").map((line) => line.trim()).filter(Boolean));
    }).catch(() => null);
    localBranchesCache = { atMs: nowMs, branches };
    return branches;
  };

  const scan = async (row: Row): Promise<string[]> => {
    const [reflogRes, localBranches] = await Promise.all([
      runGit(
        ["reflog", "show", "--date=unix", "--format=%gd%x09%gs", "-n", String(REFLOG_LIMIT), "HEAD"],
        { cwd: row.worktree_path, timeoutMs: 5_000 },
      ),
      readLocalBranches(),
    ]);
    if (reflogRes.exitCode !== 0 || !localBranches) return [];
    // Another lane's branch is that lane's work, even if this worktree once
    // checked it out. Base branches are never anyone's PR head.
    const excludedBranches = new Set<string>();
    for (const other of deps.db.all<{ branch_ref: string; base_ref: string }>(
      "select branch_ref, base_ref from lanes where project_id = ? and status != 'archived'",
      [deps.projectId],
    )) {
      const branch = normalizeBranchKey(other.branch_ref ?? "");
      if (branch) excludedBranches.add(branch);
      const base = normalizeBranchKey(other.base_ref ?? "");
      if (base) excludedBranches.add(base);
    }
    const defaultBase = normalizeBranchKey(deps.defaultBaseRef);
    if (defaultBase) excludedBranches.add(defaultBase);
    excludedBranches.add(normalizeBranchKey(row.branch_ref));

    const visited = selectLaneHistoryBranches({
      visits: parseReflogBranchVisits(reflogRes.stdout),
      laneCreatedAtMs: Date.parse(row.created_at),
      localBranches,
      excludedBranches,
    });
    // The scan waited on git and on its queue slot; the lane may have been
    // archived or deleted meanwhile, and its profiles must not come back.
    const current = deps.getLaneRow(row.id);
    if (!current || current.status === "archived" || current.archived_at) return [];
    for (const visit of visited) {
      // Insert-only. The lane status refresh runs this for every lane, and an
      // update here would be a replicated write on every pass.
      if (!deps.hasBranchProfile(current.id, visit.branchRef)) deps.recordBranchProfile(current, visit);
    }
    return visited.map((visit) => visit.branchRef);
  };

  /**
   * Reads the worktree reflog when HEAD moves, on the first sight of a lane in
   * this process, and otherwise at most every ten minutes — one git read per
   * lane, never on every refresh.
   */
  const observe = (row: Row, headBranchRef: string | null | undefined): void => {
    if (row.lane_type === "primary" || row.status === "archived" || row.archived_at) return;
    if (scansInFlight.has(row.id)) return;
    const head = normalizeBranchKey(headBranchRef ?? "");
    const previous = observedByLaneId.get(row.id);
    const nowMs = Date.now();
    const headMoved = !previous || previous.headBranchRef !== head;
    if (!headMoved && nowMs - previous.atMs < RESCAN_MS) return;
    observedByLaneId.set(row.id, { headBranchRef: head, atMs: nowMs });
    scansInFlight.add(row.id);
    void withScanSlot(() => scan(row))
      .then((branchRefs) => {
        if (branchRefs.length === 0 || !onObserved) return;
        // Report every history branch when HEAD moves, not only new ones: a
        // branch recorded before its PR was opened needs another look once the
        // worktree has moved on. A timed rescan reports only a changed set.
        if (!headMoved) {
          const known = reportedByLaneId.get(row.id);
          if (known && branchRefs.every((branch) => known.has(branch))) return;
        }
        reportedByLaneId.set(row.id, new Set(branchRefs));
        onObserved({ laneId: row.id, branchRefs });
      })
      .catch((error) => {
        deps.logger.debug("laneService.branch_history_scan_failed", {
          laneId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        scansInFlight.delete(row.id);
      });
  };

  return {
    observe,
    setOnObserved: (hook) => {
      onObserved = hook;
    },
  };
}
