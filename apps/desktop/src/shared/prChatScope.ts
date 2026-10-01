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
 * current-branch PRs (no silent write). Never show a PR another chat claimed.
 * An unlinked (dismissed) PR does not revive as fallback.
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

/**
 * Every PR this chat should show: owned by the lane OR explicitly linked to
 * this chat session, never detached, then scoped to the session. Kept
 * lane-first (rather than `selectPrsForChat`'s edges-first) so the desktop
 * toolbar/pane do not suddenly hide a lane's legacy unedged rows when a
 * sibling row gains an edge.
 */
export function selectPrsForChatInLane(
  prs: readonly PrSummary[],
  laneId: string,
  sessionId?: string | null,
): PrSummary[] {
  const owned = prs.filter((pr) => {
    if (pr.detached) return false;
    if (pr.laneId === laneId) return true;
    return Boolean(sessionId && pr.chatSessionIds?.includes(sessionId));
  });
  if (!sessionId) return owned;
  return owned.filter((pr) => {
    const ids = (pr.chatSessionIds ?? []).filter(Boolean);
    return ids.length === 0 || ids.includes(sessionId);
  });
}

/**
 * Dot colour and label for a PR state. One function because it was written
 * three times and two of the copies rendered a DRAFT pull request green — the
 * same PR read amber in the pane header and green in the pane's own selector.
 */
export function prStateTone(state: PrSummary["state"]): { dot: string; label: string } {
  switch (state) {
    case "open": return { dot: "bg-emerald-400", label: "Open" };
    case "draft": return { dot: "bg-amber-400/70", label: "Draft" };
    case "merged": return { dot: "bg-violet-400", label: "Merged" };
    case "closed": return { dot: "bg-red-400/70", label: "Closed" };
    default: return { dot: "bg-fg/25", label: String(state) };
  }
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
