import fs from "node:fs";
import { stripAnsiWithOptions } from "../../utils/ansiStrip";
import { isTerminalChromeLine } from "../../utils/sessionSummary";
import { claudeSessionPath } from "../externalSessions/discoverClaude";
import { findCodexRolloutPathBySessionIdAsync } from "../externalSessions/discoverCodex";
import type { AgentChatSpawnKind, AgentChatTranscriptEntry } from "../../../shared/types/chat";
import { providerFromTool } from "../../utils/terminalSessionSignals";
import type { ChatTurnStatusSnapshot, DeriveChatTurnStatusInput } from "../../../shared/chatTurnStatus";
import { deriveChatTurnStatus } from "../../../shared/chatTurnStatus";
import {
  TRACKED_AGENT_CLI_TOOL_TYPES,
  type AgentChatCliChildSessionSummary,
  type CliSessionFacts,
} from "../../../shared/cliChildSession";
import {
  isTrackedAgentCliToolType,
  type TerminalToolType,
  type TerminalSessionStatus,
  type TerminalSessionSummary,
  type TrackedAgentCliToolType,
} from "../../../shared/types/sessions";

export type TrackedCliRow = TerminalSessionSummary;

type CliChildSessionAccessOptions = {
  getSession: (sessionId: string) => TerminalSessionSummary | null;
  listSessions: (args: { laneId?: string; limit: number; toolTypes: TrackedAgentCliToolType[] }) => TerminalSessionSummary[];
  enrichSessions?: (rows: TerminalSessionSummary[]) => TerminalSessionSummary[];
  isChatToolType: (toolType: TerminalToolType | null | undefined) => boolean;
  readTerminalTail: (terminalId: string) => Promise<string | null>;
  readProviderMessage: (row: TerminalSessionSummary, provider: string) => Promise<string | null>;
  deriveTurnStatus?: (input: DeriveChatTurnStatusInput) => ChatTurnStatusSnapshot;
};

