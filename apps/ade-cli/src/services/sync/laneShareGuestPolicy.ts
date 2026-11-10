import { createHash } from "node:crypto";
import {
  LANE_SHARE_GUEST_MAX_TYPED_LINE_CHARS,
  laneShareDisplayName,
  type LaneShareRights,
} from "../../../../desktop/src/shared/laneShareRights";
import {
  LANE_SHARE_PLAIN_TEXT_ONLY,
  LANE_SHARE_PLAIN_TEXT_ONLY_MESSAGE,
  leadingPromptCommandCharacter,
} from "../../../../desktop/src/shared/messageAuthor";
import { isChatToolType } from "../../../../desktop/src/shared/sessionSpawnNesting";
import { isUserOnlyConsentCard } from "../../../../desktop/src/shared/types/macDesktop";
import { isTrackedAgentCliToolType, type TerminalToolType } from "../../../../desktop/src/shared/types/sessions";

/**
 * What a lane-sharing guest may do on this host.
 *
 * A guest is another ADE account that the owner of this machine shared ONE
 * lane with. The host decides everything: the account directory only lists
 * the grants, and the rights of each grant live in this host's own table
 * (`laneShareRightsStore.ts`). These rules are default refuse. An envelope
 * type, a command or an outgoing message is closed to a guest until it is
 * listed here, a listed one needs the right it names, and every listed item
 * that names a session or a lane is checked against the guest's grant on the
 * host, with the session resolved to its lane and kind from this host's own
 * database. A lane id the client sends next to a session id is never trusted.
 */

/**
 * `endsAtMs`: the grant's end on the host clock, null for no end.
 * `sharedAtMs`: the share's start on the host clock (history cutoff), null
 * when the directory did not say. `receiverName`: the guest's name from the
 * directory, never from the guest.
 */
export type LaneShareGuestGrant = {
  grantId: string;
  laneId: string;
  endsAtMs: number | null;
  sharedAtMs?: number | null;
  receiverName?: string | null;
};

/** What a guest's rights see a session as. A shell is never written to by a guest. */
export type LaneShareSessionKind = "chat" | "cli" | "shell";

/** A session on this host, as the guest gates read it. */
export type LaneShareGuestSessionInfo = {
  laneId: string | null;
  kind: LaneShareSessionKind;
  /** When the session started (host clock). Null when unknown. */
  startedAtMs: number | null;
};

export type LaneShareSessionResolver = (sessionId: string) => LaneShareGuestSessionInfo | null;

/**
 * Attached to a peer by the host after a guest hello. Nothing on it comes
 * from the client: the user id and the grant come from the account
 * directory's answer to the redeemed ticket, the grant's lane and end from the
 * host's grant list, the rights from the host's own table.
 */
export type LaneShareGuestRole = {
  readonly guest: true;
  readonly userId: string;
  /** The grant the redeemed ticket names. The connection never reaches another grant. */
  readonly grantId: string;
  /** The device id the client sent. The peer's own device id is namespaced. */
  readonly clientDeviceId: string;
  /** The key that signed the hello: the one the ticket was minted for. */
  readonly dpopPublicKey: string;
  grants: LaneShareGuestGrant[];
  /** The grant's rights, read from the host's table. A change applies to the next action. */
  rights: LaneShareRights;
  /** The directory's name for the guest (cleaned). Null: no trusted name. */
  name: string | null;
  /**
   * The history cutoff when the directory did not say when the share
   * started: when this host stored the share, else when this guest connected.
   */
  readonly historyFallbackMs: number;
  /**
   * sessionId -> what the host knows of it (null: no such session), read at
   * `atMs`. Cleared when the grants or rights change; an entry older than
   * `SESSION_LANE_TTL_MS` is read again, so a session moved to another lane
   * stops reaching the guest within that time.
   */
  readonly sessionLanes: Map<string, { info: LaneShareGuestSessionInfo | null; atMs: number }>;
  /** Fixed-window rate limit on everything this connection sends. */
  readonly rate: { windowStartMs: number; count: number };
};

export const SESSION_LANE_TTL_MS = 30_000;
/** A guest connection may send this many envelopes per `LANE_SHARE_GUEST_RATE_WINDOW_MS`. */
export const LANE_SHARE_GUEST_RATE_LIMIT = 200;
export const LANE_SHARE_GUEST_RATE_WINDOW_MS = 10_000;
/** Devices of one guest connected to one grant at the same time. */
export const LANE_SHARE_MAX_DEVICES_PER_GRANT = 3;
/** Drafts one guest may keep, and comments one guest may keep on one chat. */
export const LANE_SHARE_MAX_GUEST_DRAFTS = 5;
export const LANE_SHARE_MAX_GUEST_COMMENTS_PER_SESSION = 20;

/** What a session's tool type is to a guest's rights. Unknown kinds are shells: read only. */
export function laneShareSessionKind(toolType: string | null | undefined): LaneShareSessionKind {
  if (isChatToolType(toolType)) return "chat";
  if (isTrackedAgentCliToolType((toolType ?? null) as TerminalToolType | null)) return "cli";
  return "shell";
}

/** Whether these rights let a guest see a session of this kind at all. */
export function laneShareRightsSeeKind(rights: LaneShareRights, kind: LaneShareSessionKind): boolean {
  if (kind === "chat") return rights.see.chats;
  if (kind === "cli") return rights.see.cliSessions;
  return rights.see.shells;
}

type RightCheck = (rights: LaneShareRights) => boolean;

export type LaneShareGuestCommandRule = {
  /**
   * `lane`: `laneId` must be the granted lane. `session`: the session named by
   * `sessionKey` (default `sessionId`) must resolve, on this host, to the
   * granted lane and to a kind in `kinds` the rights let the guest see.
   * `none`: no lane or session argument (the result is filtered by the host).
   */
  readonly scope: "lane" | "session" | "none";
  readonly sessionKey?: string;
  /** Session kinds the command applies to. Default: every kind the rights can see. */
  readonly kinds?: readonly LaneShareSessionKind[];
  /**
   * The only arguments a guest's call keeps; every other key is dropped, so
   * a flag that widens what a command reads or does (`includeIdentity`,
   * `requestedCwd`, `presetId`, `runtime`, a client `laneId` next to a session
   * id, a client `metadata.author`) never reaches the handler. The scope key
   * is set by the gate.
   */
  readonly args: readonly string[];
  /** The right the command needs on top of seeing its lane or session. */
  readonly needs: RightCheck;
  /** `read` commands run with `readOnly` (no write on a read). */
  readonly kind: "read" | "write";
};

const anySee: RightCheck = (rights) => rights.see.chats || rights.see.cliSessions || rights.see.shells;
const always: RightCheck = () => true;
const CHAT: readonly LaneShareSessionKind[] = ["chat"];

