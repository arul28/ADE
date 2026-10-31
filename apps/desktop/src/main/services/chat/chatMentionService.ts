// Suggestion + expansion backend for composer @-mentions of chats, lanes,
// terminals, pull requests, and account machines.
//
// Two responsibilities, deliberately split by cost:
//   1. `listChatMentionSuggestions` — menu-time. Roster reads only (session
//      list, lane list, terminal list, local PR rows, a cached machine
//      directory read). No transcript or PTY reads happen here, so
//      keystroke-rate calls stay cheap.
//   2. `resolveChatMentionDetails` — send-time, once per message. Adds the
//      bounded preview (last exchange / lane branch+PR / PTY tail / machine
//      snapshot).
//
// Everything is injected so the module is testable without Electron, and so the
// desktop main process and the `ade` runtime share one implementation.

import { maskBrowserTabMentions } from "../../../shared/browserTabMention";
import {
  CHAT_MENTION_KINDS,
  CHAT_MENTION_MAX_PER_KIND,
  CHAT_MENTION_MAX_RESULTS,
  appendChatMentionBlocks,
  collectChatMentionTargets,
  isChatMentionId,
  parseChatMentionKindFilter,
  rankChatMentionSuggestions,
  renderChatMentionBlock,
  renderUnresolvedChatMentionBlock,
} from "../../../shared/chatMentions";
import {
  buildAccountMachineSnapshot,
  describeAccountMachinePresence,
  findMachineByMentionId,
  formatAccountMachineSnapshotText,
  machineMentionId,
} from "../../../shared/accountMachineSnapshot";
import type { AdeAccountMachine, AdeAccountMachinesResult } from "../../../shared/types/account";
import type { AttentionSnapshot } from "../../../shared/types/attention";
import {
  buildModelMentionDetail,
  parseModelMentions,
  type ModelMentionModelInfo,
} from "../../../shared/modelMentions";
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
import type { McpRegistryServer, McpRegistryState } from "../../../shared/mcpRegistry";

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
/**
 * The machine directory and Activity feed are network reads (account Worker,
 * push relay), so the menu reuses one read for longer than the local roster.
 * Send time always reads fresh: an expansion is a snapshot of "now".
 */
const MACHINE_CACHE_TTL_MS = 30_000;
/** Upper bound on one directory/Activity read, so a hung relay never blocks the menu or a send. */
const MACHINE_READ_TIMEOUT_MS = 4_000;
/** How long one menu query waits for a cold machine read before answering without it. */
const MACHINE_MENU_WAIT_MS = 800;

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
  /**
   * Optional: the ADE account machine directory, read inside the brain. This
   * is deliberately NOT the CTO-only `account.listMachines` action: the
   * mention service only ever reads presence through it, so a chat-role
   * caller can mention a machine without being granted that action.
   */
  listAccountMachines?: (() => Promise<AdeAccountMachinesResult>) | null;
  /** Optional: account-wide Activity, the only cross-machine source of projects, lanes and chats. */
  getAccountActivity?: (() => Promise<AttentionSnapshot | null>) | null;
  /** Optional: this machine's directory key, so its row reads "this machine". */
  getLocalMachineKey?: (() => string | null) | null;
  logger?: { warn?: (message: string, meta?: Record<string, unknown>) => void } | null;
  /**
   * Optional: coarse product-analytics hook, invoked once per send whose text
   * actually gained expansion blocks. Carries identity only — never text.
   */
  onMentionsExpanded?: ((event: { sessionId: string | null }) => void) | null;
  /**
   * Optional: look up a model for an `@model:` chip. Absent means model chips
   * expand as unavailable, which tells the agent to ask instead of guess.
   */
  describeModel?: ((modelId: string) => ModelMentionModelInfo | null) | null;
  /** MCP servers as configured on this brain. Never returns secret values. */
  listMcpServers?: (() => Array<{
    server: McpRegistryServer;
    state: McpRegistryState;
    needsSignIn?: boolean;
    toolNames?: string[];
    toolCount?: number | null;
    lastError?: string | null;
    lastErrorAt?: number | null;
  }>) | null;
};

