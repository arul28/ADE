import { encodeCodedErrorMessage } from "./codedError";
import { trustedAccountRelayBaseUrls } from "./accountDirectory";
import type {
  LaneShareAcceptResult,
  LaneShareConnectTicket,
  LaneShareGuestBridge,
  LaneShareLeaveResult,
  LaneShareOpenResult,
  LaneShareReceivedEntry,
  LaneShareReceivedResult,
} from "./types/laneShare";
import type { LaneShareRiskLevel } from "./laneShareRights";

/**
 * The guest's account calls to the account directory (lane sharing). Pure:
 * the caller gives `send`, which attaches THIS device's own account token and
 * talks only to the trusted directory (desktop: the main process, with
 * `sendLaneShareDirectoryRequest`; web: the page's account session). The
 * token never reaches a machine of another person: the host only ever sees
 * the one-use ticket that `connect` returns.
 *
 * Everything the directory answers is read as untrusted: ids, URLs and the
 * ticket are checked here before anything uses them.
 */

export const LANE_SHARE_GRANT_ID_PATTERN = /^ls_[0-9a-f]{32}$/;
/** A ticket and an RFC 7638 thumbprint: 43 base64url characters (directory contract). */
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RELAY_CONNECT_PATH = /^\/connect\/[A-Za-z0-9._:-]{1,256}$/;

export type LaneShareDirectorySend = (request: {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}) => Promise<{ status: number; body: unknown }>;

const RISK_LEVELS = new Set<string>(["low", "medium", "high"]);
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function isGrantRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object"
    && typeof (value as { id?: unknown }).id === "string" && LANE_SHARE_GRANT_ID_PATTERN.test((value as { id: string }).id);
}

/** A received grant as the "Shared with me" list shows it. Display fields only. */
export function laneShareReceivedEntry(grant: Record<string, unknown>): LaneShareReceivedEntry {
  return {
    grantId: grant.id as string,
    state: str(grant.state) ?? "unknown",
    laneId: str(grant.laneId) ?? "",
    repoKey: str(grant.repoKey),
    projectLabel: str(grant.projectLabel),
    laneLabel: str(grant.laneLabel),
    preset: str(grant.preset),
    risk: typeof grant.risk === "string" && RISK_LEVELS.has(grant.risk) ? grant.risk as LaneShareRiskLevel : null,
    giverLabel: str(grant.giverLabel),
    receiverEmail: str(grant.receiverEmail),
    endsAt: num(grant.endsAt),
    inviteExpiresAt: num(grant.inviteExpiresAt),
    createdAt: num(grant.createdAt),
    acceptedAt: num(grant.acceptedAt),
  };
}

/** The received list from `GET /lane-shares/received`, malformed rows dropped. */
export function parseLaneShareReceivedResponse(body: unknown): LaneShareReceivedResult {
  const record = body && typeof body === "object" ? body as { grants?: unknown; pendingInvitesUnavailable?: unknown } : {};
  const grants = Array.isArray(record.grants) ? record.grants.filter(isGrantRecord) : [];
  return {
    shares: grants.map(laneShareReceivedEntry),
    pendingInvitesUnavailable: record.pendingInvitesUnavailable === true,
  };
}

/**
 * A relay address the guest may dial: `wss:` under one of ADE's trusted relays,
 * path `/connect/<key>`, no credentials, query or fragment. Null otherwise.
 * The host published this address; it is another person's data until checked.
 */
export function trustedLaneShareRelayUrl(raw: unknown, trustedBases: readonly string[]): string | null {
  if (typeof raw !== "string" || raw.length > 2_048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash) return null;
  const trusted = trustedBases.some((base) => {
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch {
      return false;
    }
    if (parsed.protocol === "https:") parsed.protocol = "wss:";
    if (parsed.origin !== url.origin) return false;
    const prefix = parsed.pathname.replace(/\/+$/, "");
    if (!url.pathname.startsWith(`${prefix}/`)) return false;
    return RELAY_CONNECT_PATH.test(url.pathname.slice(prefix.length));
  });
  return trusted ? `${url.origin}${url.pathname}` : null;
}

function cleanGrantId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!LANE_SHARE_GRANT_ID_PATTERN.test(id)) {
    throw new Error(encodeCodedErrorMessage("invalid_args", "That lane share link is not valid."));
  }
  return id;
}

/** The directory has no lane share routes (an older deploy): nothing about one share. */
export const LANE_SHARING_UNAVAILABLE = "lane_sharing_unavailable";
export const LANE_SHARING_UNAVAILABLE_MESSAGE = "Lane sharing is not available yet.";
/** One grant, or one action on it: `/lane-shares/<id>[/<action>]`. */
const ONE_GRANT_PATH = /^\/lane-shares\/ls_[0-9a-f]{32}(?:\/[a-z]+)?$/;

/**
 * Whether a directory 404 means "no such share for this account". Only for
 * one grant, and only with the directory's own `not_found` code
 * (`laneShares/routes.ts`). A list route's 404, or a 404 with no code (a
 * directory without the lane share routes answers plain text), means the
 * directory has no lane sharing.
 */
export function laneShareDirectoryNotFound(path: string, body: unknown): boolean {
  const error = body && typeof body === "object" ? (body as { error?: { code?: unknown } }).error : null;
  return ONE_GRANT_PATH.test(path) && error?.code === "not_found";
}