/**
 * Every command a guest may run, with the right it needs. A rights object
 * with every switch on still reaches only these. Notably absent: anything
 * that writes to a shell, starts a shell, deletes or archives, moves a chat,
 * changes a provider account, sends a draft, reads another lane, or names a
 * file path the host did not resolve.
 */
export const LANE_SHARE_GUEST_COMMANDS: Readonly<Record<string, LaneShareGuestCommandRule>> = Object.freeze({
  // See.
  "work.listSessions": { scope: "lane", args: ["status", "limit"], needs: anySee, kind: "read" },
  "chat.listSessions": { scope: "lane", args: ["includeArchived"], needs: (rights) => rights.see.chats, kind: "read" },
  "work.getSession": { scope: "session", args: [], needs: always, kind: "read" },
  "chat.getSummary": { scope: "session", kinds: CHAT, args: [], needs: always, kind: "read" },
  "chat.getTranscript": { scope: "session", kinds: CHAT, args: ["limit", "maxChars", "cursor", "cursorKind"], needs: always, kind: "read" },
  "chat.getChatEventHistory": {
    scope: "session",
    kinds: CHAT,
    args: ["maxEvents", "maxBytes", "afterOffset", "historyGeneration"],
    needs: always,
    kind: "read",
  },
  "chat.getChatEventHistoryPage": { scope: "session", kinds: CHAT, args: ["beforeOffset", "beforeSequence", "maxBytes"], needs: always, kind: "read" },
  "agentChat.getEventHistoryPage": { scope: "session", kinds: CHAT, args: ["beforeOffset", "beforeSequence", "maxBytes"], needs: always, kind: "read" },
  // The host also checks that `agentId`/`taskId` is a subagent of this chat
  // (`laneShareGuestSubagentBelongs`) before the provider sees it.
  "chat.getSubagentTranscript": {
    scope: "session",
    kinds: CHAT,
    args: ["agentId", "taskId", "limit", "offset"],
    needs: (rights) => rights.see.subagentChats,
    kind: "read",
  },
  "chat.listSubagents": { scope: "session", kinds: CHAT, args: [], needs: (rights) => rights.see.subagentChats, kind: "read" },
  "chat.listThreadComments": { scope: "session", kinds: CHAT, args: [], needs: always, kind: "read" },

  // Speak. The host sets the author of each write and checks ownership of
  // the comment, draft or queued message a guest edits or removes.
  "chat.createThreadComment": {
    scope: "session",
    kinds: CHAT,
    args: ["messageKey", "messageExcerpt", "anchor", "body"],
    needs: (rights) => rights.speak.comment,
    kind: "write",
  },
  "chat.updateThreadComment": { scope: "session", kinds: CHAT, args: ["commentId", "body"], needs: (rights) => rights.speak.comment, kind: "write" },
  "chat.deleteThreadComment": { scope: "session", kinds: CHAT, args: ["commentId"], needs: (rights) => rights.speak.comment, kind: "write" },
  "chat.listDrafts": { scope: "none", args: [], needs: (rights) => rights.speak.drafts, kind: "read" },
  // A guest's draft names the chat it is for. No schedule, no attachments:
  // only the owner sends a draft, and it then counts for the owner.
  "chat.createDraft": {
    scope: "session",
    sessionKey: "originSessionId",
    kinds: CHAT,
    args: ["text"],
    needs: (rights) => rights.speak.drafts,
    kind: "write",
  },
  "chat.updateDraft": { scope: "none", args: ["id", "text"], needs: (rights) => rights.speak.drafts, kind: "write" },
  "chat.deleteDraft": { scope: "none", args: ["id"], needs: (rights) => rights.speak.drafts, kind: "write" },
  "chat.send": { scope: "session", kinds: CHAT, args: ["text", "clientSendId"], needs: (rights) => rights.speak.send, kind: "write" },
  "chat.steer": { scope: "session", kinds: CHAT, args: ["text", "dispatchMode"], needs: (rights) => rights.speak.steer, kind: "write" },
  // Stop a running turn. The host also checks whose turn it is: a guest's
  // own turn needs `speak.steer`, anyone else's needs `speak.interruptAnyTurn`.
  "chat.interrupt": {
    scope: "session",
    kinds: CHAT,
    args: [],
    needs: (rights) => rights.speak.steer || rights.speak.interruptAnyTurn,
    kind: "write",
  },
  "chat.cancelSteer": {
    scope: "session",
    kinds: CHAT,
    args: ["steerId"],
    needs: (rights) => rights.speak.send || rights.speak.steer,
    kind: "write",
  },

  // Run. Model, reasoning and permission mode are checked against the locks
  // by the host (`laneShareCheckLocks`).
  "chat.create": {
    scope: "lane",
    args: ["provider", "modelId", "reasoningEffort", "permissionMode"],
    needs: (rights) => rights.run.startChats,
    kind: "write",
  },
  "work.startCliSession": {
    scope: "lane",
    args: ["provider", "modelId", "reasoningEffort", "permissionMode", "initialInput", "title", "cols", "rows"],
    needs: (rights) => rights.run.startCliSessions,
    kind: "write",
  },
  "chat.updateSession": {
    scope: "session",
    kinds: CHAT,
    args: ["modelId", "reasoningEffort", "permissionMode"],
    needs: (rights) => rights.speak.send || rights.speak.steer || rights.run.startChats,
    kind: "write",
  },

  // Decide. `chat.respondToInput` also needs the right of the card's kind
  // (`laneShareInputKindRight`), read from the host's own pending list.
  "chat.approve": {
    scope: "session",
    kinds: CHAT,
    args: ["itemId", "decision", "responseText"],
    needs: (rights) => rights.decide.approvals,
    kind: "write",
  },
  "chat.respondToInput": {
    scope: "session",
    kinds: CHAT,
    args: ["itemId", "decision", "answers", "responseText"],
    needs: (rights) => rights.decide.approvals || rights.decide.questions,
    kind: "write",
  },
  "chat.dismissPendingInput": { scope: "session", kinds: CHAT, args: ["itemId"], needs: (rights) => rights.decide.questions, kind: "write" },

  // Tools: reads of the granted lane only, with paths and commits checked
  // here (`laneShareSafeRelativePath`, `COMMIT_SHA`). No compare refs and no
  // other lanes' scope.
  "git.listRecentCommits": { scope: "lane", args: ["limit", "skip"], needs: (rights) => rights.tools.git, kind: "read" },
  "git.listCommitFiles": { scope: "lane", args: ["commitSha"], needs: (rights) => rights.tools.git, kind: "read" },
  "git.getCommitMessage": { scope: "lane", args: ["commitSha"], needs: (rights) => rights.tools.git, kind: "read" },
  "git.getFileHistory": { scope: "lane", args: ["path", "limit"], needs: (rights) => rights.tools.git, kind: "read" },
  "git.getChanges": { scope: "lane", args: [], needs: (rights) => rights.tools.diff, kind: "read" },
  "git.getBranchChanges": { scope: "lane", args: [], needs: (rights) => rights.tools.diff, kind: "read" },
  "git.getFile": { scope: "lane", args: ["path", "mode"], needs: (rights) => rights.tools.diff, kind: "read" },
  "git.getFilePatch": { scope: "lane", args: ["path", "mode"], needs: (rights) => rights.tools.diff, kind: "read" },
  "prs.getForLane": { scope: "lane", args: [], needs: (rights) => rights.tools.pr, kind: "read" },
});

