import type {
  AgentChatEventEnvelope,
  ChatLaunchSnapshot,
  TerminalSessionSummary,
} from "../../../../shared/types";
import { LAUNCH_DELIVERY_ERROR_METADATA_KEY } from "../../../../shared/chatUserMessageStatus";
import type { AdeCardPayload } from "../../../../shared/adeCard";
import { getModelById, resolveProviderGroupForModel } from "../../../../shared/modelRegistry";
import { buildLaneSetupCard, isChatLaunchPending, isChatLaunchSucceeded, laneSetupCardId } from "../../../../shared/chatLaunch";
import { chatToolTypeForProvider } from "../../../lib/sessions";
import {
  chatLaunchRowSourcesNow,
  chatLaunchStore,
  getChatLaunchLocalRecord,
  pauseChatLaunchBridges,
  resumeChatLaunchBridges,
  type ChatLaunchBridgeClock,
  type ChatLaunchRowSource,
} from "../../../state/chatLaunchStore";

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
 * How long a started chat's row stays listed while the host's own row is still
 * missing, counted from when this window saw the launch start, in visible time:
 * reads cannot run while the window is hidden, so a hidden stretch does not count
 * (`syncChatLaunchBridgeClock`).
 *
 * Sized to the slowest realistic landing on a pinned machine (`crossMachineLanes`):
 * the forced read the launch asks for runs on the next coalesced tick (0.4 s, or
 * up to `FOREIGN_MACHINE_REFRESH_MS`, 10 s, if a tick is already armed). If that
 * read times out (`MACHINE_READ_TIMEOUT_MS`, 8 s) it stamps no clock, so the
 * next poll (10 s later) carries the chat: about 28 s, plus a round trip. 40 s
 * covers that with headroom. It also caps how long a window that never listed
 * the chat can show a deleted or archived one, counted in visible time, for a
 * delete no event reached (archive emits none; see
 * `retireChatLaunchBridgesForSession`).
 */
export const CHAT_LAUNCH_BRIDGE_TTL_MS = 40 * 1000;

/**
 * Visible time a bridge is topped up to, once, on the return that finds less than
 * this left (`syncChatLaunchBridgeClock`), so the first read after the window is
 * back can land. That read is forced on return and normally runs on the 0.4 s
 * coalesced tick (`REFRESH_COALESCE_MS`). If it times out (`MACHINE_READ_TIMEOUT_MS`,
 * 8 s) it stamps no clock, and the retry is the next poll, `FOREIGN_MACHINE_REFRESH_MS`
 * (10 s) after that: 0.4 + 8 + 10 = 18.4 s, plus a round trip, so 20 s. Once granted,
 * later returns keep only the visible time left, so a bridge is listed for at most
 * `CHAT_LAUNCH_BRIDGE_TTL_MS` plus this, however many hide/show cycles.
 */
export const CHAT_LAUNCH_BRIDGE_RETURN_GRACE_MS = 20 * 1000;

/**
 * A started chat whose row stays listed until the host's own row for it lands.
 *
 * The agent is up, but the chat's machine has not listed the chat yet: the
 * active roster refresh and a pinned machine's next slice read both lag the
 * start. Dropping the stand-in in that gap hands the open tab to the first old
 * chat (`WorkViewArea` falls back to `visibleSessions[0]`). The bridge lapses
 * `CHAT_LAUNCH_BRIDGE_TTL_MS` after its clock (`chatLaunchBridgeClockMs`), and
 * never resumes once the roster has listed the real chat (`bridgeRetired`): a chat
 * deleted or archived after that must not reappear as a running row.
 */
export function shouldBridgeChatLaunchRow(source: ChatLaunchRowSource, nowMs: number): boolean {
  const { snapshot, bridgeRetired } = source;
  const clockMs = chatLaunchBridgeClockMs(source);
  return snapshot.kind === "chat"
    && !bridgeRetired
    && Boolean(snapshot.sessionId)
    && snapshot.sessionCreated
    && isChatLaunchSucceeded(snapshot)
    && clockMs != null
    && nowMs - clockMs < CHAT_LAUNCH_BRIDGE_TTL_MS;
}

/**
 * The local time a bridge's TTL counts from: when this window saw the launch
 * start, or the bridge's clock base after a hidden stretch, whichever is later.
 * Null when the launch never stopped pending here.
 */
function chatLaunchBridgeClockMs(source: ChatLaunchRowSource): number | null {
  const { pendingEndedAtMs, bridgeClock } = source;
  if (pendingEndedAtMs == null) return null;
  return Math.max(pendingEndedAtMs, bridgeClock?.baseMs ?? pendingEndedAtMs);
}

