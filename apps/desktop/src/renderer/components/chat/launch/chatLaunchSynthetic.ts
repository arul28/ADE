import type {
  AgentChatEventEnvelope,
  ChatLaunchSnapshot,
  TerminalSessionSummary,
} from "../../../../shared/types";
import { LAUNCH_DELIVERY_ERROR_METADATA_KEY } from "../../../../shared/chatUserMessageStatus";
import type { AdeCardPayload } from "../../../../shared/adeCard";
import { getModelById, resolveProviderGroupForModel } from "../../../../shared/modelRegistry";
import { buildLaneSetupCard, isChatLaunchPending, laneSetupCardId } from "../../../../shared/chatLaunch";
import { chatToolTypeForProvider } from "../../../lib/sessions";
import { getChatLaunchLocalRecord, type ChatLaunchRowSource } from "../../../state/chatLaunchStore";

/**
 * Stand-ins a pending chat launch renders before the host has created the
 * chat. They are shaped exactly like the real thing — the Work roster row has
 * the chat's reserved session id, and the thread events are the same
 * `user_message` + `ade_card lane_setup` the host writes to the transcript —
 * so when the real rows arrive they replace these in place, with no swap.
 */

function launchProvider(snapshot: ChatLaunchSnapshot): string | null {
  const local = getChatLaunchLocalRecord(snapshot.launchId);
  if (local?.args.provider) return local.args.provider;
  const descriptor = snapshot.modelId ? getModelById(snapshot.modelId) : undefined;
  return descriptor ? resolveProviderGroupForModel(descriptor) : null;
}

/**
 * A launch whose chat should be listed in Work even though the host may not
 * have reported it yet: only until the chat exists, or while the launch still
 * owns it (see `isChatLaunchPending`). After that the host's own row is the
 * chat — a stand-in would outlive a chat that was since deleted or archived.
 */
export function shouldListChatLaunchRow(snapshot: ChatLaunchSnapshot): boolean {
  return snapshot.kind === "chat"
    && snapshot.phase !== "cancelled"
    && Boolean(snapshot.sessionId)
    && (!snapshot.sessionCreated || isChatLaunchPending(snapshot));
}

/**
 * The launches the Work roster lists: the active binding's, plus those pinned
 * to the same project on another machine (`sameProjectBindingKeys`). Another
 * project's launch never shows here.
 */
export function selectRosterChatLaunches(
  sources: readonly ChatLaunchRowSource[],
  activeBindingKey: string,
  sameProjectBindingKeys: ReadonlySet<string>,
): ChatLaunchSnapshot[] {
  return sources
    .filter((source) => source.bindingKey === activeBindingKey || sameProjectBindingKeys.has(source.bindingKey))
    .map((source) => source.snapshot)
    .filter(shouldListChatLaunchRow);
}

export function buildChatLaunchSessionRow(snapshot: ChatLaunchSnapshot): TerminalSessionSummary {
  const toolType = chatToolTypeForProvider(launchProvider(snapshot));
  const title = snapshot.title?.trim() || snapshot.prompt.displayText?.trim() || snapshot.prompt.text.trim() || "New chat";
  return {
    id: snapshot.sessionId ?? snapshot.launchId,
    laneId: snapshot.laneId,
    laneName: snapshot.laneName,
    ptyId: null,
    tracked: true,
    pinned: false,
    manuallyNamed: false,
    goal: snapshot.prompt.text || null,
    toolType,
    title,
    status: "running",
    startedAt: snapshot.startedAt,
    endedAt: null,
    archivedAt: null,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    lastActivityAt: snapshot.updatedAt,
    summary: null,
    runtimeState: "running",
    resumeCommand: null,
    resumeMetadata: null,
    chatSessionId: null,
    ...(snapshot.modelId ? { modelId: snapshot.modelId as TerminalSessionSummary["modelId"] } : {}),
  };
}

/**
 * Merge pending launch rows into a roster. A real row with the same id always
 * wins; launch rows only fill ids the roster does not have yet.
 */