/**
 * Commands only the host answers for a guest (no remote command behind
 * them). `laneShare.getGuestState`: the guest's own rights, limits, locks,
 * who is present, and whether the share is paused. `laneShare.move`: one
 * step of a move of a chat to or from the guest; the move service binds it
 * to the grant, the lane, the move id and the consent
 * (`laneShareMoveService.ts`).
 */
export const LANE_SHARE_GUEST_HOST_COMMANDS = new Set(["laneShare.getGuestState", "laneShare.move"]);

/** Commands that count as one guest message against the limits. */
export const LANE_SHARE_COUNTED_COMMANDS = new Set(["chat.send", "chat.steer", "work.startCliSession"]);

export function isLaneShareGuestCommand(action: string): boolean {
  return Object.prototype.hasOwnProperty.call(LANE_SHARE_GUEST_COMMANDS, action);
}

/**
 * Envelope types a guest may send. `session`: the payload's `sessionId` must
 * resolve to a granted lane and a kind the rights see. `command`: the
 * command gate below decides. `terminal_input`: the session must also be a
 * CLI session and the rights must allow typing into one (never a shell).
 * `file`: a read file request in the granted lane's worktree, with the file
 * tools switch on. Every other type is refused, including terminal resize,
 * file writes, changesets, project and roster requests, pairing commits, and
 * the runtime RPC channel.
 */
export const LANE_SHARE_GUEST_INBOUND: ReadonlyMap<string, "none" | "session" | "command" | "terminal_input" | "file"> = new Map([
  ["heartbeat", "none"],
  // No `relay_reauthorize`: a guest has no Relay lease to refresh (its
  // session is bounded by the host's grant checks), and that message would
  // carry an account token.
  ["command", "command"],
  ["chat_subscribe", "session"],
  ["chat_unsubscribe", "session"],
  ["chat_history", "session"],
  ["chat_tool_result", "session"],
  ["terminal_subscribe", "session"],
  ["terminal_unsubscribe", "session"],
  ["terminal_history", "session"],
  ["terminal_input", "terminal_input"],
  ["file_request", "file"],
] as const);

/**
 * Envelope types a guest may receive. `session`: only when the payload's
 * `sessionId` resolves to a granted lane and a kind the rights see.
 * Everything else (brain status, the project catalog, changesets, roster,
 * launch events, PR pushes, screen streams, pairing results, runtime RPC)
 * never goes to a guest.
 */
export const LANE_SHARE_GUEST_OUTBOUND: ReadonlyMap<string, "always" | "session"> = new Map([
  ["hello_ok", "always"],
  ["hello_error", "always"],
  ["heartbeat", "always"],
  ["relay_reauthorize_result", "always"],
  // Replies to the guest's own requests, which the gates admitted.
  ["command_ack", "always"],
  ["command_result", "always"],
  ["file_response", "always"],
  ["chat_event", "session"],
  ["chat_subscribe", "session"],
  ["chat_history", "session"],
  ["chat_tool_result", "session"],
  ["terminal_snapshot", "session"],
  ["terminal_data", "session"],
  ["terminal_exit", "session"],
  ["terminal_history", "session"],
  ["terminal_input_ack", "session"],
  // Only the grant id: the guest reads its state again (`laneShare.getGuestState`).
  ["lane_share_guest_changed", "always"],
] as const);

/**
 * A granted lane whose end, checked on every use, has not passed: the grant's
 * end from the directory and the end date in the host's rights. Every scope
 * check, every outgoing session payload and every file request goes through
 * here, so an end date that passes stops all of them at once.
 */
export function laneShareGuestHasLane(role: LaneShareGuestRole, laneId: string | null | undefined, nowMs = Date.now()): boolean {
  if (!laneId) return false;
  // The host's own end date (`rights.limits.endsAt`), not only the directory's.
  if (role.rights.limits.endsAt != null && nowMs >= role.rights.limits.endsAt) return false;
  return role.grants.some((grant) => grant.laneId === laneId && (grant.endsAtMs == null || grant.endsAtMs > nowMs));
}

/** What the host knows of a session, cached briefly on the role. */
export function laneShareGuestSessionInfo(
  role: LaneShareGuestRole,
  sessionId: string,
  resolveSession: LaneShareSessionResolver,
  nowMs = Date.now(),
): LaneShareGuestSessionInfo | null {
  const cached = role.sessionLanes.get(sessionId);
  if (cached && nowMs - cached.atMs < SESSION_LANE_TTL_MS) return cached.info;
  let info: LaneShareGuestSessionInfo | null = null;
  try {
    info = resolveSession(sessionId);
  } catch {
    info = null;
  }
  // Bounded: a guest that names many unknown ids cannot grow this without end.
  if (role.sessionLanes.size >= 2_048) role.sessionLanes.clear();
  role.sessionLanes.set(sessionId, { info, atMs: nowMs });
  return info;
}

/**
 * The session a guest may see, or null: it exists on this host, sits in the
 * granted lane, and the rights see its kind (and `kinds` when given).
 */
export function laneShareGuestVisibleSession(
  role: LaneShareGuestRole,
  sessionId: unknown,
  resolveSession: LaneShareSessionResolver,
  kinds?: readonly LaneShareSessionKind[],
): LaneShareGuestSessionInfo | null {
  if (typeof sessionId !== "string" || !sessionId.trim()) return null;
  const info = laneShareGuestSessionInfo(role, sessionId.trim(), resolveSession);
  if (!info || !laneShareGuestHasLane(role, info.laneId)) return null;
  if (!laneShareRightsSeeKind(role.rights, info.kind)) return null;
  if (kinds && !kinds.includes(info.kind)) return null;
  return info;
}

/** True when this guest may see anything of `sessionId`. */
export function laneShareGuestMaySeeSession(
  role: LaneShareGuestRole,
  sessionId: unknown,
  resolveSession: LaneShareSessionResolver,
): boolean {
  return laneShareGuestVisibleSession(role, sessionId, resolveSession) != null;
}

