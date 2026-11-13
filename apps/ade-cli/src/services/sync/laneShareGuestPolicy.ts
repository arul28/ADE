import { createHash } from "node:crypto";
import {
  LANE_SHARE_GUEST_MAX_TYPED_LINE_CHARS,
  laneShareDisplayName,
  laneShareRightsEnded,
  type LaneShareRights,
} from "../../../../desktop/src/shared/laneShareRights";
import {
  LANE_SHARE_PLAIN_TEXT_ONLY,
  LANE_SHARE_PLAIN_TEXT_ONLY_MESSAGE,
  leadingPromptCommandCharacter,
} from "../../../../desktop/src/shared/messageAuthor";
import { isChatToolType } from "../../../../desktop/src/shared/sessionSpawnNesting";
import { laneShareIsAdeStatePath, rowField } from "./laneShareGuestScrub";
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
type LaneShareSessionKind = "chat" | "cli" | "shell";

/** A session on this host, as the guest gates read it. */
export type LaneShareGuestSessionInfo = {
  laneId: string | null;
  kind: LaneShareSessionKind;
  /** When the session started (host clock). Null when unknown. */
  startedAtMs: number | null;
  /** Spawned by another chat (a subagent or a peer): it needs `see.subagentChats` too. */
  child?: boolean;
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

const SESSION_LANE_TTL_MS = 30_000;
/** A guest connection may send this many envelopes per `LANE_SHARE_GUEST_RATE_WINDOW_MS`. */
const LANE_SHARE_GUEST_RATE_LIMIT = 200;
const LANE_SHARE_GUEST_RATE_WINDOW_MS = 10_000;
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
function laneShareRightsSeeKind(rights: LaneShareRights, kind: LaneShareSessionKind): boolean {
  if (kind === "chat") return rights.see.chats;
  if (kind === "cli") return rights.see.cliSessions;
  return rights.see.shells;
}

type RightCheck = (rights: LaneShareRights) => boolean;

type LaneShareGuestCommandRule = {
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
  // here (`laneShareSafeRelativePath`, `COMMIT_SHA`), and a commit checked
  // against the lane's history by the git service (`onlyLaneHistory`). No
  // compare refs and no other lanes' scope.
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
const LANE_SHARE_GUEST_OUTBOUND: ReadonlyMap<string, "always" | "session"> = new Map([
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
function laneShareGuestHasLane(role: LaneShareGuestRole, laneId: string | null | undefined, nowMs = Date.now()): boolean {
  if (!laneId) return false;
  // The host's own end date (`rights.limits.endsAt`), not only the directory's.
  if (laneShareRightsEnded(role.rights, nowMs)) return false;
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
function laneShareGuestVisibleSession(
  role: LaneShareGuestRole,
  sessionId: unknown,
  resolveSession: LaneShareSessionResolver,
  kinds?: readonly LaneShareSessionKind[],
): LaneShareGuestSessionInfo | null {
  if (typeof sessionId !== "string" || !sessionId.trim()) return null;
  const info = laneShareGuestSessionInfo(role, sessionId.trim(), resolveSession);
  if (!info || !laneShareGuestHasLane(role, info.laneId)) return null;
  if (!laneShareRightsSeeKind(role.rights, info.kind)) return null;
  if (info.child && !role.rights.see.subagentChats) return null;
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
function laneShareSafeRelativePath(value: unknown, options: { allowEmpty?: boolean } = {}): string | null {
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
  if ("commitSha" in kept) {
    if (typeof kept.commitSha !== "string" || !COMMIT_SHA.test(kept.commitSha)) return "Name a commit by its hash.";
    // Lanes share one object store: the git service refuses a commit the
    // granted lane's HEAD does not reach.
    kept.onlyLaneHistory = true;
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

/**
 * Fields of a session row a guest may read. Everything else on the host's row
 * stays here: absolute paths on the owner's disk (`transcriptPath`), process
 * ids, provider resume ids, settle and cache internals.
 */
const GUEST_SESSION_ROW_FIELDS = [
  "id",
  "sessionId",
  "chatSessionId",
  "laneId",
  "laneName",
  "toolType",
  "title",
  "goal",
  "status",
  "runtimeState",
  "statusNote",
  "summary",
  "lastOutputPreview",
  "startedAt",
  "endedAt",
  "archivedAt",
  "lastActivityAt",
  "currentTurnStartedAt",
  "spawnKind",
  "orchestrationParentSessionId",
] as const;

/** Fields of a chat summary a guest may read: what the guest view shows, no provider or host internals. */
const GUEST_CHAT_SUMMARY_FIELDS = [
  "sessionId",
  "laneId",
  "provider",
  "model",
  "modelId",
  "title",
  "goal",
  "reasoningEffort",
  "permissionMode",
  "interactionMode",
  "status",
  "currentTurnStartedAt",
  "idleSinceAt",
  "startedAt",
  "endedAt",
  "archivedAt",
  "lastActivityAt",
  "lastOutputPreview",
  "summary",
  "spawnKind",
  "orchestrationParentSessionId",
] as const;

function pickFields(row: unknown, fields: readonly string[]): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const source = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of fields) if (key in source) out[key] = source[key];
  return out;
}

/**
 * A session row or chat summary as a guest gets it: only the listed fields;
 * a CLI session's launch model and mode (the guest's run locks read them);
 * and the parent chat's id only when the guest can see that chat, so the id
 * of a chat in another lane never leaves this host.
 */
function trimGuestSessionRecord(
  row: unknown,
  fields: readonly string[],
  role: LaneShareGuestRole,
  resolveSession: LaneShareSessionResolver,
): unknown {
  const picked = pickFields(row, fields);
  if (!picked || typeof picked !== "object" || Array.isArray(picked)) return picked;
  const out = picked as Record<string, unknown>;
  const parent = out.orchestrationParentSessionId;
  if (typeof parent === "string" && parent.trim()) {
    if (!laneShareGuestSessionInfo(role, parent, resolveSession)) {
      out.orchestrationParentSessionId = null;
      // The row stays a child for the guest's kind and rights checks.
      if (out.spawnKind == null) out.spawnKind = "subagent";
    }
  }
  const launch = (row as { resumeMetadata?: { launch?: unknown } | null }).resumeMetadata?.launch;
  if (launch && typeof launch === "object" && !Array.isArray(launch)) {
    const source = launch as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    if (typeof source.model === "string") kept.model = source.model;
    if (typeof source.permissionMode === "string") kept.permissionMode = source.permissionMode;
    out.resumeMetadata = { launch: kept };
  }
  return out;
}

/** One session record a guest's command returns, trimmed (`trimGuestSessionRecord`). Lists are trimmed per row by the filter. */
function trimLaneShareGuestResult(
  action: string,
  result: unknown,
  role: LaneShareGuestRole,
  resolveSession: LaneShareSessionResolver,
): unknown {
  switch (action) {
    case "work.getSession":
    case "work.startCliSession":
      return trimGuestSessionRecord(result, GUEST_SESSION_ROW_FIELDS, role, resolveSession);
    case "chat.getSummary":
    case "chat.create":
    case "chat.updateSession":
      return trimGuestSessionRecord(result, GUEST_CHAT_SUMMARY_FIELDS, role, resolveSession);
    default:
      return result;
  }
}

/**
 * Session lists keep only rows of the granted lane whose kind the rights see,
 * even though the gate already pinned `laneId`: a service that ignores the
 * filter must not leak. Session rows and chat summaries keep only the fields
 * a guest may read (`trimLaneShareGuestResult`). Model names are hidden later,
 * on the way out (`laneShareHideModels`).
 */
export function filterLaneShareGuestCommandResult(
  action: string,
  result: unknown,
  role: LaneShareGuestRole,
  resolveSession: LaneShareSessionResolver,
): unknown {
  if (action !== "work.listSessions" && action !== "chat.listSessions") {
    return trimLaneShareGuestResult(action, result, role, resolveSession);
  }
  const visible = (row: unknown) => {
    const laneId = rowField(row, "laneId");
    if (!laneShareGuestHasLane(role, typeof laneId === "string" ? laneId : null)) return false;
    const toolType = rowField(row, "toolType");
    // A chat list row has no tool type; it is a chat.
    const kind = action === "chat.listSessions" && toolType == null ? "chat" : laneShareSessionKind(typeof toolType === "string" ? toolType : null);
    if (!laneShareRightsSeeKind(role.rights, kind)) return false;
    if (role.rights.see.subagentChats) return true;
    // A child of another chat: by the row's own lineage, else by this host's records.
    const parent = rowField(row, "orchestrationParentSessionId");
    if (typeof parent === "string" && parent.trim()) return false;
    const id = rowField(row, "sessionId") ?? rowField(row, "id");
    return typeof id !== "string" || laneShareGuestSessionInfo(role, id, resolveSession)?.child !== true;
  };
  const keep = (rows: unknown[]) => rows.filter(visible).map((row) => trimGuestSessionRecord(row, GUEST_SESSION_ROW_FIELDS, role, resolveSession));
  if (Array.isArray(result)) return keep(result);
  if (result && typeof result === "object" && Array.isArray((result as { sessions?: unknown }).sessions)) {
    const record = result as { sessions: unknown[] };
    return { ...record, sessions: keep(record.sessions) };
  }
  // A shape this filter does not know is not sent at all.
  return [];
}

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
function laneShareCoAuthorAddress(userId: string): string {
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
