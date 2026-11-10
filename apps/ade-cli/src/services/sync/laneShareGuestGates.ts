import type { WebSocket } from "ws";
import type {
  LaneShareTerminalInputRefusalCode,
  SyncCommandAckPayload,
  SyncCommandPayload,
  SyncCommandResultPayload,
  SyncTerminalInputAckPayload,
} from "../../../../desktop/src/shared/types";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { createAgentChatService } from "../../../../desktop/src/main/services/chat/agentChatService";
import type { LaneShareRightsStore } from "../../../../desktop/src/main/services/lanes/laneShareRightsStore";
import { toOptionalString } from "../../../../desktop/src/main/services/shared/utils";
import {
  laneShareRightsEnded,
  type LaneShareGuestPresence,
  type LaneShareGuestState,
} from "../../../../desktop/src/shared/laneShareRights";
import {
  evaluateLaneShareGuestCommand,
  filterLaneShareGuestCommandResult,
  LANE_SHARE_GUEST_HOST_COMMANDS,
  LANE_SHARE_GUEST_INBOUND,
  laneShareGuestFileRequest,
  laneShareGuestMayReceive,
  laneShareGuestMaySeeSession,
  laneShareGuestSessionInfo,
  laneShareGuestTakeRate,
  type LaneShareGuestRole,
  type LaneShareGuestSessionInfo,
} from "./laneShareGuestPolicy";
import {
  filterLaneShareActionHistory,
  filterLaneShareHistory,
  laneShareEventBeforeCutoff,
  laneShareHideMachines,
  laneShareHideModels,
  laneShareScrubFileResponse,
  laneShareScrubOwnerOnlyCards,
} from "./laneShareGuestScrub";
import { createLaneShareGuestCommandPrep } from "./laneShareGuestCommandPrep";
import { LaneShareMoveError, type LaneShareMoveService } from "./laneShareMoveService";
import type { ParsedSyncEnvelope } from "./syncProtocol";
import type { ChatScopeRequest, LaneShareGuestPeer, LaneShareGuestSyncHostDeps, LaneShareTurnOwner } from "./laneShareGuestTypes";
import {
  commandErrorResult,
  evaluateRemoteCommandPolicy,
  type SyncRemoteCommandExecutionContext,
} from "./syncRemoteCommandService";

/**
 * The lane share guest gates of the sync host (`laneShareGuestHost.ts` owns
 * the connection and the grants): the outbound gate in the host's `send*`,
 * the queued and unqueued inbound gates, and the guest command path. Every
 * gate is default refuse.
 */

export type LaneShareGuestGatesDeps = LaneShareGuestSyncHostDeps & {
  args: {
    logger: Logger;
    projectId?: string | null;
    agentChatService?: ReturnType<typeof createAgentChatService>;
    laneShareMoves?: LaneShareMoveService | null;
  };
  /** The guest host's state and rules. */
  host: {
    laneShareRights: LaneShareRightsStore | null;
    laneShareGuestPeersBySocket: ReadonlyMap<WebSocket, LaneShareGuestPeer>;
    laneShareTurnOwners: Map<string, LaneShareTurnOwner>;
    laneShareRunningTurns: Map<string, string | null>;
    resolveLaneShareSession(sessionId: string): LaneShareGuestSessionInfo | null;
    laneShareHistoryCutoffFor(role: LaneShareGuestRole): number | null;
    laneShareLaneState(laneId: string | null | undefined): "active" | "archived" | "missing";
    connectedLaneShareGuests(): LaneShareGuestPeer[];
    endLaneShareGuest(peer: LaneShareGuestPeer, role: LaneShareGuestRole, reason: string): void;
    earliestLaneShareEnd(a: number | null, b: number | null): number | null;
  };
};

