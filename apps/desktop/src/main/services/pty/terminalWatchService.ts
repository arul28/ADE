import { randomUUID } from "node:crypto";
import type { AdeCardPayload, AdeCardRow } from "../../../shared/adeCard";
import { isMovedAwayChatError } from "../../../shared/crossMachineMoveLock";
import { isChatToolType } from "../../../shared/sessionSpawnNesting";
import {
  compileTerminalWatchMatch,
  describeTerminalWatchStop,
  parseTerminalWatchLifetimeMs,
  type TerminalListWatchesArgs,
  type TerminalUnwatchArgs,
  type TerminalUnwatchResult,
  type TerminalWatchArgs,
  type TerminalWatchMatcher,
  type TerminalWatchResult,
  type TerminalWatchStopReason,
  type TerminalWatchSummary,
} from "../../../shared/terminalWatch";
import type { AgentChatMessageSessionArgs } from "../../../shared/types/chat";
import type {
  ChatTerminalReadArgs,
  ChatTerminalReadResult,
  PtyCreateArgs,
  TerminalSessionChangedEvent,
} from "../../../shared/types/sessions";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { buildTerminalWatchExcerpt, cleanTerminalOutput } from "./terminalWatchOutput";

/** Output must go quiet this long before a wake is sent… */
const QUIET_MS = 3_000;
/** …but a process that never goes quiet still wakes after this long. */
const MAX_DELAY_MS = 20_000;
/** A held wake (busy chat) looks again this often. Only runs while output is held. */
const HELD_RECHECK_MS = 15_000;
/** The excerpt a wake carries. */
const EXCERPT_MAX_BYTES = 4_096;
/** Raw output kept between wakes; older output is counted, not kept. */
const PENDING_MAX_CHARS = 64 * 1024;
/** Raw output kept for the exit wake's "last lines". */
const RECENT_TAIL_CHARS = 4 * 1024;
const WAKES_PER_HOUR = 20;
const MAX_WATCHES_PER_CHAT = 5;
const MAX_WATCHES_TOTAL = 100;
const DELIVERY_FAILURES_BEFORE_STOP = 3;
/** Output a `command` watch buffers while its shell is being created. */
const LAUNCH_BUFFER_MAX_CHARS = PENDING_MAX_CHARS;

type ChatRow = {
  toolType?: string | null;
  settledAt?: string | null;
  archivedAt?: string | null;
  laneId?: string | null;
  title?: string | null;
  goal?: string | null;
};

export type TerminalWatchServiceDeps = {
  logger: Logger;
  ptyService: {
    onData: (listener: (event: { sessionId: string; data: string; replace?: boolean }) => void) => () => void;
    onExit: (listener: (event: { sessionId: string; exitCode: number | null }) => void) => () => void;
    /** Resolves a terminal id, PTY id or a chat's active shell, and refuses chat rows. */
    readTerminal: (args: ChatTerminalReadArgs) => Promise<ChatTerminalReadResult>;
    hasLivePty: (sessionId: string) => boolean;
    create?: (args: PtyCreateArgs) => Promise<{ ptyId: string; sessionId: string }>;
    dispose?: (args: { ptyId: string; sessionId?: string }) => unknown;
  };
  sessionService: {
    get: (sessionId: string) => ChatRow | null;
    onChanged?: (listener: (event: TerminalSessionChangedEvent) => void) => () => void;
    /** Tells every client a session's row changed, so a chat's pane re-reads its watches. */
    notifyChanged?: (sessionId: string) => void;
  };
  messageSession: (args: AgentChatMessageSessionArgs) => Promise<unknown>;
  /** The chat service's own view of a turn; a session row cannot tell an idle chat from a busy one. */
  getChatLiveness?: (sessionId: string) => Promise<{ status?: string | null } | null>;
  isChatMovedAway?: (sessionId: string) => boolean;
  now?: () => number;
  timing?: Partial<{ quietMs: number; maxDelayMs: number; heldRecheckMs: number }>;
};

type FinalReason = Extract<TerminalWatchStopReason, "terminal_exited" | "expired" | "wake_limit">;