/** Whether one outgoing envelope may reach this guest. Unlisted types never do. */
export function laneShareGuestMayReceive(
  role: LaneShareGuestRole,
  type: string,
  payload: unknown,
  resolveSession: LaneShareSessionResolver,
): boolean {
  const rule = LANE_SHARE_GUEST_OUTBOUND.get(type);
  if (rule === "always") return true;
  if (rule !== "session") return false;
  const sessionId = payload && typeof payload === "object" ? (payload as { sessionId?: unknown }).sessionId : null;
  return laneShareGuestMaySeeSession(role, sessionId, resolveSession);
}

export type LaneShareGuestRefusal = { code: string; message: string; resetAt?: number | null };

const GUEST_REFUSAL_MESSAGE = "This is not available on a shared lane.";

const refusal = (message = GUEST_REFUSAL_MESSAGE, code = "forbidden_command"): { ok: false; refusal: LaneShareGuestRefusal } =>
  ({ ok: false, refusal: { code, message } });

const COMMIT_SHA = /^[0-9a-fA-F]{7,64}$/;
/** Diff modes a guest may read: the lane's own changes, never a compare ref. */
const GUEST_DIFF_MODES = new Set(["unstaged", "staged", "branch"]);

/**
 * A path relative to the lane's worktree, or null. No absolute or drive path,
 * no `..` segment, no NUL, nothing inside `.git`. The file and diff services
 * then resolve it inside the lane's worktree on this host (symlinks
 * included), so this is the first of two checks.
 */
export function laneShareSafeRelativePath(value: unknown, options: { allowEmpty?: boolean } = {}): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return options.allowEmpty ? "" : null;
  if (trimmed.length > 4_096 || trimmed.includes("\0")) return null;
  const slashed = trimmed.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[a-zA-Z]:/.test(slashed) || slashed.startsWith("~")) return null;
  const segments = slashed.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === ".." || segment.toLowerCase() === ".git")) return null;
  if (segments.length === 0) return options.allowEmpty ? "" : null;
  return segments.join("/");
}

/** Extra argument checks for the tool reads: paths, commits and diff modes. */
function checkToolArgs(action: string, kept: Record<string, unknown>): string | null {
  if ("commitSha" in kept && (typeof kept.commitSha !== "string" || !COMMIT_SHA.test(kept.commitSha))) {
    return "Name a commit by its hash.";
  }
  if (action === "git.getFile" || action === "git.getFilePatch" || action === "git.getFileHistory") {
    const path = laneShareSafeRelativePath(kept.path);
    if (!path) return "That path is outside the shared lane.";
    if (laneShareIsAdeStatePath(path)) return "That file is not shared on this lane.";
    kept.path = path;
  }
  if (action === "git.getFile" || action === "git.getFilePatch") {
    if (!GUEST_DIFF_MODES.has(String(kept.mode))) return "That comparison is not available on a shared lane.";
    // An unstaged read opens the working-tree file: the diff service asks git
    // on this host and refuses an ignored file (`.env`) or a link to one.
    kept.refuseIgnored = true;
  }
  return null;
}

/**
 * The command gate for a guest. Returns the arguments to run with (a client
 * `laneId` next to a session id is removed: the host resolves the lane
 * itself), the rule, and the session it names, or a refusal. The host then
 * runs the checks that need its services (locks, limits, ownership, the kind
 * of a pending card).
 */
export function evaluateLaneShareGuestCommand(args: {
  action: string;
  args: Record<string, unknown>;
  role: LaneShareGuestRole;
  resolveSession: LaneShareSessionResolver;
}):
  | { ok: true; args: Record<string, unknown>; rule: LaneShareGuestCommandRule; session: LaneShareGuestSessionInfo | null }
  | { ok: false; refusal: LaneShareGuestRefusal } {
  if (!isLaneShareGuestCommand(args.action)) return refusal();
  const rule = LANE_SHARE_GUEST_COMMANDS[args.action]!;
  if (!rule.needs(args.role.rights)) return refusal("Your access to this shared lane does not include this.", "lane_share_right_missing");
  // Only the listed arguments survive. The conditional list reply (`{
  // signature, notModified }` with no rows) cannot be filtered row by row, so
  // its flags are not listed and a guest always gets the plain list.
  const kept: Record<string, unknown> = {};
  for (const key of rule.args) {
    if (Object.prototype.hasOwnProperty.call(args.args, key)) kept[key] = args.args[key];
  }
  const toolProblem = checkToolArgs(args.action, kept);
  if (toolProblem) return refusal(toolProblem);
  if (rule.scope === "none") return { ok: true, args: kept, rule, session: null };
  if (rule.scope === "lane") {
    const laneId = typeof args.args.laneId === "string" ? args.args.laneId.trim() : "";
    if (!laneShareGuestHasLane(args.role, laneId)) return refusal("Name a lane that was shared with you.");
    return { ok: true, args: { ...kept, laneId }, rule, session: null };
  }
  const sessionKey = rule.sessionKey ?? "sessionId";
  const sessionId = typeof args.args[sessionKey] === "string" ? (args.args[sessionKey] as string).trim() : "";
  const session = laneShareGuestVisibleSession(args.role, sessionId, args.resolveSession, rule.kinds);
  if (!session) return refusal();
  return { ok: true, args: { ...kept, [sessionKey]: sessionId }, rule, session };
}

/**
 * The model, reasoning level and permission mode a guest asks for, checked
 * against the locks. An empty lock means "the current value, no change": a
 * request for anything else is refused, and so is a new chat or CLI session
 * (it has no current value). `current` is the session's, for a change.
 */
export function laneShareCheckLocks(
  rights: LaneShareRights,
  requested: { modelId?: unknown; reasoningEffort?: unknown; permissionMode?: unknown },
  current: { modelId?: string | null; reasoningEffort?: string | null; permissionMode?: string | null } | null,
): LaneShareGuestRefusal | null {
  const check = (value: unknown, lock: readonly string[], now: string | null | undefined, what: string, code: string): LaneShareGuestRefusal | null => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") return { code, message: `That ${what} is not available on this shared lane.` };
    const trimmed = value.trim();
    if (lock.includes(trimmed)) return null;
    if (lock.length === 0 && current && now != null && trimmed === now) return null;
    return { code, message: `The owner locked the ${what} on this shared lane.` };
  };
  return check(requested.modelId, rights.run.models, current?.modelId, "model", "lane_share_model_locked")
    ?? check(requested.reasoningEffort, rights.run.reasoningLevels, current?.reasoningEffort, "reasoning level", "lane_share_reasoning_locked")
    ?? check(requested.permissionMode, rights.run.permissionModes, current?.permissionMode, "permission mode", "lane_share_permission_locked");
}

/** The session fields that decide the mode a turn really runs in. */
export type LaneShareSessionModes = {
  provider?: string | null;
  modelId?: string | null;
  permissionMode?: string | null;
  interactionMode?: string | null;
  claudePermissionMode?: string | null;
  claudePrePlanAccessMode?: string | null;
  codexApprovalPolicy?: string | null;
  codexSandbox?: string | null;
  codexConfigSource?: string | null;
  opencodePermissionMode?: string | null;
  droidPermissionMode?: string | null;
  copilotPermissionMode?: string | null;
  musePermissionMode?: string | null;
  cursorModeId?: string | null;
};

