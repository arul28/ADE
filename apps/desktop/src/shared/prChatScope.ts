import type { PrFile, PrSummary } from "./types";

function normalizeBranch(value: string | null | undefined): string {
  return (value ?? "").replace(/^refs\/heads\//i, "").trim().toLowerCase();
}

function linkedSessionIds(pr: PrSummary): string[] {
  return (pr.chatSessionIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean);
}

function dismissedSessionIds(pr: PrSummary): string[] {
  return (pr.dismissedChatSessionIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean);
}

export function chatHasExplicitPrEdges(
  prs: readonly PrSummary[],
  sessionId: string,
): boolean {
  return prs.some((pr) => linkedSessionIds(pr).includes(sessionId));
}

/**
 * Scope PRs to one chat.
 *
 * Edges win: if this chat linked any PRs, show only those — including
 * cross-lane GitHub stack members. A zero-edge chat may display unedged
 * current-branch PRs (no silent write). Never show a PR another chat
 * claimed. An unlinked (dismissed) PR does not revive as fallback.
 */
export function selectPrsForChat(
  prs: readonly PrSummary[],
  sessionId?: string | null,
  options?: {
    currentBranch?: string | null;
  },
): PrSummary[] {
  if (!sessionId) return [...prs];
  const edged = prs.filter((pr) => linkedSessionIds(pr).includes(sessionId));
  if (edged.length > 0) return edged;

  const branch = normalizeBranch(options?.currentBranch);
  return prs.filter((pr) => {
    if (dismissedSessionIds(pr).includes(sessionId)) return false;
    const linked = linkedSessionIds(pr);
    if (linked.length > 0) return false;
    if (!branch) return true;
    const head = normalizeBranch(pr.headBranch);
    return !head || head === branch;
  });
}

export function parsePrNumberQuery(query: string): number | null {
  const match = query.trim().match(/^#?(\d+)$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function rankPrFilesByChurn<T extends Pick<PrFile, "filename" | "additions" | "deletions">>(
  files: readonly T[],
  limit = 3,
): { files: T[]; remaining: number } {
  const ranked = [...files].sort((left, right) => {
    const byChurn = (right.additions + right.deletions) - (left.additions + left.deletions);
    if (byChurn !== 0) return byChurn;
    return left.filename.localeCompare(right.filename);
  });
  return {
    files: ranked.slice(0, Math.max(0, limit)),
    remaining: Math.max(0, ranked.length - Math.max(0, limit)),
  };
}

export function sessionHasOpenLinkedPrs(
  prs: readonly PrSummary[],
  sessionId: string,
  options?: { excludingPrId?: string | null },
): boolean {
  const excluded = String(options?.excludingPrId ?? "").trim();
  return prs.some((pr) => {
    if (excluded && pr.id === excluded) return false;
    if (pr.state !== "open" && pr.state !== "draft") return false;
    return linkedSessionIds(pr).includes(sessionId);
  });
}

export function selectStackSiblings(
  prs: readonly PrSummary[],
  pr: Pick<PrSummary, "id" | "stack" | "repoOwner" | "repoName">,
): PrSummary[] {
  const stackNumber = pr.stack?.number;
  if (!stackNumber) return [];
  const owner = pr.repoOwner.trim().toLowerCase();
  const name = pr.repoName.trim().toLowerCase();
  return prs.filter((candidate) => (
    candidate.stack?.number === stackNumber
    && candidate.repoOwner.trim().toLowerCase() === owner
    && candidate.repoName.trim().toLowerCase() === name
  ));
}

export function isGithubStackFullyLanded(prs: readonly PrSummary[]): boolean {
  if (prs.length === 0) return false;
  return prs.every((pr) => pr.state === "merged" || Boolean(pr.mergedAt));
}

export function githubHttpStatusFromError(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const http = message.match(/HTTP (\d{3})/i);
  if (http) return Number(http[1]);
  if (/^not found$/i.test(message.trim()) || /\bnot found\b/i.test(message)) return 404;
  if (/\bmethod not allowed\b/i.test(message) || /\b405\b/.test(message)) return 405;
  if (/\bforbidden\b/i.test(message) || /resource not accessible/i.test(message)) return 403;
  return null;
}

export function githubStackApiUnavailableReason(error: unknown, action: "merge" | "rebase"): string {
  const status = githubHttpStatusFromError(error);
  if (status === 404 || status === 405) {
    return action === "merge"
      ? "GitHub does not expose stack merge for this repository yet."
      : "GitHub does not expose stack rebase for this repository yet.";
  }
  if (status === 403) {
    return action === "merge"
      ? "This credential cannot merge GitHub stacks."
      : "This credential cannot rebase GitHub stacks.";
  }
  const message = error instanceof Error ? error.message.trim() : String(error ?? "").trim();
  return message || (action === "merge" ? "GitHub could not merge this stack." : "GitHub could not rebase this stack.");
}
