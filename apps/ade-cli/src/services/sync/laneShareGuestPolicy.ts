/**
 * What a lane-sharing guest may do on this host (package 4b: read only).
 *
 * A guest is another ADE account that the owner of this machine shared ONE
 * lane with. The host decides everything: the account directory only lists
 * the grants. These rules are default refuse. An envelope type, a command or
 * an outgoing message is closed to a guest until it is listed here, and every
 * listed item that names a session or a lane is checked against the guest's
 * grants on the host, with the session resolved to its lane from this host's
 * own database. A lane id the client sends next to a session id is never
 * trusted.
 */

export type LaneShareGuestGrant = { grantId: string; laneId: string };

/**
 * Attached to a peer by the host after a guest hello. Nothing on it comes
 * from the client: the user id is the verified token's subject, the grants
 * come from the host's grant list.
 */
export type LaneShareGuestRole = {
  readonly guest: true;
  readonly userId: string;
  /** The device id the client sent. The peer's own device id is namespaced. */
  readonly clientDeviceId: string;
  /** Pinned from the guest hello's DPoP proof; Relay refreshes must sign with it. */
  readonly dpopPublicKey: string | null;
  grants: LaneShareGuestGrant[];
  /**
   * sessionId -> its lane on this host (null: no such session), read at
   * `atMs`. Cleared when the grants change; an entry older than
   * `SESSION_LANE_TTL_MS` is read again, so a session moved to another lane
   * stops reaching the guest within that time.
   */
  readonly sessionLanes: Map<string, { laneId: string | null; atMs: number }>;
};

export const SESSION_LANE_TTL_MS = 30_000;

/**
 * The read-only commands a guest may run, and which argument names the
 * scope. `lane`: `laneId` must be a granted lane, and list results keep only
 * rows of granted lanes. `session`: `sessionId` must resolve, on this host,
 * to a granted lane.
 */
export const LANE_SHARE_GUEST_COMMANDS: Readonly<Record<string, "lane" | "session">> = Object.freeze({
  "work.listSessions": "lane",
  "chat.listSessions": "lane",
  "work.getSession": "session",
  "chat.getSummary": "session",
  "chat.getTranscript": "session",
  "chat.getChatEventHistory": "session",
  "chat.getChatEventHistoryPage": "session",
  "agentChat.getEventHistoryPage": "session",
  "chat.getSubagentTranscript": "session",
  "chat.listSubagents": "session",
  "chat.listThreadComments": "session",
});

export function isLaneShareGuestCommand(action: string): boolean {
  return Object.prototype.hasOwnProperty.call(LANE_SHARE_GUEST_COMMANDS, action);
}

/**
 * Envelope types a guest may send. `session`: the payload's `sessionId` must
 * resolve to a granted lane. `command`: the command gate below decides.
 * Every other type is refused, including terminal input and resize, file
 * requests, changesets, project and roster requests, pairing commits, and the
 * runtime RPC channel.
 */
export const LANE_SHARE_GUEST_INBOUND: ReadonlyMap<string, "none" | "session" | "command"> = new Map([
  ["heartbeat", "none"],
  ["relay_reauthorize", "none"],
  ["command", "command"],
  ["chat_subscribe", "session"],
  ["chat_unsubscribe", "session"],
  ["chat_history", "session"],
  ["chat_tool_result", "session"],
  ["terminal_subscribe", "session"],
  ["terminal_unsubscribe", "session"],
  ["terminal_history", "session"],
]);

/**
 * Envelope types a guest may receive. `session`: only when the payload's
 * `sessionId` resolves to a granted lane. Everything else (brain status, the
 * project catalog, changesets, roster, launch events, PR pushes, screen
 * streams, pairing results, runtime RPC) never goes to a guest.
 */
export const LANE_SHARE_GUEST_OUTBOUND: ReadonlyMap<string, "always" | "session"> = new Map([
  ["hello_ok", "always"],
  ["hello_error", "always"],
  ["heartbeat", "always"],
  ["relay_reauthorize_result", "always"],
  // Replies to the guest's own commands, which the command gate admitted.
  ["command_ack", "always"],
  ["command_result", "always"],
  ["chat_event", "session"],
  ["chat_subscribe", "session"],
  ["chat_history", "session"],
  ["chat_tool_result", "session"],
  ["terminal_snapshot", "session"],
  ["terminal_data", "session"],
  ["terminal_exit", "session"],
  ["terminal_history", "session"],
]);

export function laneShareGuestHasLane(role: LaneShareGuestRole, laneId: string | null | undefined): boolean {
  if (!laneId) return false;
  return role.grants.some((grant) => grant.laneId === laneId);
}