export function mergeChatLaunchRows(
  sessions: TerminalSessionSummary[],
  launches: readonly ChatLaunchSnapshot[],
  knownIds?: ReadonlySet<string>,
): TerminalSessionSummary[] {
  if (launches.length === 0) return sessions;
  const present = new Set(sessions.map((session) => session.id));
  const additions: TerminalSessionSummary[] = [];
  for (const launch of launches) {
    if (!shouldListChatLaunchRow(launch)) continue;
    const id = launch.sessionId ?? launch.launchId;
    if (present.has(id) || knownIds?.has(id)) continue;
    present.add(id);
    additions.push(buildChatLaunchSessionRow(launch));
  }
  if (additions.length === 0) return sessions;
  return [...additions, ...sessions].sort((left, right) => {
    const l = Date.parse(left.startedAt);
    const r = Date.parse(right.startedAt);
    return (Number.isFinite(r) ? r : 0) - (Number.isFinite(l) ? l : 0);
  });
}

/* ── Thread stand-ins ─────────────────────────────────────────────────── */

/** The host's own `lane_setup` card (shared builder), stamped for the local stand-in. */
export function buildLaneSetupCardPayload(snapshot: ChatLaunchSnapshot, nowMs = Date.now()): AdeCardPayload {
  return {
    ...buildLaneSetupCard(snapshot, nowMs),
    createdAt: snapshot.startedAt,
    updatedAt: snapshot.updatedAt,
  };
}

/** `user_message.metadata` key carrying a queued launch message's delivery failure. */
export { LAUNCH_DELIVERY_ERROR_METADATA_KEY };

/**
 * Queued messages the thread shows. Before the agent starts, all of them.
 * After, the queue is only non-empty while the host delivers it; a message
 * that is merely mid-delivery is hidden (its real row is about to land), but
 * once one has failed it and every message waiting behind it stay visible —
 * the failed one as "couldn't send" — until the host delivers them.
 */
function visibleQueuedMessages(snapshot: ChatLaunchSnapshot): ChatLaunchSnapshot["queuedMessages"] {
  if (!snapshot.agentStarted) return snapshot.queuedMessages;
  const firstFailed = snapshot.queuedMessages.findIndex((queued) => Boolean(queued.deliveryError?.trim()));
  return firstFailed < 0 ? [] : snapshot.queuedMessages.slice(firstFailed);
}

/**
 * The thread a pending chat shows: the opening prompt, the setup card, and any
 * message queued while the lane was being set up (including, after the agent
 * started, any the host could not deliver yet). Real transcript rows replace
 * each stand-in as they arrive (the user bubble by type, the card by cardId).
 */
export function buildChatLaunchThreadEvents(
  snapshot: ChatLaunchSnapshot,
  realEvents: readonly AgentChatEventEnvelope[],
): AgentChatEventEnvelope[] {
  const sessionId = snapshot.sessionId ?? snapshot.launchId;
  const cardId = laneSetupCardId(snapshot.launchId);
  const hasRealUserMessage = realEvents.some((envelope) => envelope.event.type === "user_message");
  const hasRealCard = realEvents.some((envelope) => (
    envelope.event.type === "ade_card" && envelope.event.cardId === cardId
  ));
  const out: AgentChatEventEnvelope[] = [];
  if (!hasRealUserMessage) {
    out.push({
      sessionId,
      timestamp: snapshot.startedAt,
      event: {
        type: "user_message",
        text: snapshot.prompt.text,
        ...(snapshot.prompt.displayText ? { displayText: snapshot.prompt.displayText } : {}),
        ...(snapshot.prompt.attachments.length ? { attachments: snapshot.prompt.attachments } : {}),
        messageId: `launch-prompt:${snapshot.launchId}`,
      },
    });
  }
  out.push(...realEvents);
  if (!hasRealCard) {
    out.push({
      sessionId,
      timestamp: snapshot.startedAt,
      event: { type: "ade_card", ...buildLaneSetupCardPayload(snapshot) },
    });
  }
  for (const queued of visibleQueuedMessages(snapshot)) {
    const deliveryError = queued.deliveryError?.trim() || null;
    out.push({
      sessionId,
      timestamp: queued.createdAt,
      event: {
        type: "user_message",
        text: queued.text,
        ...(queued.displayText ? { displayText: queued.displayText } : {}),
        ...(queued.attachments?.length ? { attachments: queued.attachments } : {}),
        messageId: `launch-queued:${queued.id}`,
        ...(deliveryError
          ? { deliveryState: "failed" as const, metadata: { [LAUNCH_DELIVERY_ERROR_METADATA_KEY]: deliveryError } }
          : { deliveryState: "queued" as const }),
      },
    });
  }
  return out;
}