const CLAUDE_ACCESS_TO_MODE: Record<string, string> = {
  default: "default",
  auto: "auto",
  acceptEdits: "edit",
  bypassPermissions: "full-auto",
};

/**
 * Every permission mode a turn in this session can run in, read from the
 * provider's own settings, not the legacy `permissionMode` label (a stored
 * field that can lag the native one). The mapping is the chat service's own
 * (`syncLegacyPermissionMode`). A chat in plan mode gives two: plan, and the
 * mode an approved plan returns to (for Claude the saved pre-plan mode,
 * `default` when none is saved). `null`: the native settings name no mode the
 * lock can hold (an unmapped Codex pair, a Droid tier with no ADE word), which
 * the lock refuses.
 */
export function laneShareEffectiveModes(session: LaneShareSessionModes): string[] | null {
  const legacy = session.permissionMode ?? "default";
  const plan = session.interactionMode === "plan";
  const withPlan = (mode: string | null | undefined): string[] | null => {
    if (!mode) return null;
    return plan && mode !== "plan" ? ["plan", mode] : [mode];
  };
  switch (session.provider) {
    case "claude": {
      if (plan || session.claudePermissionMode === "plan") {
        const after = session.claudePrePlanAccessMode ? ownMode(CLAUDE_ACCESS_TO_MODE, session.claudePrePlanAccessMode) : "default";
        return after ? ["plan", after] : null;
      }
      const mode = session.claudePermissionMode ? ownMode(CLAUDE_ACCESS_TO_MODE, session.claudePermissionMode) : legacy;
      return mode ? [mode] : null;
    }
    case "codex": {
      if (!session.codexApprovalPolicy && !session.codexSandbox && !session.codexConfigSource) return [legacy];
      if (session.codexConfigSource === "config-toml") return ["config-toml"];
      const approval = session.codexApprovalPolicy ?? "";
      const sandbox = session.codexSandbox ?? "";
      if (approval === "never" && sandbox === "danger-full-access") return ["full-auto"];
      if (approval === "untrusted" && sandbox === "workspace-write") return ["edit"];
      if ((approval === "on-request" || approval === "on-failure") && sandbox === "workspace-write") return ["default"];
      if ((approval === "on-request" || approval === "untrusted") && sandbox === "read-only") return ["plan"];
      return null;
    }
    case "droid":
    case "factory": {
      if (!session.droidPermissionMode) return withPlan(session.opencodePermissionMode ?? legacy);
      return withPlan(ownMode(DROID_TO_MODE, session.droidPermissionMode));
    }
    case "muse":
      return withPlan(session.musePermissionMode ? ownMode(MUSE_TO_MODE, session.musePermissionMode) : legacy);
    case "copilot":
      return withPlan(session.copilotPermissionMode ? ownMode(COPILOT_TO_MODE, session.copilotPermissionMode) : legacy);
    case "cursor":
      if (session.cursorModeId === undefined) return withPlan(legacy);
      return withPlan(session.cursorModeId === null ? "default" : ownMode(CURSOR_TO_MODE, session.cursorModeId));
    case "pi":
      return withPlan(legacy);
    default:
      // OpenCode and providers that speak its modes.
      return withPlan(session.opencodePermissionMode ? ownMode(OPENCODE_TO_MODE, session.opencodePermissionMode) : legacy);
  }
}

/** The ADE mode a native value names, or null (own keys only). */
function ownMode(map: Readonly<Record<string, string>>, value: string): string | null {
  return Object.prototype.hasOwnProperty.call(map, value) ? map[value]! : null;
}

const DROID_TO_MODE: Record<string, string> = { "read-only": "plan", "auto-low": "edit", "auto-medium": "default", "auto-high": "full-auto" };
const MUSE_TO_MODE: Record<string, string> = { denyUnmatched: "plan", promptUnmatched: "edit", onRequest: "default", allowAll: "full-auto" };
const COPILOT_TO_MODE: Record<string, string> = { plan: "plan", ask: "default", assisted: "edit", "auto-edit": "edit", "full-auto": "full-auto" };
const CURSOR_TO_MODE: Record<string, string> = { "full-auto": "full-auto", plan: "plan", ask: "edit", agent: "default" };
const OPENCODE_TO_MODE: Record<string, string> = { plan: "plan", edit: "edit", "full-auto": "full-auto", "config-toml": "config-toml" };

/**
 * Whether a guest turn may run in a session as it is now: with a non-empty
 * lock, the session's current model and every mode the turn can run in
 * (`laneShareEffectiveModes`) must be in it. A guest never sends into a chat
 * the owner set to a mode it did not allow, and never into a plan that would
 * return to such a mode when it is approved.
 */
export function laneShareSessionWithinLocks(
  rights: LaneShareRights,
  session: LaneShareSessionModes,
): LaneShareGuestRefusal | null {
  if (rights.run.models.length > 0 && !rights.run.models.includes(String(session.modelId ?? ""))) {
    return { code: "lane_share_model_locked", message: "This chat uses a model the owner did not allow on this shared lane." };
  }
  if (rights.run.permissionModes.length > 0) {
    const allowed = rights.run.permissionModes as readonly string[];
    const modes = laneShareEffectiveModes(session);
    if (!modes || !modes.every((mode) => allowed.includes(mode))) {
      return {
        code: "lane_share_permission_locked",
        message: "This chat runs in a permission mode the owner did not allow on this shared lane.",
      };
    }
  }
  return null;
}

/** What a guest sees of a card only the owner may answer. */
export const LANE_SHARE_OWNER_ONLY_CARD_TEXT = "Waiting for the owner. Only the owner can answer this.";

const OWNER_ONLY_CARD_KEPT_KEYS = ["requestId", "itemId", "kind", "turnId", "source", "blocking", "createdAt"] as const;

function ownerOnlyCardRequest(request: Record<string, unknown>): Record<string, unknown> | null {
  const metadata = request.providerMetadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  if (!isUserOnlyConsentCard(metadata as Record<string, unknown>)) return null;
  const kept: Record<string, unknown> = {};
  for (const key of OWNER_ONLY_CARD_KEPT_KEYS) if (key in request) kept[key] = request[key];
  return {
    ...kept,
    title: LANE_SHARE_OWNER_ONLY_CARD_TEXT,
    description: LANE_SHARE_OWNER_ONLY_CARD_TEXT,
    questions: [],
    allowsFreeform: false,
    providerMetadata: { laneShareOwnerOnly: true },
  };
}

