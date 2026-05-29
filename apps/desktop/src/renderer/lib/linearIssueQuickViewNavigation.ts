export type LinearIssueQuickViewRequest = {
  issueIdentifier: string;
  branch?: string | null;
  source?: "deeplink" | "manual";
  requestedAt: number;
};

const LINEAR_ISSUE_QUICK_VIEW_EVENT = "ade:linear-issue-quick-view";

let pendingRequest: LinearIssueQuickViewRequest | null = null;

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
  pendingRequest = normalized;
  window.dispatchEvent(new CustomEvent<LinearIssueQuickViewRequest>(LINEAR_ISSUE_QUICK_VIEW_EVENT, {
    detail: normalized,
  }));
}

export function consumePendingLinearIssueQuickViewRequest(): LinearIssueQuickViewRequest | null {
  const request = pendingRequest;
  pendingRequest = null;
  return request;
}

export function subscribeLinearIssueQuickViewRequests(
  onRequest: (request: LinearIssueQuickViewRequest) => void,
): () => void {
  const listener = (event: Event) => {
    const request = event instanceof CustomEvent ? event.detail as LinearIssueQuickViewRequest | null : null;
    if (request) {
      pendingRequest = null;
      onRequest(request);
    }
  };
  window.addEventListener(LINEAR_ISSUE_QUICK_VIEW_EVENT, listener);
  return () => window.removeEventListener(LINEAR_ISSUE_QUICK_VIEW_EVENT, listener);
}
