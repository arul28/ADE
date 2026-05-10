import type { LaneLinearIssue, NormalizedLinearIssue } from "./types";

type BranchIssueInput = Pick<LaneLinearIssue | NormalizedLinearIssue, "identifier" | "title">;

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
