import { branchNameFromLaneRef } from "./laneBaseResolution";

/**
 * Where a new lane's branch starts: which branch, and on which copy of it.
 *
 * One shape for every surface that makes a lane: the New lane dialog (desktop,
 * phone), Auto-create lane, `ade lanes create`, agent tools and the
 * sync commands. The brain resolves it into a commit (`laneService.create`), so
 * every caller gets the same answer for the same choice.
 *
 * - `from: "default"`  the project's default branch (usually `main`).
 * - `from: "primary"`  whatever branch the primary lane has checked out.
 * - `from: "branch"`   a branch the caller names in `branch` (a plain name such
 *                      as `develop`, never `origin/develop`).
 *
 * - `on: "remote"`       fetch, then start from `origin/<branch>`.
 * - `on: "local"`        start from the local branch tip, unpushed commits included.
 * - `on: "uncommitted"`  the local tip plus a COPY of the uncommitted changes
 *                        in the folder that has the branch checked out. The
 *                        source folder is never changed.
 */
export type LaneStartFrom = "default" | "primary" | "branch";
export type LaneStartOn = "remote" | "local" | "uncommitted";

export type LaneStart = {
  from: LaneStartFrom;
  /** Required when `from` is `"branch"`; ignored otherwise. */
  branch?: string | null;
  on: LaneStartOn;
};

/**
 * How every new lane in a project starts unless the caller picks otherwise.
 * A saved start is the default branch or the primary lane's branch, never a
 * named branch: whoever wants every lane to start from `develop` checks out
 * `develop` in the primary lane.
 */
export type NewLaneDefaults = {
  start: LaneStart;
  /** The template a new lane is set up with; null for none. */
  templateId: string | null;
};

export const LANE_START_FROM_VALUES: readonly LaneStartFrom[] = ["default", "primary", "branch"];
/** The starts a project can save as its default. */
export const LANE_START_DEFAULT_FROM_VALUES: readonly LaneStartFrom[] = ["default", "primary"];
export const LANE_START_ON_VALUES: readonly LaneStartOn[] = ["remote", "local", "uncommitted"];

export const DEFAULT_LANE_START: LaneStart = { from: "default", on: "remote" };
export const DEFAULT_NEW_LANE_DEFAULTS: NewLaneDefaults = { start: DEFAULT_LANE_START, templateId: null };

/** A branch name as the user would type it: no `refs/heads/`, `refs/remotes/` or `origin/` prefix. */
export function plainLaneStartBranch(value: string | null | undefined): string {
  return branchNameFromLaneRef(value);
}

/** A valid `LaneStart` from untrusted input (JSON, YAML, sync payloads), or null. */
export function normalizeLaneStart(value: unknown): LaneStart | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const from = record.from;
  const on = record.on;
  if (typeof from !== "string" || !(LANE_START_FROM_VALUES as readonly string[]).includes(from)) return null;
  if (typeof on !== "string" || !(LANE_START_ON_VALUES as readonly string[]).includes(on)) return null;
  if (from === "branch") {
    const branch = plainLaneStartBranch(typeof record.branch === "string" ? record.branch : "");
    if (!branch) return null;
    return { from, branch, on: on as LaneStartOn };
  }
  return { from: from as LaneStartFrom, on: on as LaneStartOn };
}

/** A start a project may save as its default: not a named branch. */
export function isSavableDefaultLaneStart(start: LaneStart): boolean {
  return (LANE_START_DEFAULT_FROM_VALUES as readonly string[]).includes(start.from);
}

export function normalizeNewLaneDefaults(value: unknown): NewLaneDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_NEW_LANE_DEFAULTS;
  const record = value as Record<string, unknown>;
  const parsed = normalizeLaneStart(record.start);
  const start = parsed && isSavableDefaultLaneStart(parsed) ? parsed : DEFAULT_LANE_START;
  const templateId = typeof record.templateId === "string" && record.templateId.trim() ? record.templateId.trim() : null;
  return { start, templateId };
}

export function sameLaneStart(a: LaneStart, b: LaneStart): boolean {
  if (a.from !== b.from || a.on !== b.on) return false;
  return a.from !== "branch" || plainLaneStartBranch(a.branch) === plainLaneStartBranch(b.branch);
}

/**
 * The branch a start points at, given the project's default branch and the
 * primary lane's checked-out branch. Empty when it cannot be known yet.
 */
export function laneStartSourceBranch(
  start: LaneStart,
  context: { defaultBranch: string | null | undefined; primaryBranch: string | null | undefined },
): string {
  if (start.from === "branch") return plainLaneStartBranch(start.branch);
  if (start.from === "primary") return plainLaneStartBranch(context.primaryBranch);
  return plainLaneStartBranch(context.defaultBranch);
}

/** The ref a start begins at, as the user reads it: `origin/main` or `main`. */
export function laneStartRefLabel(start: LaneStart, sourceBranch: string): string {
  if (!sourceBranch) return "";
  return start.on === "remote" ? `origin/${sourceBranch}` : sourceBranch;
}

export const LANE_START_FROM_LABEL: Record<LaneStartFrom, string> = {
  default: "Default branch",
  primary: "Primary lane's branch",
  branch: "A specific branch",
};

export const LANE_START_ON_LABEL: Record<LaneStartOn, string> = {
  remote: "Remote",
  local: "Local",
  uncommitted: "Local + uncommitted",
};

/**
 * The sentence under a start, naming the branch: "Lane will be created from
 * local main, and uncommitted work will be copied over." `subject` is "Lane"
 * or "New lanes".
 */
export function laneStartSentence(start: LaneStart, sourceBranch: string, subject = "Lane"): string {
  if (start.on === "remote") return `${subject} will be created from the latest ${sourceBranch} on the remote.`;
  if (start.on === "local") return `${subject} will be created from local ${sourceBranch}, including commits you haven't pushed.`;
  return `${subject} will be created from local ${sourceBranch}, and uncommitted work will be copied over.`;
}