/** The lane of a session on this host, cached briefly on the role. */
export function laneShareGuestSessionLane(
  role: LaneShareGuestRole,
  sessionId: string,
  resolveSessionLaneId: (sessionId: string) => string | null,
  nowMs = Date.now(),
): string | null {
  const cached = role.sessionLanes.get(sessionId);
  if (cached && nowMs - cached.atMs < SESSION_LANE_TTL_MS) return cached.laneId;
  let laneId: string | null = null;
  try {
    laneId = resolveSessionLaneId(sessionId);
  } catch {
    laneId = null;
  }
  // Bounded: a guest that names many unknown ids cannot grow this without end.
  if (role.sessionLanes.size >= 2_048) role.sessionLanes.clear();
  role.sessionLanes.set(sessionId, { laneId, atMs: nowMs });
  return laneId;
}

/** True when this guest may see anything of `sessionId`. No session, no lane: false. */
export function laneShareGuestMaySeeSession(
  role: LaneShareGuestRole,
  sessionId: unknown,
  resolveSessionLaneId: (sessionId: string) => string | null,
): boolean {
  if (typeof sessionId !== "string" || !sessionId.trim()) return false;
  return laneShareGuestHasLane(role, laneShareGuestSessionLane(role, sessionId.trim(), resolveSessionLaneId));
}

/** Whether one outgoing envelope may reach this guest. Unlisted types never do. */
export function laneShareGuestMayReceive(
  role: LaneShareGuestRole,
  type: string,
  payload: unknown,
  resolveSessionLaneId: (sessionId: string) => string | null,
): boolean {
  const rule = LANE_SHARE_GUEST_OUTBOUND.get(type);
  if (rule === "always") return true;
  if (rule !== "session") return false;
  const sessionId = payload && typeof payload === "object" ? (payload as { sessionId?: unknown }).sessionId : null;
  return laneShareGuestMaySeeSession(role, sessionId, resolveSessionLaneId);
}

export type LaneShareGuestRefusal = { code: "forbidden_command"; message: string };

const GUEST_REFUSAL_MESSAGE = "This is not available on a shared lane.";

/**
 * The command gate for a guest. Returns the arguments to run with (a client
 * `laneId` next to a session id is removed: the host resolves the lane
 * itself), or a refusal.
 */
export function evaluateLaneShareGuestCommand(args: {
  action: string;
  args: Record<string, unknown>;
  role: LaneShareGuestRole;
  resolveSessionLaneId: (sessionId: string) => string | null;
}): { ok: true; args: Record<string, unknown> } | { ok: false; refusal: LaneShareGuestRefusal } {
  const refuse = (message = GUEST_REFUSAL_MESSAGE) => ({ ok: false as const, refusal: { code: "forbidden_command" as const, message } });
  if (!isLaneShareGuestCommand(args.action)) return refuse();
  const scope = LANE_SHARE_GUEST_COMMANDS[args.action];
  if (scope === "lane") {
    const laneId = typeof args.args.laneId === "string" ? args.args.laneId.trim() : "";
    if (!laneShareGuestHasLane(args.role, laneId)) return refuse("Name a lane that was shared with you.");
    // The conditional reply (`{ signature, notModified }` with no rows) cannot
    // be filtered row by row, so a guest always gets the plain list.
    const { conditional: _c, ifNoneMatch: _i, headRows: _h, ...rest } = args.args;
    return { ok: true, args: { ...rest, laneId } };
  }
  const sessionId = typeof args.args.sessionId === "string" ? args.args.sessionId.trim() : "";
  if (!laneShareGuestMaySeeSession(args.role, sessionId, args.resolveSessionLaneId)) return refuse();
  const { laneId: _clientLaneId, ...rest } = args.args;
  return { ok: true, args: { ...rest, sessionId } };
}

function rowLaneId(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const laneId = (row as { laneId?: unknown }).laneId;
  return typeof laneId === "string" ? laneId : null;
}

/**
 * List results keep only rows of granted lanes, even though the gate already
 * pinned `laneId`: a service that ignores the filter must not leak.
 */
export function filterLaneShareGuestCommandResult(
  action: string,
  result: unknown,
  role: LaneShareGuestRole,
): unknown {
  if (LANE_SHARE_GUEST_COMMANDS[action] !== "lane") return result;
  const keep = (rows: unknown[]) => rows.filter((row) => laneShareGuestHasLane(role, rowLaneId(row)));
  if (Array.isArray(result)) return keep(result);
  if (result && typeof result === "object" && Array.isArray((result as { sessions?: unknown }).sessions)) {
    const record = result as { sessions: unknown[] };
    return { ...record, sessions: keep(record.sessions) };
  }
  // A shape this filter does not know is not sent at all.
  return [];
}
