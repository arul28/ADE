import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import type {
  AgentChatEventEnvelope,
  SyncLaneShareGuestChangedPayload,
} from "../../../../desktop/src/shared/types";
import { toOptionalString } from "../../../../desktop/src/main/services/shared/utils";
import { laneShareRightsEnded, type LaneShareRights } from "../../../../desktop/src/shared/laneShareRights";
import { parseMessageAuthor } from "../../../../desktop/src/shared/messageAuthor";
import {
  laneShareGuestMaySeeSession,
  laneShareSessionKind,
  type LaneShareGuestRole,
  type LaneShareGuestSessionInfo,
} from "./laneShareGuestPolicy";
import { laneShareHistoryCutoff } from "./laneShareGuestScrub";
import {
  activeLaneShareGrantsFor,
  LANE_SHARE_GRANT_MAX_AGE_MS,
  LANE_SHARE_GRANT_REFRESH_MS,
  LaneShareGrantError,
  type LaneShareGrantSnapshot,
} from "./laneShareGrantService";
import { createSyncDpopNonceCache } from "./syncDpop";
import { createLaneShareGuestGates } from "./laneShareGuestGates";
import { createLaneShareGuestHello } from "./laneShareGuestHello";
import { createLaneShareGuestQueue } from "./laneShareGuestQueue";
import type { LaneShareCloseResult, LaneShareGuestHostDeps, LaneShareGuestPeer, LaneShareTurnOwner } from "./laneShareGuestTypes";

export type { LaneShareCloseResult, LaneShareGuestHandoff, LaneShareGuestHostDeps, LaneShareGuestPeer } from "./laneShareGuestTypes";

/** Session updates of a shared lane reach its guests at most this often (`notifyLaneShareLaneChanged`). */
const LANE_SHARE_LANE_CHANGE_DEBOUNCE_MS = 5_000;

/**
 * The lane share guest host of the sync host: the grants and rights of
 * connected guests, their queued messages, presence and the grant refresh.
 * `laneShareGuestHello.ts` holds the guest hello and hand-off,
 * `laneShareGuestGates.ts` the inbound, outbound and command gates. The sync
 * host keeps only the hook calls.
 */

