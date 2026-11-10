import type { AgentChatProvider } from "../../../../desktop/src/shared/types/chat";
import { MAX_DRAFTS, type AdeMessageAuthor } from "../../../../desktop/src/shared/types/chat";
import { isLaunchProfile, LAUNCH_PROFILE_TOOL_TYPE } from "../../../../desktop/src/shared/cliLaunch";
import { laneShareRightsEnded } from "../../../../desktop/src/shared/laneShareRights";
import {
  LANE_SHARE_PLAIN_TEXT_ONLY,
  LANE_SHARE_PLAIN_TEXT_ONLY_MESSAGE,
  leadingPromptCommandCharacter,
} from "../../../../desktop/src/shared/messageAuthor";
import { isUserOnlyConsentCard } from "../../../../desktop/src/shared/types/macDesktop";
import { toOptionalString } from "../../../../desktop/src/main/services/shared/utils";
import type { LaneShareMessageClaim, LaneShareRightsStore } from "../../../../desktop/src/main/services/lanes/laneShareRightsStore";
import type { createAgentChatService } from "../../../../desktop/src/main/services/chat/agentChatService";
import {
  LANE_SHARE_MAX_GUEST_COMMENTS_PER_SESSION,
  LANE_SHARE_MAX_GUEST_DRAFTS,
  laneShareCheckLocks,
  laneShareCoAuthorNote,
  laneShareEffectiveModes,
  laneShareGuestMayTypeInto,
  laneShareGuestSessionInfo,
  laneShareGuestSubagentBelongs,
  laneShareGuestTakeRate,
  laneShareInputKindRight,
  laneShareSessionKind,
  laneShareSessionWithinLocks,
  laneShareTypedLineRefusal,
  type LaneShareGuestRefusal,
  type LaneShareGuestRole,
  type LaneShareSessionResolver,
} from "./laneShareGuestPolicy";
import type { SyncRemoteCommandExecutionContext } from "./syncRemoteCommandService";

/**
 * The host's checks of a lane share guest's command that need this host's
 * services (`syncHostService.ts` runs the gate, then this, then the action):
 * the locks against the chat as it is now, the message limits (counted
 * here, before the turn), ownership of the draft, comment or queued message
 * a command names, and the card it answers. Sets the verified author.
 */

/** On Windows a CLI starts without exec, so a shell stays when it exits, and the host cannot tell which program has the terminal. */
function laneShareWindowsTypingRefusal(): LaneShareGuestRefusal | null {
  return process.platform === "win32"
    ? { code: "lane_share_right_missing", message: "Typing into a CLI is not available on a shared lane of this computer." }
    : null;
}

export type LaneShareGuestCommandPrepDeps = {
  chat: () => ReturnType<typeof createAgentChatService> | null | undefined;
  laneShareRights: LaneShareRightsStore | null;
  logger: { warn(event: string, fields?: Record<string, unknown>): void };
  /** Chats with a turn running now, by the chat's own status events (turn id when it has one). */
  runningTurns: ReadonlyMap<string, string | null>;
  /** Who started the running turn, for turns a guest started. */
  turnOwners: ReadonlyMap<string, { userId: string; turnId: string | null }>;
  resolveSession: LaneShareSessionResolver;
  laneState: (laneId: string | null | undefined) => "active" | "archived" | "missing";
};

