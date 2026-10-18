/**
 * Project health: one list of what is wrong with a project, why it matters,
 * and a fix for what ADE can fix. Built by the project's runtime (the machine
 * that owns the project), shown on Settings → Health, and handed to an agent
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
  /** Every check that ran, so "no issues" means something. */
  checks: Array<{ id: string; label: string; ok: boolean }>;
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