/**
 * A payload for a guest with each card only the owner may answer
 * (`isUserOnlyConsentCard`: a secret, an MCP server, an integration
 * connect, the Mac real-input lease, a shared-desktop consent, an MCP App
 * call) reduced to its ids and a "waiting for the owner" line. The card's
 * text, questions and metadata can name a secret, a command line or an
 * account, and a guest can never answer it anyway. Covers the card itself
 * (pending lists) and the `approval_request` event that carries it.
 */
export function laneShareScrubOwnerOnlyCards<T>(value: T, depth = 0): T {
  if (depth > 12 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => laneShareScrubOwnerOnlyCards(entry, depth + 1)) as T;
  const record = value as Record<string, unknown>;
  const card = ownerOnlyCardRequest(record);
  if (card) return card as T;
  if (record.type === "approval_request" && record.detail && typeof record.detail === "object") {
    const request = (record.detail as Record<string, unknown>).request;
    const scrubbed = request && typeof request === "object" ? ownerOnlyCardRequest(request as Record<string, unknown>) : null;
    if (scrubbed) return { ...record, description: LANE_SHARE_OWNER_ONLY_CARD_TEXT, detail: { request: scrubbed } } as T;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const next = laneShareScrubOwnerOnlyCards(entry, depth + 1);
    if (next !== entry) changed = true;
    out[key] = next;
  }
  return (changed ? out : value) as T;
}

/** The right that answers a pending card of `kind`. A kind not listed here is refused under any rights. */
export function laneShareInputKindRight(rights: LaneShareRights, kind: string | null | undefined): boolean {
  if (kind === "question" || kind === "structured_question") return rights.decide.questions;
  if (kind === "approval" || kind === "permissions" || kind === "plan_approval") return rights.decide.approvals;
  return false;
}

/**
 * Whether the child a guest names (`agentId`, and `taskId` when given) is a
 * subagent of the chat, by the host's own list of that chat's subagents. A
 * provider reads a child by the id it is given, so a guest must never pass
 * an id the host cannot show belongs to the granted chat.
 */
export function laneShareGuestSubagentBelongs(subagents: unknown, args: Record<string, unknown>): boolean {
  if (!Array.isArray(subagents)) return false;
  const agentId = typeof args.agentId === "string" ? args.agentId.trim() : "";
  const taskId = typeof args.taskId === "string" ? args.taskId.trim() : "";
  if (!agentId) return false;
  return subagents.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const record = entry as { agentId?: unknown; taskId?: unknown };
    const ids = [record.agentId, record.taskId].filter((id): id is string => typeof id === "string" && id.trim() !== "");
    return ids.includes(agentId) && (!taskId || ids.includes(taskId));
  });
}

function rowField(row: unknown, key: string): unknown {
  return row && typeof row === "object" ? (row as Record<string, unknown>)[key] : undefined;
}

/**
 * Keys whose string value names a model: `model`, `models`, `modelId`,
 * `modelIds`, and camel-case keys that end in `Model`, `ModelId` or
 * `ModelIds` (`toModelId`, `servedModel`, `availableModelIds`, ...).
 */
const MODEL_VALUE_KEY = /^(?:models?|modelIds?|modelProvider)$|[a-z](?:Model|ModelId|ModelIds)$/;
/** Keys whose whole value is about the host's models or presets: always null. */
const MODEL_DROP_KEYS = new Set(["modelHandoffHistory", "modelManifest", "modelConfigId", "presetId"]);
const MAX_SCRUB_DEPTH = 64;

function scrubModels(value: unknown, allowed: ReadonlySet<string>, modelKey: boolean, depth: number): unknown {
  if (typeof value === "string") return modelKey && !allowed.has(value) ? null : value;
  if (!value || typeof value !== "object") return value;
  // Deeper than any ADE payload: dropped, never sent unread.
  if (depth >= MAX_SCRUB_DEPTH) return null;
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    for (let index = 0; index < value.length; index += 1) {
      const next = scrubModels(value[index], allowed, modelKey, depth + 1);
      if (next !== value[index]) {
        copy ??= value.slice();
        copy[index] = next;
      }
    }
    return copy ?? value;
  }
  let copy: Record<string, unknown> | null = null;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const next = MODEL_DROP_KEYS.has(key)
      ? (entry == null ? entry : null)
      : scrubModels(entry, allowed, MODEL_VALUE_KEY.test(key), depth + 1);
    if (next !== entry) {
      copy ??= { ...(value as Record<string, unknown>) };
      copy[key] = next;
    }
  }
  return copy ?? value;
}

/**
 * With `privacy.hideModels` on, everything the host sends a guest goes
 * through this one function: a model name in a structured field is kept only
 * when it is one the guest may use (`run.models`); every other one becomes
 * null, and preset ids and model histories are null. Unchanged parts keep
 * their identity, so a payload with no model costs one walk and no copy.
 *
 * Free text is not changed: a model name inside an agent reply, a notice, an
 * error message, a tool's output or terminal output reaches the guest as is.
 */
export function laneShareHideModels<T>(value: T, rights: LaneShareRights): T {
  if (!rights.privacy.hideModels) return value;
  return scrubModels(value, new Set(rights.run.models), false, 0) as T;
}

/**
 * Keys whose value names or identifies a computer: device ids and names,
 * machine keys, names and platforms (also with a prefix, such as
 * `targetMachineName` or `hostDeviceId`), host names and site ids.
 */
const MACHINE_VALUE_KEY = /^(?:deviceId|deviceName|machineKey|machineName|machinePlatform|machineLabel|hostname|hostName|siteId)$|[a-z](?:DeviceId|DeviceName|MachineKey|MachineName|MachinePlatform|MachineLabel|HostName|Hostname|SiteId)$/;

function scrubMachines(value: unknown, depth: number): unknown {
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_SCRUB_DEPTH) return null;
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    for (let index = 0; index < value.length; index += 1) {
      const next = scrubMachines(value[index], depth + 1);
      if (next !== value[index]) {
        copy ??= value.slice();
        copy[index] = next;
      }
    }
    return copy ?? value;
  }
  let copy: Record<string, unknown> | null = null;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const next = MACHINE_VALUE_KEY.test(key) ? (entry == null ? entry : null) : scrubMachines(entry, depth + 1);
    if (next !== entry) {
      copy ??= { ...(value as Record<string, unknown>) };
      copy[key] = next;
    }
  }
  return copy ?? value;
}

/**
 * With `privacy.hideMachines` on, everything the host sends a guest (except
 * the hello reply, which the host builds with an id made for the share)
 * goes through this: every field that names or identifies a computer
 * (`MACHINE_VALUE_KEY`) becomes null. Unchanged parts keep their identity.
 * Free text (an agent reply, terminal output) is not changed.
 */
export function laneShareHideMachines<T>(value: T, rights: LaneShareRights): T {
  if (!rights.privacy.hideMachines) return value;
  return scrubMachines(value, 0) as T;
}

