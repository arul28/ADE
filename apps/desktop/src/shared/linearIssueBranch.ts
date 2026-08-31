import type { LaneLinearIssue, NormalizedLinearIssue } from "./types";

type BranchIssueInput = Pick<LaneLinearIssue | NormalizedLinearIssue, "identifier" | "title">;

/**
 * The Linear-shaped names. `issueRefFormat.ts` carries the provider-neutral
 * counterparts (`issueRefLaneName`, `issueRefBranchName`) that a plugin tracker
 * uses; `issueRefFormat.test.ts` proves the two produce byte-identical branches
 * for a Linear issue.
 *
 * These two are NOT reimplemented on top of the generic ones. The generic
 * branch namer slugifies the key, which is a no-op for a Linear identifier
 * (`[A-Za-z0-9-]` only) but not for an identifier containing `_`, `.` or `/` —
 * characters Linear cannot mint but which this function would pass through to
 * the sanitizer. Delegating would therefore be a behavior change in a corner
 * nobody asked to move, so the bodies stay as they are. Only
 * `sanitizeLinearIssueBranchName` is shared, imported by the generic module.
 */
export function linearIssueLaneName(issue: BranchIssueInput): string {
  return `${issue.identifier.trim()} ${issue.title.trim()}`.trim();
}

export function linearIssueBranchName(issue: BranchIssueInput): string {
  const identifier = issue.identifier.trim().toLowerCase();
  const titleSlug = issue.title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  const branch = [identifier, titleSlug].filter(Boolean).join("-");
  return sanitizeLinearIssueBranchName(branch || identifier || "linear-issue");
}

export function sanitizeLinearIssueBranchName(input: string): string {
  return input
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "")
    // Git ref-format invalids: backslash, tilde, caret, colon, question, star,
    // brackets, whitespace, plus the `@{` sequence (reflog selector syntax).
    .replace(/@\{/g, "-")
    .replace(/[\\~^:?*\[\]\s]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/\/\.+/g, "/")
    .replace(/\.+\//g, "/")
    .replace(/\.\.+/g, "-")
    .replace(/\.+$/g, "")
    // Strip a trailing `.lock` (case-insensitive) — invalid as a Git ref suffix.
    .replace(/\.lock$/i, "")
    .replace(/^-+|-+$/g, "")
    .replace(/\/$/g, "")
    .replace(/^\/+/g, "")
    .replace(/-{2,}/g, "-")
    || "linear-issue";
}
