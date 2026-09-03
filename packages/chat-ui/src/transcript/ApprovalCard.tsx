/**
 * The inline approval card.
 *
 * Inline, not modal, and deliberately so: the reader has to see WHAT the agent
 * was doing when it asked, and a dialog over the transcript hides exactly that.
 * The card sits at the position of the request and stays there after the answer
 * — a card that disappears is indistinguishable from one that was never
 * answered.
 *
 * It never takes focus. The composer is where the person's attention is, and a
 * card that grabs focus mid-sentence loses whatever they were typing. Reaching
 * the buttons is a Tab away; being interrupted by them is not recoverable.
 */

import { useCallback, useState, type ReactNode } from "react";

import type { ApprovalDecision, ApprovalRequest } from "../sdkTypes";
import { readRecord, type ApprovalRow, type ApprovalRowState } from "./transcriptRows";

/** Button and title wording, so a host can speak its own product's language. */
export type ApprovalLabels = {
  title?: (request: ApprovalRequest) => string;
  accept?: string;
  acceptAlways?: string;
  reject?: string;
};

export type ApprovalUiOptions = {
  /** Replace the built-in card entirely. Omit to use it. */
  render?: (
    request: ApprovalRequest,
    respond: (decision: ApprovalDecision) => void,
  ) => ReactNode;
  labels?: ApprovalLabels;
};

export type ApprovalRespond = (
  itemId: string,
  decision: ApprovalDecision,
) => void | Promise<void>;

export type ApprovalCardProps = {
  row: ApprovalRow;
  /**
   * Omit when the thread has no `approve`. The card then renders read-only with
   * a line saying why, rather than offering a button that would throw.
   */
  onApprove?: ApprovalRespond;
  options?: ApprovalUiOptions;
};

const DEFAULT_LABELS = {
  accept: "Allow once",
  acceptAlways: "Always allow",
  reject: "Reject",
} as const;

const SETTLED_COPY: Record<Exclude<ApprovalRowState, "pending">, string> = {
  accepted: "Allowed",
  accepted_always: "Allowed for the rest of this session",
  rejected: "Rejected",
  cancelled: "Cancelled",
  expired: "The turn ended before this was answered.",
};

/**
 * Request kinds that want prose, not a verdict.
 *
 * `kind` has no word for a question, so a provider asking one rides the same
 * event as a tool approval. Offering Allow/Reject for it would send an answer
 * that means nothing to the model, so the card says plainly that this UI cannot
 * answer it.
 */
/*
 * THE ONLY DECLARATION OF THIS PARTITION IN THIS PACKAGE, and a deliberate
 * mirror of `isApprovalShaped` in `@ade-dev/sdk` (`src/approvals.ts`), which is
 * canonical. It is written here as the complement rather than imported because
 * `@ade-dev/sdk` is an OPTIONAL peer of this package: chat-ui must render for a
 * WebSocket proxy or a test double that has no SDK at all. Update both when
 * `PendingInputKind` gains a member.
 */
const UNANSWERABLE_REQUEST_KINDS: ReadonlySet<string> = new Set([
  "question",
  "structured_question",
  "plan_approval",
  "model_selection",
]);

export const NO_APPROVE_NOTICE = "This host cannot answer approvals.";
export const UNANSWERABLE_NOTICE =
  "The assistant is waiting for an answer this UI cannot provide.";

/** The row, back in the shape a host's own `render` and `labels` receive. */
export function approvalRequestFromRow(row: ApprovalRow): ApprovalRequest {
  const request: ApprovalRequest = {
    itemId: row.id,
    kind: row.kind,
    description: row.description,
  };
  if (row.requestKind !== undefined) request.requestKind = row.requestKind;
  if (row.turnId !== null) request.turnId = row.turnId;
  if (row.detail !== undefined) request.detail = row.detail;
  return request;
}

function readText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value : null;
  // Providers that report argv rather than a shell string.
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
    const joined = (value as string[]).join(" ").trim();
    return joined.length ? joined : null;
  }
  return null;
}

/**
 * The command a `kind: "command"` request is asking about.
 *
 * Providers disagree on where it sits: some put it at the top of `detail`,
 * others nest it under the tool input. Both are read, and a request whose
 * payload has neither simply shows its description.
 */
export function readApprovalCommand(detail: unknown): string | null {
  const record = readRecord(detail);
  if (!record) return null;
  return readText(record.command) ?? readText(readRecord(record.input)?.command);
}