/**
 * List results keep only rows of the granted lane whose kind the rights see,
 * even though the gate already pinned `laneId`: a service that ignores the
 * filter must not leak. Model names are hidden later, on the way out
 * (`laneShareHideModels`).
 */
export function filterLaneShareGuestCommandResult(
  action: string,
  result: unknown,
  role: LaneShareGuestRole,
): unknown {
  const rule = LANE_SHARE_GUEST_COMMANDS[action];
  if (rule?.scope !== "lane" || !(action === "work.listSessions" || action === "chat.listSessions")) return result;
  const visible = (row: unknown) => {
    const laneId = rowField(row, "laneId");
    if (!laneShareGuestHasLane(role, typeof laneId === "string" ? laneId : null)) return false;
    const toolType = rowField(row, "toolType");
    // A chat list row has no tool type; it is a chat.
    const kind = action === "chat.listSessions" && toolType == null ? "chat" : laneShareSessionKind(typeof toolType === "string" ? toolType : null);
    return laneShareRightsSeeKind(role.rights, kind);
  };
  const keep = (rows: unknown[]) => rows.filter(visible);
  if (Array.isArray(result)) return keep(result);
  if (result && typeof result === "object" && Array.isArray((result as { sessions?: unknown }).sessions)) {
    const record = result as { sessions: unknown[] };
    return { ...record, sessions: keep(record.sessions) };
  }
  // A shape this filter does not know is not sent at all.
  return [];
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Keeps rows at or after the cutoff. A row with no time is dropped: default refuse. */
function keptIndexes(rows: unknown[], cutoffMs: number): number[] {
  const kept: number[] = [];
  rows.forEach((row, index) => {
    const at = timestampMs(rowField(row, "timestamp") ?? rowField(row, "createdAt") ?? rowField(row, "at"));
    if (at != null && at >= cutoffMs) kept.push(index);
  });
  return kept;
}

/** Arrays positionally aligned with `events` that must lose the same rows. */
const ALIGNED_WITH_EVENTS = ["envelopeStartOffsets"];

/**
 * History from before the share's start, removed (the "history before the
 * share" switch off). Works on the shapes that carry chat history: `events`
 * (event history snapshots and pages, chat subscribe and history replies),
 * `pinnedEvents`, `entries` (transcripts) and `messages` (subagent
 * transcripts). When a row was removed, the answer also says there is
 * nothing older, so a client stops paging back. Anything else passes as is.
 */
export function filterLaneShareHistory(value: unknown, cutoffMs: number | null): unknown {
  if (cutoffMs == null || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  let changed = false;
  let dropped = false;
  const out: Record<string, unknown> = { ...record };
  for (const key of ["events", "pinnedEvents", "entries", "messages"]) {
    const rows = record[key];
    if (!Array.isArray(rows)) continue;
    const kept = keptIndexes(rows, cutoffMs);
    if (kept.length === rows.length) continue;
    changed = true;
    dropped = true;
    out[key] = kept.map((index) => rows[index]);
    if (key === "events") {
      for (const aligned of ALIGNED_WITH_EVENTS) {
        const list = record[aligned];
        if (Array.isArray(list) && list.length === rows.length) out[aligned] = kept.map((index) => list[index]);
        else if (aligned in record) delete out[aligned];
      }
    }
  }
  if (!changed) return value;
  if (dropped) {
    if ("hasOlderHistory" in out) out.hasOlderHistory = false;
    if ("hasMore" in out) out.hasMore = false;
    if ("nextCursor" in out) out.nextCursor = null;
    if ("startOffset" in out) out.startOffset = 0;
  }
  return out;
}

/** Text fields of a session or chat row that repeat its history (previews, summaries, goals). */
const HISTORY_TEXT_KEYS = [
  "lastOutputPreview",
  "lastMessagePreview",
  "lastUserMessagePreview",
  "lastAssistantMessagePreview",
  "preview",
  "summary",
  "summaryText",
  "goal",
  "excerpt",
  "finalSummary",
  "statusNote",
  "attentionMessage",
  "codexGoal",
  "claudeGoal",
] as const;

function rowStartedMs(row: unknown): number | null {
  return timestampMs(rowField(row, "startedAt"))
    ?? timestampMs(rowField(row, "startTimestamp"))
    ?? timestampMs(rowField(row, "createdAt"));
}

/** A row that began before the cutoff (or has no time) loses its history text. */
function withoutHistoryText(row: unknown, cutoffMs: number): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const started = rowStartedMs(row);
  if (started != null && started >= cutoffMs) return row;
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  let changed = false;
  for (const key of HISTORY_TEXT_KEYS) {
    if (key in out) {
      delete out[key];
      changed = true;
    }
  }
  return changed ? out : row;
}

function mapRows(value: unknown, keys: readonly string[], map: (rows: unknown[]) => unknown[]): unknown {
  if (Array.isArray(value)) return map(value);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(record[key])) return { ...record, [key]: map(record[key] as unknown[]) };
  }
  return value;
}

/**
 * The history filter for answers that are not event lists: thread comments
 * written before the cutoff go (their excerpts quote the history);
 * subagents started before it go; session and chat rows that began before
 * it keep their ids and state but lose previews, summaries and goals.
 */
export function filterLaneShareActionHistory(action: string, value: unknown, cutoffMs: number | null): unknown {
  if (cutoffMs == null) return value;
  const after = (row: unknown) => {
    const at = rowStartedMs(row);
    return at != null && at >= cutoffMs;
  };
  switch (action) {
    case "chat.listThreadComments":
      return mapRows(value, ["comments", "items"], (rows) => rows.filter(after));
    case "chat.listSubagents":
      return mapRows(value, ["subagents", "items"], (rows) => rows.filter(after));
    case "work.listSessions":
    case "chat.listSessions":
      return mapRows(value, ["sessions", "items"], (rows) => rows.map((row) => withoutHistoryText(row, cutoffMs)));
    case "work.getSession":
    case "chat.getSummary":
      return withoutHistoryText(value, cutoffMs);
    default:
      return value;
  }
}

/** One line and its line end. No other control character: C0, DEL or C1 (escape sequences, Ctrl-C, Tab, Backspace). */
const LANE_SHARE_TYPED_LINE = /^([^\u0000-\u001f\u007f-\u009f]*)(?:\r\n|\r|\n)$/;

/**
 * The input a guest types into a CLI session, checked as text: exactly one
 * line that ends with a line end, no other control character, at most
 * `LANE_SHARE_GUEST_MAX_TYPED_LINE_CHARS`, and no leading character the CLI
 * reads as a command (`/`, `!`, and `#` for Claude's memory line), as for a
 * first line (`initialInput`). A whole line each time, so a guest cannot
 * build a command line from parts sent one by one.
 */