type Watch = {
  id: string;
  chatSessionId: string;
  terminalId: string;
  terminalTitle: string;
  matcher: TerminalWatchMatcher | null;
  armedBy: "agent" | "user";
  startedAtMs: number;
  expiresAtMs: number;
  stoppedAtMs: number | null;
  stopReason: TerminalWatchStopReason | null;
  bytesSeen: number;
  /** Bytes since the last wake, including what fell out of `pending`. */
  bytesSinceWake: number;
  pending: string[];
  pendingChars: number;
  /** Output since the last wake that was too old to keep. */
  droppedChars: number;
  recentTail: string;
  firstPendingAtMs: number | null;
  quietTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
  heldTimer: ReturnType<typeof setTimeout> | null;
  lifetimeTimer: ReturnType<typeof setTimeout> | null;
  wakeTimesMs: number[];
  wakeCount: number;
  lastWokeAtMs: number | null;
  lastExcerpt: string | null;
  holding: boolean;
  delivering: boolean;
  flushAgain: boolean;
  deliveryFailures: number;
  /** Set once a final reason is known, so a late flush cannot send a second final wake. */
  finalReason: FinalReason | null;
  exitCode: number | null;
};

function iso(ms: number): string;
function iso(ms: number | null): string | null;
function iso(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

/**
 * A code fence longer than any backtick run in the text, so terminal output
 * (which a server log can fill with anyone's text) cannot close the fence and
 * read as ADE's own words in the wake.
 */
function codeFenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Terminal watch: wakes a chat when an ADE terminal on this brain prints
 * something new.
 *
 * Event driven: one `ptyService.onData` subscription, held only while a watch
 * exists, feeds every watch on the chunk's terminal. Nothing runs per chunk
 * but an append; the cleaning, matching and excerpting happen once per wake,
 * after the output goes quiet (or a max delay, so a chatty process still
 * wakes). The baseline is the stream at the moment the watch starts, so output
 * that was already on screen never wakes anyone.
 *
 * Watches live in memory. They end when this brain stops, as the terminals
 * they watch do; an agent re-arms after a restart.
 */
export function createTerminalWatchService(deps: TerminalWatchServiceDeps) {
  const { logger } = deps;
  const now = deps.now ?? (() => Date.now());
  const quietMs = deps.timing?.quietMs ?? QUIET_MS;
  const maxDelayMs = deps.timing?.maxDelayMs ?? MAX_DELAY_MS;
  const heldRecheckMs = deps.timing?.heldRecheckMs ?? HELD_RECHECK_MS;

  const watches = new Map<string, Watch>();
  const byTerminal = new Map<string, Set<Watch>>();
  /** Shells a `command` watch is creating: output that lands before the id is known. */
  const launchBuffers = new Set<Map<string, string[]>>();
  let unsubscribeData: (() => void) | null = null;
  let unsubscribeExit: (() => void) | null = null;
  let unsubscribeSessions: (() => void) | null = null;
  let disposed = false;

  const summarize = (watch: Watch): TerminalWatchSummary => ({
    watchId: watch.id,
    chatSessionId: watch.chatSessionId,
    terminalId: watch.terminalId,
    terminalTitle: watch.terminalTitle,
    match: watch.matcher?.label ?? null,
    armedBy: watch.armedBy,
    status: watch.stoppedAtMs == null ? "active" : "stopped",
    startedAt: iso(watch.startedAtMs),
    expiresAt: iso(watch.expiresAtMs),
    stoppedAt: iso(watch.stoppedAtMs),
    stopReason: watch.stopReason,
    wakeCount: watch.wakeCount,
    lastWokeAt: iso(watch.lastWokeAtMs),
    bytesSeen: watch.bytesSeen,
    holding: watch.holding,
  });

  const notifyChat = (chatSessionId: string) => {
    try {
      deps.sessionService.notifyChanged?.(chatSessionId);
    } catch {
      // A client refresh hint; never worth failing a watch over.
    }
  };

  const clearTimer = (watch: Watch, key: "quietTimer" | "maxTimer" | "heldTimer" | "lifetimeTimer") => {
    const timer = watch[key];
    if (timer) clearTimeout(timer);
    watch[key] = null;
  };

  const unref = <T extends ReturnType<typeof setTimeout>>(timer: T): T => {
    (timer as { unref?: () => void }).unref?.();
    return timer;
  };

  const syncSubscriptions = () => {
    const needed = !disposed && (watches.size > 0 || launchBuffers.size > 0);
    if (needed && !unsubscribeData) {
      unsubscribeData = deps.ptyService.onData(onData);
      unsubscribeExit = deps.ptyService.onExit(onExit);
      unsubscribeSessions = deps.sessionService.onChanged?.(onSessionChanged) ?? null;
    } else if (!needed && unsubscribeData) {
      unsubscribeData();
      unsubscribeExit?.();
      unsubscribeSessions?.();
      unsubscribeData = null;
      unsubscribeExit = null;
      unsubscribeSessions = null;
    }
  };

  const endWatch = (watch: Watch, reason: TerminalWatchStopReason) => {
    if (watch.stoppedAtMs != null) return;
    watch.stoppedAtMs = now();
    watch.stopReason = reason;
    watch.holding = false;
    clearTimer(watch, "quietTimer");
    clearTimer(watch, "maxTimer");
    clearTimer(watch, "heldTimer");
    clearTimer(watch, "lifetimeTimer");
    watch.pending = [];
    watch.pendingChars = 0;
    watches.delete(watch.id);
    const set = byTerminal.get(watch.terminalId);
    set?.delete(watch);
    if (set && set.size === 0) byTerminal.delete(watch.terminalId);
    syncSubscriptions();
    logger.info("terminal_watch.stopped", {
      watchId: watch.id,
      chatSessionId: watch.chatSessionId,
      terminalId: watch.terminalId,
      reason,
      wakes: watch.wakeCount,
    });
    notifyChat(watch.chatSessionId);
  };

  const appendOutput = (watch: Watch, data: string) => {
    const bytes = Buffer.byteLength(data, "utf8");
    watch.bytesSeen += bytes;
    watch.bytesSinceWake += bytes;
    watch.pending.push(data);
    watch.pendingChars += data.length;
    // A burst of megabytes keeps only its newest part; the rest is counted.
    if (watch.pendingChars > PENDING_MAX_CHARS * 2) {
      const joined = watch.pending.join("");
      const keep = joined.slice(joined.length - PENDING_MAX_CHARS);
      watch.droppedChars += joined.length - keep.length;
      watch.pending = [keep];
      watch.pendingChars = keep.length;
    }
    watch.recentTail = (watch.recentTail + data).slice(-RECENT_TAIL_CHARS);
    if (watch.finalReason) return;
    const nowMs = now();
    if (watch.firstPendingAtMs == null) watch.firstPendingAtMs = nowMs;
    clearTimer(watch, "quietTimer");
    watch.quietTimer = unref(setTimeout(() => {
      watch.quietTimer = null;
      void flush(watch);
    }, quietMs));
    if (!watch.maxTimer && !watch.holding) {
      watch.maxTimer = unref(setTimeout(() => {
        watch.maxTimer = null;
        void flush(watch);
      }, maxDelayMs));
    }
  };

  function onData(event: { sessionId: string; data: string; replace?: boolean }): void {
    // A replace is the renderer's screen snapshot being restored, not output.
    if (event.replace || !event.data) return;
    for (const buffer of launchBuffers) {
      const chunks = buffer.get(event.sessionId) ?? [];
      if (chunks.reduce((sum, chunk) => sum + chunk.length, 0) < LAUNCH_BUFFER_MAX_CHARS) {
        chunks.push(event.data);
        buffer.set(event.sessionId, chunks);
      }
    }
    const set = byTerminal.get(event.sessionId);
    if (!set) return;
    for (const watch of set) appendOutput(watch, event.data);
  }

  function onExit(event: { sessionId: string; exitCode: number | null }): void {
    const set = byTerminal.get(event.sessionId);
    if (!set) return;
    for (const watch of [...set]) {
      watch.exitCode = event.exitCode;
      watch.finalReason = "terminal_exited";
      clearTimer(watch, "quietTimer");
      clearTimer(watch, "maxTimer");
      // The PTY flushes its last bytes just before the exit event; give them a
      // moment to land, then send the final wake.
      watch.quietTimer = unref(setTimeout(() => {
        watch.quietTimer = null;
        void flush(watch);
      }, 250));
    }
  }

  function onSessionChanged(event: TerminalSessionChangedEvent): void {
    for (const watch of [...watches.values()]) {
      if (watch.chatSessionId !== event.sessionId) continue;
      const row = deps.sessionService.get(watch.chatSessionId);
      if (!row || row.archivedAt || event.reason === "deleted") {
        endWatch(watch, "chat_gone");
        continue;
      }
      // A chat that moved back (or any change to it) is a chance to deliver held output.
      if (watch.holding && !watch.delivering) void flush(watch);
    }
  }

  type ChatGate = "deliver" | "hold" | "gone";

  const chatGate = async (watch: Watch): Promise<ChatGate> => {
    const row = deps.sessionService.get(watch.chatSessionId);
    if (!row || !isChatToolType(row.toolType) || row.archivedAt) return "gone";
    // A moved-away chat is driven elsewhere: hold what came in until it is
    // back. A settled chat is still woken: settle stops nothing, and the
    // wake's turn takes the chat out of settled.
    if (deps.isChatMovedAway?.(watch.chatSessionId)) return "hold";
    if (watch.finalReason) return "deliver";
    // Mid-turn, hold and coalesce: one wake when the turn ends, never a queue
    // of wakes for a chat that is busy for an hour.
    try {
      const liveness = await deps.getChatLiveness?.(watch.chatSessionId);
      if (liveness?.status === "active") return "hold";
    } catch {
      // Unknown liveness: deliver; the chat service queues a wake at the turn boundary.
    }
    return "deliver";
  };

  const hold = (watch: Watch) => {
    const wasHolding = watch.holding;
    watch.holding = true;
    clearTimer(watch, "maxTimer");
    if (!watch.heldTimer) {
      watch.heldTimer = unref(setTimeout(() => {
        watch.heldTimer = null;
        void flush(watch);
      }, heldRecheckMs));
    }
    if (!wasHolding) notifyChat(watch.chatSessionId);
  };

  const buildWake = (
    watch: Watch,
    excerpt: { text: string; omittedLines: number; matchedLines: number } | null,
    final: { reason: FinalReason } | null,
    /** The excerpt is the screen's last lines (an exit with nothing new), not new output. */
    excerptIsTail = false,
  ): { text: string; card: AdeCardPayload; summary: string } => {
    const title = watch.terminalTitle;
    const sinceWhat = watch.wakeCount === 0 ? "the watch started" : "your last wake";
    const lines: string[] = [];
    let summary: string;
    if (final?.reason === "terminal_exited") {
      summary = watch.exitCode == null ? "exited" : `exited with code ${watch.exitCode}`;
      lines.push(`Terminal watch: "${title}" (terminal ${watch.terminalId}) ${summary}. This watch has ended.`);
    } else if (final) {
      summary = `watch ended: ${describeTerminalWatchStop(final.reason)}`;
      lines.push(`Terminal watch on "${title}" (terminal ${watch.terminalId}) has ended: ${describeTerminalWatchStop(final.reason)}.`);
    } else {
      summary = watch.matcher ? `matched ${watch.matcher.label}` : "new output";
      lines.push(`Terminal watch: new output in "${title}" (terminal ${watch.terminalId}).`);
    }
    if (excerpt && excerptIsTail) {
      const fence = codeFenceFor(excerpt.text);
      lines.push("No new output since your last wake. The last lines on screen:", "", `${fence}text`, excerpt.text, fence);
    } else if (excerpt) {
      const omitted = excerpt.omittedLines > 0 ? ` ${excerpt.omittedLines} earlier line${excerpt.omittedLines === 1 ? "" : "s"} left out.` : "";
      const dropped = watch.droppedChars > 0 ? ` About ${formatBytes(watch.droppedChars)} of older output was not kept.` : "";
      const filter = watch.matcher
        ? ` ${excerpt.matchedLines} line${excerpt.matchedLines === 1 ? "" : "s"} matched ${watch.matcher.label}; shown with a little context.`
        : "";
      const fence = codeFenceFor(excerpt.text);
      lines.push(
        `${formatBytes(watch.bytesSinceWake)} of new output since ${sinceWhat}. Colors and redraws are removed.${filter}${omitted}${dropped}`,
        "",
        `${fence}text`,
        excerpt.text,
        fence,
      );
    } else if (final) {
      lines.push("No new output to show.");
    }
    lines.push("", `Read more: \`ade terminal read --terminal ${watch.terminalId} --text\``);
    if (!final) lines.push(`Stop watching: \`ade terminal unwatch ${watch.id}\``);
    if (final?.reason === "wake_limit" || final?.reason === "expired") {
      lines.push(`Watch again if you still need it: \`ade terminal watch ${watch.terminalId}${watch.matcher ? ` --match ${JSON.stringify(watch.matcher.label)}` : ""}\``);
    }

    const excerptLines = excerpt ? excerpt.text.split("\n").filter((line) => line && line !== "…") : [];
    const shown = excerptLines.slice(-3);
    const rows: AdeCardRow[] = shown.map((line) => ({ icon: "info", text: line.length > 160 ? `${line.slice(0, 160)}…` : line }));
    const deliveredAt = new Date(now()).toISOString();
    const card: AdeCardPayload = {
      cardId: `terminal-watch:${watch.id}:${deliveredAt}`,
      variant: "terminal_watch_wake",
      state: "terminal",
      title: `${title} · ${summary}`,
      subtitle: final ? "Agent notified · watch ended" : "Agent notified · watching",
      rows,
      ...(excerptLines.length > shown.length ? { rowsTruncated: excerptLines.length - shown.length } : {}),
      fallbackText: `Terminal "${title}": ${summary}. Agent notified.`,
      createdAt: deliveredAt,
    };
    return { text: lines.join("\n"), card, summary };
  };

  async function flush(watch: Watch): Promise<void> {
    if (watch.stoppedAtMs != null || disposed) return;
    if (watch.delivering) {
      watch.flushAgain = true;
      return;
    }
    watch.delivering = true;
    try {
      await flushOnce(watch);
    } catch (error) {
      logger.warn("terminal_watch.flush_failed", { watchId: watch.id, error: getErrorMessage(error) });
    } finally {
      watch.delivering = false;
    }
    if (watch.flushAgain && watch.stoppedAtMs == null) {
      watch.flushAgain = false;
      void flush(watch);
    }
  }

  async function flushOnce(watch: Watch): Promise<void> {
    const gate = await chatGate(watch);
    if (watch.stoppedAtMs != null) return;
    if (gate === "gone") {
      endWatch(watch, "chat_gone");
      return;
    }
    if (gate === "hold") {
      // A moved-away chat is not woken to say goodbye either; its watch just
      // ends when the terminal does.
      if (watch.finalReason === "terminal_exited" || watch.finalReason === "expired") {
        if (deps.isChatMovedAway?.(watch.chatSessionId)) {
          endWatch(watch, watch.finalReason);
          return;
        }
      }
      if (watch.pendingChars > 0 || watch.finalReason) hold(watch);
      return;
    }
    clearTimer(watch, "heldTimer");
    clearTimer(watch, "maxTimer");
    clearTimer(watch, "quietTimer");
    const wasHolding = watch.holding;
    watch.holding = false;

    const raw = watch.pending.join("");
    const pendingSnapshot = { pending: watch.pending, pendingChars: watch.pendingChars };
    watch.pending = [];
    watch.pendingChars = 0;
    watch.firstPendingAtMs = null;

    let final: { reason: FinalReason } | null = watch.finalReason ? { reason: watch.finalReason } : null;
    const lines = cleanTerminalOutput(raw);
    let excerpt = buildTerminalWatchExcerpt(lines, watch.matcher, EXCERPT_MAX_BYTES);
    if (!final) {
      // Paint only, nothing matching, or the same text again: no wake. The
      // baseline still moves past it.
      if (!excerpt || !excerpt.text.trim() || excerpt.text === watch.lastExcerpt) {
        watch.bytesSinceWake = 0;
        watch.droppedChars = 0;
        if (wasHolding) notifyChat(watch.chatSessionId);
        return;
      }
      const hourAgo = now() - 60 * 60_000;
      watch.wakeTimesMs = watch.wakeTimesMs.filter((at) => at > hourAgo);
      if (watch.wakeTimesMs.length + 1 >= WAKES_PER_HOUR) {
        final = { reason: "wake_limit" };
        watch.finalReason = "wake_limit";
      }
    }
    let excerptIsTail = false;
    if (final?.reason === "terminal_exited" && !excerpt) {
      // Nothing new before the exit: the last lines on screen say how it ended.
      excerpt = buildTerminalWatchExcerpt(cleanTerminalOutput(watch.recentTail).slice(-12), null, 1_500);
      excerptIsTail = Boolean(excerpt);
    }

    const wake = buildWake(watch, excerpt, final, excerptIsTail);
    try {
      await deps.messageSession({
        sessionId: watch.chatSessionId,
        kind: "wake",
        text: wake.text,
        metadata: {
          terminalWatchWake: {
            watchId: watch.id,
            terminalId: watch.terminalId,
            card: wake.card,
          },
        },
      });
    } catch (error) {
      if (watch.stoppedAtMs != null) return;
      // Put the output back so the next try still has it.
      watch.pending = [...pendingSnapshot.pending, ...watch.pending];
      watch.pendingChars += pendingSnapshot.pendingChars;
      if (isMovedAwayChatError(error)) {
        hold(watch);
        return;
      }
      watch.deliveryFailures += 1;
      logger.warn("terminal_watch.wake_delivery_failed", {
        watchId: watch.id,
        chatSessionId: watch.chatSessionId,
        attempts: watch.deliveryFailures,
        error: getErrorMessage(error),
      });
      if (watch.deliveryFailures >= DELIVERY_FAILURES_BEFORE_STOP) {
        endWatch(watch, "delivery_failed");
        return;
      }
      hold(watch);
      return;
    }
    if (watch.stoppedAtMs != null) return;
    watch.deliveryFailures = 0;
    watch.wakeCount += 1;
    watch.lastWokeAtMs = now();
    watch.wakeTimesMs.push(watch.lastWokeAtMs);
    watch.lastExcerpt = excerpt?.text ?? null;
    watch.bytesSinceWake = 0;
    watch.droppedChars = 0;
    logger.info("terminal_watch.woke_chat", {
      watchId: watch.id,
      chatSessionId: watch.chatSessionId,
      terminalId: watch.terminalId,
      final: final?.reason ?? null,
      excerptBytes: excerpt ? Buffer.byteLength(excerpt.text, "utf8") : 0,
    });
    if (final) {
      endWatch(watch, final.reason);
      return;
    }
    notifyChat(watch.chatSessionId);
  }

  const resolveChat = (chatSessionId: string): ChatRow => {
    const row = deps.sessionService.get(chatSessionId);
    if (!row) {
      throw new Error(`Chat '${chatSessionId}' was not found on this machine. A terminal watch runs on the machine that runs the chat.`);
    }
    if (!isChatToolType(row.toolType)) {
      throw new Error("A terminal watch wakes an ADE chat, and this session is not one. Run it from a chat, or pass --chat <chat id>.");
    }
    if (row.archivedAt) throw new Error(`Chat '${chatSessionId}' is archived.`);
    return row;
  };

  const resolveTerminal = async (args: TerminalWatchArgs): Promise<{ terminalId: string; title: string }> => {
    const terminalId = args.terminalId?.trim() || null;
    const ptyId = args.ptyId?.trim() || null;
    let resolved: string;
    try {
      const read = await deps.ptyService.readTerminal({
        terminalId,
        ptyId,
        chatSessionId: terminalId || ptyId ? null : args.chatSessionId,
        maxBytes: 1,
      });
      resolved = read.terminalId;
    } catch (error) {
      if (!terminalId && !ptyId) {
        throw new Error("This chat has no active shell to watch. Pass a terminal id (`ade terminal list --text`), or --command to start one.");
      }
      throw new Error(`${getErrorMessage(error)} A terminal watch can only watch a terminal on the machine that runs the chat.`);
    }
    if (!deps.ptyService.hasLivePty(resolved)) {
      throw new Error(`Terminal '${resolved}' is not running on this machine, so there is nothing to watch. A watch needs a live terminal on the chat's machine.`);
    }
    const row = deps.sessionService.get(resolved);
    const title = (row?.goal ?? row?.title ?? "").trim() || "Terminal";
    return { terminalId: resolved, title };
  };

  /** A replacement on the same terminal does not count against the limits. */
  const assertCapacity = (chatSessionId: string, terminalId: string | null) => {
    const others = [...watches.values()].filter((watch) => watch.terminalId !== terminalId || watch.chatSessionId !== chatSessionId);
    const forChat = others.filter((watch) => watch.chatSessionId === chatSessionId).length;
    if (forChat >= MAX_WATCHES_PER_CHAT) {
      throw new Error(`This chat already watches ${forChat} terminals, the most it can. Stop one first (\`ade terminal unwatch <watch id>\`).`);
    }
    if (others.length >= MAX_WATCHES_TOTAL) {
      throw new Error("Too many terminal watches are running on this machine. Stop some first.");
    }
  };

  const arm = (input: {
    chatSessionId: string;
    terminalId: string;
    title: string;
    matcher: TerminalWatchMatcher | null;
    lifetimeMs: number;
    armedBy: "agent" | "user";
    initialOutput?: string[];
  }): TerminalWatchResult => {
    assertCapacity(input.chatSessionId, input.terminalId);
    let replaced = false;
    for (const existing of byTerminal.get(input.terminalId) ?? []) {
      if (existing.chatSessionId === input.chatSessionId) {
        endWatch(existing, "replaced");
        replaced = true;
      }
    }
    const startedAtMs = now();
    const watch: Watch = {
      id: randomUUID(),
      chatSessionId: input.chatSessionId,
      terminalId: input.terminalId,
      terminalTitle: input.title,
      matcher: input.matcher,
      armedBy: input.armedBy,
      startedAtMs,
      expiresAtMs: startedAtMs + input.lifetimeMs,
      stoppedAtMs: null,
      stopReason: null,
      bytesSeen: 0,
      bytesSinceWake: 0,
      pending: [],
      pendingChars: 0,
      droppedChars: 0,
      recentTail: "",
      firstPendingAtMs: null,
      quietTimer: null,
      maxTimer: null,
      heldTimer: null,
      lifetimeTimer: null,
      wakeTimesMs: [],
      wakeCount: 0,
      lastWokeAtMs: null,
      lastExcerpt: null,
      holding: false,
      delivering: false,
      flushAgain: false,
      deliveryFailures: 0,
      finalReason: null,
      exitCode: null,
    };
    watches.set(watch.id, watch);
    const set = byTerminal.get(watch.terminalId) ?? new Set<Watch>();
    set.add(watch);
    byTerminal.set(watch.terminalId, set);
    syncSubscriptions();
    watch.lifetimeTimer = unref(setTimeout(() => {
      watch.lifetimeTimer = null;
      if (watch.stoppedAtMs != null || watch.finalReason) return;
      watch.finalReason = "expired";
      clearTimer(watch, "quietTimer");
      clearTimer(watch, "maxTimer");
      void flush(watch);
    }, input.lifetimeMs));
    for (const chunk of input.initialOutput ?? []) appendOutput(watch, chunk);
    logger.info("terminal_watch.armed", {
      watchId: watch.id,
      chatSessionId: watch.chatSessionId,
      terminalId: watch.terminalId,
      hasMatch: Boolean(watch.matcher),
      lifetimeMs: input.lifetimeMs,
      armedBy: watch.armedBy,
      replaced,
    });
    notifyChat(watch.chatSessionId);
    return { watch: summarize(watch), replaced };
  };

  return {
    /** Start (or replace) a watch. Throws a plain-language error the caller can show. */
    async watch(args: TerminalWatchArgs): Promise<TerminalWatchResult> {
      if (disposed) throw new Error("Terminal watches are shutting down on this machine.");
      const chatSessionId = String(args?.chatSessionId ?? "").trim();
      if (!chatSessionId) throw new Error("terminal.watch requires chatSessionId (the chat to wake).");
      const chat = resolveChat(chatSessionId);
      const matcher = compileTerminalWatchMatch(args.match);
      const lifetimeMs = parseTerminalWatchLifetimeMs(args.lifetime);
      const armedBy = args.armedBy === "user" ? "user" : "agent";
      const command = typeof args.command === "string" ? args.command.trim() : "";
      if (command) {
        if (args.terminalId || args.ptyId) throw new Error("Pass either a terminal or --command, not both.");
        if (!deps.ptyService.create) throw new Error("This machine cannot start terminals for a watch.");
        const laneId = args.laneId?.trim() || chat.laneId?.trim() || "";
        if (!laneId) throw new Error("The chat has no lane to start the command in. Pass --lane.");
        // Before the shell starts, so a refused watch leaves no process behind.
        assertCapacity(chatSessionId, null);
        // Capture output from the first byte: the shell may print before the
        // create call returns its id.
        const buffer = new Map<string, string[]>();
        launchBuffers.add(buffer);
        syncSubscriptions();
        try {
          const created = await deps.ptyService.create({
            laneId,
            chatSessionId,
            title: command.length > 60 ? `${command.slice(0, 57)}…` : command,
            startupCommand: command,
            toolType: "shell",
            tracked: true,
            cols: 120,
            rows: 36,
          });
          try {
            return arm({
              chatSessionId,
              terminalId: created.sessionId,
              title: command,
              matcher,
              lifetimeMs,
              armedBy,
              initialOutput: buffer.get(created.sessionId) ?? [],
            });
          } catch (error) {
            // The chat filled its watches while the shell started: a shell
            // running the command with nothing watching it is not what was
            // asked for, so close it.
            deps.ptyService.dispose?.({ ptyId: created.ptyId, sessionId: created.sessionId });
            throw error;
          }
        } finally {
          launchBuffers.delete(buffer);
          syncSubscriptions();
        }
      }
      const terminal = await resolveTerminal({ ...args, chatSessionId });
      return arm({ chatSessionId, terminalId: terminal.terminalId, title: terminal.title, matcher, lifetimeMs, armedBy });
    },

    /** Stop watches quietly: by id, by (chat, terminal), or all of a chat's. */
    unwatch(args: TerminalUnwatchArgs): TerminalUnwatchResult {
      const watchId = args?.watchId?.trim() || null;
      const terminalId = args?.terminalId?.trim() || null;
      const chatSessionId = args?.chatSessionId?.trim() || null;
      // A terminal alone would reach every chat's watch on it.
      if (!watchId && !chatSessionId) {
        throw new Error("terminal.unwatch requires a watch id, or the chat (and optionally the terminal) to stop.");
      }
      const targets = [...watches.values()].filter((watch) => {
        // Every given field must match, so a chat-scoped caller's id never
        // reaches another chat's watch.
        if (watchId && watch.id !== watchId) return false;
        if (chatSessionId && watch.chatSessionId !== chatSessionId) return false;
        if (terminalId && watch.terminalId !== terminalId) return false;
        return true;
      });
      const stopped: TerminalWatchSummary[] = [];
      for (const watch of targets) {
        endWatch(watch, "unwatched");
        stopped.push(summarize(watch));
      }
      return { stopped };
    },

    listWatches(args: TerminalListWatchesArgs = {}): TerminalWatchSummary[] {
      const chatSessionId = args?.chatSessionId?.trim() || null;
      const terminalId = args?.terminalId?.trim() || null;
      return [...watches.values()]
        .filter((watch) => (!chatSessionId || watch.chatSessionId === chatSessionId)
          && (!terminalId || watch.terminalId === terminalId))
        .sort((a, b) => b.startedAtMs - a.startedAtMs)
        .map(summarize);
    },

    dispose(): void {
      disposed = true;
      for (const watch of [...watches.values()]) {
        // Quietly: the brain is going away, and the chat with it.
        clearTimer(watch, "quietTimer");
        clearTimer(watch, "maxTimer");
        clearTimer(watch, "heldTimer");
        clearTimer(watch, "lifetimeTimer");
      }
      watches.clear();
      byTerminal.clear();
      launchBuffers.clear();
      syncSubscriptions();
    },
  };
}

export type TerminalWatchService = ReturnType<typeof createTerminalWatchService>;
