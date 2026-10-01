import type { PrFile, PrSummary } from "./types";

function linkedSessionIds(pr: PrSummary): string[] {
  return (pr.chatSessionIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean);
}

/** Every PR that shares a GitHub stack with `pr` in the same repository. */
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

/** True once every layer of a GitHub stack reports merged. */
export function isGithubStackFullyLanded(prs: readonly PrSummary[]): boolean {
  if (prs.length === 0) return false;
  return prs.every((pr) => pr.state === "merged" || Boolean(pr.mergedAt));
}

/** Parse a `#123` / `123` palette query into a PR number, or null. */
export function parsePrNumberQuery(query: string): number | null {
  const match = query.trim().match(/^#?(\d+)$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Highest-churn files first, capped at `limit`, with a remainder count. */
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

/** True when the chat still has an open/draft linked PR other than `excludingPrId`. */
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

/** True when this chat explicitly linked at least one of `prs`. */
export function chatHasExplicitPrEdges(
  prs: readonly PrSummary[],
  sessionId: string,
): boolean {
  return prs.some((pr) => linkedSessionIds(pr).includes(sessionId));
}
