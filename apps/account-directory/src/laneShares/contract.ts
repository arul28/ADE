/**
 * The lane sharing routes this Worker serves (migration 0023). Paths, request
 * and response shapes only: nothing here imports the Worker, so the desktop,
 * the brain and the web client can `import type` it or mirror it.
 *
 * A grant gives one account (the receiver) limited access to ONE lane on one
 * machine of another account (the giver). This Worker is only the index and
 * the revocation list. It never holds the detailed rights, and a grant here
 * never opens a machine by itself: the host machine keeps the rights and
 * checks `POST /lane-shares/host` on every guest connection.
 *
 * Every route takes the account token as a bearer. Errors are
 * `{ error: { code, message } }` and `message` is one plain sentence.
 * A grant the caller may not see answers 404 `not_found`, exactly as an id
 * that does not exist.
 *
 *   POST   /lane-shares                 LaneShareInviteResponse      giver: invite (or refresh a pending invite)
 *   GET    /lane-shares/given           { grants: LaneShareGiverView[] }
 *   GET    /lane-shares/received        LaneShareReceivedResponse
 *   POST   /lane-shares/host            LaneShareHostResponse        a machine of the giver
 *   GET    /lane-shares/:id             LaneShareOpenResponse        giver, receiver, or the invited address
 *   PATCH  /lane-shares/:id             { grant: LaneShareGiverView } giver: endsAt, preset, risk
 *   POST   /lane-shares/:id/accept      { grant: LaneShareReceiverView } the invited address (verified)
 *   POST   /lane-shares/:id/revoke      { grant: LaneShareGiverView } giver
 *   POST   /lane-shares/:id/leave       { grant: LaneShareReceiverView } receiver, or the invited address (decline)
 *   POST   /lane-shares/:id/move        { grant: LaneShareGiverView, moved } giver: the lane moved to another of
 *                                       its machines; every live grant of that lane follows (`moved` = how many)
 *   POST   /lane-shares/:id/connect     LaneShareConnectResponse     receiver of an ACTIVE grant: how to reach the host,
 *                                       and a one-use ticket for the host (body: LaneShareConnectRequest)
 *   POST   /lane-shares/host/redeem     LaneShareRedeemResponse      a machine of the giver: redeems a guest's ticket
 *
 * Browsers may call every route except `/lane-shares/host` and
 * `/lane-shares/host/redeem` from the hosted web client's exact origin
 * (`WEB_CLIENT_ORIGIN`). Native callers send no Origin. Any other Origin is
 * refused before the token is read.
 *
 * A guest's account token goes only to this directory. A host never sees it:
 * the guest's hello carries a one-use ticket from `connect`, and the host
 * learns the guest's user id by redeeming that ticket here.
 */

export const LANE_SHARE_PATHS = {
  root: "/lane-shares",
  given: "/lane-shares/given",
  received: "/lane-shares/received",
  host: "/lane-shares/host",
  hostRedeem: "/lane-shares/host/redeem",
} as const;

/** A grant id: `ls_` and 32 hex characters. */
export const LANE_SHARE_GRANT_ID_PATTERN = /^ls_[0-9a-f]{32}$/;

/** A connection ticket: 32 random bytes, base64url. Also the RFC 7638 thumbprint's shape (SHA-256, base64url). */
export const LANE_SHARE_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** `/lane-shares/:id` and its actions. */
export const laneSharePath = (id: string, action?: "accept" | "revoke" | "leave" | "move" | "connect"): string =>
  `${LANE_SHARE_PATHS.root}/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;

/** The link in the invite email. An address only: it gives no access. */
export const laneShareInviteLink = (id: string): string =>
  `https://ade-app.dev/open?type=lane-share&id=${encodeURIComponent(id)}`;

export const LANE_SHARE_PRESETS = ["watch", "comment", "suggest", "collaborate"] as const;
export type LaneSharePreset = (typeof LANE_SHARE_PRESETS)[number];

export const LANE_SHARE_RISKS = ["low", "medium", "high"] as const;
export type LaneShareRisk = (typeof LANE_SHARE_RISKS)[number];

/**
 * `pending`: invite sent, not accepted. `active`: accepted.
 * Final: `revoked` (giver), `left` (receiver left or declined), `expired`
 * (invite not accepted within 24 h), `ended` (`endsAt` passed).
 * `expired` and `ended` are derived from the server clock on every read.
 */
export const LANE_SHARE_STATES = ["pending", "active", "revoked", "left", "expired", "ended"] as const;
export type LaneShareState = (typeof LANE_SHARE_STATES)[number];

/** Why a final grant closed, when it was not the plain action of its state. */
export type LaneShareClosedReason = "account_deleted" | null;

