import type { LaneShareCliTyping, LaneShareCreatedBy, LaneShareRights, LaneShareRiskLevel } from "../laneShareRights";

/**
 * The owner's lane sharing contract between the renderer and the machine that
 * holds the lane (`lane_share` action domain). A person in the ADE app may
 * call every action; an agent or the `ade` CLI only `list`, `create` (a Watch
 * share) and `revoke` (see "Shares made by an agent" in
 * docs/features/lanes/lane-sharing.md). The host service is
 * `apps/ade-cli/src/services/sync/laneShareHostService.ts`; these are the
 * shapes it answers with, so the renderer and the host read one definition.
 */

export type LaneShareAction =
  | "list"
  | "create"
  | "updateRights"
  | "revoke"
  | "resendInvite"
  | "listReceived"
  | "leave";

/** Usage counters of one share, on the host's clock. */
export type LaneShareUsageView = {
  total: number;
  today: number;
  messagesLeftToday: number | null;
  messagesLeftTotal: number | null;
  dailyResetAt: number | null;
};

/** `missing`: the lane is gone (the share ends). `archived`: the share is paused. `unknown`: not a lane of this project. */
export type LaneShareLaneState = "active" | "archived" | "missing" | "unknown";

/** One share as the owner's list shows it. */
export type LaneShareGivenEntry = {
  grantId: string;
  laneId: string;
  receiverEmail: string | null;
  /** `pending`, `active`, `revoked`, `left`, `expired`, `ended` (directory states). */
  state: string;
  endsAt: number | null;
  createdAt: number | null;
  acceptedAt: number | null;
  /** When a pending invite stops working. */
  inviteExpiresAt: number | null;
  /** The invite link (an address only). */
  link: string | null;
  repoKey: string | null;
  projectLabel: string | null;
  laneLabel: string | null;
  /** The directory's display label of the rights. */
  preset: string | null;
  /** The directory's risk label. */
  directoryRisk: LaneShareRiskLevel | null;
  machineKey: string | null;
  /**
   * True when the share belongs to the machine and project that answered:
   * its rights, usage and connections below are real, and it can be edited
   * there. False rows come only from an account-wide list.
   */
  local: boolean;
  /**
   * Null for a share this runtime holds no rights for (made on another
   * machine, the store was lost, or a revoke that did not reach the
   * directory). Such a guest gets nothing; see `needsRights`.
   */
  rights: LaneShareRights | null;
  /** A live grant of this runtime with no rights here: the guest is refused until rights are set. */
  needsRights: boolean;
  risk: { level: LaneShareRiskLevel; reasons: string[] } | null;
  usage: LaneShareUsageView | null;
  connectedDevices: number;
  /** The shared lane on this runtime. Null for a row of another machine or project. */
  laneState: LaneShareLaneState | null;
  /**
   * Who made the share on the machine that holds it: a person in the ADE
   * app, or an agent (always a Watch share when made). Null for a row this
   * runtime holds no rights for. Absent from an older host.
   */
  createdBy?: LaneShareCreatedBy | null;
};

export type LaneShareListArgs = {
  /** `account`: every share the account gave, on any machine; `local` rows are enriched. */
  scope?: "machine" | "account";
};

export type LaneShareListResult = {
  shares: LaneShareGivenEntry[];
  /**
   * Whether the machine that answered lets a guest type into a CLI. Its local
   * rows already show `run.typeInCliSessions` as that machine enforces it.
   * Absent from an older host: read as available.
   */
  cliTyping?: LaneShareCliTyping;
};

export type LaneShareCreateArgs = {
  laneId: string;
  receiverEmail: string;
  rights: LaneShareRights;
  endsAt?: number | null;
  confirmHighRisk?: boolean;
};

/** The directory's invite answer, as far as the renderer reads it. */
export type LaneShareInviteDirectoryBody = {
  refreshed?: boolean;
  emailSent?: boolean;
  emailNotSentReason?: "not_configured" | "rate_limited" | "failed" | null;
  link?: string;
};

export type LaneShareCreateResult = {
  grantId: string;
  rights: LaneShareRights;
  risk: { level: LaneShareRiskLevel; reasons: string[] };
  directory: LaneShareInviteDirectoryBody | null;
};

export type LaneShareUpdateRightsArgs = {
  grantId: string;
  rights: LaneShareRights;
  endsAt?: number | null;
  confirmHighRisk?: boolean;
};

export type LaneShareUpdateRightsResult = {
  grantId: string;
  rights: LaneShareRights;
  risk: { level: LaneShareRiskLevel; reasons: string[] };
  appliedConnections: number;
  directorySynced: boolean;
  directoryMessage: string | null;
};