/** A directory error as a coded Error (`code: message`), so IPC keeps the code. */
function directoryError(status: number, body: unknown, path: string): Error {
  const error = body && typeof body === "object" ? (body as { error?: { code?: unknown; message?: unknown } }).error : null;
  const directoryCode = typeof error?.code === "string" ? error.code.slice(0, 64) : null;
  const message = typeof error?.message === "string" && error.message.trim()
    ? error.message.trim().slice(0, 300)
    : `The account directory answered ${status}.`;
  if (status === 401) return new Error(encodeCodedErrorMessage("signed_out", "Sign in to your ADE account."));
  if (status === 404) {
    return laneShareDirectoryNotFound(path, body)
      ? new Error(encodeCodedErrorMessage("not_found", message))
      : new Error(encodeCodedErrorMessage(LANE_SHARING_UNAVAILABLE, LANE_SHARING_UNAVAILABLE_MESSAGE));
  }
  if (status === 410) return new Error(encodeCodedErrorMessage(directoryCode === "invite_expired" ? "invite_expired" : "share_closed", message));
  if (status === 429) return new Error(encodeCodedErrorMessage("rate_limited", message));
  if (status >= 500) return new Error(encodeCodedErrorMessage("unavailable", message));
  return new Error(encodeCodedErrorMessage(directoryCode && /^[a-z_]+$/.test(directoryCode) ? directoryCode : "directory_refused", message));
}

export function createLaneShareGuestDirectory(options: {
  send: LaneShareDirectorySend;
  /** Relay bases this device trusts (default: ADE's own relay). */
  trustedRelayBaseUrls?: () => readonly string[];
}): LaneShareGuestBridge {
  const relayBases = () => options.trustedRelayBaseUrls?.() ?? trustedAccountRelayBaseUrls();
  const request = async (method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<unknown> => {
    const answer = await options.send({ method, path, ...(body ? { body } : {}) });
    if (answer.status < 200 || answer.status >= 300) throw directoryError(answer.status, answer.body, path);
    return answer.body;
  };
  const grantOf = (body: unknown): Record<string, unknown> | null => {
    const grant = body && typeof body === "object" ? (body as { grant?: unknown }).grant : null;
    return isGrantRecord(grant) ? grant : null;
  };

  return {
    async listReceived(): Promise<LaneShareReceivedResult> {
      return parseLaneShareReceivedResponse(await request("GET", "/lane-shares/received"));
    },

    async open(args): Promise<LaneShareOpenResult> {
      const grantId = cleanGrantId(args.grantId);
      let body: unknown;
      try {
        body = await request("GET", `/lane-shares/${encodeURIComponent(grantId)}`);
      } catch (error) {
        // A grant this account may not see answers 404, the same as no grant.
        if (error instanceof Error && error.message.startsWith("not_found:")) return { role: "none", grant: null };
        throw error;
      }
      const role = body && typeof body === "object" ? (body as { role?: unknown }).role : null;
      const grant = grantOf(body);
      if (role === "giver") return { role: "giver", grant: null };
      if ((role === "receiver" || role === "invitee") && grant && grant.id === grantId) {
        return { role, grant: laneShareReceivedEntry(grant) };
      }
      return { role: "none", grant: null };
    },

    async accept(args): Promise<LaneShareAcceptResult> {
      const grantId = cleanGrantId(args.grantId);
      const grant = grantOf(await request("POST", `/lane-shares/${encodeURIComponent(grantId)}/accept`));
      if (!grant || grant.id !== grantId) {
        throw new Error(encodeCodedErrorMessage("unavailable", "The account directory answer could not be read."));
      }
      return { grant: laneShareReceivedEntry(grant) };
    },

    async leave(args): Promise<LaneShareLeaveResult> {
      const grantId = cleanGrantId(args.grantId);
      const grant = grantOf(await request("POST", `/lane-shares/${encodeURIComponent(grantId)}/leave`));
      return { grantId, state: str(grant?.state) ?? "left" };
    },

    async connect(args): Promise<LaneShareConnectTicket> {
      const grantId = cleanGrantId(args.grantId);
      const thumbprint = typeof args.dpopThumbprint === "string" ? args.dpopThumbprint.trim() : "";
      if (!TICKET_PATTERN.test(thumbprint)) {
        throw new Error(encodeCodedErrorMessage("invalid_args", "This device's connection key is not valid."));
      }
      const body = await request("POST", `/lane-shares/${encodeURIComponent(grantId)}/connect`, { dpopThumbprint: thumbprint });
      const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
      if (record.grantId !== grantId || typeof record.laneId !== "string" || !record.laneId.trim()) {
        throw new Error(encodeCodedErrorMessage("unavailable", "The account directory answer could not be read."));
      }
      const relayUrl = record.relayUrl == null ? null : trustedLaneShareRelayUrl(record.relayUrl, relayBases());
      if (record.relayUrl != null && !relayUrl) {
        throw new Error(encodeCodedErrorMessage(
          "untrusted_relay",
          "The owner's computer published a relay address ADE does not trust. Ask the owner to update ADE.",
        ));
      }
      const ticket = typeof record.ticket === "string" && TICKET_PATTERN.test(record.ticket) ? record.ticket : null;
      return {
        grantId,
        laneId: record.laneId.trim(),
        repoKey: str(record.repoKey),
        relayUrl: ticket ? relayUrl : null,
        hostOnline: record.hostOnline === true,
        ticket: relayUrl ? ticket : null,
        ticketExpiresAt: ticket && relayUrl ? num(record.ticketExpiresAt) : null,
      };
    },
  };
}
