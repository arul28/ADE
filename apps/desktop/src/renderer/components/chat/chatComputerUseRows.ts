/**
 * Which work-log entries are computer-use actions, and how their runs sit in
 * the drawn timeline. The non-React half of `ChatComputerUseActions.tsx`, kept
 * apart so the transcript row and fold modules can use it without importing
 * the row components (and without an import cycle through
 * `chatTranscriptRows.ts`, which this file only takes types from).
 */
import {
  computerUseCommandText,
  summarizeComputerUseCommand,
  type ComputerUseActionSummary,
  type ComputerUseCommandInput,
} from "../../../shared/computerUseActionSummary";
import {
  computerUseOutcomeNote,
  computerUseShownProofIds,
  layoutComputerUseRun,
} from "../../../shared/computerUseActionPresentation";
import { readRecord } from "../../../shared/readRecord";
import { isShellToolName } from "./toolPresentation";
import type { ChatWorkLogEntry, ChatWorkLogGroupEvent } from "./chatTranscriptRows";

/* ── Reading a work-log entry ─────────────────────────────────────────────── */

/**
 * A tool result as the text a terminal would have shown. The iOS app mirrors
 * this in `WorkComputerUseActions.swift` (`workComputerUseTextOfContent`).
 */
function textOfContent(value: unknown, depth = 0): string {
  if (depth > 3 || value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => textOfContent(part, depth + 1)).filter(Boolean).join("\n");
  const record = readRecord(value);
  if (!record) return "";
  const parts: string[] = [];
  for (const key of ["stdout", "stderr", "output", "text", "content", "aggregated_output", "formatted_output"]) {
    const text = textOfContent(record[key], depth + 1);
    if (text) parts.push(text);
  }
  if (!parts.length) {
    const error = typeof record.error === "string" ? record.error : readRecord(record.error)?.message;
    if (typeof error === "string") parts.push(`ade: ${error}`);
  }
  return parts.join("\n");
}

function readExitCode(result: unknown): number | null {
  const record = readRecord(result);
  for (const key of ["exitCode", "exit_code", "returncode"]) {
    const value = record?.[key];
    if (typeof value === "number") return value;
  }
  return null;
}

/**
 * The parse inputs of one work-log entry: the command it ran, its output (a
 * tool's result text when it has one), its status, and its exit code.
 */
function computerUseInputForEntry(entry: ChatWorkLogEntry): ComputerUseCommandInput | null {
  if (entry.entryKind === "command") {
    return { command: entry.command ?? null, output: entry.output ?? null, status: entry.status };
  }
  if (entry.entryKind !== "tool" || !entry.toolName || entry.mcp || !isShellToolName(entry.toolName)) return null;
  const args = readRecord(entry.args) ?? {};
  const command = typeof args.command === "string" || Array.isArray(args.command)
    ? args.command as string | string[]
    : typeof args.cmd === "string" || Array.isArray(args.cmd)
      ? args.cmd as string | string[]
      : null;
  if (!command) return null;
  const hasResult = entry.result !== undefined;
  return {
    command,
    output: hasResult ? textOfContent(entry.result) : entry.output ?? null,
    status: entry.status === "running" && hasResult ? "completed" : entry.status,
    exitCode: readExitCode(entry.result),
  };
}

type EntryParse = {
  command: ChatWorkLogEntry["command"];
  args: unknown;
  output: unknown;
  result: unknown;
  status: ChatWorkLogEntry["status"];
  summary: ComputerUseActionSummary | null;
  /** The command it ran, as one line of shell. */
  commandText: string | null;
};

const parseByEntry = new WeakMap<ChatWorkLogEntry, EntryParse>();

/**
 * Cached per entry object. The live transcript never edits an entry in place:
 * each streamed event (a Claude `tool_call` arrives first with empty args, then
 * with the command, then its result) makes a new entry object through
 * `mergeWorkLogEntries`, so a changed entry misses this cache and an unchanged
 * one keeps its parse — the same identity rule `arrangeComputerUseRuns` uses
 * to reuse a run's envelope. The field check below only guards against a
 * caller that mutates an entry anyway (the parser keeps its own content-keyed
 * cache too).
 */
function parseEntry(entry: ChatWorkLogEntry): EntryParse {
  const cached = parseByEntry.get(entry);
  if (
    cached
    && cached.command === entry.command
    && cached.args === entry.args
    && cached.output === entry.output
    && cached.result === entry.result
    && cached.status === entry.status
  ) return cached;
  const input = computerUseInputForEntry(entry);
  const summary = input ? summarizeComputerUseCommand(input) : null;
  const parse: EntryParse = {
    command: entry.command,
    args: entry.args,
    output: entry.output,
    result: entry.result,
    status: entry.status,
    summary,
    commandText: summary && input ? computerUseCommandText(input.command) : null,
  };
  parseByEntry.set(entry, parse);
  return parse;
}

/**
 * The computer-use summary of one work-log entry, or null for anything that
 * is not an ADE computer-use shell command.
 */
export function computerUseSummaryForEntry(entry: ChatWorkLogEntry): ComputerUseActionSummary | null {
  return parseEntry(entry).summary;
}

/** The shell command a computer-use entry ran, as one line; null for any other entry. */
export function computerUseEntryCommand(entry: ChatWorkLogEntry): string | null {
  return parseEntry(entry).commandText;
}

export function hasComputerUseEntries(entries: readonly ChatWorkLogEntry[]): boolean {
  return entries.some((entry) => computerUseSummaryForEntry(entry) !== null);
}

