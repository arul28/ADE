import { createPendingRequestChannel } from "./pendingRequestChannel";

/**
 * "Open the Linear quick view for this issue" — a one-shot request channel.
 *
 * Asked for by deeplinks, the command palette and session cards; answered by
 * the top bar's `LinearQuickViewButton`, which may not have mounted yet when
 * the request arrives. The mechanics are `createPendingRequestChannel`; only
 * the payload and its normalization are this module's.
 */
export type LinearIssueQuickViewRequest = {
  issueIdentifier: string;
  branch?: string | null;
  source?: "deeplink" | "manual";
  requestedAt: number;
};

const channel = createPendingRequestChannel<LinearIssueQuickViewRequest>("linear-quick-view");

function normalizeRequest(
  request: Omit<LinearIssueQuickViewRequest, "requestedAt"> & { requestedAt?: number },
): LinearIssueQuickViewRequest | null {
  const issueIdentifier = request.issueIdentifier.trim().toUpperCase();
  if (!issueIdentifier) return null;
  const branch = request.branch?.trim() || null;
  return {
    issueIdentifier,
    branch,
    source: request.source ?? "manual",
    requestedAt: request.requestedAt ?? Date.now(),
  };
}

export function requestLinearIssueQuickView(
  request: Omit<LinearIssueQuickViewRequest, "requestedAt"> & { requestedAt?: number },
): void {
  const normalized = normalizeRequest(request);
  if (!normalized) return;
  channel.request(normalized);
}

export function consumePendingLinearIssueQuickViewRequest(): LinearIssueQuickViewRequest | null {
  return channel.takePending();
}

export function subscribeLinearIssueQuickViewRequests(
  onRequest: (request: LinearIssueQuickViewRequest) => void,
): () => void {
  return channel.subscribe((request) => {
    // This subscriber owns the request now; drop the hold so a later mount
    // cannot drain it again and re-open a quick view nobody asked for.
    channel.clearPending();
    onRequest(request);
  });
}
