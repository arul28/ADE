import { createPendingRequestChannel } from "./pendingRequestChannel";

/**
 * "Open the GitHub Issues pane" — asked for by the issue sheet's "All issues"
 * and the Issues tool's empty state, answered by the top bar's
 * `GitHubIssuesButton`, which may not have mounted yet.
 */
const channel = createPendingRequestChannel<{ requestedAt: number }>("github-issues-pane");

export function requestGitHubIssuesPaneOpen(): void {
  channel.request({ requestedAt: Date.now() });
}

export const takePendingGitHubIssuesPaneRequest = channel.takePending;
export const clearPendingGitHubIssuesPaneRequest = channel.clearPending;
export const subscribeGitHubIssuesPaneRequests = channel.subscribe;