/** Most guests (pending + active) one lane may have. */
export const LANE_SHARE_MAX_GUESTS_PER_LANE = 5;
/** How long an invite can be accepted. A second invite to the same address restarts it. */
export const LANE_SHARE_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
/** Invites plus re-sends one account may make per UTC day. */
export const LANE_SHARE_DAILY_INVITES_PER_GIVER = 20;
/** Invite emails one address may receive per UTC day, from all accounts together. */
export const LANE_SHARE_DAILY_EMAILS_PER_RECIPIENT = 5;
/** Least time between two emails for one invite. */
export const LANE_SHARE_RESEND_INTERVAL_MS = 10 * 60 * 1000;
/** Most emails one invite may send in its life. */
export const LANE_SHARE_MAX_EMAILS_PER_INVITE = 5;
/** Longest `endsAt` from now. */
export const LANE_SHARE_MAX_DURATION_MS = 366 * 24 * 60 * 60 * 1000;
/** How long a closed grant stays in the lists and in the host read's `closed`. */
export const LANE_SHARE_CLOSED_VISIBLE_MS = 30 * 24 * 60 * 60 * 1000;
export const LANE_SHARE_HOST_CLOSED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Invite emails all accounts together may send per UTC day. Past it an invite still works by its link. */
export const LANE_SHARE_DAILY_EMAILS_GLOBAL = 2_000;
/** Clerk Backend API reads one account's lane share calls may cause per UTC hour. */
export const LANE_SHARE_HOURLY_CLERK_READS_PER_USER = 120;
/** How long a connection ticket can be redeemed. */
export const LANE_SHARE_TICKET_TTL_MS = 2 * 60 * 1000;
/** Tickets one grant may mint per hour. */
export const LANE_SHARE_TICKET_MINTS_PER_HOUR = 30;

export type LaneShareInviteRequest = {
  /** Trimmed and lowercased by the server. */
  receiverEmail: string;
  /** `accountRepoScopeKey(origin)` from the desktop: `repo:host/owner/name`. */
  repoKey: string;
  /** The giver's machine that holds the lane. Must be a machine of the caller's account. */
  machineKey: string;
  laneId: string;
  /** Display text only; cleaned and cut to 120 characters. */
  projectLabel?: string | null;
  laneLabel?: string | null;
  preset: LaneSharePreset;
  risk: LaneShareRisk;
  /** Epoch ms, in the future, at most `LANE_SHARE_MAX_DURATION_MS` away. Null = no end. */
  endsAt?: number | null;
  /**
   * A share back after a lane share move: the id of an ACTIVE grant between
   * the caller and the other person. The invite is refused
   * (`share_back_mismatch`) unless `receiverEmail` is a verified address of
   * the other person of that grant (its receiver when the caller gave it,
   * its giver when the caller received it), and the repository is the same.
   */
  shareBackOf?: string;
};

export type LaneShareEmailNotSentReason =
  /** No email sender on this Worker. The invite still works by its link. */
  | "not_configured"
  /** A re-send inside `LANE_SHARE_RESEND_INTERVAL_MS`, or a daily or per-invite cap. */
  | "rate_limited"
  /** The sender refused or did not answer. */
  | "failed";

export type LaneShareInviteResponse = {
  grant: LaneShareGiverView;
  /** True when this call refreshed a pending invite to the same address instead of making one. */
  refreshed: boolean;
  emailSent: boolean;
  emailNotSentReason: LaneShareEmailNotSentReason | null;
  /** The invite link, to copy. Same as `grant.link`. */
  link: string;
  /** The request's `shareBackOf`, after the check passed; null for a plain invite. */
  shareBackOf: string | null;
};

export type LaneShareEditRequest = {
  endsAt?: number | null;
  preset?: LaneSharePreset;
  risk?: LaneShareRisk;
};

export type LaneShareMoveRequest = { machineKey: string };

export type LaneShareHostRequest = { machineKey: string };

type LaneShareCommon = {
  id: string;
  state: LaneShareState;
  repoKey: string;
  laneId: string;
  projectLabel: string | null;
  laneLabel: string | null;
  preset: LaneSharePreset;
  risk: LaneShareRisk;
  inviteExpiresAt: number;
  endsAt: number | null;
  version: number;
  createdAt: number;
  acceptedAt: number | null;
  closedAt: number | null;
  closedReason: LaneShareClosedReason;
};

/** What the giver sees. */
export type LaneShareGiverView = LaneShareCommon & {
  receiverEmail: string;
  receiverUserId: string | null;
  machineKey: string;
  updatedAt: number;
  link: string;
};

/**
 * What the receiver (or the invited address) sees. No machine key: the
 * receiver of an active grant asks `POST /lane-shares/:id/connect` for the
 * host's relay address when it connects.
 */
