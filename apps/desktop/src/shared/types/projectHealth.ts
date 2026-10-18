/**
 * Project health: one list of what is wrong with a project, why it matters,
 * and a fix for what ADE can fix. Built by the project's runtime (the machine
 * that owns the project), shown on Settings → Overview and Location, and handed to an agent
 * when the person asks one to help. See docs/features/onboarding-and-settings/project-health.md.
 */

export type ProjectHealthSeverity = "problem" | "warning" | "info";

export type ProjectHealthArea = "location" | "git" | "dependencies" | "agents" | "apple" | "drive" | "storage";

export type ProjectHealthFix = {
  /** Passed back to `fix`. */
  id: string;
  /** Button label, e.g. "Update paths". */
  label: string;
  /** What pressing it changes, in one sentence, shown before it runs. */
  description: string;
  /** "change": ADE edits files or data in place. "terminal": ADE opens a terminal per item and runs a command there. */
  kind: "change" | "terminal";
};

export type ProjectHealthIssue = {
  /** Stable per kind of issue, e.g. "stale-paths". */
  id: string;
  area: ProjectHealthArea;
  severity: ProjectHealthSeverity;
  /** One short line, e.g. "10 proof items point at the old folder". */
  title: string;
  /** Why it matters and what happens if it is left, in plain words. */
  detail: string;
  /** Named things behind the line: lanes, files, folders. */
  items?: string[];
  fix?: ProjectHealthFix;
};

/** Why a lane counts as stale. */
export type ProjectLaneStaleReason = "pr-merged" | "pr-closed" | "idle";

/** One lane, as the Lanes page and the stale-lane check see it. */
export type ProjectLaneHealth = {
  laneId: string;
  name: string;
  laneType: "primary" | "worktree" | "attached" | string;
  worktreePath: string;
  branch: string | null;
  folderExists: boolean;
  /** Latest PR for the lane's branch, if any. */
  pr: { number: number; state: "open" | "merged" | "closed" | string; url: string | null; mergedAt: string | null } | null;
  /** Last time anything happened in the lane: a chat or terminal, or the lane's creation. */
  lastActivityAt: string | null;
  /** Uncommitted changes (tracked or untracked files). Null when git couldn't tell. */
  dirty: boolean | null;
  changedFileCount: number | null;
  /** Commits not on any remote branch. Null when git couldn't tell. */
  unpushedCommits: number | null;
  /** Chats or terminals open in this lane right now (not necessarily working). */
  runningSessions: number;
  stale: ProjectLaneStaleReason | null;
  /** Git-wise, archiving loses nothing: no uncommitted files, no commits that exist only here. Running chats are checked separately (`lanes.getReclaimRisk`). */
  safeToArchive: boolean;
};

export type ProjectHealthReport = {
  projectRoot: string;
  checkedAt: string;
  /** Where this project lived before, from ADE's move records (newest first). */
  previousRoots: string[];
  /** The drive the project is on. */
  drive: {
    name: string;
    internal: boolean;
    freeBytes: number;
    totalBytes: number;
  } | null;
  issues: ProjectHealthIssue[];
  /** Every active lane, for the Lanes page (primary first, then newest activity). */
  lanes: ProjectLaneHealth[];
  /** Lanes idle this many days count as stale. */
  staleAfterDays: number;
  /** Every check that ran, so "no issues" means something. */
  checks: Array<{ id: string; label: string; ok: boolean }>;
};

export type ProjectHealthFixArgs = {
  fixId: string;
};

export type ProjectHealthFixResult = {
  ok: boolean;
  /** One line per thing done or opened. */
  done: string[];
  /** One line per thing that failed. */
  problems: string[];
  /** The report after the fix. */
  report: ProjectHealthReport;
};
