import {
  cleanLaneShareMoveBranchName,
  cleanLaneShareMoveLaneName,
  cleanLaneShareMoveText,
  createLaneShareMoveConsents,
  isLaneShareMoveId,
  LANE_SHARE_MOVE_FINAL_STAGES,
  LANE_SHARE_MOVE_TTL_MS,
  newLaneShareMoveId,
  parseLaneShareMovePayload,
  type LaneShareMoveDirection,
  type LaneShareMovePayload,
  type LaneShareMoveStage,
  type LaneShareMoveView,
} from "../../../../desktop/src/shared/laneShareMove";
import { laneShareRiskLevel, parseLaneShareRights, type LaneShareRights } from "../../../../desktop/src/shared/laneShareRights";
import type { LaneShareEvent } from "../../../../desktop/src/shared/types/laneShare";
import type { AgentChatCrossMachineGitBundle } from "../../../../desktop/src/shared/types/chat";
import {
  createLaneShareMoveReceiver,
  type LaneShareMoveIncomingBundle,
  type LaneShareMoveOutgoingBundle,
} from "../../../../desktop/src/main/services/chat/laneShareMoveTransfer";
import type { LaneShareRightsStore } from "../../../../desktop/src/main/services/lanes/laneShareRightsStore";

/**
 * Moves a chat, with its lane's work, between the two people of a lane share
 * (plan Part C; trust rules in `shared/laneShareMove.ts`). One instance per
 * project runtime. It plays four parts:
 *
 * - host, source (`to_guest`, the owner moves a chat of the shared lane to
 *   the guest): offers, waits for the guest's accept (a guest command), then
 *   packs and serves the bundle in chunks only to a guest connection of that
 *   grant while the consent is accepted;
 * - host, destination (`to_owner`, the guest moves work here): the owner's
 *   consent lives here. Chunks are refused until the owner pressed Accept;
 *   the work lands in a NEW lane, and the new lane is shared back to the
 *   guest by the normal create path with this machine's account;
 * - local, destination (the guest's own machine, through its own runtime
 *   actions): the guest's consent lives here, made when the guest pressed
 *   Accept; the same landing rules;
 * - local, source (the guest's own machine packs a chat for `to_owner`).
 *
 * Every consent refuses by default, expires after 15 minutes, is used once,
 * and ends with a revoke, a leave or the end of the share (`cancelGrant`).
 * Temp files of a move go when it ends, however it ends.
 */

export class LaneShareMoveError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LaneShareMoveError";
  }
}

const GRANT_ID = /^ls_[0-9a-f]{32}$/;
/** A final move stays readable this long, so both sides see how it ended. */
const FINAL_KEPT_MS = 5 * 60_000;
const SWEEP_MS = 30_000;
const STARTED_LANDING_MESSAGE = "Moving the work into a new lane…";

export type LaneShareMoveChatPort = {
  getSessionSummary(sessionId: string): Promise<{ laneId: string; title?: string | null; modelId?: string | null } | null>;
  prepareLaneShareMove(args: { sessionId: string; moveId: string }): Promise<{ payload: LaneShareMovePayload; bundle: LaneShareMoveOutgoingBundle | null }>;
  checkLaneShareMoveDestination(args: { repoKey: string; modelHint: string | null }): Promise<{ modelId: string }>;
  acceptLaneShareMove(args: { payload: unknown; bundle: AgentChatCrossMachineGitBundle | null; fromName: string | null }): Promise<{
    laneId: string;
    laneName: string;
    sessionId: string;
    branchName: string;
  }>;
  markLaneShareMoved(args: { sessionId: string; moveId: string; toName: string | null }): Promise<void>;
  discardLaneShareMoveLane(laneId: string): Promise<void>;
};

export type LaneShareMoveSharePort = {
  create(args: { laneId: unknown; receiverEmail: unknown; rights: unknown; endsAt?: unknown; confirmHighRisk?: unknown }): Promise<{ grantId: string }>;
  /** Accepts a share back made for this account, only when its giver and repository are the expected ones. */
  acceptShareBack(args: { grantId: string; giverUserId: string }): Promise<void>;
};

/** A guest connection as the host knows it. Nothing here comes from the client. */
export type LaneShareMoveGuest = {
  grantId: string;
  laneId: string;
  userId: string;
  name: string | null;
  rights: LaneShareRights;
};

type Role = "host_source" | "host_destination" | "local_destination" | "local_source";

type MoveRecord = {
  moveId: string;
  grantId: string;
  laneId: string;
  direction: LaneShareMoveDirection;
  role: Role;
  stage: LaneShareMoveStage;
  sessionId: string | null;
  chatTitle: string | null;
  laneName: string | null;
  branchName: string | null;
  modelHint: string | null;
  starterName: string | null;
  /** The other person's user id, from the host's own role (host parts only). */
  guestUserId: string | null;
  expiresAt: number;
  rights: LaneShareRights | null;
  shareBackEmail: string | null;
  /** Host destination: the rights the owner chose for the share back, checked when chosen. */
  shareBackRights: LaneShareRights | null;
  shareBackEndsAt: number | null;
  repoKey: string | null;
  payload: LaneShareMovePayload | null;
  outgoing: LaneShareMoveOutgoingBundle | null;
  incoming: LaneShareMoveIncomingBundle | null;
  /** Set when the move is cancelled while it lands; the landed lane is then removed. */
  cancelled: boolean;
  error: string | null;
  result: { laneName: string | null; shareBackGrantId: string | null } | null;
  finishedAt: number | null;
};

