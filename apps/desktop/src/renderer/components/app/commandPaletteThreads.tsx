/**
 * Thread (session) results for the command palette.
 *
 * The palette is now the Work sidebar's search — the sidebar's inline input was
 * replaced by a button that opens this dialog — so the palette has to answer
 * "which chat was I in?" as well as it answers "which command do I want?".
 * This module owns the searchable index over `TerminalSessionSummary`, the
 * ranking, and the row. `CommandPalette.tsx` keeps the flat keyboard index and
 * the navigation.
 *
 * Status presentation deliberately goes through `sessionStatusDisplay` +
 * `SESSION_TONE_*_CLASS` rather than a local color map: see
 * `shared/sessionStatusPresentation.ts` for why exactly one hue table exists.
 */
import React, { useMemo } from "react";
import { ChatCircle, Terminal } from "@phosphor-icons/react";
import type {
  LaneSummary,
  OpenProjectBinding,
  TerminalSessionSummary,
} from "../../../shared/types";
import type { CrossMachineMachineLanes } from "../../state/appStore";
import type { CrossMachineLaneMarker } from "../../state/crossMachineLanes";
import { THIS_MACHINE_ID, THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { LaneMachineMarker } from "../terminals/LaneMachineMarker";
import {
  SESSION_TONE_DOT_CLASS,
  SESSION_TONE_TEXT_CLASS,
  type SessionStatusPresentation,
} from "../../../shared/sessionStatusPresentation";
import { relativeTimeCompact } from "../../lib/format";
import { isChatToolType } from "../../lib/sessions";
import {
  isSessionSnoozed,
  sessionWokeMarker,
  snoozeWakeLabel,
} from "../../lib/sessionSnooze";
import {
  canonicalInputFromSummary,
  sessionStatusDisplay,
} from "../../lib/terminalAttention";
import { cn } from "../ui/cn";
import { highlightTitle } from "./commandPaletteSearch";

/**
 * Rows rendered in the Recent threads group. The palette can be opened against
 * a project with hundreds of sessions loaded; rendering all of them would push
 * every command off-screen and make the flat keyboard index unusable. The cap
 * is surfaced to the user by `ThreadOverflowNote` rather than silently applied.
 */
export const THREAD_RESULT_LIMIT = 8;

export type ThreadIndexEntry = {
  session: TerminalSessionSummary;
  /** Lane/worktree label — the "project · branch" line's first half. */
  laneName: string;
  /** Lane branch ref, when the lane is known. Shown with a leading `#`. */
  branch: string | null;
  /**
   * Cross-machine identity. Every thread is attributed to its owner; this Mac
   * stays unmarked while foreign rows are marked and (when unreachable)
   * receded rather than hidden.
   */
  machineId: string;
  machineName: string;
  machineOnline: boolean;
  /** Routing target for a foreign thread — the machine's project binding. */
  binding: OpenProjectBinding | null;
  /** Pre-lowercased haystacks, built once per session list (not per keystroke). */
  titleLower: string;
  laneNameLower: string;
  branchLower: string;
  machineNameLower: string;
  /** Recency rank (ms). Ties in relevance fall back to "most recently touched". */
  recencyMs: number;
};

function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Most-recent-activity rank. `lastActivityAt` is the honest "when did something
 * happen here" column; `startedAt` only says when the row was created, which
 * would bury a long-lived chat you were just talking in under a terminal you
 * opened and abandoned.
 */
function recencyRank(session: TerminalSessionSummary): number {
  return Math.max(
    timestampMs(session.lastActivityAt),
    timestampMs(session.settledAt),
    timestampMs(session.startedAt),
  );
}

function makeEntry(args: {
  session: TerminalSessionSummary;
  lane: LaneSummary | null;
  machineId: string;
  machineName: string;
  machineOnline: boolean;
  binding: OpenProjectBinding | null;
}): ThreadIndexEntry {
  const laneName = args.lane?.name ?? args.session.laneName ?? "";
  const branch = args.lane?.branchRef?.trim() || null;
  return {
    session: args.session,
    laneName,
    branch,
    machineId: args.machineId,
    machineName: args.machineName,
    machineOnline: args.machineOnline,
    binding: args.binding,
    titleLower: (args.session.title ?? "").toLowerCase(),
    laneNameLower: laneName.toLowerCase(),
    branchLower: (branch ?? "").toLowerCase(),
    machineNameLower: args.machineName.toLowerCase(),
    recencyMs: recencyRank(args.session),
  };
}

/**
 * Build the searchable thread index. Memoize this against the session/lane
 * arrays — it lowercases every field, which is exactly the work we must not
 * redo on each keystroke.
 *
 * The index is a UNION across every connected machine, matching the Work
 * sidebar. That is not a nicety: the sidebar shows foreign work unconditionally,
 * so a palette that searched only the bound machine would answer "no results"
 * for a thread the user can see one pane over — a worse failure than having no
 * thread search at all. Local rows win ties by session id, so the currently
 * bound machine's sessions are never listed twice.
 */
export function buildThreadIndex(
  sessions: readonly TerminalSessionSummary[],
  lanes: readonly LaneSummary[],
  foreignMachines: Readonly<Record<string, CrossMachineMachineLanes>> = {},
  /**
   * The machine that owns `sessions` and `lanes` — the tab's binding, which is
   * NOT necessarily this Mac. Omit for a locally-bound tab.
   *
   * These entries used to be hardcoded to a null machine on the assumption that
   * the bound machine is the one you're sitting at. Bind the tab to another Mac
   * and every thread on it went unattributed: no marker on the row, and — since
   * the scorer matches on `machineNameLower` — no way to find it by typing that
   * machine's name either.
   */
  activeMachine: { machineId: string; machineName: string } | null = null,
): ThreadIndexEntry[] {
  const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
  const activeMachineOnline = activeMachine
    ? (foreignMachines[activeMachine.machineId]?.online ?? true)
    : true;
  const seen = new Set<string>();
  const entries: ThreadIndexEntry[] = [];

  for (const session of sessions) {
    seen.add(session.id);
    entries.push(
      makeEntry({
        session,
        lane: laneById.get(session.laneId) ?? null,
        machineId: activeMachine?.machineId ?? THIS_MACHINE_ID,
        machineName: activeMachine?.machineName ?? THIS_MACHINE_NAME,
        machineOnline: activeMachineOnline,
        binding: null,
      }),
    );
  }

  for (const machine of Object.values(foreignMachines)) {
    const foreignLaneById = new Map(
      (machine.lanes ?? []).map((lane) => [lane.id, lane] as const),
    );
    for (const session of machine.sessions ?? []) {
      // Id dedupe rather than a binding comparison: when the tab is bound to a
      // remote, that machine's slice and the local list are the same sessions,
      // and "never show one session twice" is the invariant we actually want.
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      entries.push(
        makeEntry({
          session,
          lane: foreignLaneById.get(session.laneId) ?? null,
          machineId: machine.machineId,
          machineName: machine.machineName,
          machineOnline: machine.online,
          binding: machine.binding ?? null,
        }),
      );
    }
  }

  entries.sort((left, right) => right.recencyMs - left.recencyMs);
  return entries;
}

/**
 * Per-term score for one entry. Returns 0 when the term matches nothing, which
 * makes the caller's AND semantics fall out naturally: every typed word has to
 * land somewhere on the row.
 *
 * The tiers encode where a hit is most likely to be what you meant: the title
 * you read in the sidebar beats the lane you filed it under, which beats the
 * branch you probably don't remember verbatim. A prefix hit outranks a mid-word
 * hit within each field so typing "red" surfaces "Redesign…" above
 * "…considered".
 */
function scoreTerm(entry: ThreadIndexEntry, term: string): number {
  const titleIdx = entry.titleLower.indexOf(term);
  if (titleIdx === 0) return 100;
  if (titleIdx > 0) {
    // Word-boundary hits read as deliberate; mid-word hits are usually noise.
    const preceding = entry.titleLower[titleIdx - 1] ?? "";
    return /[\s\-_/.]/.test(preceding) ? 80 : 60;
  }
  const laneIdx = entry.laneNameLower.indexOf(term);
  if (laneIdx === 0) return 50;
  if (laneIdx > 0) return 40;
  const branchIdx = entry.branchLower.indexOf(term);
  if (branchIdx === 0) return 30;
  if (branchIdx > 0) return 25;
  // Machine name ranks last: "Mac Studio" narrows a set, it rarely identifies
  // the one thread you want, so it must never outrank a title hit.
  const machineIdx = entry.machineNameLower.indexOf(term);
  if (machineIdx === 0) return 20;
  if (machineIdx > 0) return 15;
  return 0;
}

export type ThreadMatch = {
  entry: ThreadIndexEntry;
  score: number;
};

/**
 * Rank the index against a query. An empty query returns the index as-is (it is
 * already recency-sorted), which is what "Recent threads" means with nothing
 * typed. Callers slice to `THREAD_RESULT_LIMIT`; the full length is kept so the
 * "showing N of M" affordance can tell the truth.
 */
export function rankThreads(
  index: readonly ThreadIndexEntry[],
  query: string,
): ThreadMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return index.map((entry) => ({ entry, score: 0 }));
  const terms = needle.split(/\s+/).filter(Boolean);
  const matches: ThreadMatch[] = [];
  for (const entry of index) {
    let total = 0;
    let matchedEveryTerm = true;
    for (const term of terms) {
      const score = scoreTerm(entry, term);
      if (score === 0) {
        matchedEveryTerm = false;
        break;
      }
      total += score;
    }
    if (matchedEveryTerm) matches.push({ entry, score: total });
  }
  // Stable-by-recency: the index is already recency-ordered, and Array#sort is
  // stable in every engine we ship on, so equal scores keep that order.
  matches.sort((left, right) => right.score - left.score);
  return matches;
}