export function createLaneShareGuestHost(deps: LaneShareGuestHostDeps) {
  const {
    args,
    peers,
    send,
    remoteCommandService,
    readBrainMetadata,
    captureAccountAuthorization,
    isPeerLifecycleCurrent,
    clearPeerAuthTimeout,
    discardChatEventCoalescer,
    isDisposed,
    heartbeatIntervalMs,
    pollIntervalMs,
    compressionThresholdBytes,
    buildSyncHostHelloOkPayload,
  } = deps;

  // ---------------------------------------------------------------------------
  // Lane sharing: guests (package 4b; rights from package 5).
  //
  // A guest is another ADE account the owner of this machine shared one lane
  // with. Its account token never comes here: its hello carries a one-use
  // ticket from the account directory and a DPoP proof over it (relay only).
  // The host redeems the ticket with its owner's token, takes the user id
  // from the directory's answer, and accepts only while that grant is active
  // in the fresh list read in the same call and the hello is signed by the
  // key the ticket was minted for. A guest never gets a pairing record, so it
  // cannot reconnect on any other path, and it never gets a Relay lease to
  // refresh: the grant refresh below bounds its session. What a guest may do
  // comes from the grant's rights in this host's own table
  // (`laneShareRightsStore.ts`), read again on every action. Every gate below
  // is default refuse:
  //   - inbound: `admitLaneShareGuestEnvelope` (queued) and the top of
  //     `handleImmediateControlEnvelope` (unqueued);
  //   - commands: `handleLaneShareGuestCommand`, before the command cache;
  //   - outbound: `laneShareGuestOutboundPayload` in `send`,
  //     `sendRequired` and `sendAndWait`.
  // ---------------------------------------------------------------------------
  // Guests get their own replay cache: a guest names its own device id in its
  // proofs, and that id must never touch the owner's devices' nonces.
  const laneShareGuestDpopNonceCache = createSyncDpopNonceCache();
  let laneShareRefreshTimer: ReturnType<typeof setInterval> | null = null;
  // The relay admits any socket, so a hello must not let anyone make this
  // host call the directory at will. A ticket is single use: one this host
  // already sent to the directory is refused here without a call. And the
  // host sends at most LANE_SHARE_REDEEMS_PER_MINUTE redeems a minute.
  const LANE_SHARE_REDEEMS_PER_MINUTE = 30;
  const LANE_SHARE_TICKETS_SEEN_MAX = 4_096;
  const laneShareTicketsSeen = new Map<string, number>();
  const laneShareRedeemWindow = { startedAtMs: 0, count: 0 };

  /** Claims one directory redeem for `ticket`: refused when seen before or over the rate. */
  function claimLaneShareRedeem(ticket: string): "ok" | "seen" | "busy" {
    const nowMs = Date.now();
    for (const [hash, expiresAtMs] of laneShareTicketsSeen) {
      if (expiresAtMs > nowMs && laneShareTicketsSeen.size < LANE_SHARE_TICKETS_SEEN_MAX) break;
      laneShareTicketsSeen.delete(hash);
    }
    const hash = createHash("sha256").update(ticket, "utf8").digest("hex");
    if (laneShareTicketsSeen.has(hash)) return "seen";
    if (nowMs - laneShareRedeemWindow.startedAtMs >= 60_000) {
      laneShareRedeemWindow.startedAtMs = nowMs;
      laneShareRedeemWindow.count = 0;
    }
    if (laneShareRedeemWindow.count >= LANE_SHARE_REDEEMS_PER_MINUTE) return "busy";
    laneShareRedeemWindow.count += 1;
    // Kept past the directory's two-minute ticket life.
    laneShareTicketsSeen.set(hash, nowMs + 5 * 60_000);
    return "ok";
  }

  /** A session's lane, kind and start, from THIS host's database. Never from the client. */
  function resolveLaneShareSession(sessionId: string): LaneShareGuestSessionInfo | null {
    const row = args.sessionService.get(sessionId) as {
      laneId?: unknown;
      toolType?: unknown;
      startedAt?: unknown;
      orchestrationParentSessionId?: unknown;
    } | null | undefined;
    if (!row) return null;
    const startedAtMs = typeof row.startedAt === "string" ? Date.parse(row.startedAt) : Number.NaN;
    const kind = laneShareSessionKind(typeof row.toolType === "string" ? row.toolType : null);
    // A tracked CLI child keeps its parent on the row; a chat keeps it in its own record.
    const child = Boolean(toOptionalString(row.orchestrationParentSessionId))
      || (kind === "chat" && Boolean(args.agentChatService?.getSessionOrchestrationParentId?.(sessionId)));
    return {
      laneId: toOptionalString(row.laneId) ?? null,
      kind,
      startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
      child,
    };
  }

  const laneShareRights = args.laneShareRights ?? null;

  /**
   * The rights the host enforces for a grant: its stored row. Null when this
   * host has no row (the share was made on another machine, or the store was
   * lost): the guest then gets nothing until the owner sets rights here.
   */
  function laneShareRightsFor(grantId: string): LaneShareRights | null {
    try {
      return laneShareRights?.get(grantId)?.rights ?? null;
    } catch (error) {
      // Fails closed (no rights, nothing admitted), but a store that cannot be read is a defect.
      args.logger.warn("sync_host.lane_share_rights_read_failed", { grantId, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  const guestQueue = createLaneShareGuestQueue({
    laneShareRights,
    grants: () => args.laneShareGrants?.current() ?? null,
    chat: () => args.agentChatService ?? null,
    laneState: (laneId) => laneShareLaneState(laneId),
    rightsMatchLane: (grantId, laneId) => laneShareRightsMatchLane(grantId, laneId),
    logger: args.logger,
  });
  const removeLaneShareQueuedSteers = guestQueue.removeQueued;
  const dropLaneShareQueuedSteersSoon = guestQueue.dropQueuedSoon;

  /**
   * Who started the turn that runs in a chat, for chats where a guest started
   * it, read from the chat's own events. A `user_message` that starts a turn
   * (no steer id) names its author in `metadata.author`, which only the host
   * sets: a guest author makes that turn the guest's, any other author ends
   * the guest's claim. The turn's end (`status` completed, interrupted or
   * failed) ends it too. A send that starts no turn emits no such message, so
   * it claims nothing. No entry: the owner's turn, or one this host cannot
   * attribute; a guest may then stop or steer it only with
   * `speak.interruptAnyTurn`. In memory only: after a restart no turn is a
   * guest's own, which refuses more, never less.
   */
  const laneShareTurnOwners = new Map<string, LaneShareTurnOwner>();
  /** Chats with a turn running now, by the chat's own status events (turn id when it has one). */
  const laneShareRunningTurns = new Map<string, string | null>();

  function trackLaneShareTurns(envelope: AgentChatEventEnvelope): void {
    const event = envelope.event as {
      type?: unknown;
      turnStatus?: unknown;
      turnId?: unknown;
      steerId?: unknown;
      deliveryState?: unknown;
      metadata?: { author?: unknown } | null;
    };
    const sessionId = envelope.sessionId;
    const turnId = typeof event?.turnId === "string" && event.turnId ? event.turnId : null;
    // A chat's summary changed without a session row write (a title, model or
    // mode change; a turn that starts or ends): the lane's guests read their
    // sessions again, at most once per debounce. Nothing runs with no guest.
    if ((event?.type === "session_meta_updated" || event?.type === "status") && laneShareGuestPeersBySocket.size > 0) {
      const laneId = resolveLaneShareSession(sessionId)?.laneId ?? null;
      if (laneId) notifyLaneShareLaneChanged(laneId, false);
    }
    if (event?.type === "user_message") {
      // A steer, queued or delivered, starts no turn of its own. One that left
      // the queue is no longer the guest's to remove.
      if (typeof event.steerId === "string" && event.steerId) {
        if (event.deliveryState !== "queued") guestQueue.forget(event.steerId);
        return;
      }
      const author = parseMessageAuthor(event.metadata?.author);
      if (author?.kind === "guest") laneShareTurnOwners.set(sessionId, { userId: author.userId, turnId });
      else laneShareTurnOwners.delete(sessionId);
      return;
    }
    if (event?.type !== "status") return;
    if (event.turnStatus === "started") {
      laneShareRunningTurns.set(sessionId, turnId);
      return;
    }
    laneShareRunningTurns.delete(sessionId);
    const owner = laneShareTurnOwners.get(sessionId);
    if (owner && (owner.turnId == null || turnId == null || owner.turnId === turnId)) laneShareTurnOwners.delete(sessionId);
  }

  /** Archived lanes pause a share; a deleted lane ends it. No store: the lane is taken as active. */
  function laneShareLaneState(laneId: string | null | undefined): "active" | "archived" | "missing" {
    if (!laneId) return "missing";
    if (!laneShareRights) return "active";
    return laneShareRights.laneState(laneId);
  }

  function laneShareHistoryCutoffFor(role: LaneShareGuestRole): number | null {
    return laneShareHistoryCutoff(role.rights, role.grants[0], role.historyFallbackMs);
  }

  function connectedLaneShareGuests(): LaneShareGuestPeer[] {
    return [...peers].filter((peer) =>
      peer.laneShareGuest != null
      && peer.authenticated
      && peer.ws.readyState === WebSocket.OPEN);
  }

  /**
   * Guest sockets, so the send path checks a socket in O(1) and every other
   * peer pays one map lookup. Removed only when the socket closes.
   */
  const laneShareGuestPeersBySocket = new Map<WebSocket, LaneShareGuestPeer>();

  /**
   * Ends a guest connection. The role stays on the peer, so the outbound gate
   * keeps refusing anything still in flight toward this socket. A running
   * turn on the host is not touched.
   */
  function closeLaneShareGuest(peer: LaneShareGuestPeer, reason: string): void {
    peer.authenticated = false;
    args.logger.info("sync_host.lane_share_guest_closed", {
      reason,
      guestUserId: peer.laneShareGuest?.userId ?? null,
    });
    try {
      peer.ws.close(4003, reason);
    } catch {
      // ignore close failures
    }
  }

  /**
   * The share of this guest ended (removed from the grant list, its end date
   * passed): the connection closes, the messages it queued that have not
   * started go, and a move of its grant is cancelled. Every path that ends a
   * guest's share for good comes here, so none forgets a step.
   */
  function endLaneShareGuest(peer: LaneShareGuestPeer, role: LaneShareGuestRole, reason: string): void {
    closeLaneShareGuest(peer, reason);
    dropLaneShareQueuedSteersSoon(role.grantId);
    args.laneShareMoves?.cancelGrant(role.grantId, "The share ended.");
  }

  function dropLaneShareGuestSubscriptionsOutsideGrants(peer: LaneShareGuestPeer, role: LaneShareGuestRole): void {
    for (const sessionId of [...peer.subscribedChatSessionIds]) {
      if (laneShareGuestMaySeeSession(role, sessionId, resolveLaneShareSession)) continue;
      peer.subscribedChatSessionIds.delete(sessionId);
      peer.hydratingChatSessionIds.delete(sessionId);
      peer.chatSubscriptionBindings.delete(sessionId);
      peer.chatTranscriptOffsets.delete(sessionId);
      peer.chatTranscriptScanOffsets.delete(sessionId);
      peer.chatEventIdsSent.delete(sessionId);
      peer.resolvedChatTranscriptPaths.delete(sessionId);
      peer.projectChatTranscriptPaths.delete(sessionId);
      discardChatEventCoalescer(peer, sessionId);
    }
    for (const sessionId of [...peer.subscribedSessionIds]) {
      if (laneShareGuestMaySeeSession(role, sessionId, resolveLaneShareSession)) continue;
      // The barrier and the subscription together, as the terminal streams drop them.
      peer.pendingTerminalSnapshots.delete(sessionId);
      peer.subscribedSessionIds.delete(sessionId);
    }
  }

  /** The guest's grant (only the one its ticket named) in `snapshot`, if still active. */
  function laneShareGuestGrantsIn(snapshot: LaneShareGrantSnapshot, role: LaneShareGuestRole, nowMs: number) {
    return activeLaneShareGrantsFor(snapshot, role.userId, nowMs)
      .filter((grant) => grant.grantId === role.grantId && laneShareRightsMatchLane(grant.grantId, grant.laneId));
  }

  /**
   * Whether this host's rights row of `grantId` is for `laneId`. A row for
   * another lane is not this share's: its rights are removed, so the share
   * shows "needs rights" to the owner, and nothing is admitted.
   */
  function laneShareRightsMatchLane(grantId: string, laneId: string): boolean {
    let record: { laneId: string } | null = null;
    try {
      record = laneShareRights?.get(grantId) ?? null;
    } catch (error) {
      args.logger.warn("sync_host.lane_share_rights_read_failed", { grantId, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
    if (!record) return false;
    if (record.laneId === laneId) return true;
    args.logger.warn("sync_host.lane_share_rights_lane_mismatch", { grantId });
    try {
      laneShareRights?.deleteRights(grantId);
    } catch {
      // Refused either way.
    }
    return false;
  }

  /** The earlier of two end dates, null when neither is set. */
  function earliestLaneShareEnd(a: number | null, b: number | null): number | null {
    if (a == null) return b;
    if (b == null) return a;
    return Math.min(a, b);
  }

  /** `<prefix>:<32 hex>` from two ids: stable, and neither id can be read back from it. */
  function laneSharePairId(prefix: string, a: string, b: string): string {
    return `${prefix}:${createHash("sha256").update(a, "utf8").update("\0").update(b, "utf8").digest("hex").slice(0, 32)}`;
  }

  /** A stable id for this computer that only this share's guest sees. */
  function laneShareOpaqueHostId(deviceId: string, grantId: string): string {
    return laneSharePairId("shared", deviceId, grantId);
  }

  /** Each good grant read: drop removed grants from every guest; close a guest left with none. */
  function applyLaneShareGrantSnapshot(snapshot: LaneShareGrantSnapshot): void {
    const nowMs = Date.now();
    // A final grant's rights and records go (revoked, left, expired, ended),
    // after the messages its guest queued are removed: a revoke made on
    // another device, a guest who left and an expiry reach this host only
    // through this list.
    for (const grantId of snapshot.closedIds ?? []) {
      // A move of a closed grant ends here, connected guest or not.
      args.laneShareMoves?.cancelGrant(grantId, "The share ended.");
      let queued = false;
      try {
        if (!laneShareRights?.get(grantId)) continue;
        queued = laneShareRights.listItems(grantId, "steer").length > 0;
        if (!queued) laneShareRights.delete(grantId);
      } catch {
        // A later list removes it.
      }
      if (!queued) continue;
      void removeLaneShareQueuedSteers(grantId)
        .catch((error) => {
          args.logger.warn("sync_host.lane_share_queue_drop_failed", {
            grantId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          try {
            laneShareRights?.delete(grantId);
          } catch {
            // A later list removes it.
          }
        });
    }
    // A row whose grant neither list names (made elsewhere and gone, or a
    // closed grant past the directory's window) goes after a long wait.
    if (laneShareRights && snapshot.complete === true) {
      try {
        const listed = new Set<string>([...snapshot.grants.map((grant) => grant.id), ...(snapshot.closedIds ?? [])]);
        const forgotten = laneShareRights.forgetUnlisted(listed);
        if (forgotten.length > 0) args.logger.info("sync_host.lane_share_rows_forgotten", { count: forgotten.length });
      } catch {
        // The next good list tries again.
      }
    }
    for (const peer of connectedLaneShareGuests()) {
      const role = peer.laneShareGuest!;
      const next = laneShareGuestGrantsIn(snapshot, role, nowMs);
      if (next.length === 0) {
        endLaneShareGuest(peer, role, "Lane share ended");
        continue;
      }
      const same = next.length === role.grants.length
        && next.every((grant, index) =>
          grant.grantId === role.grants[index]?.grantId
          && grant.laneId === role.grants[index]?.laneId
          && grant.endsAtMs === role.grants[index]?.endsAtMs);
      if (same) continue;
      role.grants = next;
      role.name = next[0]?.receiverName ?? role.name;
      role.sessionLanes.clear();
      dropLaneShareGuestSubscriptionsOutsideGrants(peer, role);
    }
    syncLaneShareRefreshTimer();
  }

  /**
   * New rights for a grant reach its connected guests at once: the next
   * action, envelope and outgoing message use them, and subscriptions the new
   * rights do not see are dropped.
   */
  function applyLaneShareRights(grantId: string): number {
    let applied = 0;
    for (const peer of connectedLaneShareGuests()) {
      const role = peer.laneShareGuest!;
      if (role.grantId !== grantId) continue;
      const rights = laneShareRightsFor(grantId);
      if (!rights) {
        closeLaneShareGuest(peer, "lane_share_rights_missing");
        continue;
      }
      role.rights = rights;
      role.sessionLanes.clear();
      dropLaneShareGuestSubscriptionsOutsideGrants(peer, role);
      applied += 1;
    }
    notifyLaneShareGuests((role) => role.grantId === grantId);
    // A guest that lost Collaborate keeps no move of its own going; no rights end every move.
    args.laneShareMoves?.rightsChanged(grantId, laneShareRightsFor(grantId));
    // Rights that no longer send or steer, or an end date that has passed:
    // the guest's queued messages go too, connected or not.
    const rights = laneShareRightsFor(grantId);
    if (!rights || (!rights.speak.send && !rights.speak.steer) || laneShareRightsEnded(rights, Date.now())) {
      dropLaneShareQueuedSteersSoon(grantId);
    }
    return applied;
  }

  /**
   * The lane's sessions or name changed: its connected guests read their
   * state and session list again (`lane_share_guest_changed`). A new or
   * removed session, a rename or a branch change tells them at once; other
   * session updates (status notes, activity) at most once per
   * `LANE_SHARE_LANE_CHANGE_DEBOUNCE_MS`. With no guest connected it does
   * nothing. A null lane reaches every guest (a removed session whose lane
   * is no longer known).
   */
  const pendingLaneChangeNotices = new Map<string, ReturnType<typeof setTimeout>>();
  function notifyLaneShareLaneChanged(laneId: string | null, urgent: boolean): void {
    if (laneShareGuestPeersBySocket.size === 0) return;
    const key = laneId ?? "";
    const fire = () => {
      pendingLaneChangeNotices.delete(key);
      notifyLaneShareGuests((role) => laneId == null || role.grants.some((grant) => grant.laneId === laneId));
    };
    const pending = pendingLaneChangeNotices.get(key);
    if (urgent) {
      if (pending) clearTimeout(pending);
      fire();
      return;
    }
    if (pending) return;
    const timer = setTimeout(fire, LANE_SHARE_LANE_CHANGE_DEBOUNCE_MS);
    timer.unref?.();
    pendingLaneChangeNotices.set(key, timer);
  }

  /** Closes every guest connection of a lane (archived: the share pauses). */
  function closeLaneShareLane(laneId: string, reason: string): number {
    let closed = 0;
    for (const peer of connectedLaneShareGuests()) {
      if (!peer.laneShareGuest!.grants.some((grant) => grant.laneId === laneId)) continue;
      closeLaneShareGuest(peer, reason);
      closed += 1;
    }
    for (const record of laneShareRights?.list() ?? []) {
      if (record.laneId === laneId) args.laneShareMoves?.cancelGrant(record.grantId, "The owner paused this shared lane.");
    }
    syncLaneShareRefreshTimer();
    return closed;
  }

  /**
   * Ends a share on this host at once (revoke, lane deleted): closes the
   * guest's connections, removes the messages it queued that have not
   * started, and reports each chat where a turn it started still runs. A
   * running turn is not stopped: the owner decides.
   */
  async function closeLaneShareGrant(grantId: string, reason: string): Promise<LaneShareCloseResult> {
    // A move of this grant ends first: no chunk or landing goes on after a revoke.
    args.laneShareMoves?.cancelGrant(grantId, "The share ended.");
    let closedConnections = 0;
    let guestName: string | null = null;
    for (const peer of connectedLaneShareGuests()) {
      if (peer.laneShareGuest!.grantId !== grantId) continue;
      guestName = guestName ?? peer.laneShareGuest!.name;
      closeLaneShareGuest(peer, reason);
      closedConnections += 1;
    }
    syncLaneShareRefreshTimer();
    const removedQueuedMessages = await removeLaneShareQueuedSteers(grantId);
    const runningTurnSessionIds: string[] = [];
    const chat = args.agentChatService;
    if (laneShareRights && chat) {
      for (const turn of laneShareRights.listItems(grantId, "turn")) {
        try {
          const summary = await chat.getSessionSummary(turn.itemId);
          if (summary?.status === "active") runningTurnSessionIds.push(turn.itemId);
        } catch {
          // A chat that cannot be read is not reported.
        }
      }
    }
    for (const sessionId of runningTurnSessionIds) {
      const who = guestName ?? "the guest";
      args.onLaneShareEvent?.({
        type: "lane_share_guest_turn_running",
        grantId,
        sessionId,
        guestName,
        message: `A turn started by ${who} is still running.`,
      });
    }
    args.logger.info("sync_host.lane_share_grant_closed", {
      grantId,
      reason,
      closedConnections,
      removedQueuedMessages,
      runningTurns: runningTurnSessionIds.length,
    });
    return { closedConnections, removedQueuedMessages, runningTurnSessionIds };
  }

  /** Tells the owner's clients that a guest device came or went (no names, no device ids). */
  function emitLaneSharePresence(role: LaneShareGuestRole): void {
    try {
      args.onLaneShareEvent?.({ type: "lane_share_presence_changed", grantId: role.grantId, laneId: role.grants[0]?.laneId ?? null });
    } catch {
      // A listener failure never touches the connection.
    }
    // The grant's other devices read who is here again. The new device reads it after hello_ok.
    notifyLaneShareGuests((other) => other !== role && other.grantId === role.grantId);
  }

  /**
   * Tells connected guests that their state changed (presence, rights,
   * limits). The payload is only the grant id: the guest reads its state
   * again through `laneShare.getGuestState`, which applies the privacy rules.
   */
  function notifyLaneShareGuests(matches: (role: LaneShareGuestRole) => boolean): void {
    if (laneShareGuestPeersBySocket.size === 0) return;
    for (const peer of connectedLaneShareGuests()) {
      const role = peer.laneShareGuest!;
      if (matches(role)) send(peer, "lane_share_guest_changed", { grantId: role.grantId } satisfies SyncLaneShareGuestChangedPayload);
    }
  }

  /** Connected devices of a grant's guest, for the owner's list. */
  function laneShareConnectedDevices(grantId: string): number {
    return connectedLaneShareGuests().filter((peer) => peer.laneShareGuest!.grantId === grantId).length;
  }

  /**
   * Runs on every tick, before and whatever the read does, so a slow or hung
   * read never delays a close: a guest goes once the last good list is older
   * than the bound, or once its grant's end passed on the host clock.
   */
  function enforceLaneShareGrantAge(): void {
    const current = args.laneShareGrants?.current() ?? null;
    const nowMs = Date.now();
    const fresh = Boolean(current && nowMs - current.fetchedAtMs <= LANE_SHARE_GRANT_MAX_AGE_MS);
    for (const peer of connectedLaneShareGuests()) {
      const role = peer.laneShareGuest!;
      if (!fresh) {
        closeLaneShareGuest(peer, "This machine could not check its shared lanes");
      } else if (
        laneShareRightsEnded(role.rights, nowMs)
        || role.grants.every((grant) => grant.endsAtMs != null && grant.endsAtMs <= nowMs)
      ) {
        endLaneShareGuest(peer, role, "Lane share ended");
      }
    }
    // Queued messages, guest connected or not: a share that may no longer
    // send loses them. No list read yet (just started): the next tick decides.
    if (current) {
      for (const grantId of guestQueue.grantsWithQueued()) {
        if (!guestQueue.mayStart(grantId, null)) dropLaneShareQueuedSteersSoon(grantId);
      }
    }
    syncLaneShareRefreshTimer();
  }

  function closeAllLaneShareGuests(reason: string): void {
    for (const peer of connectedLaneShareGuests()) closeLaneShareGuest(peer, reason);
    syncLaneShareRefreshTimer();
  }

  async function refreshLaneShareGrants(): Promise<void> {
    enforceLaneShareGrantAge();
    if (!args.laneShareGrants) return;
    try {
      // A good read reaches every guest through the subscription below.
      await args.laneShareGrants.refresh();
    } catch (error) {
      // The directory no longer lists this machine for the signed-in account:
      // final, so every guest goes now instead of after the age bound.
      if (error instanceof LaneShareGrantError && error.code === "unknown_machine") {
        closeAllLaneShareGuests("This computer is no longer on the account that shared this lane");
        return;
      }
      enforceLaneShareGrantAge();
    }
  }

  /** Guest work this host still holds with no guest connected: queued guest messages, or a move it runs. */
  function laneShareHasPendingGuestWork(): boolean {
    return guestQueue.grantsWithQueued().length > 0 || args.laneShareMoves?.hasRunningHostMoves?.() === true;
  }

  /**
   * Armed while a guest is connected, a guest's messages wait in a queue, or
   * a move runs here (a guest can disconnect while its move lands): otherwise
   * no timer and no request. Armed for a queue or a move alone, it reads the
   * grants at once.
   */
  function syncLaneShareRefreshTimer(): void {
    const guests = isDisposed() ? 0 : connectedLaneShareGuests().length;
    const needed = !isDisposed() && (guests > 0 || laneShareHasPendingGuestWork());
    if (needed && !laneShareRefreshTimer) {
      laneShareRefreshTimer = setInterval(() => {
        void refreshLaneShareGrants();
      }, LANE_SHARE_GRANT_REFRESH_MS);
      laneShareRefreshTimer.unref?.();
      if (guests === 0) void refreshLaneShareGrants();
    } else if (!needed && laneShareRefreshTimer) {
      clearInterval(laneShareRefreshTimer);
      laneShareRefreshTimer = null;
    }
  }

  const unsubscribeLaneShareGrants = args.laneShareGrants?.subscribe(applyLaneShareGrantSnapshot) ?? null;
  const removeQueuedGuestSteerGate = args.agentChatService?.installQueuedGuestSteerGate?.((input) => {
    const admitted = guestQueue.admit(input);
    syncLaneShareRefreshTimer();
    return admitted;
  }) ?? null;
  // Messages a guest queued before a restart keep the grant checks going
  // (after the sync host finished its own setup).
  queueMicrotask(syncLaneShareRefreshTimer);



  const { handleLaneShareGuestHello, acceptHandedOffLaneShareGuest } = createLaneShareGuestHello({
    ...deps,
    host: {
      laneShareRights,
      laneShareGuestPeersBySocket,
      laneShareGuestDpopNonceCache,
      claimLaneShareRedeem,
      emitLaneSharePresence,
      laneShareConnectedDevices,
      laneShareLaneState,
      laneShareOpaqueHostId,
      laneSharePairId,
      laneShareRightsFor,
      laneShareRightsMatchLane,
      syncLaneShareRefreshTimer,
    },
  });

  const gates = createLaneShareGuestGates({
    ...deps,
    host: {
      laneShareRights,
      laneShareGuestPeersBySocket,
      laneShareTurnOwners,
      laneShareRunningTurns,
      resolveLaneShareSession,
      laneShareHistoryCutoffFor,
      laneShareLaneState,
      connectedLaneShareGuests,
      endLaneShareGuest,
      earliestLaneShareEnd,
    },
  });

  /** A guest's socket closed: the refresh may stop, and the grant's other devices read presence again. */
  function laneShareGuestSocketClosed(peer: LaneShareGuestPeer): void {
    if (!peer.laneShareGuest) return;
    laneShareGuestPeersBySocket.delete(peer.ws);
    syncLaneShareRefreshTimer();
    emitLaneSharePresence(peer.laneShareGuest);
  }

  function dispose(): void {
    gates.disposeLaneShareGates();
    unsubscribeLaneShareGrants?.();
    removeQueuedGuestSteerGate?.();
    if (laneShareRefreshTimer) clearInterval(laneShareRefreshTimer);
    laneShareRefreshTimer = null;
    for (const timer of pendingLaneChangeNotices.values()) clearTimeout(timer);
    pendingLaneChangeNotices.clear();
  }

  return {
    ...gates,
    trackLaneShareTurns,
    handleLaneShareGuestHello,
    acceptHandedOffLaneShareGuest,
    laneShareHasPendingGuestWork,
    notifyLaneShareGuests,
    laneShareGuestSocketClosed,
    refreshLaneShareGrants,
    applyLaneShareRights,
    closeLaneShareGrant,
    closeLaneShareLane,
    notifyLaneShareLaneChanged,
    laneShareConnectedDevices,
    dispose,
  };
}
