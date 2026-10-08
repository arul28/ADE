import type { PrSummary } from "./types";

function normalizeBranch(value: string | null | undefined): string {
  return (value ?? "").replace(/^refs\/heads\//i, "").trim().toLowerCase();
}

function linkedSessionIds(pr: PrSummary): string[] {
  return (pr.chatSessionIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean);
}

/**
 * Chats that claim a PR away from the other chats on its lane: every linked
 * chat except one on another lane. A stack coordinator links every layer from
 * its own lane; that is a reference, and the layer's own chats keep the PR.
 */
function claimingSessionIds(pr: PrSummary): string[] {
  const crossLane = new Set((pr.crossLaneChatSessionIds ?? []).map((id) => String(id ?? "").trim()));
  return linkedSessionIds(pr).filter((id) => !crossLane.has(id));
}

/** True when a chat on this PR's lane other than `sessionId` claimed it. */
export function prClaimedByOtherChat(pr: PrSummary, sessionId: string): boolean {
  if (linkedSessionIds(pr).includes(sessionId)) return false;
  return claimingSessionIds(pr).length > 0;
}

function dismissedSessionIds(pr: PrSummary): string[] {
  return (pr.dismissedChatSessionIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean);
}

/**
 * Scope PRs to one chat.
 *
 * Edges win: if this chat linked any PRs, show only those — including
 * cross-lane GitHub stack members. A zero-edge chat may display unedged
 * current-branch PRs (no silent write). Never show a PR another chat on its
 * lane claimed; a link from a chat on another lane is not a claim.
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
    if (claimingSessionIds(pr).length > 0) return false;
    if (!branch) return true;
    const head = normalizeBranch(pr.headBranch);
    return !head || head === branch;
  });
}

/**
 * Scope PRs to one chat, lane-first.
 *
 * Every PR this lane owns (or this chat explicitly linked) is the candidate
 * set; then a row claimed by another chat on its lane is dropped (a link from
 * a chat on another lane, such as a stack coordinator, is not a claim), and a row this
 * chat explicitly unlinked (a tombstone) stays gone even though the lane still
 * owns it. Kept lane-first rather than edges-first so the desktop toolbar/pane
 * do not hide a lane's legacy unedged rows when a sibling row gains an edge.
 */
export function selectPrsForChatInLane(
  prs: readonly PrSummary[],
  laneId: string,
  sessionId?: string | null,
): PrSummary[] {
  const owned = prs.filter((pr) => {
    if (pr.detached) return false;
    if (pr.laneId === laneId) return true;
    return Boolean(sessionId && linkedSessionIds(pr).includes(sessionId));
  });
  if (!sessionId) return owned;
  return owned.filter((pr) => {
    if (dismissedSessionIds(pr).includes(sessionId)) return false;
    return !prClaimedByOtherChat(pr, sessionId);
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
