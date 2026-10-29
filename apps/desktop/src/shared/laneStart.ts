/**
 * Where a new lane's branch starts, and how much work it brings along.
 *
 * One shape for every surface that makes a lane: the New lane dialog (desktop,
 * phone, `ade code`), Auto-create lane, `ade lanes create`, agent tools and the
 * sync commands. The brain resolves it into a commit (`laneService.create`), so
 * every caller gets the same answer for the same choice.
 *
 * - `from: "default"`  the project's default branch (usually `main`).
 * - `from: "primary"`  whatever branch the primary lane has checked out.
 * - `from: "branch"`   a branch the caller names in `branch` (a plain name such
 *                      as `develop`, never `origin/develop`).
 *
 * - `bring: "pushed"`       fetch, then start from `origin/<branch>`.
 * - `bring: "local"`        start from the local branch tip, unpushed commits included.
 * - `bring: "uncommitted"`  the local tip plus a COPY of the uncommitted changes
 *                           in the folder that has the branch checked out. The
 *                           source folder is never changed.
 */
export type LaneStartFrom = "default" | "primary" | "branch";
export type LaneStartBring = "pushed" | "local" | "uncommitted";

export type LaneStart = {
  from: LaneStartFrom;
  /** Required when `from` is `"branch"`; ignored otherwise. */
  branch?: string | null;
  bring: LaneStartBring;
};

/** How every new lane in a project starts unless the caller picks otherwise. */
export type NewLaneDefaults = {
  start: LaneStart;
  /** The template a new lane is set up with; null for none. */
  templateId: string | null;
};

export const LANE_START_FROM_VALUES: readonly LaneStartFrom[] = ["default", "primary", "branch"];
export const LANE_START_BRING_VALUES: readonly LaneStartBring[] = ["pushed", "local", "uncommitted"];

export const DEFAULT_LANE_START: LaneStart = { from: "default", bring: "pushed" };
export const DEFAULT_NEW_LANE_DEFAULTS: NewLaneDefaults = { start: DEFAULT_LANE_START, templateId: null };

/** A branch name as the user would type it: no `refs/heads/`, `refs/remotes/` or `origin/` prefix. */
export function plainLaneStartBranch(value: string | null | undefined): string {
  let name = (value ?? "").trim();
  if (name.startsWith("refs/heads/")) name = name.slice("refs/heads/".length);
  else if (name.startsWith("refs/remotes/")) name = name.slice("refs/remotes/".length).replace(/^[^/]+\//, "");
  else if (name.startsWith("origin/")) name = name.slice("origin/".length);
  return name;
}

/** A valid `LaneStart` from untrusted input (JSON, YAML, sync payloads), or null. */
export function normalizeLaneStart(value: unknown): LaneStart | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const from = record.from;
  const bring = record.bring;
  if (typeof from !== "string" || !(LANE_START_FROM_VALUES as readonly string[]).includes(from)) return null;
  if (typeof bring !== "string" || !(LANE_START_BRING_VALUES as readonly string[]).includes(bring)) return null;
  if (from === "branch") {
    const branch = plainLaneStartBranch(typeof record.branch === "string" ? record.branch : "");
    if (!branch) return null;
    return { from, branch, bring: bring as LaneStartBring };
  }
  return { from: from as LaneStartFrom, bring: bring as LaneStartBring };
}

export function normalizeNewLaneDefaults(value: unknown): NewLaneDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_NEW_LANE_DEFAULTS;
  const record = value as Record<string, unknown>;
  const start = normalizeLaneStart(record.start) ?? DEFAULT_LANE_START;
  const templateId = typeof record.templateId === "string" && record.templateId.trim() ? record.templateId.trim() : null;
  return { start, templateId };
}

export function sameLaneStart(a: LaneStart, b: LaneStart): boolean {
  if (a.from !== b.from || a.bring !== b.bring) return false;
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
  return start.bring === "pushed" ? `origin/${sourceBranch}` : sourceBranch;
}

export const LANE_START_FROM_LABEL: Record<LaneStartFrom, string> = {
  default: "Default branch",
  primary: "Primary lane's branch",
  branch: "A specific branch",
};

export const LANE_START_BRING_LABEL: Record<LaneStartBring, string> = {
  pushed: "Pushed work",
  local: "Local commits",
  uncommitted: "Local + uncommitted",
};

export const LANE_START_BRING_HINT: Record<LaneStartBring, string> = {
  pushed: "Fetches first, then starts from what's on the remote.",
  local: "Starts from your local copy, including commits you haven't pushed.",
  uncommitted: "Your local copy plus a copy of its uncommitted changes. The original folder is left as it is.",
};

/**
 * One sentence for a start, e.g. "origin/main, fetched first" or
 * "develop with its uncommitted changes". Used by the dialog summary, settings
 * and CLI output.
 */
export function describeLaneStart(start: LaneStart, sourceBranch: string): string {
  const branch = sourceBranch || (start.from === "branch" ? plainLaneStartBranch(start.branch) : "");
  const name = branch || (start.from === "primary" ? "the primary lane's branch" : "the default branch");
  if (start.bring === "pushed") return branch ? `origin/${branch}, fetched first` : `${name} on the remote, fetched first`;
  if (start.bring === "local") return `${name}, local commits included`;
  return `${name} with a copy of its uncommitted changes`;
}