/** The path a `kind: "file_change"` request is asking about, and its root. */
export function readApprovalPaths(detail: unknown): { path?: string; grantRoot?: string } {
  const record = readRecord(detail);
  if (!record) return {};
  const path = readText(record.path) ?? readText(readRecord(record.input)?.path);
  const grantRoot = readText(record.grantRoot);
  return {
    ...(path ? { path } : {}),
    ...(grantRoot ? { grantRoot } : {}),
  };
}

export function ApprovalCard({ row, onApprove, options }: ApprovalCardProps) {
  /**
   * The decision this reader sent, held locally for two reasons the row cannot
   * cover: the buttons must stop responding the instant one is pressed, and
   * `pending_input_resolved` reports only "accepted", so "Allowed for the rest
   * of this session" is knowable here and nowhere else.
   */
  const [submitted, setSubmitted] = useState<ApprovalDecision | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const request = approvalRequestFromRow(row);
  const unanswerable =
    row.requestKind !== undefined && UNANSWERABLE_REQUEST_KINDS.has(row.requestKind);
  const answerable = Boolean(onApprove) && !unanswerable;

  const respond = useCallback(
    (decision: ApprovalDecision) => {
      if (!onApprove) return;
      setSubmitted(decision);
      setFailure(null);
      void (async () => {
        try {
          await onApprove(row.id, decision);
        } catch (cause: unknown) {
          // Never silent: the turn is still blocked, and a reader who believes
          // they answered will sit and wait for a reply that cannot come.
          setSubmitted(null);
          setFailure(cause instanceof Error ? cause.message : String(cause));
        }
      })();
    },
    [onApprove, row.id],
  );

  if (options?.render) {
    return <>{options.render(request, respond)}</>;
  }

  const state = resolveDisplayState(row.state, submitted);
  const settled = state !== "pending";
  const command = row.kind === "command" ? readApprovalCommand(row.detail) : null;
  const paths = row.kind === "file_change" ? readApprovalPaths(row.detail) : {};
  const title = options?.labels?.title?.(request) ?? row.description;

  return (
    <div className="adechat-approval" data-state={state} data-kind={row.kind}>
      <div className="adechat-approval-head">
        <span className="adechat-approval-title">{title}</span>
        {settled ? (
          <span className="adechat-approval-settled">{SETTLED_COPY[state]}</span>
        ) : null}
      </div>

      {command ? <pre className="adechat-approval-command">{command}</pre> : null}

      {paths.path ? (
        <p className="adechat-approval-path">
          <code>{paths.path}</code>
        </p>
      ) : null}
      {paths.grantRoot ? (
        <p className="adechat-approval-note">Inside {paths.grantRoot}</p>
      ) : null}

      {unanswerable ? <p className="adechat-approval-note">{UNANSWERABLE_NOTICE}</p> : null}
      {!unanswerable && !onApprove ? (
        <p className="adechat-approval-note">{NO_APPROVE_NOTICE}</p>
      ) : null}

      {answerable ? (
        <div className="adechat-approval-actions">
          <button
            type="button"
            className="adechat-button"
            data-variant="primary"
            disabled={settled}
            onClick={() => respond("accept")}
          >
            {options?.labels?.accept ?? DEFAULT_LABELS.accept}
          </button>
          <button
            type="button"
            className="adechat-button"
            disabled={settled}
            onClick={() => respond("accept_always")}
          >
            {options?.labels?.acceptAlways ?? DEFAULT_LABELS.acceptAlways}
          </button>
          <button
            type="button"
            className="adechat-button"
            data-variant="danger"
            disabled={settled}
            onClick={() => respond("reject")}
          >
            {options?.labels?.reject ?? DEFAULT_LABELS.reject}
          </button>
        </div>
      ) : null}

      {failure ? (
        <p className="adechat-approval-error" role="alert">
          Could not send that answer: {failure}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The row's own state wins once the runtime has confirmed it, except that a
 * plain `accepted` confirming an `accept_always` click keeps the stronger
 * wording — the event cannot carry the difference, and telling the reader they
 * allowed one call when they allowed every call would be wrong.
 */
function resolveDisplayState(
  rowState: ApprovalRowState,
  submitted: ApprovalDecision | null,
): ApprovalRowState {
  if (rowState === "accepted" && submitted === "accept_always") return "accepted_always";
  if (rowState !== "pending") return rowState;
  if (submitted === "accept") return "accepted";
  if (submitted === "accept_always") return "accepted_always";
  if (submitted === "reject") return "rejected";
  return "pending";
}
