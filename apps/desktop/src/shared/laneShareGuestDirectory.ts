import { encodeCodedErrorMessage, parseCodedErrorMessage } from "./codedError";
import {
  directoryNumber as num,
  directoryRisk,
  directoryString as str,
  isLaneShareGrantRecord as isGrantRecord,
  LANE_SHARE_GRANT_ID_PATTERN,
  LANE_SHARE_TICKET_PATTERN as TICKET_PATTERN,
  laneShareDirectoryError as directoryError,
} from "./laneShareDirectory";
import { trustedAccountRelayBaseUrls } from "./accountDirectory";
import type {
  LaneShareAcceptResult,
  LaneShareConnectTicket,
  LaneShareGivenEntry,
  LaneShareGuestBridge,
  LaneShareLeaveResult,
  LaneShareOpenResult,
  LaneShareReceivedEntry,
  LaneShareReceivedResult,
  LaneShareRevokeGivenResult,
} from "./types/laneShare";

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

const RELAY_CONNECT_PATH = /^\/connect\/[A-Za-z0-9._:-]{1,256}$/;

type LaneShareDirectorySend = (request: {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}) => Promise<{ status: number; body: unknown }>;

/** A received grant as the "Shared with me" list shows it. Display fields only. */
function laneShareReceivedEntry(grant: Record<string, unknown>): LaneShareReceivedEntry {
  return {
    grantId: grant.id as string,
    state: str(grant.state) ?? "unknown",
    laneId: str(grant.laneId) ?? "",
    repoKey: str(grant.repoKey),
    projectLabel: str(grant.projectLabel),
    laneLabel: str(grant.laneLabel),
    preset: str(grant.preset),
    risk: directoryRisk(grant.risk),
    giverLabel: str(grant.giverLabel),
    receiverEmail: str(grant.receiverEmail),
    endsAt: num(grant.endsAt),
    inviteExpiresAt: num(grant.inviteExpiresAt),
    createdAt: num(grant.createdAt),
    acceptedAt: num(grant.acceptedAt),
  };
}

/**
 * A given grant as the directory has it. The rights, usage and connections
 * live on the lane's computer, so they are empty here (`local: false`).
 */
function laneShareGivenEntry(grant: Record<string, unknown>): LaneShareGivenEntry {
  return {
    grantId: grant.id as string,
    laneId: str(grant.laneId) ?? "",
    receiverEmail: str(grant.receiverEmail),
    state: str(grant.state) ?? "unknown",
    endsAt: num(grant.endsAt),
    createdAt: num(grant.createdAt),
    acceptedAt: num(grant.acceptedAt),
    inviteExpiresAt: num(grant.inviteExpiresAt),
    link: str(grant.link),
    repoKey: str(grant.repoKey),
    projectLabel: str(grant.projectLabel),
    laneLabel: str(grant.laneLabel),
    preset: str(grant.preset),
    directoryRisk: directoryRisk(grant.risk),
    machineKey: str(grant.machineKey),
    local: false,
    rights: null,
    needsRights: false,
    risk: null,
    usage: null,
    connectedDevices: 0,
    laneState: null,
    createdBy: null,
  };
}

/** The given list from `GET /lane-shares/given`, malformed rows dropped. */
export function parseLaneShareGivenResponse(body: unknown): LaneShareGivenEntry[] {
  const record = body && typeof body === "object" ? body as { grants?: unknown } : {};
  const grants = Array.isArray(record.grants) ? record.grants.filter(isGrantRecord) : [];
  return grants.map(laneShareGivenEntry);
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
function trustedLaneShareRelayUrl(raw: unknown, trustedBases: readonly string[]): string | null {
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

    async listGiven(): Promise<LaneShareGivenEntry[]> {
      return parseLaneShareGivenResponse(await request("GET", "/lane-shares/given"));
    },

    async revokeGiven(args): Promise<LaneShareRevokeGivenResult> {
      const grantId = cleanGrantId(args.grantId);
      const grant = grantOf(await request("POST", `/lane-shares/${encodeURIComponent(grantId)}/revoke`));
      return { grantId, state: str(grant?.state) ?? "revoked" };
    },

    async open(args): Promise<LaneShareOpenResult> {
      const grantId = cleanGrantId(args.grantId);
      let body: unknown;
      try {
        body = await request("GET", `/lane-shares/${encodeURIComponent(grantId)}`);
      } catch (error) {
        // A grant this account may not see answers 404, the same as no grant.
        if (parseCodedErrorMessage(error).code === "not_found") return { role: "none", grant: null };
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
