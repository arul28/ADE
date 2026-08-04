// Suggestion + expansion backend for composer @-mentions of chats, lanes, and
// terminals.
//
// Two responsibilities, deliberately split by cost:
//   1. `listChatMentionSuggestions` — menu-time. Roster reads only (session
//      list, lane list, terminal list). No transcript or PTY reads happen here,
//      so keystroke-rate calls stay cheap.
//   2. `resolveChatMentionDetails` — send-time, once per message. Adds the
//      bounded preview (last exchange / lane branch+PR / PTY tail).
//
// Everything is injected so the module is testable without Electron, and so the
// desktop main process and the `ade` runtime share one implementation.

import {
  CHAT_MENTION_KINDS,
  CHAT_MENTION_MAX_PER_KIND,
  appendChatMentionBlocks,
  collectChatMentionTargets,
  rankChatMentionSuggestions,
  renderChatMentionBlock,
  renderUnresolvedChatMentionBlock,
} from "../../../shared/chatMentions";
import type {
  ChatMentionDetail,
  ChatMentionKind,
  ChatMentionSuggestArgs,
  ChatMentionSuggestResult,
  ChatMentionSuggestion,
} from "../../../shared/types/chatMentions";
import type { AgentChatSessionSummary, AgentChatTranscriptEntry } from "../../../shared/types/chat";
import type { LaneSummary } from "../../../shared/types/lanes";
import type { PrSummary } from "../../../shared/types/prs";
import type { ChatTerminalPreviewResult, ChatTerminalSession } from "../../../shared/types/sessions";

/** Transcript entries pulled for one chat preview. Kept tiny on purpose. */
const CHAT_PREVIEW_ENTRY_LIMIT = 6;
const CHAT_PREVIEW_MAX_CHARS = 1200;
/** PTY tail: last N lines, per the locked design. */
const TERMINAL_PREVIEW_LINES = 15;
const TERMINAL_PREVIEW_MAX_BYTES = 4096;
/**
 * How long one roster read is reused across calls.
 *
 * The @-menu fires per keystroke and the chat roster is a synchronous
 * per-session JSON read on the main process, so an uncached menu could cost
 * hundreds of file reads per query. 1.5s is long enough to cover a burst of
 * typing and short enough that a lane or terminal created in another window
 * shows up on the user's next pause.
 */
const ROSTER_CACHE_TTL_MS = 1500;

export type ChatMentionServiceDeps = {
  /** Project-scoped chat roster. Archived/personal rows are filtered here. */
  listChatSessions: () => Promise<AgentChatSessionSummary[]>;
  /** Bounded tail read of one chat transcript. */
  readChatTranscript: (args: {
    sessionId: string;
    limit: number;
    maxChars: number;
  }) => Promise<{ entries: AgentChatTranscriptEntry[] }>;
  listLanes: () => Promise<LaneSummary[]>;
  /** Optional: PR number/state per lane. Absent in runtimes without prService. */
  listPrs?: (() => PrSummary[]) | null;
  /** Optional: terminal roster. Absent when the runtime has no ptyService. */
  listTerminals?: (() => ChatTerminalSession[]) | null;
  /** Optional: bounded PTY snapshot/transcript tail. */
  previewTerminal?:
    | ((args: { terminalId: string; maxBytes: number }) => Promise<ChatTerminalPreviewResult | null>)
    | null;
  logger?: { warn?: (message: string, meta?: Record<string, unknown>) => void } | null;
  /**
   * Optional: coarse product-analytics hook, invoked once per send whose text
   * actually gained expansion blocks. Carries identity only — never text.
   */
  onMentionsExpanded?: ((event: { sessionId: string | null }) => void) | null;
};