/** When the next bridged row lapses, or null when none is bridging. Drives the roster's expiry timer. */
export function nextChatLaunchBridgeExpiryMs(sources: readonly ChatLaunchRowSource[], nowMs: number): number | null {
  let next: number | null = null;
  for (const source of sources) {
    const clockMs = chatLaunchBridgeClockMs(source);
    if (clockMs == null || !shouldBridgeChatLaunchRow(source, nowMs)) continue;
    const expiresAtMs = clockMs + CHAT_LAUNCH_BRIDGE_TTL_MS;
    if (next == null || expiresAtMs < next) next = expiresAtMs;
  }
  return next;
}

/**
 * Runs each started launch's bridge clock on the visible time this window can read.
 *
 * Reads stop while the window is hidden, and nothing can tell it whether the host
 * has listed the chat yet. So while hidden the roster freezes the clock at the hide
 * (`hiddenSinceMs`) and arms no expiry timer. On return, a bridge still running at
 * the hide keeps the visible time it had already used, so hide/show cycles cannot
 * stretch its budget. The first return that leaves less than
 * `CHAT_LAUNCH_BRIDGE_RETURN_GRACE_MS` tops it up to that, once per bridge. A bridge
 * that lapsed before the hide stays lapsed. One that started while hidden has used
 * nothing, so it gets its full TTL from first visibility.
 * Idempotent: called on every visibility change and focus.
 */
export function syncChatLaunchBridgeClock(hidden: boolean, nowMs: number = Date.now()): void {
  if (hidden) {
    pauseChatLaunchBridges(nowMs);
    return;
  }
  const hiddenSinceMs = chatLaunchStore.getState().hiddenSinceMs;
  if (hiddenSinceMs == null) return;
  const clocks: Record<string, ChatLaunchBridgeClock> = {};
  for (const source of chatLaunchRowSourcesNow()) {
    const clockMs = chatLaunchBridgeClockMs(source);
    if (clockMs == null || !shouldBridgeChatLaunchRow(source, hiddenSinceMs)) continue;
    // Visible time the bridge had used at the hide; none if the launch started while hidden.
    const usedMs = Math.max(0, hiddenSinceMs - clockMs);
    const graceUsed = source.bridgeClock?.graceUsed ?? false;
    const grant = !graceUsed && CHAT_LAUNCH_BRIDGE_TTL_MS - usedMs < CHAT_LAUNCH_BRIDGE_RETURN_GRACE_MS;
    const countedMs = grant ? CHAT_LAUNCH_BRIDGE_TTL_MS - CHAT_LAUNCH_BRIDGE_RETURN_GRACE_MS : usedMs;
    clocks[source.snapshot.launchId] = { baseMs: nowMs - countedMs, graceUsed: graceUsed || grant };
  }
  resumeChatLaunchBridges(clocks);
}

/**
 * The launches the Work roster lists: the active binding's, plus those pinned
 * to the same project on another machine (`sameProjectBindingKeys`). Another
 * project's launch never shows here. A started chat stays listed while it is
 * bridging (see `shouldBridgeChatLaunchRow`).
 */
export function selectRosterChatLaunches(
  sources: readonly ChatLaunchRowSource[],
  activeBindingKey: string,
  sameProjectBindingKeys: ReadonlySet<string>,
  nowMs: number = Date.now(),
): ChatLaunchSnapshot[] {
  return sources
    .filter((source) => source.bindingKey === activeBindingKey || sameProjectBindingKeys.has(source.bindingKey))
    .filter((source) => shouldListChatLaunchRow(source.snapshot) || shouldBridgeChatLaunchRow(source, nowMs))
    .map((source) => source.snapshot);
}

/**
 * Session ids owned by a live launch on this project — listed or not.
 *
 * A launch row can outlive its listing (see `shouldBridgeChatLaunchRow`) while
 * the host's own row for it lands only on the next roster read. Work keeps these
 * ids valid across that gap so an open tab is not dropped (and the active chat
 * moved) in the hand-off.
 */
export function selectKnownLaunchSessionIds(
  sources: readonly ChatLaunchRowSource[],
  activeBindingKey: string,
  sameProjectBindingKeys: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const source of sources) {
    if (source.bindingKey !== activeBindingKey && !sameProjectBindingKeys.has(source.bindingKey)) continue;
    const { snapshot } = source;
    if (snapshot.kind !== "chat" || snapshot.phase === "cancelled") continue;
    ids.add(snapshot.sessionId ?? snapshot.launchId);
  }
  return ids;
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
 * Merge the launch rows the roster lists (`selectRosterChatLaunches`) into a
 * roster. A real row with the same id always wins; launch rows only fill ids
 * the roster does not have yet.
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