/** Service-owned lookups and read/status/list factories for tracked CLI children. */
export function createCliChildSessionAccess(options: CliChildSessionAccessOptions) {
  const deriveTurnStatus = options.deriveTurnStatus ?? deriveChatTurnStatus;

  const readTrackedCliRow = (sessionId: string): { row: TrackedCliRow; lineage: CliChildLineage | null } | null => {
    const trimmed = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!trimmed) return null;
    let row: TerminalSessionSummary | null = null;
    try {
      row = options.getSession(trimmed);
    } catch {
      return null;
    }
    if (!row || options.isChatToolType(row.toolType) || !isTrackedAgentCliToolType(row.toolType ?? null)) return null;
    return { row, lineage: cliChildLineageFromRow(row) };
  };

  const cliReadHint = (terminalId: string): string => `ade terminal read ${terminalId}`;
  const cliSessionStatusFields = (row: TrackedCliRow, lineage: CliChildLineage | null): CliSessionFacts => ({
    toolType: row.toolType ?? null,
    provider: lineage?.provider ?? row.resumeMetadata?.provider ?? null,
    status: row.status,
    exitCode: row.exitCode ?? null,
    laneId: row.laneId,
    title: row.title ?? null,
    endedAt: row.endedAt ?? null,
    parentSessionId: lineage?.parentSessionId ?? null,
    spawnKind: lineage?.spawnKind ?? null,
    readHint: cliReadHint(row.id),
  });

  const getCliTurnStatus = (sessionId: string): ChatTurnStatusSnapshot | null => {
    const tracked = readTrackedCliRow(sessionId);
    if (!tracked) return null;
    const { row, lineage } = tracked;
    let enriched = row;
    try {
      enriched = options.enrichSessions?.([row])[0] ?? row;
    } catch {
      enriched = row;
    }
    const live = enriched.status === "running";
    const waiting = live && enriched.runtimeState === "waiting-input";
    const busy = live && enriched.runtimeState === "running";
    return {
      ...deriveTurnStatus({
        sessionId: row.id,
        provider: lineage?.provider ?? row.resumeMetadata?.provider ?? row.toolType ?? undefined,
        sessionStatus: busy ? "active" : live ? "idle" : "ended",
        currentTurnStartedAt: busy ? enriched.currentTurnStartedAt ?? null : null,
        lastActivityAt: enriched.lastActivityAt ?? row.endedAt ?? row.startedAt,
        awaitingInput: waiting,
        pendingTitle: waiting ? "waiting for input in the terminal" : null,
        subagents: [],
      }),
      cliSession: cliSessionStatusFields(enriched, lineage),
    };
  };

  const readCliTranscript = async (sessionId: string): Promise<{
    sessionId: string;
    entries: AgentChatTranscriptEntry[];
    truncated: boolean;
    totalEntries: number;
    cliSession: CliSessionFacts;
  } | null> => {
    const tracked = readTrackedCliRow(sessionId);
    if (!tracked) return null;
    const { row, lineage } = tracked;
    const provider = lineage?.provider ?? row.resumeMetadata?.provider ?? "";
    let providerMessage: string | null = null;
    try {
      if (provider) providerMessage = await options.readProviderMessage(row, provider);
    } catch {
      providerMessage = null;
    }
    const terminalTail = await options.readTerminalTail(row.id);
    const sections = [
      providerMessage ? `Last CLI message:\n${providerMessage}` : null,
      terminalTail ? `Terminal (last lines):\n${terminalTail}` : null,
      `This is a CLI terminal session, not a chat. Full output: ${cliReadHint(row.id)}`,
    ].filter((section): section is string => Boolean(section));
    return {
      sessionId: row.id,
      entries: [{ role: "assistant", text: sections.join("\n\n"), timestamp: row.endedAt ?? row.lastActivityAt ?? row.startedAt }],
      truncated: true,
      totalEntries: 1,
      cliSession: cliSessionStatusFields(row, lineage),
    };
  };

  const listCliChildSessions = (args?: { laneId?: string | null; parentSessionId?: string | null }): AgentChatCliChildSessionSummary[] => {
    const laneId = typeof args?.laneId === "string" && args.laneId.trim() ? args.laneId.trim() : undefined;
    const parentFilter = typeof args?.parentSessionId === "string" && args.parentSessionId.trim()
      ? args.parentSessionId.trim()
      : null;
    const rows = options.listSessions({ ...(laneId ? { laneId } : {}), limit: 500, toolTypes: [...TRACKED_AGENT_CLI_TOOL_TYPES] });
    let enriched = rows;
    try {
      enriched = options.enrichSessions?.(rows) ?? rows;
    } catch {
      enriched = rows;
    }
    return enriched.flatMap((row) => {
      const lineage = cliChildLineageFromRow(row);
      if (!lineage || (parentFilter && lineage.parentSessionId !== parentFilter)) return [];
      return [{
        sessionId: row.id,
        kind: "cli" as const,
        provider: lineage.provider,
        laneId: row.laneId,
        title: row.title ?? null,
        status: row.status,
        runtimeState: row.runtimeState ?? null,
        exitCode: row.exitCode ?? null,
        startedAt: row.startedAt,
        endedAt: row.endedAt ?? null,
        parentSessionId: lineage.parentSessionId,
        spawnKind: lineage.spawnKind,
        readHint: cliReadHint(row.id),
      }];
    });
  };

  return { readTrackedCliRow, cliReadHint, getCliTurnStatus, readCliTranscript, listCliChildSessions };
}

/**
 * A tracked agent CLI (`ade new chat --mode cli --parent … --type …`) spawned
 * by a chat. It is a PTY session, not a chat session, so none of the chat
 * lifecycle reaches its parent on its own: this module holds the pure half of
 * the bridge that does — who the parent is, what the child's end means, and
 * what report the parent gets. `agentChatService` owns the emission.
 */

export type CliChildLineage = {
  parentSessionId: string;
  spawnKind: AgentChatSpawnKind;
  /** Provider id (`codex`, `claude`, `cursor`, …), which is what the card's logo keys on. */
  provider: string;
  model: string | null;
};

export type CliChildRow = Pick<
  TerminalSessionSummary,
  "id" | "toolType" | "resumeMetadata" | "orchestrationParentSessionId" | "spawnKind"
>;

/**
 * The parent a tracked CLI session reports to, or null for any session that is
 * not a parented agent CLI (a chat, a plain shell, an unparented CLI, or a
 * legacy row whose spawn type is neither subagent nor peer).
 */
export function cliChildLineageFromRow(row: CliChildRow | null | undefined): CliChildLineage | null {
  if (!row || !isTrackedAgentCliToolType(row.toolType ?? null)) return null;
  const parentSessionId = (
    row.orchestrationParentSessionId
    ?? row.resumeMetadata?.orchestrationParentSessionId
    ?? ""
  ).trim();
  if (!parentSessionId || parentSessionId === row.id) return null;
  const spawnKind = row.spawnKind ?? row.resumeMetadata?.spawnKind ?? null;
  if (spawnKind !== "subagent" && spawnKind !== "peer") return null;
  const toolType = row.toolType ?? "";
  const provider = row.resumeMetadata?.provider?.trim()
    || providerFromTool(row.toolType ?? null)
    || toolType;
  const model = row.resumeMetadata?.launch?.model?.trim() || null;
  return { parentSessionId, spawnKind, provider, model };
}