function toEpoch(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstLine(value: string | null | undefined, max = 120): string | null {
  if (!value) return null;
  const line = value.replace(/\s+/g, " ").trim();
  if (!line.length) return null;
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** A chat is mentionable when it belongs to this project and is not archived. */
function isMentionableSession(session: AgentChatSessionSummary): boolean {
  if (session.archivedAt) return false;
  // Personal chats are machine-owned, outside the project registry.
  if (session.surface === "personal") return false;
  return true;
}

function sessionTitle(session: AgentChatSessionSummary): string {
  return (
    firstLine(session.title)
    ?? firstLine(session.goal)
    ?? firstLine(session.lastOutputPreview, 60)
    ?? `Chat ${session.sessionId.slice(0, 8)}`
  );
}

function terminalTitle(terminal: ChatTerminalSession): string {
  return firstLine(terminal.title) ?? firstLine(terminal.goal) ?? `Terminal ${terminal.terminalId.slice(0, 8)}`;
}

/**
 * Private marker stamped on args whose text already carries expansion blocks.
 *
 * A symbol, not a field: symbols do not survive structured clone, so nothing
 * arriving over IPC or the sync wire can set it, and it adds nothing to the
 * chat wire contract the TUI and iOS marshal. Sniffing the block header
 * instead would let a user who merely pastes that sentence silently lose their
 * own mention expansion.
 */
const CHAT_MENTIONS_EXPANDED = Symbol("ade.chatMentionsExpanded");

/** Stamp the marker on a copy of `args` (spreads carry it; literals do not). */
export function markChatMentionsExpanded<T extends object>(args: T): T {
  return Object.assign({}, args, { [CHAT_MENTIONS_EXPANDED]: true }) as T;
}

function hasChatMentionsExpandedMark(args: object): boolean {
  return (args as { [CHAT_MENTIONS_EXPANDED]?: boolean })[CHAT_MENTIONS_EXPANDED] === true;
}

/** One shared roster read. Per-source failures are captured, not thrown, so a
 * dead PTY surface cannot blank the chat and lane sections of the menu. */
type MentionRoster = {
  sessions: AgentChatSessionSummary[];
  sessionsError: unknown;
  lanes: LaneSummary[];
  lanesById: Map<string, LaneSummary>;
  lanesError: unknown;
  terminals: ChatTerminalSession[];
  terminalsError: unknown;
};

export function createChatMentionService(deps: ChatMentionServiceDeps) {
  // Single in-flight roster read shared by every caller inside the TTL: a burst
  // of keystrokes collapses to one session/lane/terminal read, and send-time
  // resolution reuses whatever the menu just loaded.
  let rosterCache: { at: number; promise: Promise<MentionRoster> } | null = null;

  // Settle one roster source: capture the failure (sync throw included), never
  // reject, so a dead source degrades its own section only.
  const settle = async <T,>(read: () => T | Promise<T>, fallback: T): Promise<{ value: T; error: unknown }> => {
    try {
      return { value: await read(), error: null };
    } catch (error: unknown) {
      return { value: fallback, error: error ?? new Error("unknown") };
    }
  };

  const readRoster = async (): Promise<MentionRoster> => {
    const [sessions, lanes, terminals] = await Promise.all([
      settle(() => deps.listChatSessions(), [] as AgentChatSessionSummary[]),
      settle(() => deps.listLanes(), [] as LaneSummary[]),
      settle(() => deps.listTerminals?.() ?? [], [] as ChatTerminalSession[]),
    ]);
    return {
      sessions: sessions.value,
      sessionsError: sessions.error,
      lanes: lanes.value,
      lanesById: new Map(lanes.value.map((lane) => [lane.id, lane])),
      lanesError: lanes.error,
      terminals: terminals.value,
      terminalsError: terminals.error,
    };
  };

  const loadRoster = (): Promise<MentionRoster> => {
    const now = Date.now();
    if (rosterCache && now - rosterCache.at < ROSTER_CACHE_TTL_MS) return rosterCache.promise;
    const promise = readRoster();
    rosterCache = { at: now, promise };
    // A rejected read must not be cached, or one transient failure blanks the
    // menu for a whole TTL.
    promise.catch(() => {
      if (rosterCache?.promise === promise) rosterCache = null;
    });
    return promise;
  };

  const buildChatCandidates = async (
    excludeSessionId?: string,
  ): Promise<ChatMentionSuggestion[]> => {
    const roster = await loadRoster();
    if (roster.sessionsError) throw roster.sessionsError;
    return roster.sessions
      .filter(isMentionableSession)
      .filter((session) => session.sessionId !== excludeSessionId)
      .map((session) => {
        const lane = roster.lanesById.get(session.laneId);
        const parts = [lane?.name, session.provider, session.status].filter(Boolean);
        return {
          kind: "chat" as const,
          id: session.sessionId,
          title: sessionTitle(session),
          subtitle: parts.join(" · "),
          lastActivityAt: toEpoch(session.lastActivityAt) ?? toEpoch(session.startedAt),
        };
      });
  };

  const buildLaneCandidates = async (): Promise<ChatMentionSuggestion[]> => {
    const roster = await loadRoster();
    if (roster.lanesError) throw roster.lanesError;
    return roster.lanes
      .filter((lane) => !lane.archivedAt)
      .map((lane) => ({
        kind: "lane" as const,
        id: lane.id,
        title: lane.name,
        subtitle: lane.branchRef,
        // Lanes have no lastActivityAt; createdAt is the only monotonic field
        // on the cheap list shape, and recency of creation is a fine proxy.
        lastActivityAt: toEpoch(lane.createdAt),
      }));
  };

  const buildTerminalCandidates = async (): Promise<ChatMentionSuggestion[]> => {
    const roster = await loadRoster();
    if (roster.terminalsError) throw roster.terminalsError;
    return roster.terminals.map((terminal) => ({
      kind: "terminal" as const,
      id: terminal.terminalId,
      title: terminalTitle(terminal),
      subtitle: [terminal.laneName, terminal.active ? "running" : terminal.status]
        .filter(Boolean)
        .join(" · "),
      // Running terminals sort above ended ones of the same age.
      lastActivityAt:
        (toEpoch(terminal.endedAt) ?? toEpoch(terminal.startedAt) ?? 0)
        + (terminal.active ? 1 : 0),
    }));
  };

  const candidateBuildersByKind: Record<
    ChatMentionKind,
    (args: ChatMentionSuggestArgs) => Promise<ChatMentionSuggestion[]>
  > = {
    chat: (args) => buildChatCandidates(args.excludeSessionId),
    lane: () => buildLaneCandidates(),
    terminal: () => buildTerminalCandidates(),
  };

  /**
   * Menu-time suggestions. Always all three kinds, ranked per kind and capped
   * per kind so one noisy kind can never crowd the others out of the sectioned
   * menu. The renderer decides which sections to show.
   */
  const listChatMentionSuggestions = async (
    args: ChatMentionSuggestArgs = {},
  ): Promise<ChatMentionSuggestResult> => {
    const query = typeof args.query === "string" ? args.query : "";
    const suggestions: ChatMentionSuggestion[] = [];
    for (const kind of CHAT_MENTION_KINDS) {
      let candidates: ChatMentionSuggestion[] = [];
      try {
        candidates = await candidateBuildersByKind[kind](args);
      } catch (error) {
        // One failing roster must not blank the whole menu.
        deps.logger?.warn?.("chat mention suggestions failed for kind", { kind, error });
        continue;
      }
      suggestions.push(
        ...rankChatMentionSuggestions(candidates, query, CHAT_MENTION_MAX_PER_KIND),
      );
    }
    return { suggestions };
  };

  // -------------------------------------------------------------------------
  // Send-time detail resolution
  // -------------------------------------------------------------------------

  const chatPreview = async (sessionId: string): Promise<string | null> => {
    try {
      const transcript = await deps.readChatTranscript({
        sessionId,
        limit: CHAT_PREVIEW_ENTRY_LIMIT,
        maxChars: CHAT_PREVIEW_MAX_CHARS,
      });
      const entries = transcript.entries ?? [];
      const lastUser = [...entries].reverse().find((entry) => entry.role === "user");
      const lastAssistant = [...entries].reverse().find((entry) => entry.role === "assistant");
      const lines: string[] = [];
      if (lastUser) lines.push(`user: ${(lastUser.displayText || lastUser.text || "").trim()}`);
      if (lastAssistant) {
        lines.push(`assistant: ${(lastAssistant.displayText || lastAssistant.text || "").trim()}`);
      }
      // Truncation is renderChatMentionBlock's job (it is the single owner of
      // the cap and of CRLF normalization); this path only bounds the read.
      const joined = lines.join("\n").trim();
      return joined.length ? joined : null;
    } catch (error) {
      deps.logger?.warn?.("chat mention preview failed", { sessionId, error });
      return null;
    }
  };

  const terminalPreview = async (terminalId: string): Promise<string | null> => {
    const preview = deps.previewTerminal;
    if (!preview) return null;
    try {
      const result = await preview({ terminalId, maxBytes: TERMINAL_PREVIEW_MAX_BYTES });
      if (!result) return null;
      const rows = result.snapshot?.visibleRows
        ?.map((row) => (typeof row?.text === "string" ? row.text : ""))
        ?.filter((text) => text.trim().length > 0);
      const body = rows?.length
        ? rows.slice(-TERMINAL_PREVIEW_LINES).join("\n")
        : (result.transcript ?? "")
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .slice(-TERMINAL_PREVIEW_LINES)
            .join("\n");
      const trimmed = body.trim();
      return trimmed.length ? trimmed : null;
    } catch (error) {
      deps.logger?.warn?.("terminal mention preview failed", { terminalId, error });
      return null;
    }
  };

  const resolveChatDetail = async (
    sessionId: string,
    roster: MentionRoster,
  ): Promise<ChatMentionDetail | null> => {
    const session = roster.sessions.find((entry) => entry.sessionId === sessionId);
    if (!session || !isMentionableSession(session)) return null;
    const lane = roster.lanesById.get(session.laneId);
    return {
      kind: "chat",
      id: session.sessionId,
      title: sessionTitle(session),
      attributes: [
        ["lane", lane?.name ?? session.laneId],
        ["provider", session.provider],
        ["model", session.model],
        ["state", session.status],
        ["lastActivity", session.lastActivityAt],
      ].filter((pair): pair is [string, string] => typeof pair[1] === "string"),
      hint:
        "Pointer to another ADE chat on this machine. Read its transcript with the ade CLI "
        + "(silent and bounded): "
        + `\`ade chat read ${session.sessionId} --limit 20 --max-chars 8000 --text\`. `
        + `Page older content with \`ade chat read ${session.sessionId} --page --cursor <n>\`. `
        + `Search inside it with \`ade search "session:${session.sessionId} <terms>" --text\`. `
        + "Do not assume anything beyond the preview below.",
      previewLabel: "Preview (most recent exchange, truncated):",
      preview: await chatPreview(session.sessionId),
    };
  };

  const resolveLaneDetail = async (
    laneId: string,
    roster: MentionRoster,
  ): Promise<ChatMentionDetail | null> => {
    const lane = roster.lanesById.get(laneId);
    if (!lane) return null;
    const prs = deps.listPrs?.() ?? [];
    const pr = prs.find((entry) => entry.laneId === lane.id);
    return {
      kind: "lane",
      id: lane.id,
      title: lane.name,
      attributes: [
        ["branch", lane.branchRef],
        ["base", lane.baseRef],
        // No `state` attribute: lanes are listed without a status probe here,
        // and laneService fills an indistinguishable default when unprobed —
        // emitting "clean" would assert something never measured.
        // Raw path on purpose: it must stay copy-pasteable on Windows and
        // macOS alike. Display shortening happens in the renderer, not here.
        ["worktree", lane.worktreePath],
        // Omitted rather than asserted when the roster was listed without
        // status: "true" would be a claim we never checked.
        ...(typeof lane.worktreeAvailable === "boolean"
          ? ([["worktreeAvailable", lane.worktreeAvailable ? "true" : "false"]] as Array<[string, string]>)
          : []),
        ...(pr?.githubPrNumber != null
          ? ([
              ["pr", `#${pr.githubPrNumber}`],
              ["prState", pr.state ?? ""],
              ["prChecks", pr.checksStatus ?? ""],
            ] as Array<[string, string]>)
          : []),
        ...(lane.linearIssue?.identifier
          ? ([["linearIssue", lane.linearIssue.identifier]] as Array<[string, string]>)
          : []),
      ].filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].length > 0),
      hint:
        "Pointer to an ADE lane (git worktree + branch) in this project. Inspect it with "
        + `\`ade lanes show ${lane.id} --text\`, list its chats with `
        + `\`ade chat list --lane ${lane.id} --text\`, and search its history with `
        // Id + `--lane` flag rather than the in-query `lane:<name>` filter: lane
        // names may contain spaces or quotes, and the flag form stays
        // copy-pasteable in sh, PowerShell, and cmd without any escaping.
        + `\`ade search "<terms>" --lane ${lane.id} --text\`. `
        + "Read files under the worktree path above rather than guessing.",
      preview: pr?.title ? `PR: ${pr.title}` : null,
      previewLabel: pr?.title ? "Linked pull request:" : null,
    };
  };

  const resolveTerminalDetail = async (
    terminalId: string,
    roster: MentionRoster,
  ): Promise<ChatMentionDetail | null> => {
    const terminal = roster.terminals.find((entry) => entry.terminalId === terminalId);
    if (!terminal) return null;
    return {
      kind: "terminal",
      id: terminal.terminalId,
      title: terminalTitle(terminal),
      attributes: [
        ["lane", terminal.laneName],
        ["tool", terminal.toolType ?? ""],
        ["state", terminal.active ? "running" : terminal.status],
        ["startedAt", terminal.startedAt],
      ].filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].length > 0),
      hint:
        "Pointer to a terminal session in this project. Read its scrollback with "
        + `\`ade terminal read --terminal ${terminal.terminalId} --text\`. `
        + `Search it with \`ade search "kind:terminal <terms>" --text\`.`,
      previewLabel: `Preview (last ${TERMINAL_PREVIEW_LINES} lines of scrollback, truncated):`,
      preview: await terminalPreview(terminal.terminalId),
    };
  };

  const detailResolversByKind: Record<
    ChatMentionKind,
    (id: string, roster: MentionRoster) => Promise<ChatMentionDetail | null>
  > = {
    chat: resolveChatDetail,
    lane: resolveLaneDetail,
    terminal: resolveTerminalDetail,
  };

  /**
   * Resolve every mention target for one outgoing message. Roster reads are
   * shared across all targets; only previews are per-target.
   */
  const resolveChatMentionDetails = async (
    targets: Array<{ kind: ChatMentionKind; id: string }>,
  ): Promise<Map<string, ChatMentionDetail | null>> => {
    const out = new Map<string, ChatMentionDetail | null>();
    if (!targets.length) return out;
    const roster = await loadRoster().catch((): MentionRoster => ({
      sessions: [],
      sessionsError: null,
      lanes: [],
      lanesById: new Map(),
      lanesError: null,
      terminals: [],
      terminalsError: null,
    }));
    for (const target of targets) {
      const key = `${target.kind}:${target.id}`;
      try {
        out.set(key, await detailResolversByKind[target.kind](target.id, roster));
      } catch (error) {
        deps.logger?.warn?.("chat mention resolution failed", { target, error });
        out.set(key, null);
      }
    }
    return out;
  };

  /**
   * Expand `@chat:` / `@lane:` / `@term:` chips into `<ade-mention>` pointer
   * blocks. Only ever touches the prompt text — the transcript keeps the raw
   * chips the user typed.
   */
  const expandChatMentionsForSend = async (text: string): Promise<string> => {
    const targets = collectChatMentionTargets(text);
    if (!targets.length) return text;
    const details = await resolveChatMentionDetails(targets);
    const blocks = targets.map((target) => {
      const detail = details.get(`${target.kind}:${target.id}`);
      return detail
        ? renderChatMentionBlock(detail)
        : renderUnresolvedChatMentionBlock(target.kind, target.id);
    });
    return appendChatMentionBlocks(text, blocks);
  };

  /**
   * Rewrite send/steer args so the provider receives the expanded prompt while
   * the transcript keeps the user's literal chips. `displayText` is pinned to
   * the original text when the caller did not supply one of its own.
   *
   * Idempotent: the send path can reroute into the steer path, and both expand,
   * so the result carries a private marker (see `markChatMentionsExpanded`).
   */
  const applyChatMentionExpansion = async <
    T extends { text: string; displayText?: string },
  >(args: T): Promise<T> => {
    const original = args.text;
    if (typeof original !== "string" || !original.length) return args;
    if (hasChatMentionsExpandedMark(args)) return args;
    let expanded: string;
    try {
      expanded = await expandChatMentionsForSend(original);
    } catch (error) {
      // A failed expansion must never block the send; the raw chip text still
      // names the entity and the agent can look it up itself.
      deps.logger?.warn?.("chat mention expansion failed", { error });
      return args;
    }
    if (expanded === original) return args;
    // Coarse adoption fact, fired only when blocks were actually appended (not
    // on no-mention sends or the idempotent second pass). Failures never block
    // the send.
    try {
      deps.onMentionsExpanded?.({
        sessionId: (args as { sessionId?: string }).sessionId ?? null,
      });
    } catch {
      // Analytics is best-effort by contract.
    }
    return markChatMentionsExpanded({
      ...args,
      text: expanded,
      displayText: args.displayText ?? original,
    });
  };

  return {
    listChatMentionSuggestions,
    resolveChatMentionDetails,
    expandChatMentionsForSend,
    applyChatMentionExpansion,
  };
}

export type ChatMentionService = ReturnType<typeof createChatMentionService>;
