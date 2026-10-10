/**
 * Turn, approval and queued-steer state, folded from a chat transcript.
 */

import type {
  AgentChatContextAttachment,
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatFileRef,
} from "../../../shared/types";
import { foldedOverAppends } from "../../../shared/chatHistoryMerge";
import { isSettledSteerDeliveryState } from "../../../shared/chatTranscript";
import { applySteerOrder } from "../../../shared/steerOrder";
import { derivePendingInputRequests, type DerivedPendingInput } from "./pendingInput";
import { parseThreadReviewBlock, threadReviewCountLabel } from "../../../shared/threadComments";

export type PendingSteerEntry = {
  steerId: string;
  text: string;
  attachments: AgentChatFileRef[];
  contextAttachments: AgentChatContextAttachment[];
};

export function userMessageVisibleText(event: Extract<AgentChatEventEnvelope["event"], { type: "user_message" }>): string {
  const displayText = event.displayText?.trim();
  if (displayText?.length) return displayText;
  // A send that carried thread comments: the user saw what they typed, or,
  // with nothing typed, the comment count the optimistic bubble shows.
  const review = parseThreadReviewBlock(event.text);
  if (review) return review.rest.trim() || threadReviewCountLabel(review.comments.length);
  return event.text.trim();
}

/**
 * Re-sorts the staged queue to the host's published order. Ids the event does
 * not name (a steer queued after it, on another client) keep their place after
 * the named ones; a named id that already left the queue is skipped.
 */
function reorderSteerMap(steerMap: Map<string, PendingSteerEntry>, steerIds: readonly string[]): void {
  const ordered = applySteerOrder([...steerMap.entries()], ([id]) => id, steerIds);
  steerMap.clear();
  for (const [id, entry] of ordered) steerMap.set(id, entry);
}

export type DerivedRuntimeState = {
  turnActive: boolean;
  pendingInputs: DerivedPendingInput[];
  pendingSteers: PendingSteerEntry[];
};

const derivedRuntimeStateByEvents = new WeakMap<readonly AgentChatEventEnvelope[], { value: DerivedRuntimeState }>();

/**
 * Whether an appended event can change {@link deriveRuntimeState}'s answer,
 * given the answer for the events before it. Mirrors the branches of that
 * fold (below) and of `derivePendingInputRequests`. An event type that one of
 * them starts to read must be listed here too, or a streamed turn keeps the
 * old answer.
 */
function eventAffectsRuntimeState(event: AgentChatEvent, before: DerivedRuntimeState): boolean {
  switch (event.type) {
    case "status":
    case "done":
    case "queue_reordered":
    case "queue_recovery":
    case "approval_request":
    case "structured_question":
    case "pending_input_resolved":
      return true;
    case "user_message":
    case "system_notice":
    case "command_lifecycle":
      return Boolean(event.steerId);
    // A tool settling only moots an approval that is still listed.
    case "tool_result":
    case "command":
    case "file_change":
      return before.pendingInputs.length > 0;
    default:
      return false;
  }
}

/**
 * Turn, approval and queued-steer state of a transcript. A streamed turn is
 * almost all text, reasoning and tool traffic that cannot change any of it, so
 * a list the live merge appended to reuses the answer of the list before it
 * unless one of the new events can.
 */
export function deriveRuntimeState(events: AgentChatEventEnvelope[]): DerivedRuntimeState {
  return foldedOverAppends(
    derivedRuntimeStateByEvents,
    events,
    (before, append) => {
      for (let index = append.appendedFrom; index < events.length; index += 1) {
        if (eventAffectsRuntimeState(events[index]!.event, before)) return null;
      }
      return { value: before };
    },
    () => foldRuntimeState(events),
  );
}

function foldRuntimeState(events: AgentChatEventEnvelope[]): DerivedRuntimeState {
  let turnActive = false;

  // Track pending steers: added on queued user_message, removed on cancel/deliver notices
  const steerMap = new Map<string, PendingSteerEntry>();
  const resolvedSteerIds = new Set<string>();

  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "status") {
      turnActive = event.turnStatus === "started";
    } else if (event.type === "done") {
      turnActive = false;
    } else if (event.type === "user_message" && event.steerId) {
      if (event.deliveryState === "queued") {
        if (!resolvedSteerIds.has(event.steerId)) {
          const previous = steerMap.get(event.steerId);
          steerMap.set(event.steerId, {
            steerId: event.steerId,
            text: userMessageVisibleText(event),
            attachments: event.attachments ?? previous?.attachments ?? [],
            contextAttachments: event.contextAttachments ?? previous?.contextAttachments ?? [],
          });
        }
      } else {
        // "inline" / "delivered" / "failed" — the steer left the queue, so
        // clear it from the display. Without this the chip stays staged after
        // the user clicks "Send Now" or after a queued steer is delivered.
        steerMap.delete(event.steerId);
        // "accepted" is not final: a Cursor or OpenCode turn can refuse an
        // inline steer it was offered, and the same steerId comes back as
        // "queued". Resolving it here would keep that chip hidden for good.
        if (isSettledSteerDeliveryState(event.deliveryState)) resolvedSteerIds.add(event.steerId);
      }
    } else if (event.type === "system_notice" && event.steerId) {
      // "cancelled" or "Delivering" notices resolve the steer
      if (/cancelled|delivering/i.test(event.message)) {
        steerMap.delete(event.steerId);
        resolvedSteerIds.add(event.steerId);
      }
    } else if (event.type === "command_lifecycle" && event.steerId && event.status !== "queued") {
      steerMap.delete(event.steerId);
      resolvedSteerIds.add(event.steerId);
    } else if (event.type === "queue_reordered") {
      reorderSteerMap(steerMap, event.steerIds);
    } else if (event.type === "queue_recovery" && event.state === "restored") {
      for (const steer of event.restoredSteers ?? []) {
        resolvedSteerIds.delete(steer.steerId);
        steerMap.set(steer.steerId, {
          steerId: steer.steerId,
          text: steer.text,
          attachments: steer.attachments ?? [],
          contextAttachments: steer.contextAttachments ?? [],
        });
      }
    }
  }

  return {
    turnActive,
    pendingInputs: derivePendingInputRequests(events),
    pendingSteers: Array.from(steerMap.values()),
  };
}