export type CliChildResultStatus = "completed" | "failed" | "stopped";

/**
 * What a tracked CLI session's end means to its parent. `null` while it is
 * still running. A clean exit (0, or an unknown code on a `completed` row) is
 * finished; a non-zero exit is failed; a closed (`disposed`) or orphaned
 * (`detached`) terminal was cut short, so it is stopped.
 */
export function cliChildResultStatus(
  row: { status: TerminalSessionStatus; exitCode?: number | null },
): CliChildResultStatus | null {
  switch (row.status) {
    case "running":
      return null;
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "disposed":
    case "detached":
      return "stopped";
    default: {
      const exhaustive: never = row.status;
      return exhaustive;
    }
  }
}

/**
 * The durable identity of one run of a CLI child, used as the completion's
 * `childTurnId`. Keyed on the persisted end time, so a live exit and a
 * post-restart reconcile of the same exit resolve to the same key (and the
 * parent-side dedupe holds), while a resumed run that ends again is new.
 */
export function cliChildRunKey(row: { endedAt?: string | null; startedAt?: string | null }): string {
  const endedAt = row.endedAt?.trim();
  if (endedAt) return `cli-exit:${endedAt}`;
  return `cli-exit:started:${row.startedAt?.trim() || "unknown"}`;
}

const REPORT_MAX_CHARS = 1_200;
const TAIL_MAX_LINES = 12;