/** Cap on model blocks per message, like `CHAT_MENTION_MAX_PER_MESSAGE`. */
const MODEL_MENTION_MAX_PER_MESSAGE = 6;

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
 * chat wire contract iOS marshals. Sniffing the block header
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

/** One directory read plus the Activity items that describe each machine's work. */
type MachineRoster = {
  state: AdeAccountMachinesResult["state"] | "unsupported";
  machines: AdeAccountMachine[];
  message: string | null;
  /** Null when Activity could not be read (unknown, not empty). */
  activity: AttentionSnapshot["items"] | null;
};

/** Open and draft PRs are the ones worth pointing an agent at. */
function isMentionablePr(pr: PrSummary): boolean {
  return (pr.state === "open" || pr.state === "draft") && isChatMentionId(pr.id);
}

function prMentionTitle(pr: PrSummary): string {
  return `#${pr.githubPrNumber} ${firstLine(pr.title) ?? "Untitled pull request"}`;
}

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

  // ---- Account machines (network; separate cache so they never slow chats) ----

  let machineCache: { at: number; promise: Promise<MachineRoster> } | null = null;

  const withTimeout = <T,>(promise: Promise<T>, label: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${MACHINE_READ_TIMEOUT_MS}ms`)),
        MACHINE_READ_TIMEOUT_MS,
      );
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error: unknown) => { clearTimeout(timer); reject(error); },
      );
    });

  const readMachineRoster = async (): Promise<MachineRoster> => {
    const list = deps.listAccountMachines;
    if (!list) return { state: "unsupported", machines: [], message: null, activity: null };
    const activityRead = deps.getAccountActivity
      ? withTimeout(deps.getAccountActivity(), "account activity read")
        .then((snapshot) => snapshot?.items ?? null)
        .catch((error: unknown) => {
          deps.logger?.warn?.("chat mention activity read failed", { error });
          return null;
        })
      : Promise.resolve(null);
    const [listed, activity] = await Promise.all([
      withTimeout(list(), "machine directory read").catch((error: unknown): AdeAccountMachinesResult => ({
        state: "unavailable",
        machines: [],
        message: error instanceof Error ? error.message : String(error),
      })),
      activityRead,
    ]);
    return { state: listed.state, machines: listed.machines ?? [], message: listed.message, activity };
  };

  /** `fresh` bypasses the menu cache (send time) and refreshes it for the menu. */
  const loadMachineRoster = (fresh = false): Promise<MachineRoster> => {
    const now = Date.now();
    if (!fresh && machineCache && now - machineCache.at < MACHINE_CACHE_TTL_MS) return machineCache.promise;
    const promise = readMachineRoster();
    machineCache = { at: now, promise };
    promise.then((roster) => {
      // Only a good read is worth reusing; a failure retries on the next keystroke burst.
      if (roster.state !== "ok" && machineCache?.promise === promise) machineCache = null;
    }, () => {
      if (machineCache?.promise === promise) machineCache = null;
    });
    return promise;
  };

  const localMachineKey = (): string | null => {
    try {
      return deps.getLocalMachineKey?.()?.trim() || null;
    } catch {
      return null;
    }
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

  const buildPrCandidates = async (): Promise<ChatMentionSuggestion[]> => {
    const listPrs = deps.listPrs;
    if (!listPrs) return [];
    // Local DB rows only: the menu never waits on GitHub.
    const prs = listPrs().filter(isMentionablePr);
    const roster = prs.length ? await loadRoster() : null;
    return prs.map((pr) => {
      const lane = roster?.lanesById.get(pr.laneId);
      const repo = pr.repoOwner && pr.repoName ? `${pr.repoOwner}/${pr.repoName}` : null;
      return {
        kind: "pr" as const,
        id: pr.id,
        title: prMentionTitle(pr),
        subtitle: [repo, lane?.name, pr.state === "draft" ? "draft" : null].filter(Boolean).join(" · "),
        lastActivityAt: toEpoch(pr.updatedAt) ?? toEpoch(pr.createdAt),
        pr: { number: pr.githubPrNumber, state: pr.state, checks: pr.checksStatus },
      };
    });
  };

  const buildMachineCandidates = async (): Promise<ChatMentionSuggestion[]> => {
    if (!deps.listAccountMachines) return [];
    // The menu waits only briefly for a cold network read: the read keeps
    // going and fills the cache, so the machine rows join on the next
    // keystroke instead of holding the chat and lane rows back.
    let budgetTimer: ReturnType<typeof setTimeout> | null = null;
    const roster = await Promise.race([
      loadMachineRoster(),
      new Promise<null>((resolve) => {
        budgetTimer = setTimeout(() => resolve(null), MACHINE_MENU_WAIT_MS);
      }),
    ]).finally(() => {
      if (budgetTimer) clearTimeout(budgetTimer);
    });
    if (!roster || roster.state !== "ok") return [];
    const localKey = localMachineKey();
    const now = Date.now();
    return roster.machines.map((machine) => {
      const snapshot = buildAccountMachineSnapshot({
        machine,
        activityItems: roster.activity,
        localMachineKey: localKey,
      });
      const projects = snapshot.activityAvailable && snapshot.projects.length
        ? `${snapshot.projects.length} project${snapshot.projects.length === 1 ? "" : "s"}`
        : null;
      return {
        kind: "machine" as const,
        id: snapshot.mentionId,
        title: snapshot.name,
        subtitle: [
          snapshot.isThisMachine ? "this machine" : null,
          describeAccountMachinePresence(snapshot, now),
          projects,
        ].filter(Boolean).join(" · "),
        // Online machines first (all "now"), then by last heartbeat.
        lastActivityAt: machine.online ? now : machine.lastSeenAt,
        machine: { online: machine.online, isThisMachine: snapshot.isThisMachine },
      };
    });
  };

  const buildMcpCandidates = async (): Promise<ChatMentionSuggestion[]> =>
    (deps.listMcpServers?.() ?? []).map(({ server, state, needsSignIn, toolNames = [], toolCount, lastError = null, lastErrorAt = null }) => ({
      kind: "mcp" as const,
      id: server.name,
      title: server.name,
      subtitle: `${needsSignIn && state === "on" ? "needs sign-in" : state} · ${server.transport}`,
      mcp: {
        state: needsSignIn && state === "on" ? "needs-sign-in" : state,
        transport: server.transport,
        toolNames: toolNames.slice(0, 32),
        ...(toolCount != null ? { toolCount } : {}),
        lastError,
        ...(lastErrorAt != null ? { lastErrorAt } : {}),
      },
    }));

  const candidateBuildersByKind: Record<
    ChatMentionKind,
    (args: ChatMentionSuggestArgs) => Promise<ChatMentionSuggestion[]>
  > = {
    chat: (args) => buildChatCandidates(args.excludeSessionId),
    lane: () => buildLaneCandidates(),
    terminal: () => buildTerminalCandidates(),
    pr: () => buildPrCandidates(),
    machine: () => buildMachineCandidates(),
    mcp: () => buildMcpCandidates(),
  };

  /**
   * Menu-time suggestions.
   *
   * - A leading kind word (`pr`, `mac`, `chat`, `lane`, `term`) narrows the
   *   result to that kind and searches the rest of the query.
   * - An empty query is a browse: each kind's most recent rows, capped per
   *   kind, so a client can show them in sections without one busy kind
   *   crowding the others out.
   * - Otherwise every kind is collected and ranked as one list by match
   *   quality (not by kind). Each source is still capped before the mix so a
   *   huge chat roster cannot starve the other kinds of candidates.
   *
   * Kinds are read in parallel and each failure is contained, so a slow
   * machine directory can never blank (or hold up) the chat and lane rows for
   * longer than its own timeout.
   */
  const listChatMentionSuggestions = async (
    args: ChatMentionSuggestArgs = {},
  ): Promise<ChatMentionSuggestResult> => {
    const rawQuery = typeof args.query === "string" ? args.query : "";
    const filter = parseChatMentionKindFilter(rawQuery);
    const query = filter.rest;
    const kinds = filter.kind ? [filter.kind] : CHAT_MENTION_KINDS;
    const perKind = await Promise.all(kinds.map(async (kind) => {
      try {
        const candidates = await candidateBuildersByKind[kind](args);
        return rankChatMentionSuggestions(
          candidates,
          query,
          filter.kind ? CHAT_MENTION_MAX_RESULTS : CHAT_MENTION_MAX_PER_KIND,
        );
      } catch (error) {
        // One failing roster must not blank the whole menu.
        deps.logger?.warn?.("chat mention suggestions failed for kind", { kind, error });
        return [] as ChatMentionSuggestion[];
      }
    }));
    if (filter.kind || !query.trim()) return { suggestions: perKind.flat() };
    return { suggestions: rankChatMentionSuggestions(perKind.flat(), query, CHAT_MENTION_MAX_RESULTS) };
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
      // Keep transcript order: the preview is labeled "most recent exchange",
      // so a trailing unanswered user message must render AFTER the earlier
      // assistant reply (or alone) — never as if it had been answered.
      const lastUser = [...entries].reverse().find((entry) => entry.role === "user");
      const lastAssistant = [...entries].reverse().find((entry) => entry.role === "assistant");
      const picked = [lastUser, lastAssistant]
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .sort((a, b) => entries.indexOf(a) - entries.indexOf(b));
      const lines = picked.map(
        (entry) => `${entry.role}: ${(entry.displayText || entry.text || "").trim()}`,
      );
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

  /**
   * Status only, from the local PR row: no GitHub call happens at send time.
   * The hint names the `ade prs` reads for anything deeper.
   */
  const resolvePrDetail = async (
    prId: string,
    roster: MentionRoster,
  ): Promise<ChatMentionDetail | null> => {
    const pr = deps.listPrs?.().find((entry) => entry.id === prId);
    if (!pr) return null;
    const lane = roster.lanesById.get(pr.laneId);
    const checks = pr.checksReason?.trim()
      ? `${pr.checksStatus} (${pr.checksReason.trim()})`
      : pr.checksStatus;
    return {
      kind: "pr",
      id: pr.id,
      title: firstLine(pr.title) ?? `Pull request #${pr.githubPrNumber}`,
      attributes: [
        ["number", `#${pr.githubPrNumber}`],
        ["repo", pr.repoOwner && pr.repoName ? `${pr.repoOwner}/${pr.repoName}` : ""],
        ["state", pr.state],
        ["review", pr.reviewStatus],
        ["checks", checks],
        ["lines", `+${pr.additions}/-${pr.deletions}`],
        ...(typeof pr.mergeConflicts === "boolean"
          ? ([["conflicts", pr.mergeConflicts ? "true" : "false"]] as Array<[string, string]>)
          : []),
        ...(typeof pr.behindBaseBy === "number"
          ? ([["behindBase", String(pr.behindBaseBy)]] as Array<[string, string]>)
          : []),
        ["head", pr.headBranch],
        ["base", pr.baseBranch],
        ["lane", lane?.name ?? ""],
        ["url", pr.githubUrl],
        ["lastSynced", pr.lastSyncedAt ?? ""],
      ].filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].length > 0),
      hint:
        "Pointer to a pull request tracked by ADE. The status above is ADE's last sync, not a live read. "
        + `Read more with \`ade prs show ${pr.id} --text\`, `
        + `\`ade prs checks ${pr.id} --text\` (CI rollup and per-check rows), and `
        + `\`ade prs comments ${pr.id} --text\` (unresolved review work).`,
    };
  };

  const machineUnresolvedReason = (roster: MachineRoster): string | null => {
    switch (roster.state) {
      case "ok":
        return null;
      case "signed_out":
        return "The ADE account is signed out on this machine, so account machines cannot be read.";
      case "auth_expired":
        return "The ADE account session on this machine expired, so account machines cannot be read.";
      case "not_configured":
        return "The ADE account machine directory is not configured on this machine.";
      case "unsupported":
        return "This ADE runtime cannot read account machines.";
      default:
        return "The ADE account machine directory could not be reached.";
    }
  };

  const resolveMachineDetail = async (
    id: string,
    machines: MachineRoster,
    unresolvedReasons: Map<string, string>,
  ): Promise<ChatMentionDetail | null> => {
    const reason = machineUnresolvedReason(machines);
    if (reason) {
      unresolvedReasons.set(`machine:${id}`, reason);
      return null;
    }
    const machine = findMachineByMentionId(machines.machines, id);
    if (!machine) return null;
    const snapshot = buildAccountMachineSnapshot({
      machine,
      activityItems: machines.activity,
      localMachineKey: localMachineKey(),
    });
    return {
      kind: "machine",
      id: machineMentionId(machine),
      title: snapshot.name,
      attributes: [
        ["machineKey", snapshot.machineKey],
        ["platform", snapshot.platform ?? ""],
        ["status", describeAccountMachinePresence(snapshot)],
        ["thisMachine", snapshot.isThisMachine ? "true" : ""],
        ["snapshotAt", new Date().toISOString()],
      ].filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].length > 0),
      hint:
        "The user referenced this machine connected through ADE. "
        + `Read its status, projects, lanes and recent chats with \`ade machines show ${snapshot.machineKey} --text\`. `
        + "Change nothing there unless the user asks. When the user asks for work there: "
        + `to run a command (tests, a build, a CLI signed in there), run \`ade shell start --machine ${snapshot.machineKey} --wait -- <command>\` from this chat; `
        + "it runs in this chat's work copy there, so push your commit first (uncommitted changes go along). "
        + `For a whole task, start a chat there (\`ade chat create --machine ${snapshot.machineKey}\`); `
        + `to move this chat, \`ade chat handoff <this chat> --machine ${snapshot.machineKey}\`. `
        + "Projects, lanes and chats below come from ADE Activity (recent work only, not a full listing).",
      previewLabel: "Snapshot at send time:",
      preview: formatAccountMachineSnapshotText(snapshot, Date.now(), { compact: true }),
    };
  };

  const resolveMcpDetail = async (name: string): Promise<ChatMentionDetail | null> => {
    const record = deps.listMcpServers?.().find(({ server }) => server.name === name);
    if (!record) return null;
    const tools = record.toolNames?.slice(0, 32) ?? [];
    const toolCount = record.toolCount ?? (record.toolNames ? record.toolNames.length : null);
    return {
      kind: "mcp",
      id: record.server.name,
      title: record.server.name,
      attributes: [
        ["state", record.needsSignIn && record.state === "on" ? "needs sign-in" : record.state],
        ["transport", record.server.transport],
        ["toolCount", toolCount != null ? String(toolCount) : "not reported"],
        ["lastError", record.lastError ?? "not reported"],
      ],
      hint: "Pointer to an MCP server configured in ADE on this machine. This snapshot does not attach tools or authorize a tool call. Check the named server and available tools before using it.",
      previewLabel: toolCount != null ? "Available tool names:" : "Available tool names (not reported):",
      preview: tools.length ? tools.join("\n") : null,
    };
  };

  const detailResolversByKind: Record<
    Exclude<ChatMentionKind, "machine" | "mcp">,
    (id: string, roster: MentionRoster) => Promise<ChatMentionDetail | null>
  > = {
    chat: resolveChatDetail,
    lane: resolveLaneDetail,
    terminal: resolveTerminalDetail,
    pr: resolvePrDetail,
  };

  /**
   * Resolve every mention target for one outgoing message. Roster reads are
   * shared across all targets; only previews are per-target. The machine
   * directory is read once, fresh, and only when the message mentions one.
   */
  const resolveDetailsWithReasons = async (
    targets: Array<{ kind: ChatMentionKind; id: string }>,
  ): Promise<{
    details: Map<string, ChatMentionDetail | null>;
    /** Why a target did not resolve, when that says more than "not found". */
    reasons: Map<string, string>;
  }> => {
    const out = new Map<string, ChatMentionDetail | null>();
    const reasons = new Map<string, string>();
    if (!targets.length) return { details: out, reasons };
    const roster = await loadRoster().catch((): MentionRoster => ({
      sessions: [],
      sessionsError: null,
      lanes: [],
      lanesById: new Map(),
      lanesError: null,
      terminals: [],
      terminalsError: null,
    }));
    let machines: Promise<MachineRoster> | null = null;
    for (const target of targets) {
      const key = `${target.kind}:${target.id}`;
      try {
        if (target.kind === "machine") {
          machines ??= loadMachineRoster(true).catch((): MachineRoster => ({
            state: "unavailable",
            machines: [],
            message: null,
            activity: null,
          }));
          out.set(key, await resolveMachineDetail(target.id, await machines, reasons));
        } else if (target.kind === "mcp") {
          out.set(key, await resolveMcpDetail(target.id));
        } else {
          out.set(key, await detailResolversByKind[target.kind](target.id, roster));
        }
      } catch (error) {
        deps.logger?.warn?.("chat mention resolution failed", { target, error });
        out.set(key, null);
      }
    }
    return { details: out, reasons };
  };

  const resolveChatMentionDetails = async (
    targets: Array<{ kind: ChatMentionKind; id: string }>,
  ): Promise<Map<string, ChatMentionDetail | null>> =>
    (await resolveDetailsWithReasons(targets)).details;

  /**
   * Expand `@chat:` / `@lane:` / `@term:` / `@pr:` / `@mac:` chips into
   * `<ade-mention>` pointer blocks. Only ever touches the prompt text — the
   * transcript keeps the raw chips the user typed.
   */
  const expandChatMentionsForSend = async (text: string): Promise<string> => {
    const userText = maskBrowserTabMentions(text);
    const targets = collectChatMentionTargets(userText);
    const modelBlocks = renderModelMentionBlocks(userText);
    if (!targets.length && !modelBlocks.length) return text;
    const { details, reasons } = await resolveDetailsWithReasons(targets);
    const blocks = targets.map((target) => {
      const key = `${target.kind}:${target.id}`;
      const detail = details.get(key);
      return detail
        ? renderChatMentionBlock(detail)
        : renderUnresolvedChatMentionBlock(target.kind, target.id, reasons.get(key));
    });
    return appendChatMentionBlocks(text, [...blocks, ...modelBlocks]);
  };

  /** One block per distinct model chip. Needs no roster, only the model catalog. */
  const renderModelMentionBlocks = (text: string): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const mention of parseModelMentions(text)) {
      if (seen.has(mention.token)) continue;
      seen.add(mention.token);
      let info: ModelMentionModelInfo | null = null;
      try {
        info = deps.describeModel?.(mention.modelId) ?? null;
      } catch (error) {
        deps.logger?.warn?.("model mention lookup failed", { modelId: mention.modelId, error });
      }
      out.push(renderChatMentionBlock(buildModelMentionDetail(mention, info)));
      if (out.length >= MODEL_MENTION_MAX_PER_MESSAGE) break;
    }
    return out;
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
