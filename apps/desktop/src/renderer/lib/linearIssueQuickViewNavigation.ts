import { createPendingRequestChannel } from "./pendingRequestChannel";

/**
 * "Open the Linear pane" — a one-shot request channel.
 *
 * The pane is the place to browse many issues. Opening ONE issue is not this
 * channel's job any more: that goes through `issueNavigation`, which shows the
 * issue directly (in the Work tools pane or the issue sheet) instead of opening
 * this browser and searching for its identifier.
 *
 * Asked for by the Issues tool's empty state and the issue sheet's "View all
 * issues"; answered by the top bar's `LinearQuickViewButton`, which may not
 * have mounted yet when the request arrives.
 */
export type LinearPaneOpenRequest = {
  requestedAt: number;
};

const channel = createPendingRequestChannel<LinearPaneOpenRequest>("linear-pane");

export function requestLinearPaneOpen(): void {
  channel.request({ requestedAt: Date.now() });
}

export function consumePendingLinearPaneOpenRequest(): LinearPaneOpenRequest | null {
  return channel.takePending();
}

export function subscribeLinearPaneOpenRequests(
  onRequest: (request: LinearPaneOpenRequest) => void,
): () => void {
  return channel.subscribe((request) => {
    // This subscriber owns the request now; drop the hold so a later mount
    // cannot drain it again and re-open a pane nobody asked for.
    channel.clearPending();
    onRequest(request);
  });
}