function clipReport(text: string, max = REPORT_MAX_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 3).trimEnd()}...`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textBlocks(content: unknown, types: readonly string[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      if (!record || typeof record.type !== "string" || !types.includes(record.type)) return "";
      return typeof record.text === "string" ? record.text : "";
    })
    .filter((text) => text.trim().length > 0)
    .join("\n");
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

/**
 * The closing assistant message in a Codex rollout, newest first:
 * `task_complete.last_agent_message`, an `agent_message` event, or an assistant
 * `message` response item.
 */
export function extractCodexFinalMessage(lines: readonly string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const record = parseJsonLine(lines[index] ?? "");
    const payload = asRecord(record?.payload);
    if (!payload) continue;
    const type = typeof payload.type === "string" ? payload.type : "";
    let text = "";
    if (type === "task_complete" && typeof payload.last_agent_message === "string") {
      text = payload.last_agent_message;
    } else if (type === "agent_message" && typeof payload.message === "string") {
      text = payload.message;
    } else if (type === "message" && payload.role === "assistant") {
      text = textBlocks(payload.content, ["output_text", "text"]);
    }
    if (text.trim()) return clipReport(text);
  }
  return null;
}

/** The newest assistant text block in a Claude Code session JSONL. */
export function extractClaudeFinalMessage(lines: readonly string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const record = parseJsonLine(lines[index] ?? "");
    if (!record || record.type !== "assistant") continue;
    const message = asRecord(record.message);
    const text = textBlocks(message?.content, ["text"]);
    if (text.trim()) return clipReport(text);
  }
  return null;
}

const PROVIDER_FILE_TAIL_BYTES = 256 * 1024;

async function readProviderFileTail(filePath: string, maxBytes: number): Promise<string[]> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(Math.max(0, stat.size), Math.max(1, Math.floor(maxBytes)));
    if (length === 0) return [];
    const offset = Math.max(0, stat.size - length);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u);
    if (offset > 0) lines.shift();
    return lines.filter((line) => line.trim().length > 0);
  } finally {
    await handle.close().catch(() => {});
  }
}

export type CliChildSessionReaderOptions = {
  findCodexRolloutPath?: (targetId: string) => Promise<string | null>;
};

/** Async provider-file reader with a per-target rollout path cache. */
export function createCliChildSessionReader(options: CliChildSessionReaderOptions = {}) {
  const findCodexRolloutPath = options.findCodexRolloutPath ?? findCodexRolloutPathBySessionIdAsync;
  const rolloutPathCache = new Map<string, string>();
  const rolloutPathLookup = new Map<string, Promise<string | null>>();

  const resolveCodexRolloutPath = async (targetId: string): Promise<string | null> => {
    const cached = rolloutPathCache.get(targetId);
    if (cached) {
      try {
        const stat = await fs.promises.stat(cached);
        if (stat.isFile()) return cached;
      } catch {
        rolloutPathCache.delete(targetId);
      }
    }
    const existingLookup = rolloutPathLookup.get(targetId);
    if (existingLookup) return existingLookup;
    const lookup = findCodexRolloutPath(targetId)
      .then((filePath) => {
        if (filePath) rolloutPathCache.set(targetId, filePath);
        return filePath;
      })
      .finally(() => rolloutPathLookup.delete(targetId));
    rolloutPathLookup.set(targetId, lookup);
    return lookup;
  };

  const readProviderFinalMessage = async (args: {
    provider: string;
    targetId: string | null | undefined;
    cwd: string | null | undefined;
  }): Promise<string | null> => {
    const targetId = args.targetId?.trim();
    if (!targetId) return null;
    try {
      if (args.provider === "codex") {
        const rolloutPath = await resolveCodexRolloutPath(targetId);
        if (!rolloutPath || rolloutPath.endsWith(".zst")) return null;
        return extractCodexFinalMessage(await readProviderFileTail(rolloutPath, PROVIDER_FILE_TAIL_BYTES));
      }
      if (args.provider === "claude") {
        const cwd = args.cwd?.trim();
        if (!cwd) return null;
        const sessionPath = claudeSessionPath({ sessionId: targetId, cwd });
        return extractClaudeFinalMessage(await readProviderFileTail(sessionPath, PROVIDER_FILE_TAIL_BYTES));
      }
    } catch {
      return null;
    }
    return null;
  };

  return { readProviderFinalMessage };
}

const defaultCliChildSessionReader = createCliChildSessionReader();

/**
 * Best-effort read of the CLI's own last assistant message from the provider's
 * session file (Codex rollout, Claude Code JSONL). Only providers whose file
 * ADE can locate from the captured resume target are read; everything else —
 * and any read failure — returns null and the report falls back to the
 * terminal's last lines. Paths come from the shared resolvers, which handle
 * `CODEX_HOME` / `CLAUDE_CONFIG_DIR` and Windows drive-qualified cwds.
 */
export function readCliProviderFinalMessage(args: {
  provider: string;
  targetId: string | null | undefined;
  cwd: string | null | undefined;
}): Promise<string | null> {
  return defaultCliChildSessionReader.readProviderFinalMessage(args);
}

/** Exit banners agent CLIs print after the work is over (usage totals, resume hints). */
const CLI_EXIT_CHROME: readonly RegExp[] = [
  /^To continue this session, run\b/i,
  /^Token usage:/i,
];

/**
 * The last lines a person would read on the terminal: ANSI stripped, TUI
 * chrome (box drawing, shortcut hints, resume hints) dropped, repeated redraws
 * collapsed. Null when nothing meaningful is left.
 */
export function lastMeaningfulTerminalLines(text: string | null | undefined, maxLines = TAIL_MAX_LINES): string | null {
  if (!text) return null;
  const stripped = stripAnsiWithOptions(text, { preserveCarriageReturns: true });
  const lines: string[] = [];
  for (const raw of stripped.split(/\r\n|\n|\r/)) {
    const line = raw.replace(/\s+$/u, "");
    if (!line.trim() || isTerminalChromeLine(line) || CLI_EXIT_CHROME.some((re) => re.test(line.trim()))) continue;
    if (lines[lines.length - 1]?.trim() === line.trim()) continue;
    lines.push(line);
  }
  if (!lines.length) return null;
  return clipReport(lines.slice(-maxLines).join("\n"));
}

/**
 * The parent's report for one finished CLI run. Prefers the CLI's own closing
 * message, then its last terminal lines, and only when both are empty states
 * the plain fact of the exit — never a generic "finished" placeholder.
 */
export function composeCliChildReport(args: {
  status: CliChildResultStatus;
  exitCode: number | null | undefined;
  providerMessage?: string | null;
  terminalTail?: string | null;
}): string {
  const body = args.providerMessage?.trim() || args.terminalTail?.trim() || "";
  const exit = typeof args.exitCode === "number" ? `exit code ${args.exitCode}` : null;
  if (args.status === "completed") {
    return body ? clipReport(body) : `The CLI exited${exit ? ` with ${exit}` : ""} without printing any output.`;
  }
  const lead = args.status === "failed"
    ? `CLI failed${exit ? ` (${exit})` : ""}.`
    : "CLI session was closed before it exited on its own.";
  return clipReport(body ? `${lead}\n${body}` : lead);
}