export type LaneShareRevokeResult = {
  grantId: string;
  closedConnections: number;
  removedQueuedMessages: number;
  runningTurnSessionIds: string[];
  /** False: closed on this machine, but the directory did not record it. Revoke again to finish. */
  directoryRevoked: boolean;
  directoryMessage: string | null;
};

export type LaneShareResendResult = {
  grantId: string;
  directory: LaneShareInviteDirectoryBody | null;
};

/** One share another account gave this account (`GET /lane-shares/received`). */
export type LaneShareReceivedEntry = {
  grantId: string;
  state: string;
  laneId: string;
  repoKey: string | null;
  projectLabel: string | null;
  laneLabel: string | null;
  preset: string | null;
  risk: LaneShareRiskLevel | null;
  giverLabel: string | null;
  receiverEmail: string | null;
  endsAt: number | null;
  inviteExpiresAt: number | null;
  createdAt: number | null;
  acceptedAt: number | null;
};

export type LaneShareReceivedResult = {
  shares: LaneShareReceivedEntry[];
  /** Pending invites could not be read right now; accepted shares are listed. */
  pendingInvitesUnavailable: boolean;
};

export type LaneShareLeaveResult = { grantId: string; state: string };

/**
 * Moving a chat to or from the other person of a share
 * (`shared/laneShareMove.ts`, `laneShareMoveService.ts`). `move*` without
 * Receive or Pack runs on the machine of the shared lane; `moveReceive*`
 * and `movePack*` run on the guest's own machine. Pass that machine's pin.
 */
export type LaneShareMoveAction =
  | "moveStart"
  | "moveRespond"
  | "moveCancel"
  | "moveList"
  | "moveReceivePrepare"
  | "moveReceiveBegin"
  | "moveReceiveChunk"
  | "moveReceiveLand"
  | "moveReceiveStatus"
  | "moveReceiveCancel"
  | "movePackStart"
  | "movePackStatus"
  | "movePackChunk"
  | "movePackRelease";

// ---------------------------------------------------------------------------
// The guest's side (`window.ade.laneShareGuest`). Account calls only: they go
// from THIS device to the account directory with this device's own account
// token (desktop: the main process; web: the page's account session). No
// machine is involved, so there is no pin. The shared lane's machine is
// reached only through the guest connection, with a one-use ticket.

/** How this account relates to one grant (`GET /lane-shares/:id`). `none`: not this account's grant (or no such grant). */
export type LaneShareOpenRole = "giver" | "receiver" | "invitee" | "none";

export type LaneShareOpenResult = {
  role: LaneShareOpenRole;
  /** The grant as this account may see it. Null for `none` and for `giver` (the owner opens its own Sharing list). */
  grant: LaneShareReceivedEntry | null;
};

export type LaneShareAcceptResult = { grant: LaneShareReceivedEntry };

/**
 * How to reach the shared lane's machine, once (`POST /lane-shares/:id/connect`).
 * The ticket is shown once, lives 2 minutes and is never stored or logged.
 * `relayUrl` was checked against ADE's trusted relays.
 */
export type LaneShareConnectTicket = {
  grantId: string;
  laneId: string;
  repoKey: string | null;
  relayUrl: string | null;
  hostOnline: boolean;
  ticket: string | null;
  ticketExpiresAt: number | null;
};

export type LaneShareGuestBridge = {
  listReceived: () => Promise<LaneShareReceivedResult>;
  open: (args: { grantId: string }) => Promise<LaneShareOpenResult>;
  accept: (args: { grantId: string }) => Promise<LaneShareAcceptResult>;
  leave: (args: { grantId: string }) => Promise<LaneShareLeaveResult>;
  connect: (args: { grantId: string; dpopThumbprint: string }) => Promise<LaneShareConnectTicket>;
};

/** What the host pushes on its runtime event stream (`lane_share_event`). */
export type LaneShareEvent =
  | {
      type: "lane_share_guest_turn_running";
      grantId: string;
      sessionId: string;
      guestName: string | null;
      message: string;
    }
  | {
      /** A share of this machine was made, changed, stopped or re-sent. */
      type: "lane_share_changed";
      grantId: string | null;
      laneId: string | null;
    }
  | {
      /** A guest device connected to or left this machine. */
      type: "lane_share_presence_changed";
      grantId: string;
      laneId: string | null;
    }
  | {
      /** A move to or from the other person of a share changed; the owner's card reads `moveList` again. */
      type: "lane_share_move_changed";
      grantId: string;
      laneId: string | null;
      moveId: string;
    };