/** Hook wrapper so the index is rebuilt only when the session/lane lists change. */
export function useThreadIndex(
  sessions: readonly TerminalSessionSummary[],
  lanes: readonly LaneSummary[],
  foreignMachines: Readonly<Record<string, CrossMachineMachineLanes>>,
  activeMachine: { machineId: string; machineName: string } | null = null,
): ThreadIndexEntry[] {
  return useMemo(
    () => buildThreadIndex(sessions, lanes, foreignMachines, activeMachine),
    [sessions, lanes, foreignMachines, activeMachine],
  );
}

/**
 * Resolve the row's status label, applying the snooze/woke visibility overlays
 * the same way the sidebar does. Returns null for calm rows — those render no
 * status at all, so a settled thread's slot stays free for its timestamp.
 */
export function threadStatusPresentation(
  session: TerminalSessionSummary,
  nowMs: number = Date.now(),
): SessionStatusPresentation | null {
  const snoozed = isSessionSnoozed(session, nowMs);
  const woke = !snoozed && sessionWokeMarker(session, nowMs) != null;
  return sessionStatusDisplay(canonicalInputFromSummary(session), {
    snoozed,
    woke,
    snoozeWakeLabel: snoozed ? snoozeWakeLabel(session.snoozedUntil, nowMs) : null,
  });
}

