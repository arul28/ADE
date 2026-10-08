import type { NormalizedLinearIssue } from "../../shared/types";
import { createPendingRequestChannel } from "./pendingRequestChannel";

/**
 * "Start a new issue" — asked for by a pane's `+ New`, an issue viewer's
 * "New sub-issue", and the chat selection toolbar's "Create issue"; answered
 * by `IssueCreateHost` in the app shell.
 */
export type IssueCreateRequest = {
  /** The tracker to start in; the form can still switch when it is not a sub-issue. */
  provider?: "linear" | "github" | null;
  prefill?: {
    title?: string;
    body?: string;
    /** Linear: `ADE-123`. GitHub: the parent issue number. */
    parent?: { provider: "linear"; identifier: string; teamKey?: string | null } | { provider: "github"; owner: string; repo: string; number: number } | null;
  };
  /** Where the issue was started from, for its "Context" footer. */
  context?: { sessionId?: string | null; laneId?: string | null; laneName?: string | null } | null;
  /**
   * "pane": started from a top-bar pane, which shows the new issue itself.
   * Anything else opens it where the user is (`openIssueRef`).
   */
  origin?: "pane" | null;
};

const channel = createPendingRequestChannel<IssueCreateRequest>("issue-create");

export function requestIssueCreate(request: IssueCreateRequest = {}): void {
  channel.request(request);
}

export const subscribeIssueCreateRequests = channel.subscribe;
export const takePendingIssueCreateRequest = channel.takePending;
export const clearPendingIssueCreateRequest = channel.clearPending;

/**
 * A selection from a chat reply as a new issue: its first line is the title,
 * the whole text the description, and the chat goes in the context footer.
 */
export function issueCreateRequestFromSelection(
  text: string,
  context: { sessionId?: string | null; laneId?: string | null; laneName?: string | null },
): IssueCreateRequest {
  const trimmed = text.trim();
  const firstLine = trimmed.split("\n").find((line) => line.trim())?.trim() ?? "";
  const line = firstLine.replace(/^[#>*\-\s]+/, "");
  // The first sentence when it is short enough; otherwise cut at a word.
  const sentence = /^(.{8,120}?[.!?])(\s|$)/.exec(line)?.[1];
  const title = sentence ?? (line.length <= 120 ? line : `${line.slice(0, 120).replace(/\s+\S*$/, "")}…`);
  return { prefill: { title, body: trimmed }, context };
}

/** A just-created issue, for the panes to select. */
export type IssueCreatedEvent =
  | { provider: "linear"; issue: NormalizedLinearIssue }
  | { provider: "github"; owner: string; repo: string; number: number };

const createdListeners = new Set<(event: IssueCreatedEvent) => void>();

export function announceIssueCreated(event: IssueCreatedEvent): void {
  for (const listener of createdListeners) listener(event);
}

export function subscribeIssueCreated(listener: (event: IssueCreatedEvent) => void): () => void {
  createdListeners.add(listener);
  return () => createdListeners.delete(listener);
}
