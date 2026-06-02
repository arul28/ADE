/**
 * Cross-page signal for "these lanes were just launched" so the Lanes tab can
 * open its stack drawer and pulse/highlight the new agents after a batch launch
 * reroutes from the Linear quick view. Mirrors the lightweight pending-context
 * pattern used by `linearIssueQuickViewNavigation`.
 */

export type LaunchedLanesHighlight = {
  laneIds: string[];
  sessionIds: string[];
  requestedAt: number;
};

const PENDING_TTL_MS = 30_000;

let pending: LaunchedLanesHighlight | null = null;
const listeners = new Set<(highlight: LaunchedLanesHighlight) => void>();

function isExpired(highlight: LaunchedLanesHighlight): boolean {
  return Date.now() - highlight.requestedAt > PENDING_TTL_MS;
}

export function rememberLaunchedLanes(args: { laneIds: string[]; sessionIds: string[] }): void {
  const sessionIds = [...args.sessionIds];
  // Lane ids drive the Lanes tab's "creating" overlay while a launched agent
  // session materializes. Lane-only creates have no session to wait for, so do
  // not publish their lane ids into that loading path.
  const laneIds = sessionIds.length > 0 ? [...args.laneIds] : [];
  if (!laneIds.length && !sessionIds.length) return;
  pending = {
    laneIds,
    sessionIds,
    requestedAt: Date.now(),
  };
  for (const listener of listeners) listener(pending);
}

/** Consumes the pending highlight (one-shot) if it is still fresh. */
export function consumeLaunchedLanesHighlight(): LaunchedLanesHighlight | null {
  if (pending && isExpired(pending)) pending = null;
  const current = pending;
  pending = null;
  return current;
}

export function subscribeLaunchedLanesHighlight(
  listener: (highlight: LaunchedLanesHighlight) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * ──────────────────────────────────────────────────────────────────────────
 * Creating-lane placeholders (optimistic, keyed by ISSUE id).
 *
 * When a batch launch reroutes to the Lanes tab, the real lanes don't exist
 * yet (their ids are minted as `runBatchLaunch` materializes each worktree).
 * To show spinner tabs immediately, the launcher records one placeholder per
 * selected ISSUE *before* running the batch; the Lanes page renders a fake
 * spinner tab per placeholder and clears each one when the real lane carrying
 * that `linearIssue.id` appears (or via {@link clearCreatingIssue} once the
 * batch reports the lane id).
 *
 * Consumer contract (Lanes page):
 *  1. On mount / when the launched-lanes highlight fires, call
 *     {@link consumeCreatingIssues} to seed initial placeholders, then
 *     {@link subscribeCreatingIssues} for live updates.
 *  2. Render a spinner tab for each placeholder whose `issueId` is not yet
 *     matched by a real lane (`lane.linearIssue?.id === issueId`).
 *  3. When a real lane materializes for an issue, the placeholder is cleared
 *     by the launcher via {@link clearCreatingIssue}; the page may also drop it
 *     defensively once it sees the matching lane.
 *
 * Placeholders expire after {@link PENDING_TTL_MS} so a failed/abandoned launch
 * never leaves a permanent spinner.
 * ──────────────────────────────────────────────────────────────────────────
 */

export type CreatingIssuePlaceholder = {
  /** Linear issue id the lane is being created for. */
  issueId: string;
  /** Display name for the spinner tab (the prospective lane name). */
  name: string;
  /** When the placeholder was recorded (for TTL expiry). */
  requestedAt: number;
};

const creating = new Map<string, CreatingIssuePlaceholder>();
const creatingListeners = new Set<(placeholders: CreatingIssuePlaceholder[]) => void>();

function pruneExpiredCreating(): void {
  const now = Date.now();
  for (const [issueId, placeholder] of creating) {
    if (now - placeholder.requestedAt > PENDING_TTL_MS) creating.delete(issueId);
  }
}

function emitCreating(): void {
  const snapshot = [...creating.values()];
  for (const listener of creatingListeners) listener(snapshot);
}

/**
 * Record optimistic "creating lane" placeholders for the given issues. Call
 * this BEFORE running the batch launch so spinner tabs appear immediately on
 * reroute to the Lanes tab. Re-recording an already-pending issue refreshes its
 * TTL and name.
 */
export function rememberCreatingIssues(args: {
  issues: Array<{ issueId: string; name: string }>;
}): void {
  if (!args.issues.length) return;
  const now = Date.now();
  for (const { issueId, name } of args.issues) {
    if (!issueId) continue;
    creating.set(issueId, { issueId, name, requestedAt: now });
  }
  emitCreating();
}

/** Clear one placeholder once its lane has materialized (or its launch failed). */
export function clearCreatingIssue(issueId: string): void {
  if (creating.delete(issueId)) emitCreating();
}

/**
 * Snapshot the current fresh placeholders (does NOT clear them — placeholders
 * are cleared per-issue as lanes materialize). Expired entries are pruned.
 */
export function consumeCreatingIssues(): CreatingIssuePlaceholder[] {
  pruneExpiredCreating();
  return [...creating.values()];
}

/** Subscribe to placeholder changes; fires with the full current snapshot. */
export function subscribeCreatingIssues(
  listener: (placeholders: CreatingIssuePlaceholder[]) => void,
): () => void {
  creatingListeners.add(listener);
  return () => creatingListeners.delete(listener);
}
