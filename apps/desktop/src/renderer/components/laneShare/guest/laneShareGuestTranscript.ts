import type { AgentChatEventEnvelope } from "../../../../shared/types/chat";
import { parseMessageAuthor } from "../../../../shared/messageAuthor";
import { sceneRowIdentity } from "../../../../shared/chatScene";

/**
 * A shared chat's transcript as plain rows, built from the host's events.
 * Everything here is data of another person: rows carry text only. No path
 * is resolved, no image or file is loaded, and no link opens.
 */

export type LaneShareGuestRow =
  | { kind: "user"; key: string; author: string; mine: boolean; text: string }
  /** `messageKey`: the reply's stable id on the host (`sceneRowIdentity`), for comments; null when it has none. */
  | { kind: "assistant"; key: string; messageKey: string | null; text: string }
  | { kind: "activity"; key: string; text: string; failed: boolean }
  | { kind: "approval"; key: string; itemId: string; description: string; question: boolean; resolved: string | null }
  | { kind: "error"; key: string; text: string };

export type LaneShareGuestTranscript = {
  rows: LaneShareGuestRow[];
  turnActive: boolean;
};

/** Rows kept in memory for one open chat. Older rows drop off the top. */
export const LANE_SHARE_GUEST_MAX_ROWS = 600;
const MAX_TEXT_CHARS = 60_000;

function clip(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
}

/**
 * Builds the rows. `selfUserId` is this guest's user id from hello_ok, so
 * the guest's own messages read "You".
 */
export function buildLaneShareGuestTranscript(
  envelopes: readonly AgentChatEventEnvelope[],
  options: { selfUserId: string | null; ownerLabel: string; initialTurnActive?: boolean | null },
): LaneShareGuestTranscript {
  const rows: LaneShareGuestRow[] = [];
  const approvals = new Map<string, Extract<LaneShareGuestRow, { kind: "approval" }>>();
  let turnActive = options.initialTurnActive === true;
  let lastAssistantKey: string | null = null;
  envelopes.forEach((envelope, index) => {
    const event = envelope.event;
    const key = `${envelope.sequence ?? "x"}-${index}`;
    switch (event.type) {
      case "user_message": {
        const author = parseMessageAuthor(event.metadata?.author);
        const mine = Boolean(author && author.kind === "guest" && options.selfUserId && author.userId === options.selfUserId);
        const name = mine ? "You" : author?.kind === "guest" ? (author.name ?? "A guest") : (author?.name ?? options.ownerLabel);
        rows.push({ kind: "user", key, author: name, mine, text: clip(event.displayText ?? event.text ?? "") });
        lastAssistantKey = null;
        return;
      }
      case "text": {
        const groupKey = event.messageId ?? event.itemId ?? event.turnId ?? null;
        const last = rows[rows.length - 1];
        if (last?.kind === "assistant" && groupKey && lastAssistantKey === groupKey) {
          last.text = clip(last.text + (event.text ?? ""));
          return;
        }
        rows.push({ kind: "assistant", key, messageKey: sceneRowIdentity(event, "") || null, text: clip(event.text ?? "") });
        lastAssistantKey = groupKey;
        return;
      }
      case "command":
        if (event.status === "running") return;
        rows.push({ kind: "activity", key, text: `Ran ${clip(event.command).slice(0, 300)}`, failed: event.status === "failed" });
        lastAssistantKey = null;
        return;
      case "file_change":
        rows.push({
          kind: "activity",
          key,
          text: `${event.kind === "create" ? "Created" : event.kind === "delete" ? "Deleted" : "Changed"} ${event.path.slice(0, 300)}`,
          failed: event.status === "failed",
        });
        lastAssistantKey = null;
        return;
      case "tool_call":
        rows.push({ kind: "activity", key, text: `Used ${String(event.tool).slice(0, 120)}`, failed: false });
        lastAssistantKey = null;
        return;
      case "approval_request": {
        const row: Extract<LaneShareGuestRow, { kind: "approval" }> = {
          kind: "approval",
          key,
          itemId: event.itemId,
          description: clip(event.description ?? "The agent asks to continue."),
          question: event.requestKind === "question" || event.requestKind === "structured_question",
          resolved: null,
        };
        approvals.set(event.itemId, row);
        rows.push(row);
        lastAssistantKey = null;
        return;
      }
      case "pending_input_resolved": {
        const row = approvals.get(event.itemId);
        if (row) row.resolved = event.resolution === "accepted" ? "Approved" : event.resolution === "declined" ? "Denied" : "Closed";
        return;
      }
      case "status":
        turnActive = event.turnStatus === "started";
        return;
      case "done":
        turnActive = false;
        return;
      case "error":
        rows.push({ kind: "error", key, text: clip(event.message ?? "The agent stopped with an error.") });
        lastAssistantKey = null;
        return;
      default:
        return;
    }
  });
  return { rows: rows.slice(-LANE_SHARE_GUEST_MAX_ROWS), turnActive };
}

/** A terminal transcript as plain text: escape sequences and control bytes removed. */
export function plainTerminalText(raw: string): string {
  return raw
    // OSC (title, hyperlinks): ESC ] … BEL or ESC \
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    // CSI and other ESC sequences
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // Other control characters except tab and newline
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}