export function createLaneShareGuestCommandPrep(deps: LaneShareGuestCommandPrepDeps) {
  const laneShareRights = deps.laneShareRights;
  const laneShareRunningTurns = deps.runningTurns;
  const laneShareTurnOwners = deps.turnOwners;
  const resolveLaneShareSession = deps.resolveSession;
  const laneShareLaneState = deps.laneState;

  function laneShareGuestOwnsRunningTurn(sessionId: string, role: LaneShareGuestRole): boolean {
    return laneShareTurnOwners.get(sessionId)?.userId === role.userId;
  }

  type LaneShareRun = (action: string, args: Record<string, unknown>) => Promise<unknown>;
  type LaneSharePrepared =
    | {
      ok: true;
      args: Record<string, unknown>;
      claim: LaneShareMessageClaim | null;
      /** A slot held under a cap (`holdItem`) for the item this command makes. */
      hold?: { kind: "draft" | "comment"; holdId: string } | null;
    }
    | { ok: false; refusal: LaneShareGuestRefusal };

  /** A turn runs, or the chat accepted one that has not started yet. */
  function laneShareTurnRunning(summary: { status?: unknown; turnAcceptedAt?: unknown }): boolean {
    return summary.status === "active" || (typeof summary.turnAcceptedAt === "string" && summary.turnAcceptedAt.length > 0);
  }

  /**
   * The turn a guest's message or stop may act on, read from this host's own
   * event tracking with no await before the caller uses it: the guest's own
   * running turn (its id), "no turn" (null) when none runs, or any turn
   * (undefined) with `speak.interruptAnyTurn`. A refusal when someone else's
   * turn runs. The chat service checks the answer again right before it
   * acts (`expectedTurnId`).
   */
  function laneShareExpectedTurn(
    sessionId: string,
    role: LaneShareGuestRole,
    summary: { status?: unknown; turnAcceptedAt?: unknown },
  ): { expected: string | null | undefined } | { refusal: LaneShareGuestRefusal } {
    if (role.rights.speak.interruptAnyTurn) return { expected: undefined };
    const running = laneShareTurnRunning(summary) || laneShareRunningTurns.has(sessionId);
    if (!running) return { expected: null };
    const turnId = laneShareRunningTurns.get(sessionId) ?? laneShareTurnOwners.get(sessionId)?.turnId ?? null;
    if (laneShareGuestOwnsRunningTurn(sessionId, role) && turnId) return { expected: turnId };
    return { refusal: { code: "lane_share_not_your_turn", message: "Someone else's turn is running in this chat. Wait for it to end." } };
  }

  /** A guest's text is a plain prompt: a leading command character is refused (see `leadingPromptCommandCharacter`). */
  function laneSharePlainTextRefusal(text: string, extra: readonly string[] = []): LaneShareGuestRefusal | null {
    return leadingPromptCommandCharacter(text, extra)
      ? { code: LANE_SHARE_PLAIN_TEXT_ONLY, message: LANE_SHARE_PLAIN_TEXT_ONLY_MESSAGE }
      : null;
  }

  /**
   * The pending card a guest names, read from this host's own list. Refused
   * under any rights: a card only the owner may answer
   * (`isUserOnlyConsentCard`), a kind with no mapped right, and a card that
   * is no longer open.
   */
  function laneShareGuestCard(
    sessionId: string | null,
    itemId: string | null,
    role: LaneShareGuestRole,
  ): { kind: string | null } | { refusal: LaneShareGuestRefusal } {
    const chat = deps.chat();
    let match: { kind?: unknown; providerMetadata?: unknown } | undefined;
    try {
      const pending = chat && sessionId ? chat.listPendingInputs({ sessionId }).requests : [];
      match = itemId ? pending.find((request) => request.itemId === itemId || request.requestId === itemId) : undefined;
    } catch {
      match = undefined;
    }
    if (!match || !sessionId || !itemId) return { refusal: { code: "forbidden_command", message: "That question is no longer open." } };
    const metadata = match.providerMetadata && typeof match.providerMetadata === "object"
      ? match.providerMetadata as Record<string, unknown>
      : null;
    let ownerOnly = isUserOnlyConsentCard(metadata);
    try {
      ownerOnly = ownerOnly || chat?.isUserOnlyPendingInput?.({ sessionId, itemId }) === true;
    } catch {
      ownerOnly = true;
    }
    if (ownerOnly) return { refusal: { code: "lane_share_owner_only", message: "Only the owner can answer this." } };
    const kind = typeof match.kind === "string" ? match.kind : null;
    if (!laneShareInputKindRight(role.rights, kind)) {
      return { refusal: { code: "lane_share_right_missing", message: "Your access to this shared lane does not include this decision." } };
    }
    return { kind };
  }

  /** Every free text in a guest's answer to a card: the typed reply and each answer value. */
  function laneShareAnswerTexts(answerArgs: Record<string, unknown>): string[] {
    const texts: string[] = [];
    if (typeof answerArgs.responseText === "string") texts.push(answerArgs.responseText);
    const answers = answerArgs.answers;
    if (answers && typeof answers === "object" && !Array.isArray(answers)) {
      for (const value of Object.values(answers as Record<string, unknown>)) {
        for (const entry of Array.isArray(value) ? value : [value]) if (typeof entry === "string") texts.push(entry);
      }
    }
    return texts;
  }

  const laneShareRefuse = (message: string, code = "forbidden_command"): LaneSharePrepared =>
    ({ ok: false, refusal: { code, message } });

  function laneShareGuestAuthor(role: LaneShareGuestRole): AdeMessageAuthor {
    return { kind: "guest", userId: role.userId, name: role.name };
  }

  /**
   * Why the host refuses a guest's terminal input, or null to write it. Only
   * into a CLI session of the granted lane, with the typing right, never a
   * shell; one plain line each time (`laneShareTypedLineRefusal`), and each
   * line counts as one message.
   */
  function laneShareGuestTypingRefusal(role: LaneShareGuestRole, payload: Record<string, unknown> | null): LaneShareGuestRefusal | null {
    const sessionId = payload?.sessionId;
    if (typeof sessionId !== "string") return { code: "forbidden_command", message: "That session is not part of this shared lane." };
    const windows = laneShareWindowsTypingRefusal();
    if (windows) return windows;
    if (laneShareRightsEnded(role.rights, Date.now())) return { code: "lane_share_ended", message: "This share has ended." };
    if (!laneShareGuestTakeRate(role)) return { code: "lane_share_rate_limited", message: "Too many requests at once. Wait a moment, then try again." };
    if (!laneShareGuestMayTypeInto(role, sessionId, resolveLaneShareSession)) {
      return { code: "lane_share_right_missing", message: "Your access to this shared lane does not include typing in this session." };
    }
    // Cached by the check above: no second session read per line.
    if (laneShareLaneState(laneShareGuestSessionInfo(role, sessionId, resolveLaneShareSession)?.laneId) !== "active") {
      return { code: "lane_share_paused", message: "The owner paused this shared lane." };
    }
    const line = laneShareTypedLineRefusal(payload?.data);
    if (line) return line;
    // Last: the line counts against the limits.
    const claimed = claimLaneShareMessage(role);
    return "refusal" in claimed ? claimed.refusal : null;
  }

  /** Counts one guest message, before its turn. A refusal carries the daily reset. */
  function claimLaneShareMessage(role: LaneShareGuestRole): { claim: LaneShareMessageClaim } | { refusal: LaneShareGuestRefusal } {
    if (!laneShareRights) {
      return { refusal: { code: "lane_share_unavailable", message: "This computer cannot count messages on a shared lane." } };
    }
    const claimed = laneShareRights.claimMessage(role.grantId);
    if (!claimed.ok) return { refusal: claimed.refusal };
    return { claim: claimed.claim };
  }

  /**
   * The checks a guest command needs from this host's services: the locks
   * against the chat as it is now, the message limits (counted here, before
   * the turn), ownership of the draft, comment or queued message it names,
   * and the kind of the card it answers. Sets the verified author.
   */
  async function prepareLaneShareGuestCommand(
    action: string,
    gateArgs: Record<string, unknown>,
    role: LaneShareGuestRole,
    context: SyncRemoteCommandExecutionContext,
    run: LaneShareRun,
  ): Promise<LaneSharePrepared> {
    const rights = role.rights;
    const chat = deps.chat();
    const sessionId = toOptionalString(gateArgs.sessionId);
    const summaryOf = async () => (chat && sessionId ? await chat.getSessionSummary(sessionId).catch(() => null) : null);
    const modelExists = async (provider: string | null | undefined, modelId: string): Promise<boolean> => {
      if (!chat) return false;
      try {
        const models = await chat.getAvailableModels({ provider: (provider ?? undefined) as AgentChatProvider | undefined });
        return Array.isArray(models) && models.some((model) => {
          const record = model as { id?: unknown; modelId?: unknown };
          return record.id === modelId || record.modelId === modelId;
        });
      } catch {
        return false;
      }
    };
    switch (action) {
      case "chat.send":
      case "chat.steer": {
        if (typeof gateArgs.text !== "string" || !gateArgs.text.trim()) return laneShareRefuse("Write a message first.", "invalid_args");
        const plain = laneSharePlainTextRefusal(gateArgs.text);
        if (plain) return { ok: false, refusal: plain };
        const summary = await summaryOf();
        if (!summary || !sessionId) return laneShareRefuse("This is not available on a shared lane.");
        const locked = laneShareSessionWithinLocks(rights, summary);
        if (locked) return { ok: false, refusal: locked };
        // A message into a running turn steers it (a send is routed to a
        // steer): only the guest's own turn, unless it may steer any turn.
        // Read after the last await; the service checks it again.
        const turn = laneShareExpectedTurn(sessionId, role, summary);
        if ("refusal" in turn) return { ok: false, refusal: turn.refusal };
        // Counted after every await and before the turn: one synchronous claim.
        const claimed = claimLaneShareMessage(role);
        if ("refusal" in claimed) return { ok: false, refusal: claimed.refusal };
        // The author makes the text a plain prompt in the chat service: no
        // slash command, shell draft or mention expansion of any provider.
        context.author = laneShareGuestAuthor(role);
        context.agentNote = laneShareCoAuthorNote({ userId: role.userId, name: role.name });
        if (turn.expected !== undefined) context.expectedTurnId = turn.expected;
        return { ok: true, args: gateArgs, claim: claimed.claim };
      }
      case "chat.interrupt": {
        const summary = await summaryOf();
        if (!summary || !sessionId) return laneShareRefuse("This is not available on a shared lane.");
        if (rights.speak.interruptAnyTurn) return { ok: true, args: gateArgs, claim: null };
        if (!rights.speak.steer) return laneShareRefuse("You can stop only a turn that you started.", "lane_share_not_your_turn");
        const turn = laneShareExpectedTurn(sessionId, role, summary);
        if ("refusal" in turn) return laneShareRefuse("You can stop only a turn that you started.", "lane_share_not_your_turn");
        // Null: no turn runs, so the stop changes nothing, and the service
        // refuses it if one started meanwhile. A stop of the guest's own turn
        // keeps the chat's queue: messages queued behind it are not the
        // guest's to cancel.
        context.expectedTurnId = turn.expected ?? null;
        return { ok: true, args: { ...gateArgs, mode: "stop_only" }, claim: null };
      }
      case "chat.cancelSteer": {
        const steerId = toOptionalString(gateArgs.steerId);
        if (!steerId || !laneShareRights?.hasItem(role.grantId, "steer", steerId)) return laneShareRefuse("You can remove only your own queued messages.");
        return { ok: true, args: { ...gateArgs, requireQueued: true }, claim: null };
      }
      case "chat.updateSession": {
        // Only a chat the guest created: the owner's chats keep the owner's settings.
        if (!sessionId || !laneShareRights?.hasItem(role.grantId, "chat", sessionId)) {
          return laneShareRefuse("You can change the settings only of a chat that you started.", "lane_share_not_your_chat");
        }
        const summary = await summaryOf();
        if (!summary) return laneShareRefuse("This is not available on a shared lane.");
        // "No change" under an empty lock means the mode the chat really runs
        // in, not its stored legacy label, which can lag the provider's own.
        const effective = laneShareEffectiveModes(summary);
        const locked = laneShareCheckLocks(rights, gateArgs, {
          ...summary,
          permissionMode: effective?.length === 1 ? effective[0]! : null,
        });
        if (locked) return { ok: false, refusal: locked };
        const modelId = toOptionalString(gateArgs.modelId);
        if (modelId && modelId !== summary.modelId && !(await modelExists(summary.provider, modelId))) {
          return laneShareRefuse("The model the owner allowed is not available on this computer now.", "lane_share_model_unavailable");
        }
        return { ok: true, args: gateArgs, claim: null };
      }
      case "chat.create": {
        const provider = toOptionalString(gateArgs.provider);
        if (!provider) return laneShareRefuse("Choose a provider.", "invalid_args");
        // A new chat has no current model: with no model lock there is no
        // model a guest may pick, and no provider default is used.
        if (rights.run.models.length === 0) {
          return laneShareRefuse("The owner has not allowed a model for new chats on this shared lane.", "lane_share_model_locked");
        }
        const locked = laneShareCheckLocks(rights, gateArgs, null);
        if (locked) return { ok: false, refusal: locked };
        const modelId = toOptionalString(gateArgs.modelId) ?? rights.run.models[0]!;
        if (!(await modelExists(provider, modelId))) {
          return laneShareRefuse("The model the owner allowed is not available on this computer now.", "lane_share_model_unavailable");
        }
        const permissionMode = toOptionalString(gateArgs.permissionMode) ?? rights.run.permissionModes[0] ?? "default";
        return { ok: true, args: { ...gateArgs, modelId, permissionMode }, claim: null };
      }
      case "work.startCliSession": {
        const provider = toOptionalString(gateArgs.provider)?.toLowerCase() ?? null;
        // Never a shell: only a launch profile whose session tool type is an
        // agent CLI this host tracks. An unknown provider is refused.
        if (!isLaunchProfile(provider) || laneShareSessionKind(LAUNCH_PROFILE_TOOL_TYPE[provider]) !== "cli") {
          return laneShareRefuse("A guest cannot start a shell.");
        }
        if (rights.run.models.length === 0) {
          return laneShareRefuse("The owner has not allowed a model for new sessions on this shared lane.", "lane_share_model_locked");
        }
        const locked = laneShareCheckLocks(rights, gateArgs, null);
        if (locked) return { ok: false, refusal: locked };
        if (typeof gateArgs.initialInput === "string" && gateArgs.initialInput.trim()) {
          if (!rights.run.typeInCliSessions) return laneShareRefuse("Your access to this shared lane does not include typing in a CLI.", "lane_share_right_missing");
          // No line a CLI reads as a command (`/`, `!`, and `#` for Claude's
          // memory line), and, as for typing, no Windows host.
          for (const line of gateArgs.initialInput.split(/\r\n|\r|\n/)) {
            const plain = laneSharePlainTextRefusal(line, ["#"]);
            if (plain) return { ok: false, refusal: plain };
          }
          const windows = laneShareWindowsTypingRefusal();
          if (windows) return { ok: false, refusal: windows };
          const claimed = claimLaneShareMessage(role);
          if ("refusal" in claimed) return { ok: false, refusal: claimed.refusal };
          return { ok: true, args: gateArgs, claim: claimed.claim };
        }
        const { initialInput: _initialInput, ...rest } = gateArgs;
        return { ok: true, args: rest, claim: null };
      }
      case "chat.approve":
      case "chat.respondToInput":
      case "chat.dismissPendingInput": {
        // "For the whole session" saves the choice: Claude writes the
        // suggested rules to its settings, Codex keeps the grant or the MCP
        // answer. That changes this computer's setup, so only the owner does it.
        if (gateArgs.decision === "accept_for_session") {
          return { ok: false, refusal: { code: "lane_share_owner_only", message: "Only the owner can allow this for the whole session." } };
        }
        // An answer can reach the agent as a message (a question answered by
        // sending): it stays a plain prompt.
        for (const text of laneShareAnswerTexts(gateArgs)) {
          const plainText = laneSharePlainTextRefusal(text);
          if (plainText) return { ok: false, refusal: plainText };
        }
        const card = laneShareGuestCard(sessionId ?? null, toOptionalString(gateArgs.itemId) ?? null, role);
        if ("refusal" in card) return { ok: false, refusal: card.refusal };
        // An approved plan returns the chat to its mode before the plan: that
        // mode must be one the owner allowed.
        if (card.kind === "plan_approval" && action !== "chat.dismissPendingInput" && gateArgs.decision !== "decline" && gateArgs.decision !== "cancel") {
          const summary = await summaryOf();
          if (!summary) return laneShareRefuse("This is not available on a shared lane.");
          const locked = laneShareSessionWithinLocks(rights, summary);
          if (locked) return { ok: false, refusal: locked };
          // After the await: the card is still open and still the same one.
          const again = laneShareGuestCard(sessionId ?? null, toOptionalString(gateArgs.itemId) ?? null, role);
          if ("refusal" in again) return { ok: false, refusal: again.refusal };
        }
        return { ok: true, args: gateArgs, claim: null };
      }
      case "chat.createDraft": {
        if (typeof gateArgs.text !== "string" || !gateArgs.text.trim()) return laneShareRefuse("A draft cannot be empty.", "invalid_args");
        // The owner can send the draft later; it stays a plain prompt then too.
        const plainText = laneSharePlainTextRefusal(gateArgs.text);
        if (plainText) return { ok: false, refusal: plainText };
        if (!laneShareRights) return laneShareRefuse("This computer cannot keep drafts for a shared lane.", "lane_share_unavailable");
        // A new draft past the cap would push out the owner's oldest one.
        const drafts = await run("chat.listDrafts", {}).catch(() => null);
        const plain = Array.isArray(drafts) ? drafts.filter((draft) => (draft as { kind?: unknown })?.kind !== "scheduled").length : MAX_DRAFTS;
        if (plain >= MAX_DRAFTS) return laneShareRefuse("The owner's drafts are full on this computer.", "lane_share_limit");
        // After the last await: count and hold the slot in one statement.
        const holdId = laneShareRights.holdItem(role.grantId, "draft", toOptionalString(gateArgs.originSessionId) ?? null, LANE_SHARE_MAX_GUEST_DRAFTS);
        if (!holdId) {
          return laneShareRefuse(`You can keep ${LANE_SHARE_MAX_GUEST_DRAFTS} drafts on a shared lane. Remove one first.`, "lane_share_limit");
        }
        context.author = laneShareGuestAuthor(role);
        return { ok: true, args: gateArgs, claim: null, hold: { kind: "draft", holdId } };
      }
      case "chat.updateDraft":
      case "chat.deleteDraft": {
        const id = toOptionalString(gateArgs.id);
        if (!id || !laneShareRights?.hasItem(role.grantId, "draft", id)) return laneShareRefuse("You can change only your own drafts.");
        // An edit keeps the draft a plain prompt, as its first text was.
        if (action === "chat.updateDraft" && typeof gateArgs.text === "string") {
          const plainText = laneSharePlainTextRefusal(gateArgs.text);
          if (plainText) return { ok: false, refusal: plainText };
        }
        return { ok: true, args: gateArgs, claim: null };
      }
      case "chat.createThreadComment": {
        if (!laneShareRights || !sessionId) return laneShareRefuse("This computer cannot keep comments for a shared lane.", "lane_share_unavailable");
        const holdId = laneShareRights.holdItem(role.grantId, "comment", sessionId, LANE_SHARE_MAX_GUEST_COMMENTS_PER_SESSION, true);
        if (!holdId) {
          return laneShareRefuse(`You can keep ${LANE_SHARE_MAX_GUEST_COMMENTS_PER_SESSION} comments on one chat.`, "lane_share_limit");
        }
        context.author = laneShareGuestAuthor(role);
        return { ok: true, args: gateArgs, claim: null, hold: { kind: "comment", holdId } };
      }
      case "chat.updateThreadComment":
      case "chat.deleteThreadComment": {
        const commentId = toOptionalString(gateArgs.commentId);
        if (!commentId || !laneShareRights?.hasItem(role.grantId, "comment", commentId)) {
          return laneShareRefuse("You can change only your own comments.");
        }
        return { ok: true, args: gateArgs, claim: null };
      }
      case "chat.getSubagentTranscript": {
        // A provider reads a child by the id it is given: the id must be a
        // subagent the host itself lists for this chat.
        let belongs = false;
        try {
          belongs = laneShareGuestSubagentBelongs(await run("chat.listSubagents", { sessionId }), gateArgs);
        } catch {
          belongs = false;
        }
        return belongs ? { ok: true, args: gateArgs, claim: null } : laneShareRefuse("This is not available on a shared lane.");
      }
      default:
        return { ok: true, args: gateArgs, claim: null };
    }
  }

  /** Records what the guest wrote or queued, so only it may change it and a revoke can remove it. */
  function recordLaneShareGuestResult(action: string, gateArgs: Record<string, unknown>, role: LaneShareGuestRole, result: unknown): void {
    if (!laneShareRights) return;
    const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const sessionId = toOptionalString(gateArgs.sessionId) ?? null;
    try {
      if ((action === "chat.send" || action === "chat.steer") && sessionId) {
        laneShareRights.addItem(role.grantId, "turn", sessionId, sessionId);
        const steerId = toOptionalString(record.steerId);
        if (steerId && record.queued === true) laneShareRights.addItem(role.grantId, "steer", steerId, sessionId);
      } else if (action === "chat.cancelSteer") {
        const steerId = toOptionalString(gateArgs.steerId);
        if (steerId) laneShareRights.removeItem(role.grantId, "steer", steerId);
      } else if (action === "chat.create") {
        const id = toOptionalString(record.id) ?? toOptionalString(record.sessionId);
        if (id) laneShareRights.addItem(role.grantId, "chat", id, id);
      } else if (action === "chat.deleteDraft") {
        const id = toOptionalString(gateArgs.id);
        if (id) laneShareRights.removeItem(role.grantId, "draft", id);
      } else if (action === "chat.deleteThreadComment") {
        const id = toOptionalString(gateArgs.commentId);
        if (id) laneShareRights.removeItem(role.grantId, "comment", id);
      }
    } catch (error) {
      deps.logger.warn("sync_host.lane_share_record_failed", {
        action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** A guest's draft list holds only its own drafts. */
  function filterLaneShareGuestOwnItems(action: string, result: unknown, role: LaneShareGuestRole): unknown {
    if (action !== "chat.listDrafts") return result;
    if (!Array.isArray(result) || !laneShareRights) return [];
    return result.filter((draft) => {
      const id = toOptionalString((draft as { id?: unknown } | null)?.id);
      return id != null && laneShareRights.hasItem(role.grantId, "draft", id);
    });
  }

  return {
    prepareLaneShareGuestCommand,
    recordLaneShareGuestResult,
    filterLaneShareGuestOwnItems,
    laneShareGuestTypingRefusal,
  };
}
