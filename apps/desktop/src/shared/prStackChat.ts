import type { PrSummary } from "./types";

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
