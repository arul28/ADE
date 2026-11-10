import type { LaneShareRights, LaneShareRiskLevel } from "../laneShareRights";

/**
 * The owner's lane sharing contract between the renderer and the machine that
 * holds the lane (`lane_share` action domain, user-only). The host service is
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
};

export type LaneShareListArgs = {
  /** `account`: every share the account gave, on any machine; `local` rows are enriched. */
  scope?: "machine" | "account";
};

export type LaneShareListResult = { shares: LaneShareGivenEntry[] };

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
    };