export function createLaneShareGuestGates(deps: LaneShareGuestGatesDeps) {
  const {
    args,
    sendRequired,
    remoteCommandService,
    readBrainMetadata,
    getLocalActiveLaneIds,
    hostProjectIdAliases,
    projectIdMatchesHost,
    safeObjectValue,
    requestedProjectChatScope,
    normalizeTerminalInputId,
  } = deps;
  const {
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
  } = deps.host;

  /**
   * Default refuse for everything that leaves this host toward a guest.
   * Returns the payload to send (history from before the share removed when
   * the rights hide it), or null to send nothing. Other peers pay one map
   * lookup.
   */
  function laneShareGuestOutboundPayload<TPayload>(ws: WebSocket, type: string, payload: TPayload): { payload: TPayload } | null {
    const role = laneShareGuestPeersBySocket.get(ws)?.laneShareGuest;
    if (!role) return { payload };
    const blocked = (): null => {
      args.logger.debug("sync_host.lane_share_guest_outbound_blocked", { type, guestUserId: role.userId });
      return null;
    };
    if (!laneShareGuestMayReceive(role, type, payload, resolveLaneShareSession)) return blocked();
    const out = (value: TPayload) => {
      const scrubbed = laneShareHideModels(
        laneShareScrubOwnerOnlyCards(type === "file_response" ? laneShareScrubFileResponse(value) : value),
        role.rights,
      );
      // The hello reply carries the id made for this share (`laneShareOpaqueHostId`).
      return { payload: type === "hello_ok" ? scrubbed : laneShareHideMachines(scrubbed, role.rights) };
    };
    const cutoff = laneShareHistoryCutoffFor(role);
    if (cutoff == null) return out(payload);
    if (type === "chat_event") return laneShareEventBeforeCutoff(payload, cutoff) ? blocked() : out(payload);
    // A tool result can belong to a turn from before the share; it carries no time.
    if (type === "chat_tool_result") return blocked();
    if (type === "chat_subscribe" || type === "chat_history") {
      return out(filterLaneShareHistory(payload, cutoff) as TPayload);
    }
    if (type === "terminal_snapshot" || type === "terminal_history") {
      // Terminal output carries no time per line: a session that started
      // before the share shows its live output only.
      const sessionId = payload && typeof payload === "object" ? (payload as { sessionId?: unknown }).sessionId : null;
      const info = typeof sessionId === "string" ? laneShareGuestSessionInfo(role, sessionId, resolveLaneShareSession) : null;
      if (!info || info.startedAtMs == null || info.startedAtMs < cutoff) return blocked();
    }
    return out(payload);
  }

  /** A typing refusal's code on the wire: `lane_share_*` or `forbidden_command`, and nothing else. */
  function laneShareTerminalRefusalCode(code: string): LaneShareTerminalInputRefusalCode {
    return code.startsWith("lane_share_") ? code as `lane_share_${string}` : "forbidden_command";
  }

  /**
   * Queued inbound gate for a guest. Unlisted types are refused; a type that
   * names a session needs that session to be in a granted lane on this host.
   * A refused envelope gets no reply, so a guest cannot tell whether a
   * session of another lane exists.
   */
  function admitLaneShareGuestEnvelope(peer: LaneShareGuestPeer, role: LaneShareGuestRole, envelope: ParsedSyncEnvelope): boolean {
    const rule = LANE_SHARE_GUEST_INBOUND.get(envelope.type);
    const payload = safeObjectValue(envelope.payload);
    let admitted = false;
    if (!laneShareGuestTakeRate(role)) {
      admitted = false;
    } else if (rule === "none" || rule === "command") {
      admitted = true;
    } else if (rule === "session") {
      // Only the active project's chats: never a personal or another project's chat.
      const projectScoped = envelope.type.startsWith("chat_")
        ? payload?.chatScope == null && requestedProjectChatScope(payload as ChatScopeRequest | null) === "project"
        : true;
      // A tool result can belong to a turn from before the share, and it has no time.
      const historyHidden = envelope.type === "chat_tool_result" && laneShareHistoryCutoffFor(role) != null;
      admitted = projectScoped
        && !historyHidden
        && laneShareGuestMaySeeSession(role, payload?.sessionId, resolveLaneShareSession);
    } else if (rule === "file") {
      // Rebuilt from the listed read arguments, in the granted lane's worktree.
      const rebuilt = laneShareGuestFileRequest(role, envelope.payload);
      if (rebuilt && laneShareLaneState(String(rebuilt.args.workspaceId)) === "active") {
        envelope.payload = rebuilt;
        admitted = true;
      }
    }
    if (!admitted) {
      args.logger.warn("sync_host.lane_share_guest_refused_envelope", {
        type: envelope.type,
        guestUserId: role.userId,
      });
    }
    return admitted;
  }

  /** The whole command path for a guest. Never the command cache, never another project. */
  async function handleLaneShareGuestCommand(
    peer: LaneShareGuestPeer,
    role: LaneShareGuestRole,
    requestId: string | null,
    payload: SyncCommandPayload,
    signal: AbortSignal,
  ): Promise<void> {
    const commandId = toOptionalString(payload.commandId) ?? requestId ?? `cmd-${Date.now()}`;
    const action = typeof payload.action === "string" ? payload.action : "";
    const reply = (result: SyncCommandResultPayload, ack: SyncCommandAckPayload): void => {
      sendRequired(peer, "command_ack", ack, requestId, { action });
      sendRequired(peer, "command_result", result, requestId, { action });
    };
    const reject = (message: string, code = "forbidden_command", resetAt?: number | null): void => {
      args.logger.warn("sync_host.lane_share_guest_refused_command", { action, code, guestUserId: role.userId });
      reply(
        { commandId, ok: false, error: { code, message, ...(resetAt != null ? { resetAt } : {}) } },
        { commandId, accepted: false, status: "rejected", message },
      );
    };
    const requestedProjectId = toOptionalString(payload.projectId);
    const hostProjectId = toOptionalString(args.projectId);
    if (requestedProjectId && !projectIdMatchesHost(requestedProjectId, hostProjectId, hostProjectIdAliases)) {
      reject("This is not available on a shared lane.");
      return;
    }
    const rawArgs = payload.args && typeof payload.args === "object" && !Array.isArray(payload.args)
      ? payload.args as Record<string, unknown>
      : {};
    if (action === "laneShare.move" || !LANE_SHARE_GUEST_HOST_COMMANDS.has(action)) {
      if (laneShareRightsEnded(role.rights, Date.now())) {
        reject("This share has ended.", "lane_share_ended");
        endLaneShareGuest(peer, role, "Lane share ended");
        return;
      }
    }
    if (action === "laneShare.move") {
      await handleLaneShareGuestMove(peer, role, commandId, rawArgs, reply, reject);
      return;
    }
    if (LANE_SHARE_GUEST_HOST_COMMANDS.has(action)) {
      reply(
        { commandId, ok: true, result: laneShareGuestState(role) },
        { commandId, accepted: true, status: "accepted", message: `Executing ${action}.` },
      );
      return;
    }
    const policyRejection = evaluateRemoteCommandPolicy({
      action,
      descriptor: remoteCommandService.getDescriptor(action as SyncCommandPayload["action"]),
      peer,
      requestedProjectId: hostProjectId,
      hostProjectId,
    });
    if (policyRejection) {
      reject(policyRejection.message, policyRejection.code);
      return;
    }
    const gate = evaluateLaneShareGuestCommand({ action, args: rawArgs, role, resolveSession: resolveLaneShareSession });
    if (!gate.ok) {
      reject(gate.refusal.message, gate.refusal.code);
      return;
    }
    const laneId = gate.session?.laneId ?? toOptionalString(gate.args.laneId) ?? role.grants[0]?.laneId ?? null;
    if (laneShareLaneState(laneId) !== "active") {
      reject("The owner paused this shared lane.", "lane_share_paused");
      return;
    }
    // Every guest command runs read only: a handler that would write on a
    // read (resume targets) skips that write.
    const context: SyncRemoteCommandExecutionContext = { signal, readOnly: true };
    const run = (runAction: string, runArgs: Record<string, unknown>) => remoteCommandService.execute({
      ...payload,
      action: runAction as SyncCommandPayload["action"],
      args: runArgs,
      ...(hostProjectId ? { projectId: hostProjectId } : {}),
    }, context);
    const prepared = await prepareLaneShareGuestCommand(action, gate.args, role, context, run);
    if (!prepared.ok) {
      reject(prepared.refusal.message, prepared.refusal.code, prepared.refusal.resetAt);
      return;
    }
    const undoPrepared = (): void => {
      if (prepared.claim) laneShareRights?.refundMessage(prepared.claim);
      if (prepared.hold) laneShareRights?.settleItem(role.grantId, prepared.hold.kind, prepared.hold.holdId, null);
    };
    // The checks above awaited: the guest may have been closed, or its rights
    // changed, meanwhile. Checked again right before the action, with no
    // await in between.
    const stillAllowed = peer.authenticated
      && peer.laneShareGuest === role
      && !laneShareRightsEnded(role.rights, Date.now())
      && evaluateLaneShareGuestCommand({ action, args: rawArgs, role, resolveSession: resolveLaneShareSession }).ok;
    if (!stillAllowed) {
      undoPrepared();
      reject("Your access to this shared lane changed. Try again.", "lane_share_rights_changed");
      return;
    }
    sendRequired(peer, "command_ack", {
      commandId,
      accepted: true,
      status: "accepted",
      message: `Executing ${action}.`,
    } satisfies SyncCommandAckPayload, requestId, { action });
    try {
      const created = await run(action, prepared.args);
      if (prepared.hold) {
        const id = created && typeof created === "object" ? toOptionalString((created as { id?: unknown }).id) : null;
        laneShareRights?.settleItem(role.grantId, prepared.hold.kind, prepared.hold.holdId, id ?? null);
      }
      recordLaneShareGuestResult(action, prepared.args, role, created);
      const cutoff = laneShareHistoryCutoffFor(role);
      sendRequired(peer, "command_result", {
        commandId,
        ok: true,
        result: filterLaneShareActionHistory(
          action,
          filterLaneShareHistory(
            filterLaneShareGuestOwnItems(action, filterLaneShareGuestCommandResult(action, created, role), role),
            cutoff,
          ),
          cutoff,
        ),
      } satisfies SyncCommandResultPayload, requestId, { action });
    } catch (error) {
      undoPrepared();
      sendRequired(peer, "command_result", commandErrorResult(commandId, error), requestId, { action });
    }
  }

  /**
   * `laneShare.move`: one step of a move to or from this guest
   * (`laneShareMoveService.ts`). The grant, lane, user id, name and rights
   * come from the host's role, never from the client; the move service binds
   * each step to the move id and the consent state. A share that ended
   * closes the guest here, as for every other command.
   */
  async function handleLaneShareGuestMove(
    peer: LaneShareGuestPeer,
    role: LaneShareGuestRole,
    commandId: string,
    rawArgs: Record<string, unknown>,
    reply: (result: SyncCommandResultPayload, ack: SyncCommandAckPayload) => void,
    reject: (message: string, code?: string) => void,
  ): Promise<void> {
    const moves = args.laneShareMoves;
    if (!moves) {
      reject("This computer cannot move chats on a shared lane.", "lane_share_unavailable");
      return;
    }
    const grant = role.grants[0];
    if (!grant) {
      reject("This share has ended.", "lane_share_ended");
      return;
    }
    try {
      const result = await moves.guestCommand(
        { grantId: role.grantId, laneId: grant.laneId, userId: role.userId, name: role.name, rights: role.rights },
        rawArgs,
      );
      // The guest may have been closed while the step awaited.
      if (!peer.authenticated || peer.laneShareGuest !== role) return;
      reply(
        { commandId, ok: true, result },
        { commandId, accepted: true, status: "accepted", message: "Executing laneShare.move." },
      );
    } catch (error) {
      const code = error instanceof LaneShareMoveError ? error.code : "lane_share_move_failed";
      reject(error instanceof Error ? error.message.slice(0, 300) : "The move failed.", code);
    }
  }

  const laneShareGuestCommandPrep = createLaneShareGuestCommandPrep({
    chat: () => args.agentChatService,
    laneShareRights,
    logger: args.logger,
    runningTurns: laneShareRunningTurns,
    turnOwners: laneShareTurnOwners,
    resolveSession: resolveLaneShareSession,
    laneState: laneShareLaneState,
  });
  const {
    prepareLaneShareGuestCommand,
    recordLaneShareGuestResult,
    filterLaneShareGuestOwnItems,
    laneShareGuestTypingRefusal,
  } = laneShareGuestCommandPrep;

  /** What the guest may know of its own share: rights, limits, locks, presence, pause. */
  function laneShareGuestState(role: LaneShareGuestRole): LaneShareGuestState {
    const grant = role.grants[0];
    const laneId = grant?.laneId ?? "";
    const usage = laneShareRights?.usage(role.grantId) ?? null;
    const brain = readBrainMetadata();
    const hide = role.rights.privacy.hideMachines;
    const present: LaneShareGuestPresence[] = [];
    if (getLocalActiveLaneIds().has(laneId)) present.push({ kind: "owner", name: hide ? null : brain.deviceName });
    for (const peer of connectedLaneShareGuests()) {
      const other = peer.laneShareGuest!;
      if (other.grantId !== role.grantId) continue;
      present.push({ kind: "guest", name: other.name, ...(other === role ? { self: true } : {}) });
    }
    return {
      grantId: role.grantId,
      laneId,
      state: laneShareLaneState(laneId) === "archived" ? "paused" : "active",
      endsAt: earliestLaneShareEnd(grant?.endsAtMs ?? null, role.rights.limits.endsAt),
      rights: role.rights,
      models: [...role.rights.run.models],
      limits: {
        messagesPerDay: role.rights.limits.messagesPerDay,
        messagesTotal: role.rights.limits.messagesTotal,
        messagesLeftToday: usage?.messagesLeftToday ?? null,
        messagesLeftTotal: usage?.messagesLeftTotal ?? null,
        dailyResetAt: usage?.dailyResetAt ?? null,
      },
      machine: hide ? null : { name: brain.deviceName, platform: String(brain.platform ?? "") },
      present,
      move: args.laneShareMoves?.guestView({ grantId: role.grantId }) ?? null,
    };
  }

  /**
   * Unqueued inbound gate for a guest: the top of the host's
   * `handleImmediateControlEnvelope`. True: refused here; false: not an
   * immediate envelope (the queued path and its guest gate take it); null:
   * not a guest's, or a typing line the gate allows: the host goes on.
   */
  function admitLaneShareGuestImmediateEnvelope(peer: LaneShareGuestPeer, envelope: ParsedSyncEnvelope): boolean | null {
    if (!peer.laneShareGuest || envelope.type === "relay_reauthorize") return null;
    // Changeset acks never come from a guest. Terminal input does only into
    // a CLI session of the granted lane, with the typing right: never into
    // a shell. Everything else takes the queued path and its guest gate.
    const role = peer.laneShareGuest;
    const refuseEnvelope = (code: string) => {
      args.logger.warn("sync_host.lane_share_guest_refused_envelope", { type: envelope.type, guestUserId: role.userId, code });
    };
    if (envelope.type === "changeset_ack") {
      refuseEnvelope("forbidden_command");
      return true;
    }
    if (envelope.type !== "terminal_input") return false;
    const typingPayload = safeObjectValue(envelope.payload);
    const refusal = laneShareGuestTypingRefusal(role, typingPayload);
    if (refusal) {
      refuseEnvelope(refusal.code);
      // A refused line gets its reason, through the outbound gate (only for a session the guest sees).
      const sessionId = toOptionalString(typingPayload?.sessionId);
      const inputId = normalizeTerminalInputId(typingPayload?.inputId);
      if (sessionId && inputId) {
        sendRequired(peer, "terminal_input_ack", {
          sessionId,
          inputId,
          ok: false,
          duplicate: false,
          error: { code: laneShareTerminalRefusalCode(refusal.code), message: refusal.message, retryable: false },
        } satisfies SyncTerminalInputAckPayload, envelope.requestId);
      }
      return true;
    }
    return null;
  }

  return {
    laneShareGuestOutboundPayload,
    admitLaneShareGuestEnvelope,
    admitLaneShareGuestImmediateEnvelope,
    handleLaneShareGuestCommand,
  };
}