/** Pairs every computer-use entry of a group with its summary, in order. */
export function collectComputerUseActions(
  entries: readonly ChatWorkLogEntry[],
): Array<{ action: ChatWorkLogEntry; summary: ComputerUseActionSummary }> {
  const actions: Array<{ action: ChatWorkLogEntry; summary: ComputerUseActionSummary }> = [];
  for (const entry of entries) {
    const summary = computerUseSummaryForEntry(entry);
    if (summary) actions.push({ action: entry, summary });
  }
  return actions;
}

/** Height of the proof picture under a filed-proof line, in px. */
export const PROOF_THUMBNAIL_HEIGHT = 64;

/**
 * Height estimate for the virtualizer: compact lines, plus the full row, plus
 * the proof pictures under filed-proof lines.
 */
export function estimateComputerUseRunHeight(entries: readonly ChatWorkLogEntry[], compactAll = false): number {
  const { earlier, latest } = layoutComputerUseRun(collectComputerUseActions(entries));
  if (!latest) return 0;
  const pictures = [...earlier, latest].filter((line) => computerUseShownProofIds(line.summary).length > 0).length
    * (PROOF_THUMBNAIL_HEIGHT + 10);
  if (compactAll) return (earlier.length + 1) * 22 + pictures;
  const note = computerUseOutcomeNote(latest.summary) ? 18 : 0;
  return earlier.length * 22 + 46 + note + pictures;
}

/* ── Runs in the drawn timeline ───────────────────────────────────────────── */

type ArrangeableRow = { key: string; timestamp: string; event: { type: string } };
type GroupRow<Row> = Row & { event: ChatWorkLogGroupEvent };

function isComputerUseGroup<Row extends ArrangeableRow>(row: Row): row is GroupRow<Row> {
  return row.event.type === "work_log_group" && hasComputerUseEntries((row.event as ChatWorkLogGroupEvent).entries);
}

function groupTurnId(event: ChatWorkLogGroupEvent): string | null {
  return event.turnId ?? event.entries[0]?.turnId ?? null;
}

function sameEntries(a: readonly ChatWorkLogEntry[], b: readonly ChatWorkLogEntry[]): boolean {
  return a === b || (a.length === b.length && a.every((entry, index) => entry === b[index]));
}

function sameStrings(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/**
 * The last call's envelope still says everything the current group says: the
 * same row timestamp, turn, summary, tool-use ids, compact flag, and the very
 * same entry objects.
 */
function sameEnvelope<Row extends ArrangeableRow>(
  reused: GroupRow<Row>,
  group: GroupRow<Row>,
  compact: boolean,
  entries: readonly ChatWorkLogEntry[],
): boolean {
  return reused.timestamp === group.timestamp
    && reused.event.turnId === group.event.turnId
    && reused.event.summary === group.event.summary
    && sameStrings(reused.event.toolUseIds, group.event.toolUseIds)
    && Boolean(reused.event.computerUseCompact) === compact
    && sameEntries(reused.event.entries, entries);
}

/**
 * The drawn timeline's computer-use runs, arranged so only the newest action
 * of a turn is drawn in full:
 *
 * - Computer-use groups of one turn that end up next to each other (the
 *   narration between them folded away) join one run, keyed by the first, so
 *   the app carries forward and repeats merge across them.
 * - Every run but the turn's last is marked `computerUseCompact`.
 *
 * Every run keeps the envelope it had last time while its timestamp, turn,
 * summary, tool-use ids, compact flag and entries are unchanged: `previous` is the `built` map of the last call. A
 * streamed delta rebuilds the turn's group envelopes upstream, and without
 * this each would re-render its whole run.
 */
export function arrangeComputerUseRuns<Row extends ArrangeableRow>(
  rows: Row[],
  previous: ReadonlyMap<string, Row>,
): { rows: Row[]; built: Map<string, Row> } {
  const built = new Map<string, Row>();
  // Join adjacent runs of one turn.
  const joined: Array<{ row: Row; group: GroupRow<Row> | null; entries: ChatWorkLogEntry[] | null }> = [];
  let anyGroup = false;
  for (const row of rows) {
    const group = isComputerUseGroup(row) ? row : null;
    if (group) anyGroup = true;
    const last = joined[joined.length - 1];
    if (
      group
      && last?.group
      && groupTurnId(group.event) != null
      && groupTurnId(group.event) === groupTurnId(last.group.event)
    ) {
      last.entries = [...(last.entries ?? last.group.event.entries), ...group.event.entries];
      continue;
    }
    joined.push({ row, group, entries: null });
  }
  if (!anyGroup) return { rows, built };
  // The last run of each turn stays full.
  const lastRunIndexByTurn = new Map<string, number>();
  joined.forEach(({ group }, index) => {
    if (group) lastRunIndexByTurn.set(groupTurnId(group.event) ?? `row:${group.key}`, index);
  });
  const out = joined.map(({ row, group, entries }, index) => {
    if (!group) return row;
    const compact = lastRunIndexByTurn.get(groupTurnId(group.event) ?? `row:${group.key}`) !== index;
    const nextEntries = entries ?? group.event.entries;
    const reused = previous.get(group.key) as GroupRow<Row> | undefined;
    let next: Row;
    if (reused && sameEnvelope(reused, group, compact, nextEntries)) {
      next = reused;
    } else if (!entries && Boolean(group.event.computerUseCompact) === compact) {
      next = group;
    } else {
      next = { ...group, event: { ...group.event, entries: nextEntries, computerUseCompact: compact } } as Row;
    }
    built.set(group.key, next);
    return next;
  });
  return { rows: out, built };
}