export function laneShareTypedLineRefusal(data: unknown): LaneShareGuestRefusal | null {
  const match = typeof data === "string" ? LANE_SHARE_TYPED_LINE.exec(data) : null;
  if (!match) {
    return { code: "lane_share_invalid_line", message: "Type one line of plain text, then Enter. Control keys are not available on a shared lane." };
  }
  const line = match[1]!;
  if (line.length > LANE_SHARE_GUEST_MAX_TYPED_LINE_CHARS) {
    return { code: "lane_share_invalid_line", message: `A line can have at most ${LANE_SHARE_GUEST_MAX_TYPED_LINE_CHARS} characters.` };
  }
  return leadingPromptCommandCharacter(line, ["#"])
    ? { code: LANE_SHARE_PLAIN_TEXT_ONLY, message: LANE_SHARE_PLAIN_TEXT_ONLY_MESSAGE }
    : null;
}

/**
 * Whether a guest may type into a session: the typing right, a CLI session it
 * can see in a granted lane. Never a shell, whatever the rights say.
 */
export function laneShareGuestMayTypeInto(
  role: LaneShareGuestRole,
  sessionId: unknown,
  resolveSession: LaneShareSessionResolver,
): boolean {
  if (!role.rights.run.typeInCliSessions) return false;
  const session = laneShareGuestVisibleSession(role, sessionId, resolveSession, ["cli"]);
  return session?.kind === "cli";
}

/** One chat event envelope from before the cutoff: never sent with the history switch off. */
export function laneShareEventBeforeCutoff(payload: unknown, cutoffMs: number | null): boolean {
  if (cutoffMs == null) return false;
  const at = timestampMs(rowField(payload, "timestamp"));
  return at == null || at < cutoffMs;
}

/**
 * The guest's history cutoff on the host clock, or null when it may read the
 * history. The share's start from the directory; without one, when this host
 * first stored the share; without that either, now.
 */
export function laneShareHistoryCutoff(
  rights: LaneShareRights,
  grant: LaneShareGuestGrant | undefined,
  fallbackMs: number,
): number | null {
  if (rights.see.historyBeforeShare) return null;
  return grant?.sharedAtMs ?? fallbackMs;
}

/**
 * Counts one envelope against the connection's rate window. False when the
 * guest is over the limit; the envelope is then dropped.
 */
export function laneShareGuestTakeRate(role: LaneShareGuestRole, nowMs = Date.now()): boolean {
  if (nowMs - role.rate.windowStartMs >= LANE_SHARE_GUEST_RATE_WINDOW_MS || nowMs < role.rate.windowStartMs) {
    role.rate.windowStartMs = nowMs;
    role.rate.count = 0;
  }
  if (role.rate.count >= LANE_SHARE_GUEST_RATE_LIMIT) return false;
  role.rate.count += 1;
  return true;
}

/**
 * The address in a guest's commit trailer: derived from the user id, never
 * the guest's real email.
 */
export function laneShareCoAuthorAddress(userId: string): string {
  const digest = createHash("sha256").update(`ade-lane-share:${userId}`, "utf8").digest("hex").slice(0, 16);
  return `guest-${digest}@users.noreply.ade-app.dev`;
}

/**
 * The note the host adds to the text a guest's message gives the agent (not
 * to the text the chat shows), asking for a `Co-authored-by` trailer on any
 * commit the turn makes. Null when the guest has no trusted name: no line
 * is better than a wrong one.
 */
export function laneShareCoAuthorNote(author: { userId: string; name: string | null }): string | null {
  const name = laneShareDisplayName(author.name);
  if (!name) return null;
  return [
    "",
    "",
    "<ade-lane-share>",
    `This message is from ${name}, a guest on this shared lane.`,
    "If you make a git commit for this request, end its message with this trailer line:",
    `Co-authored-by: ${name} <${laneShareCoAuthorAddress(author.userId)}>`,
    "</ade-lane-share>",
  ].join("\n");
}

/** File requests a guest may make with the file tools switch on: reads, ignored files hidden. */
const GUEST_FILE_ACTIONS = new Set(["listTree", "listTreeChildren", "readFile", "readFileRange", "quickOpen", "searchText"]);
const GUEST_FILE_ARGS: Record<string, readonly string[]> = {
  listTree: ["parentPath", "depth"],
  listTreeChildren: ["parentPath", "offset", "limit"],
  readFile: ["path"],
  readFileRange: ["path", "offset", "length"],
  quickOpen: ["query", "limit"],
  searchText: ["query", "limit"],
};

/**
 * A guest's file request, rebuilt from the listed arguments with the granted
 * lane as its workspace and ignored files hidden, or null to drop it.
 */
export function laneShareGuestFileRequest(
  role: LaneShareGuestRole,
  payload: unknown,
): { action: string; args: Record<string, unknown> } | null {
  if (!role.rights.tools.file) return null;
  const record = payload && typeof payload === "object" ? payload as { action?: unknown; args?: unknown } : null;
  const action = typeof record?.action === "string" ? record.action : "";
  if (!GUEST_FILE_ACTIONS.has(action)) return null;
  const input = record?.args && typeof record.args === "object" ? record.args as Record<string, unknown> : {};
  const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
  if (!laneShareGuestHasLane(role, workspaceId)) return null;
  const args: Record<string, unknown> = { workspaceId, includeIgnored: false };
  for (const key of GUEST_FILE_ARGS[action] ?? []) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    if (key === "path" || key === "parentPath") {
      const safe = laneShareSafeRelativePath(input[key], { allowEmpty: key === "parentPath" });
      if (safe == null || laneShareIsAdeStatePath(safe)) return null;
      args[key] = safe;
    } else {
      args[key] = input[key];
    }
  }
  if (action === "readFile" || action === "readFileRange") {
    if (typeof args.path !== "string") return null;
    // The file service asks git on this host and refuses ignored files (`.env`).
    args.refuseIgnored = true;
  }
  return { action, args };
}

/** A path inside `.ade/`: ADE's own state on this computer, never shared. */
export function laneShareIsAdeStatePath(relPath: string): boolean {
  return relPath.replace(/\\/g, "/").split("/").find((segment) => segment !== "" && segment !== ".")?.toLowerCase() === ".ade";
}

const FILE_ROW_PATH_KEYS = ["path", "relPath", "relativePath"] as const;

/**
 * A file reply for a guest without rows inside `.ade/` (tree nodes, quick
 * open items, search matches). The listing already hides what git ignores.
 */
export function laneShareScrubFileResponse<T>(value: T, depth = 0): T {
  if (depth > 12 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value
      .filter((row) => {
        if (!row || typeof row !== "object") return true;
        const record = row as Record<string, unknown>;
        return !FILE_ROW_PATH_KEYS.some((key) => typeof record[key] === "string" && laneShareIsAdeStatePath(record[key] as string));
      })
      .map((row) => laneShareScrubFileResponse(row, depth + 1)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = laneShareScrubFileResponse(entry, depth + 1);
  return out as T;
}