export type LaneShareReceiverView = LaneShareCommon & {
  giverUserId: string;
  giverLabel: string | null;
  receiverEmail: string;
};

export type LaneShareOpenResponse =
  | { role: "giver"; grant: LaneShareGiverView }
  | { role: "receiver" | "invitee"; grant: LaneShareReceiverView };

/**
 * How the receiver of an ACTIVE grant reaches the host machine. Only the
 * receiver may read it, and only while the grant is active. `relayUrl` is the
 * ADE Relay address the host machine published (`wss://<relay>/connect/<key>`).
 * It admits a socket to the relay and nothing more: the host redeems the
 * ticket (`POST /lane-shares/host/redeem`) on every connection, so a guest
 * that keeps the address after a revoke is refused at the host. LAN and tailnet
 * addresses are never given out; a guest connection is relay-only.
 */
export type LaneShareConnectResponse = {
  grantId: string;
  laneId: string;
  repoKey: string;
  /** Null when the host machine published no relay address (relay off, or the machine was removed). */
  relayUrl: string | null;
  /** The host machine reported in within the directory's online window. */
  hostOnline: boolean;
  /**
   * 32 random bytes, base64url, shown once. The guest's hello to the host
   * carries it with a DPoP proof signed by the key named in the request; the
   * host redeems it once, within `LANE_SHARE_TICKET_TTL_MS`. Null when there
   * is no relay address to connect to.
   */
  ticket: string | null;
  ticketExpiresAt: number | null;
};

/**
 * `dpopThumbprint`: the RFC 7638 SHA-256 JWK thumbprint (base64url, 43
 * characters) of the guest's P-256 DPoP public key. The host admits the
 * ticket only for a hello signed by that key.
 */
export type LaneShareConnectRequest = { dpopThumbprint: string };

export type LaneShareRedeemRequest = { machineKey: string; ticket: string };

/**
 * The redeemed ticket and the machine's complete live grant list, read in the
 * same call. The host admits `redeemed.receiverUserId`, never a user id the
 * guest sent, and only while the grant is active in `grants`. Every failure
 * (unknown, used, expired, another machine, a grant no longer active, a caller
 * that is not the giver) answers the same 404.
 */
export type LaneShareRedeemResponse = LaneShareHostResponse & {
  redeemed: {
    grantId: string;
    receiverUserId: string;
    laneId: string;
    repoKey: string;
    dpopThumbprint: string;
  };
};

export type LaneShareReceivedResponse = {
  grants: LaneShareReceiverView[];
  /**
   * True when Clerk could not be asked for the caller's verified addresses:
   * accepted grants are listed, pending invites are not.
   */
  pendingInvitesUnavailable: boolean;
};

/**
 * One live grant for the host. Grant access only when `state` is `active`
 * and `receiverUserId` is the connecting account.
 */
export type LaneShareHostGrant = {
  id: string;
  receiverUserId: string | null;
  laneId: string;
  repoKey: string;
  state: "pending" | "active";
  endsAt: number | null;
  preset: LaneSharePreset;
  risk: LaneShareRisk;
  version: number;
  /**
   * The receiver's name from Clerk, stored when it accepted and cleaned like
   * the invite email's sender name. Null for a pending grant, a grant
   * accepted before migration 0025, or an account with no name. The host
   * uses it as the author name of the guest's messages; the guest never
   * chooses it.
   */
  receiverName: string | null;
  createdAt: number;
  /** Null for a pending grant. */
  acceptedAt: number | null;
};

/**
 * `grants` is the COMPLETE set of live grants for this machine. A host drops
 * every cached grant whose id is not in it (revoked, left, ended, or moved to
 * another machine): absent means no access. `closed` lists grants of this
 * machine that closed in the last `LANE_SHARE_HOST_CLOSED_WINDOW_MS`, so a
 * host can say why a guest lost access; it is never needed for the decision.
 */
export type LaneShareHostResponse = {
  serverTime: number;
  grants: LaneShareHostGrant[];
  closed: Array<{
    id: string;
    receiverUserId: string | null;
    laneId: string;
    state: "revoked" | "left" | "expired" | "ended";
    closedAt: number | null;
    version: number;
  }>;
};

/** Every error code these routes answer with. */
export type LaneShareErrorCode =
  | "unauthorized"
  | "unavailable"
  | "bad_request"
  | "not_found"
  | "self_invite"
  | "already_shared"
  | "guest_limit"
  | "invite_limit"
  | "unknown_machine"
  | "invite_expired"
  | "share_closed"
  | "rate_limited"
  | "share_back_mismatch"
  | "origin_not_allowed";