function ThreadGlyph({ session }: { session: TerminalSessionSummary }) {
  const className = "shrink-0 text-[var(--color-muted-fg)]";
  return isChatToolType(session.toolType) ? (
    <ChatCircle size={15} weight="regular" className={className} />
  ) : (
    <Terminal size={15} weight="regular" className={className} />
  );
}

export const ThreadResultRow = React.memo(function ThreadResultRow({
  entry,
  query,
  index,
  isSelected,
  isCurrent,
  projectName,
  onHover,
  onActivate,
}: {
  entry: ThreadIndexEntry;
  query: string;
  index: number;
  isSelected: boolean;
  /** The session currently open in the Work tab — annotated, never hidden. */
  isCurrent: boolean;
  projectName: string | null;
  onHover: (index: number) => void;
  /** Takes the whole entry — foreign rows need the machine binding to route. */
  onActivate: (entry: ThreadIndexEntry) => void;
}) {
  const { session } = entry;
  const status = threadStatusPresentation(session);
  const time = relativeTimeCompact(
    session.lastActivityAt ?? session.settledAt ?? session.startedAt,
  );
  // Rows that are not on this Mac carry the same marker the sidebar puts on a
  // foreign lane. Its amber tower is IDENTITY, not status — it lives in the
  // context line and never in the status slot above, so it cannot be read as an
  // attention call.
  //
  // `mode: "name"` is a deliberate exception to the sidebar's glyph-only rule:
  // there, a badge is read against neighbouring rows under a lane header that
  // groups them. A palette result has neither, so a bare glyph would raise the
  // question it exists to answer.
  //
  // Gated on the MACHINE, not on whether the entry knows its name: every entry
  // knows that now, including the ones on this Mac, which must stay unmarked.
  const machineMarker: CrossMachineLaneMarker | null =
    entry.machineId !== THIS_MACHINE_ID
      ? {
          machineId: entry.machineId,
          machineName: entry.machineName,
          online: entry.machineOnline,
          mode: "name",
          title: entry.machineName,
          sameBranchElsewhere: false,
        }
      : null;
  // An unreachable machine's rows stay findable but recede, matching the
  // sidebar's `dimmed` group treatment. Its status is the LAST THING REPORTED,
  // not a live claim — a dropped machine's chat can still read "Working" hours
  // after the machine went away, so the row must not look equally trustworthy.
  const offline = machineMarker != null && !entry.machineOnline;
  // Secondary line: where the thread lives. Project first (it is the coarser
  // scope and the one the user names out loud), then branch, then the
  // current-thread marker.
  const rowProjectName = entry.binding?.displayName ?? projectName;
  const contextParts: string[] = [];
  if (rowProjectName) contextParts.push(rowProjectName);
  else if (entry.laneName) contextParts.push(entry.laneName);
  if (entry.branch) contextParts.push(`#${entry.branch}`);
  else if (rowProjectName && entry.laneName) contextParts.push(entry.laneName);

  return (
    <li>
      <button
        type="button"
        data-cmd-item
        data-thread-id={session.id}
        className={cn(
          // Same geometry and selection treatment as the command rows so a
          // selected thread and a selected command are visually identical.
          "mx-2 flex w-[calc(100%-1rem)] items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
          isSelected
            ? "border-[var(--color-accent)] bg-[var(--color-accent-muted)]"
            : "border-transparent hover:border-[var(--color-border)] hover:bg-[var(--color-muted)]",
        )}
        onMouseEnter={() => onHover(index)}
        onClick={() => onActivate(entry)}
        data-machine-id={entry.machineId}
        data-machine-online={
          machineMarker ? (entry.machineOnline ? "true" : "false") : undefined
        }
        // Same attribute the sidebar puts on a receded cross-machine group
        // (`SessionListPane`), so "this row is last-reported, not live" is one
        // queryable fact rather than a per-surface opacity class.
        data-dimmed={offline ? "true" : undefined}
      >
        <span
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center",
            offline && "opacity-55",
          )}
        >
          <ThreadGlyph session={session} />
        </span>
        <div className={cn("min-w-0 flex-1", offline && "opacity-55")}>
          <div className="flex min-w-0 items-center gap-1.5">
            {status ? (
              <span
                data-testid={`thread-status-${session.id}`}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 text-[10px]",
                  SESSION_TONE_TEXT_CLASS[status.tone],
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    SESSION_TONE_DOT_CLASS[status.tone],
                  )}
                />
                {status.label}
              </span>
            ) : null}
            {/* `min-w-0` is what actually lets `truncate` win inside a flex
                row — without it the item's automatic min-width keeps a long
                title from shrinking and the row grows a second line. */}
            <span className="min-w-0 truncate text-sm text-[var(--color-fg)]">
              {highlightTitle(session.title || "Untitled thread", query)}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-[var(--color-muted-fg)]">
            {machineMarker ? <LaneMachineMarker marker={machineMarker} /> : null}
            <span className="min-w-0 truncate">
              {contextParts.join(" · ")}
              {isCurrent ? (
                <span className="text-[var(--color-accent)]">
                  {contextParts.length > 0 ? " · " : ""}Current thread
                </span>
              ) : null}
            </span>
          </div>
        </div>
        {time ? (
          <span
            className={cn(
              "shrink-0 text-[10px] tabular-nums text-[var(--color-muted-fg)]",
              offline && "opacity-55",
            )}
          >
            {time}
          </span>
        ) : null}
      </button>
    </li>
  );
});

/**
 * The visible half of the render cap. Non-interactive and outside the flat
 * keyboard index on purpose: it is a statement about the list, not a row you
 * can act on, and making it focusable would put a dead stop in the middle of
 * arrow-key navigation.
 */
export function ThreadOverflowNote({
  shown,
  total,
}: {
  shown: number;
  total: number;
}) {
  if (total <= shown) return null;
  return (
    <li className="mx-2 px-3 py-1.5 text-[11px] text-[var(--color-muted-fg)]">
      Showing {shown} of {total} threads — keep typing to narrow.
    </li>
  );
}