function isCollaborate(rights: LaneShareRights): boolean {
  return rights.speak.send && rights.run.startChats;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 400) || "The move failed.";
}

function cleanGrantId(value: unknown): string {
  if (typeof value !== "string" || !GRANT_ID.test(value)) throw new LaneShareMoveError("invalid_args", "That lane share id is not valid.");
  return value;
}

function cleanMoveId(value: unknown): string {
  if (!isLaneShareMoveId(value)) throw new LaneShareMoveError("invalid_args", "That move id is not valid.");
  return value;
}

/** An end date for a share back: a future time, else none. */
function cleanEndsAt(value: unknown, nowMs: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > nowMs ? Math.floor(value) : null;
}

/** Rights for a share back: parsed, and a high risk result needs the person's confirmation. */
function checkedShareBackRights(value: unknown, confirmHighRisk: unknown): LaneShareRights {
  const rights = parseLaneShareRights(value);
  const risk = laneShareRiskLevel(rights);
  if (risk.level === "high" && confirmHighRisk !== true) {
    throw new LaneShareMoveError("confirm_high_risk", `These rights are high risk: ${risk.reasons.join("; ")}. Confirm them to continue.`);
  }
  return rights;
}

export function createLaneShareMoveService(options: {
  chat: () => LaneShareMoveChatPort | null;
  rightsStore: LaneShareRightsStore;
  share: () => LaneShareMoveSharePort | null;
  getRepoKey: () => string | null;
  /** This machine's signed-in account email (the owner's, for a share back from the guest). */
  getAccountEmail: () => string | null;
  /** Tell the guests of a grant that their state changed (they read it again). */
  notifyGuests: (grantId: string) => void;
  onEvent?: (event: LaneShareEvent) => void;
  now?: () => number;
  logger?: { info(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void };
}) {
  const now = options.now ?? Date.now;
  /** Consents of this machine's own person, host side (one live move per grant, both directions). */
  const hostConsents = createLaneShareMoveConsents({ now });
  /** Consents of this machine's own person for work arriving through the guest client. */
  const localConsents = createLaneShareMoveConsents({ now });
  const moves = new Map<string, MoveRecord>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  const requireChat = (): LaneShareMoveChatPort => {
    const chat = options.chat();
    if (!chat) throw new LaneShareMoveError("unavailable", "Chats are not ready on this computer yet. Try again in a moment.");
    return chat;
  };

  const view = (record: MoveRecord): LaneShareMoveView => ({
    moveId: record.moveId,
    grantId: record.grantId,
    laneId: record.laneId,
    direction: record.direction,
    stage: record.stage,
    starterName: record.starterName,
    sessionId: record.direction === "to_guest" ? record.sessionId : null,
    chatTitle: record.chatTitle,
    laneName: record.laneName,
    branchName: record.branchName,
    expiresAt: record.expiresAt,
    bundle: record.payload?.bundle
      ? { bytes: record.payload.bundle.bytes, sha256: record.payload.bundle.sha256, chunkCount: record.payload.bundle.chunkCount }
      : null,
    rights: record.rights,
    shareBackEmail: record.direction === "to_guest" ? record.shareBackEmail : null,
    modelHint: record.direction === "to_guest" ? record.modelHint : null,
    error: record.error,
    result: record.result,
  });

  const announce = (record: MoveRecord): void => {
    if (record.role === "host_source" || record.role === "host_destination") {
      try {
        options.notifyGuests(record.grantId);
      } catch {
        // A failed nudge never fails the move; the guest reads its state on a timer too.
      }
      try {
        options.onEvent?.({ type: "lane_share_move_changed", grantId: record.grantId, laneId: record.laneId, moveId: record.moveId });
      } catch {
        // Listener failures never fail the move.
      }
    }
  };

  const release = (record: MoveRecord): void => {
    record.outgoing?.dispose();
    record.outgoing = null;
    record.incoming?.dispose();
    record.incoming = null;
  };

  const end = (record: MoveRecord, stage: LaneShareMoveStage, error: string | null = null): void => {
    if (LANE_SHARE_MOVE_FINAL_STAGES.has(record.stage)) return;
    record.stage = stage;
    record.error = error;
    record.finishedAt = now();
    release(record);
    const consents = record.role === "local_destination" ? localConsents : hostConsents;
    if (record.role !== "local_source") consents.finish(record.moveId, stage);
    options.logger?.info("lane_share.move_ended", { moveId: record.moveId, grantId: record.grantId, stage, role: record.role });
    announce(record);
  };

  const sweep = (): void => {
    const at = now();
    for (const record of [...moves.values()]) {
      if (LANE_SHARE_MOVE_FINAL_STAGES.has(record.stage)) {
        if (record.finishedAt != null && at - record.finishedAt > FINAL_KEPT_MS) moves.delete(record.moveId);
        continue;
      }
      // A landing in progress finishes or fails on its own; everything else expires.
      if (record.stage !== "landing" && at >= record.expiresAt) end(record, "expired", "Nobody finished the move in 15 minutes.");
    }
    hostConsents.sweep();
    localConsents.sweep();
    if (moves.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  };

  const track = (record: MoveRecord): void => {
    moves.set(record.moveId, record);
    if (!sweepTimer) {
      sweepTimer = setInterval(sweep, SWEEP_MS);
      sweepTimer.unref?.();
    }
  };

  const find = (moveId: unknown, roles: readonly Role[]): MoveRecord => {
    sweep();
    const record = isLaneShareMoveId(moveId) ? moves.get(moveId) : undefined;
    if (!record || !roles.includes(record.role)) throw new LaneShareMoveError("lane_share_move_not_found", "This computer has no such move.");
    return record;
  };

  const blank = (input: Pick<MoveRecord, "moveId" | "grantId" | "laneId" | "direction" | "role" | "expiresAt"> & Partial<MoveRecord>): MoveRecord => ({
    stage: "offered",
    sessionId: null,
    chatTitle: null,
    laneName: null,
    branchName: null,
    modelHint: null,
    starterName: null,
    guestUserId: null,
    rights: null,
    shareBackEmail: null,
    shareBackRights: null,
    shareBackEndsAt: null,
    repoKey: null,
    payload: null,
    outgoing: null,
    incoming: null,
    cancelled: false,
    error: null,
    result: null,
    finishedAt: null,
    ...input,
  });

  /** The live rights row of a grant on this host, for its lane. */
  const hostGrant = (grantId: string) => {
    const record = options.rightsStore.get(grantId);
    if (!record) throw new LaneShareMoveError("not_found", "This computer has no live lane share with that id.");
    if (options.rightsStore.laneState(record.laneId) !== "active") {
      throw new LaneShareMoveError("lane_share_paused", "This shared lane is paused. Unarchive it first.");
    }
    return record;
  };

  // -------------------------------------------------------------------------
  // Host, source (`to_guest`): packing and serving

  const pack = async (record: MoveRecord): Promise<void> => {
    record.stage = "packing";
    announce(record);
    try {
      const prepared = await requireChat().prepareLaneShareMove({ sessionId: record.sessionId!, moveId: record.moveId });
      if (LANE_SHARE_MOVE_FINAL_STAGES.has(record.stage)) {
        prepared.bundle?.dispose();
        return;
      }
      record.payload = prepared.payload;
      record.outgoing = prepared.bundle;
      record.branchName = prepared.payload.branchName;
      record.stage = "ready";
      announce(record);
    } catch (error) {
      end(record, "failed", errorText(error));
    }
  };

  const hostSourceGuestCommand = async (record: MoveRecord, guest: LaneShareMoveGuest, op: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (op) {
      case "accept": {
        if (record.stage !== "offered") throw new LaneShareMoveError("lane_share_move_used", "This move was already answered.");
        const accepted = hostConsents.accept(record.moveId, guest.grantId);
        if (!accepted.ok) throw new LaneShareMoveError(accepted.code, accepted.message);
        record.stage = "accepted";
        record.guestUserId = guest.userId;
        void pack(record);
        return view(record);
      }
      case "decline":
        end(record, "declined");
        return view(record);
      case "status":
        return view(record);
      case "payload": {
        if (!hostConsents.isAccepted(record.moveId, guest.grantId, guest.laneId) || record.stage !== "ready" || !record.payload) {
          throw new LaneShareMoveError("lane_share_move_no_consent", "This move is not ready to send.");
        }
        return { payload: record.payload };
      }
      case "chunk": {
        if (!hostConsents.isAccepted(record.moveId, guest.grantId, guest.laneId) || record.stage !== "ready" || !record.outgoing) {
          throw new LaneShareMoveError("lane_share_move_no_consent", "This move is not ready to send.");
        }
        const index = typeof args.index === "number" ? args.index : -1;
        return { index, data: record.outgoing.readChunk(index) };
      }
      case "landed": {
        if (record.stage !== "ready") throw new LaneShareMoveError("lane_share_move_no_consent", "This move is not ready.");
        const used = hostConsents.consume(record.moveId, guest.grantId);
        if (!used.ok) throw new LaneShareMoveError(used.code, used.message);
        const shareBackGrantId = typeof args.shareBackGrantId === "string" && GRANT_ID.test(args.shareBackGrantId) ? args.shareBackGrantId : null;
        record.result = { laneName: cleanLaneShareMoveLaneName(args.laneName), shareBackGrantId };
        end(record, "done");
        void requireChat().markLaneShareMoved({ sessionId: record.sessionId!, moveId: record.moveId, toName: guest.name })
          .catch((error) => options.logger?.warn("lane_share.move_mark_failed", { moveId: record.moveId, error: errorText(error) }));
        if (shareBackGrantId) {
          // The owner started this move: its share back is accepted here,
          // only when the guest of this grant gave it for this repository.
          void (async () => {
            try {
              await options.share()?.acceptShareBack({ grantId: shareBackGrantId, giverUserId: guest.userId });
            } catch (error) {
              options.logger?.warn("lane_share.move_share_back_accept_failed", { moveId: record.moveId, error: errorText(error) });
            }
          })();
        }
        return view(record);
      }
      case "failed":
        end(record, "failed", cleanLaneShareMoveText(args.message, 300) ?? "The move failed on the other computer.");
        return view(record);
      case "cancel":
        end(record, "cancelled", "The other person cancelled the move.");
        return view(record);
      default:
        throw new LaneShareMoveError("forbidden_command", "This is not available on a shared lane.");
    }
  };

  // -------------------------------------------------------------------------
  // Host, destination (`to_owner`): the owner's consent and the landing here

  const landOnHost = async (record: MoveRecord, guest: LaneShareMoveGuest): Promise<void> => {
    const incoming = record.incoming;
    const payload = record.payload!;
    let landed: Awaited<ReturnType<LaneShareMoveChatPort["acceptLaneShareMove"]>> | null = null;
    try {
      const bundle = payload.bundle
        ? incoming!.finish({
            branchHeadSha: payload.bundle.branchHeadSha,
            snapshotSha: payload.bundle.snapshotSha,
            unpushedCommitCount: payload.bundle.unpushedCommitCount,
            changedFileCount: payload.bundle.changedFileCount,
          })
        : null;
      landed = await requireChat().acceptLaneShareMove({ payload, bundle, fromName: guest.name });
      if (record.cancelled) {
        await requireChat().discardLaneShareMoveLane(landed.laneId).catch(() => {});
        return;
      }
      let shareBackGrantId: string | null = null;
      const receiverEmail = options.rightsStore.get(record.grantId)?.receiverEmail ?? null;
      if (receiverEmail && record.shareBackRights) {
        try {
          // The owner chose (and, when high, confirmed) these rights in the card.
          shareBackGrantId = (await options.share()?.create({
            laneId: landed.laneId,
            receiverEmail,
            rights: record.shareBackRights,
            endsAt: record.shareBackEndsAt,
            confirmHighRisk: true,
          }))?.grantId ?? null;
        } catch (error) {
          options.logger?.warn("lane_share.move_share_back_failed", { moveId: record.moveId, error: errorText(error) });
        }
      }
      record.result = { laneName: landed.laneName, shareBackGrantId };
      end(record, "done");
    } catch (error) {
      end(record, "failed", errorText(error));
    } finally {
      incoming?.dispose();
    }
  };

  const hostDestinationGuestCommand = async (record: MoveRecord, guest: LaneShareMoveGuest, op: string, args: Record<string, unknown>): Promise<unknown> => {
    const accepted = (): void => {
      // Rights can shrink while a move runs: a guest without Collaborate sends no more work.
      if (!isCollaborate(guest.rights)) {
        end(record, "cancelled", "Your access to this shared lane changed.");
        throw new LaneShareMoveError("lane_share_right_missing", "Your access to this shared lane does not include moving work here.");
      }
      if (!hostConsents.isAccepted(record.moveId, guest.grantId, guest.laneId) || record.stage !== "accepted") {
        throw new LaneShareMoveError("lane_share_move_no_consent", "The owner has not accepted this move.");
      }
    };
    switch (op) {
      case "begin": {
        accepted();
        if (record.payload) throw new LaneShareMoveError("lane_share_move_used", "This move already started.");
        const payload = parseLaneShareMovePayload(args.payload, record.moveId);
        if (payload.repoKey !== options.getRepoKey()) {
          throw new LaneShareMoveError("lane_share_move_wrong_repo", "That work belongs to a different repository than this shared lane.");
        }
        record.payload = payload;
        record.laneName = payload.laneName;
        record.branchName = payload.branchName;
        record.chatTitle = payload.title;
        record.incoming = payload.bundle ? createLaneShareMoveReceiver({ bytes: payload.bundle.bytes, sha256: payload.bundle.sha256 }) : null;
        announce(record);
        return { received: 0 };
      }
      case "put": {
        accepted();
        if (!record.payload?.bundle || !record.incoming) throw new LaneShareMoveError("lane_share_move_no_consent", "This move carries no work to send.");
        const index = typeof args.index === "number" ? args.index : -1;
        try {
          record.incoming.write(index, args.data);
        } catch (error) {
          end(record, "failed", errorText(error));
          throw new LaneShareMoveError("lane_share_move_damaged", errorText(error));
        }
        return { received: record.incoming.received };
      }
      case "finish": {
        accepted();
        if (!record.payload) throw new LaneShareMoveError("lane_share_move_no_consent", "This move has not started.");
        const used = hostConsents.consume(record.moveId, guest.grantId);
        if (!used.ok) throw new LaneShareMoveError(used.code, used.message);
        record.stage = "landing";
        record.error = STARTED_LANDING_MESSAGE;
        announce(record);
        void landOnHost(record, guest).then(() => announce(record));
        return view(record);
      }
      case "status":
        return { ...view(record), received: record.incoming?.received ?? 0 };
      case "cancel":
        if (record.stage === "landing") record.cancelled = true;
        end(record, "cancelled", "The other person cancelled the move.");
        return view(record);
      default:
        throw new LaneShareMoveError("forbidden_command", "This is not available on a shared lane.");
    }
  };

  // -------------------------------------------------------------------------
  // Local parts: the guest's own machine, through its own runtime actions

  const localDestination = (moveId: unknown, grantId: unknown): MoveRecord => {
    const record = find(moveId, ["local_destination"]);
    if (record.grantId !== grantId) throw new LaneShareMoveError("lane_share_move_not_found", "This computer has no such move.");
    return record;
  };

  const landLocally = async (
    record: MoveRecord,
    fromName: string | null,
    shareBack: { receiverEmail: string; rights: LaneShareRights; endsAt: number | null } | null,
  ): Promise<void> => {
    const payload = record.payload!;
    try {
      const bundle = payload.bundle
        ? record.incoming!.finish({
            branchHeadSha: payload.bundle.branchHeadSha,
            snapshotSha: payload.bundle.snapshotSha,
            unpushedCommitCount: payload.bundle.unpushedCommitCount,
            changedFileCount: payload.bundle.changedFileCount,
          })
        : null;
      const landed = await requireChat().acceptLaneShareMove({ payload, bundle, fromName });
      if (record.cancelled) {
        await requireChat().discardLaneShareMoveLane(landed.laneId).catch(() => {});
        return;
      }
      let shareBackGrantId: string | null = null;
      if (shareBack) {
        try {
          shareBackGrantId = (await options.share()?.create({
            laneId: landed.laneId,
            receiverEmail: shareBack.receiverEmail,
            rights: shareBack.rights,
            endsAt: shareBack.endsAt,
            confirmHighRisk: true,
          }))?.grantId ?? null;
        } catch (error) {
          options.logger?.warn("lane_share.move_share_back_failed", { moveId: record.moveId, error: errorText(error) });
        }
      }
      record.result = { laneName: landed.laneName, shareBackGrantId };
      end(record, "done");
    } catch (error) {
      end(record, "failed", errorText(error));
    }
  };

  const service = {
    // ----- Host part: the owner's runtime actions (user-only) -----

    /** The owner starts "Move to <guest>'s machine" for a chat of the shared lane. */
    async start(args: { grantId: unknown; sessionId: unknown }): Promise<LaneShareMoveView> {
      sweep();
      const grantId = cleanGrantId(args.grantId);
      const grant = hostGrant(grantId);
      if (!grant.receiverEmail) throw new LaneShareMoveError("not_found", "This share has no guest yet.");
      const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId) throw new LaneShareMoveError("invalid_args", "Choose a chat to move.");
      const summary = await requireChat().getSessionSummary(sessionId);
      if (!summary || summary.laneId !== grant.laneId) throw new LaneShareMoveError("invalid_args", "That chat is not in the shared lane.");
      const repoKey = options.getRepoKey();
      if (!repoKey) throw new LaneShareMoveError("no_repo_key", "This project can't be moved: it needs a Git remote.");
      const shareBackEmail = options.getAccountEmail();
      if (!shareBackEmail) throw new LaneShareMoveError("signed_out", "Sign in to ADE on this computer to move a chat.");
      const moveId = newLaneShareMoveId();
      const offered = hostConsents.offer({ moveId, grantId, laneId: grant.laneId, direction: "to_guest" });
      if (!offered.ok) throw new LaneShareMoveError(offered.code, offered.message);
      const record = blank({
        moveId,
        grantId,
        laneId: grant.laneId,
        direction: "to_guest",
        role: "host_source",
        expiresAt: offered.consent.expiresAt,
        sessionId,
        chatTitle: cleanLaneShareMoveText(summary.title, 300),
        modelHint: summary.modelId ?? null,
        starterName: null,
        rights: grant.rights,
        shareBackEmail,
        repoKey,
      });
      track(record);
      options.logger?.info("lane_share.move_offered", { moveId, grantId, direction: "to_guest" });
      announce(record);
      return view(record);
    },

    /** The owner answers a guest's move (`to_owner`): Accept with the share back rights, or Decline. */
    respond(args: { moveId: unknown; accept: unknown; rights?: unknown; endsAt?: unknown; confirmHighRisk?: unknown }): LaneShareMoveView {
      const record = find(cleanMoveId(args.moveId), ["host_destination"]);
      if (args.accept !== true) {
        end(record, "declined");
        return view(record);
      }
      if (LANE_SHARE_MOVE_FINAL_STAGES.has(record.stage)) {
        throw new LaneShareMoveError("lane_share_move_used", record.stage === "expired" ? "This move expired. Ask to move again." : "This move already ended.");
      }
      if (record.stage !== "offered") throw new LaneShareMoveError("lane_share_move_used", "This move was already answered.");
      const grant = hostGrant(record.grantId);
      const rights = args.rights === undefined ? grant.rights : checkedShareBackRights(args.rights, args.confirmHighRisk);
      const accepted = hostConsents.accept(record.moveId, record.grantId);
      if (!accepted.ok) throw new LaneShareMoveError(accepted.code, accepted.message);
      record.shareBackRights = rights;
      record.shareBackEndsAt = cleanEndsAt(args.endsAt, now());
      record.stage = "accepted";
      announce(record);
      return view(record);
    },

    /** Either side of this host stops a move before it lands. */
    cancel(args: { moveId: unknown }): LaneShareMoveView {
      const record = find(cleanMoveId(args.moveId), ["host_source", "host_destination"]);
      if (record.stage === "landing") record.cancelled = true;
      end(record, "cancelled", "The owner cancelled the move.");
      return view(record);
    },

    /** Moves on this host, live and recently ended, for the owner's cards. */
    list(): { moves: LaneShareMoveView[] } {
      sweep();
      return {
        moves: [...moves.values()]
          .filter((record) => record.role === "host_source" || record.role === "host_destination")
          .map(view),
      };
    },

    // ----- Host part: guest commands (called by the sync host with the guest's role) -----

    /** The move a guest of this grant sees in its state; null when none. */
    guestView(guest: Pick<LaneShareMoveGuest, "grantId">): (LaneShareMoveView & { received?: number }) | null {
      sweep();
      let latest: MoveRecord | null = null;
      for (const record of moves.values()) {
        if (record.grantId !== guest.grantId || (record.role !== "host_source" && record.role !== "host_destination")) continue;
        if (!latest || !LANE_SHARE_MOVE_FINAL_STAGES.has(record.stage)) latest = record;
      }
      if (!latest) return null;
      return { ...view(latest), ...(latest.incoming ? { received: latest.incoming.received } : {}) };
    },

    /**
     * One guest command (`laneShare.move`). Each op is bound to the guest's
     * grant and lane (from the host's role, never from the client), to the
     * move id, and to the consent state; anything else is refused.
     */
    async guestCommand(guest: LaneShareMoveGuest, args: Record<string, unknown>): Promise<unknown> {
      sweep();
      const op = typeof args.op === "string" ? args.op : "";
      if (op === "offer") {
        // The guest moves work of its own machine to this host (`to_owner`).
        if (!isCollaborate(guest.rights)) {
          throw new LaneShareMoveError("lane_share_right_missing", "Your access to this shared lane does not include moving work here.");
        }
        if (options.rightsStore.laneState(guest.laneId) !== "active") {
          throw new LaneShareMoveError("lane_share_paused", "The owner paused this shared lane.");
        }
        const moveId = cleanMoveId(args.moveId);
        const laneName = cleanLaneShareMoveLaneName(args.laneName);
        const branchName = cleanLaneShareMoveBranchName(args.branchName);
        if (!laneName || !branchName) throw new LaneShareMoveError("invalid_args", "That lane or branch name is not valid.");
        if (typeof args.repoKey !== "string" || args.repoKey !== options.getRepoKey()) {
          throw new LaneShareMoveError("lane_share_move_wrong_repo", "That work belongs to a different repository than this shared lane.");
        }
        const offered = hostConsents.offer({ moveId, grantId: guest.grantId, laneId: guest.laneId, direction: "to_owner" });
        if (!offered.ok) throw new LaneShareMoveError(offered.code, offered.message);
        const record = blank({
          moveId,
          grantId: guest.grantId,
          laneId: guest.laneId,
          direction: "to_owner",
          role: "host_destination",
          expiresAt: offered.consent.expiresAt,
          chatTitle: cleanLaneShareMoveText(args.chatTitle, 300),
          laneName,
          branchName,
          starterName: guest.name,
          guestUserId: guest.userId,
          rights: guest.rights,
          repoKey: args.repoKey,
        });
        track(record);
        options.logger?.info("lane_share.move_offered", { moveId, grantId: guest.grantId, direction: "to_owner" });
        announce(record);
        return view(record);
      }
      const moveId = cleanMoveId(args.moveId);
      const record = moves.get(moveId);
      // Another grant's move reads as no move at all.
      if (!record || record.grantId !== guest.grantId || record.laneId !== guest.laneId) {
        throw new LaneShareMoveError("lane_share_move_not_found", "This shared lane has no such move.");
      }
      if (record.guestUserId && record.guestUserId !== guest.userId) {
        throw new LaneShareMoveError("lane_share_move_not_found", "This shared lane has no such move.");
      }
      if (LANE_SHARE_MOVE_FINAL_STAGES.has(record.stage)) {
        if (op === "status") return view(record);
        throw new LaneShareMoveError("lane_share_move_used", record.stage === "expired" ? "This move expired. Start it again." : "This move already ended.");
      }
      if (record.role === "host_source") return await hostSourceGuestCommand(record, guest, op, args);
      if (record.role === "host_destination") return await hostDestinationGuestCommand(record, guest, op, args);
      throw new LaneShareMoveError("lane_share_move_not_found", "This shared lane has no such move.");
    },

    /** A revoke, a leave, the end of the share, or a paused lane: every move of the grant ends now. */
    cancelGrant(grantId: string, reason = "The share ended."): number {
      let cancelled = 0;
      for (const record of moves.values()) {
        if (record.grantId !== grantId || LANE_SHARE_MOVE_FINAL_STAGES.has(record.stage)) continue;
        if (record.stage === "landing") record.cancelled = true;
        end(record, "cancelled", reason);
        cancelled += 1;
      }
      hostConsents.cancelGrant(grantId);
      localConsents.cancelGrant(grantId);
      return cancelled;
    },

    /** Rights changed: a guest that lost Collaborate keeps no move of its own going. */
    rightsChanged(grantId: string, rights: LaneShareRights | null): void {
      if (rights && isCollaborate(rights)) return;
      for (const record of moves.values()) {
        if (record.grantId === grantId && record.role === "host_destination" && !LANE_SHARE_MOVE_FINAL_STAGES.has(record.stage)) {
          if (record.stage === "landing") record.cancelled = true;
          end(record, "cancelled", "The guest's access changed.");
        }
      }
      if (!rights) service.cancelGrant(grantId);
    },

    // ----- Local part, destination (`to_guest` on the guest's own machine) -----

    /**
     * The guest pressed Accept on this machine's card. Checks this machine
     * (repository, GitHub access, a signed-in model) and only then records
     * the consent. Changes nothing else.
     */
    async receivePrepare(args: { moveId: unknown; grantId: unknown; repoKey: unknown; modelHint?: unknown; expiresAt?: unknown }) {
      sweep();
      const moveId = cleanMoveId(args.moveId);
      const grantId = cleanGrantId(args.grantId);
      const repoKey = typeof args.repoKey === "string" ? args.repoKey : "";
      if (!repoKey || repoKey !== options.getRepoKey()) {
        throw new LaneShareMoveError("lane_share_move_wrong_repo", "This project is a different repository than the shared lane.");
      }
      const modelHint = typeof args.modelHint === "string" && args.modelHint.trim() ? args.modelHint.trim().slice(0, 200) : null;
      const checked = await requireChat().checkLaneShareMoveDestination({ repoKey, modelHint });
      const expiresAt = typeof args.expiresAt === "number" && Number.isFinite(args.expiresAt) ? args.expiresAt : now() + LANE_SHARE_MOVE_TTL_MS;
      const offered = localConsents.offer({ moveId, grantId, laneId: "", direction: "to_guest", expiresAt });
      if (!offered.ok) throw new LaneShareMoveError(offered.code, offered.message);
      const accepted = localConsents.accept(moveId, grantId);
      if (!accepted.ok) throw new LaneShareMoveError(accepted.code, accepted.message);
      track(blank({ moveId, grantId, laneId: "", direction: "to_guest", role: "local_destination", expiresAt: offered.consent.expiresAt, stage: "accepted", repoKey, modelHint }));
      return { moveId, modelId: checked.modelId, expiresAt: offered.consent.expiresAt };
    },

    /** The payload arrived (from the host, through the guest client). Checked against what was prepared. */
    receiveBegin(args: { moveId: unknown; grantId: unknown; payload: unknown }): { received: number } {
      const record = localDestination(args.moveId, args.grantId);
      if (!localConsents.isAccepted(record.moveId, record.grantId) || record.stage !== "accepted") {
        throw new LaneShareMoveError("lane_share_move_no_consent", "This move was not accepted on this computer.");
      }
      if (record.payload) return { received: record.incoming?.received ?? 0 };
      const payload = parseLaneShareMovePayload(args.payload, record.moveId);
      if (payload.repoKey !== record.repoKey) throw new LaneShareMoveError("lane_share_move_wrong_repo", "The moved work is for a different repository.");
      record.payload = payload;
      record.incoming = payload.bundle ? createLaneShareMoveReceiver({ bytes: payload.bundle.bytes, sha256: payload.bundle.sha256 }) : null;
      return { received: 0 };
    },

    receiveChunk(args: { moveId: unknown; grantId: unknown; index: unknown; data: unknown }): { received: number } {
      const record = localDestination(args.moveId, args.grantId);
      if (!localConsents.isAccepted(record.moveId, record.grantId) || record.stage !== "accepted" || !record.incoming) {
        throw new LaneShareMoveError("lane_share_move_no_consent", "This move was not accepted on this computer.");
      }
      try {
        record.incoming.write(typeof args.index === "number" ? args.index : -1, args.data);
      } catch (error) {
        end(record, "failed", errorText(error));
        throw new LaneShareMoveError("lane_share_move_damaged", errorText(error));
      }
      return { received: record.incoming.received };
    },

    /** All parts arrived: uses the consent (once) and lands the work. Read the end with `receiveStatus`. */
    receiveLand(args: { moveId: unknown; grantId: unknown; fromName?: unknown; shareBack?: unknown }): { stage: LaneShareMoveStage } {
      const record = localDestination(args.moveId, args.grantId);
      if (!record.payload) throw new LaneShareMoveError("lane_share_move_no_consent", "This move has not started on this computer.");
      let shareBack: { receiverEmail: string; rights: LaneShareRights; endsAt: number | null } | null = null;
      if (args.shareBack && typeof args.shareBack === "object") {
        const raw = args.shareBack as { receiverEmail?: unknown; rights?: unknown; confirmHighRisk?: unknown; endsAt?: unknown };
        const email = typeof raw.receiverEmail === "string" ? raw.receiverEmail.trim() : "";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
          throw new LaneShareMoveError("invalid_args", "The share back address is not valid.");
        }
        shareBack = {
          receiverEmail: email,
          rights: checkedShareBackRights(raw.rights, raw.confirmHighRisk),
          endsAt: cleanEndsAt(raw.endsAt, now()),
        };
      }
      const used = localConsents.consume(record.moveId, record.grantId);
      if (!used.ok) throw new LaneShareMoveError(used.code, used.message);
      record.stage = "landing";
      void landLocally(record, cleanLaneShareMoveText(args.fromName, 80), shareBack);
      return { stage: record.stage };
    },

    receiveStatus(args: { moveId: unknown; grantId: unknown }) {
      const record = localDestination(args.moveId, args.grantId);
      return { stage: record.stage, received: record.incoming?.received ?? 0, error: record.error, result: record.result };
    },

    receiveCancel(args: { moveId: unknown; grantId: unknown }): { stage: LaneShareMoveStage } {
      let record: MoveRecord;
      try {
        record = localDestination(args.moveId, args.grantId);
      } catch {
        return { stage: "cancelled" };
      }
      if (record.stage === "landing") record.cancelled = true;
      end(record, "cancelled", "The move was cancelled.");
      return { stage: record.stage };
    },

    // ----- Local part, source (`to_owner` from the guest's own machine) -----

    /** Packs a chat of this machine for a move to the owner. Read the end with `packStatus`. */
    async packStart(args: { moveId: unknown; grantId: unknown; sessionId: unknown }): Promise<{ stage: LaneShareMoveStage; laneName: string | null; branchName: string | null; chatTitle: string | null; repoKey: string | null }> {
      sweep();
      const moveId = cleanMoveId(args.moveId);
      const grantId = cleanGrantId(args.grantId);
      const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId) throw new LaneShareMoveError("invalid_args", "Choose a chat to move.");
      if (moves.has(moveId)) throw new LaneShareMoveError("lane_share_move_used", "This move was already handled.");
      const summary = await requireChat().getSessionSummary(sessionId);
      if (!summary) throw new LaneShareMoveError("invalid_args", "That chat is not on this computer.");
      const record = blank({
        moveId,
        grantId,
        laneId: summary.laneId,
        direction: "to_owner",
        role: "local_source",
        expiresAt: now() + LANE_SHARE_MOVE_TTL_MS,
        stage: "packing",
        sessionId,
        chatTitle: cleanLaneShareMoveText(summary.title, 300),
        repoKey: options.getRepoKey(),
      });
      track(record);
      void (async () => {
        try {
          const prepared = await requireChat().prepareLaneShareMove({ sessionId, moveId });
          if (LANE_SHARE_MOVE_FINAL_STAGES.has(record.stage)) {
            prepared.bundle?.dispose();
            return;
          }
          record.payload = prepared.payload;
          record.outgoing = prepared.bundle;
          record.laneName = prepared.payload.laneName;
          record.branchName = prepared.payload.branchName;
          record.stage = "ready";
        } catch (error) {
          end(record, "failed", errorText(error));
        }
      })();
      return { stage: record.stage, laneName: null, branchName: null, chatTitle: record.chatTitle, repoKey: record.repoKey };
    },

    packStatus(args: { moveId: unknown }) {
      const record = find(cleanMoveId(args.moveId), ["local_source"]);
      return {
        stage: record.stage,
        error: record.error,
        payload: record.stage === "ready" ? record.payload : null,
      };
    },

    packChunk(args: { moveId: unknown; index: unknown }): { index: number; data: string } {
      const record = find(cleanMoveId(args.moveId), ["local_source"]);
      if (record.stage !== "ready" || !record.outgoing) throw new LaneShareMoveError("lane_share_move_no_consent", "This move is not ready.");
      const index = typeof args.index === "number" ? args.index : -1;
      return { index, data: record.outgoing.readChunk(index) };
    },

    /** The move ended on the owner's side. `landed`: one line in the source chat. Temp files go either way. */
    async packRelease(args: { moveId: unknown; landed?: unknown; toName?: unknown }): Promise<{ stage: LaneShareMoveStage }> {
      let record: MoveRecord;
      try {
        record = find(cleanMoveId(args.moveId), ["local_source"]);
      } catch {
        return { stage: "cancelled" };
      }
      if (args.landed === true && record.sessionId) {
        await requireChat().markLaneShareMoved({ sessionId: record.sessionId, moveId: record.moveId, toName: cleanLaneShareMoveText(args.toName, 80) })
          .catch((error) => options.logger?.warn("lane_share.move_mark_failed", { moveId: record.moveId, error: errorText(error) }));
        end(record, "done");
      } else {
        end(record, "cancelled");
      }
      return { stage: record.stage };
    },

    dispose(): void {
      for (const record of moves.values()) release(record);
      moves.clear();
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
    },
  };
  return service;
}

export type LaneShareMoveService = ReturnType<typeof createLaneShareMoveService>;
