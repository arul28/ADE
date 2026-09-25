import type {
  AgentChatSessionSummary,
  GitUpstreamSyncStatus,
  LaneSummary,
  PrCheck,
  PrReview,
  PrStatus,
  TerminalSessionSummary,
  TerminalToolType,
} from "../../../../shared/types";
import type { PrPipelineState } from "../../../../shared/types";
import { pipelineStateOf, STATE_RANK } from "../../../../shared/prPipelineState";
import {
  sessionElapsedAnchor,
  type SessionStatusPresentation,
} from "../../../../shared/sessionStatusPresentation";
import { isSessionSnoozed, sessionWokeMarker, snoozeWakeLabel } from "../../../lib/sessionSnooze";
import {
  chatToolTypeForProvider,
  preferredSessionLabel,
  primarySessionLabel,
  sessionActivityInstant,
} from "../../../lib/sessions";
import {
  canonicalInputFromSummary,
  sanitizeTerminalInlineText,
  sessionCanonicalUiState,
  sessionStatusDisplay,
  type SessionCanonicalUiInput,
} from "../../../lib/terminalAttention";
import type { LaneHistoryPr, LaneHistorySession } from "./laneHistoryModel";

/*
  Pure logic behind the Lanes overview column: which chats to list and in what
  order, what a PR's checks, review and merge state say in one line each, and
  the lane's one-line git status. Kept out of the components so it can be
  tested without rendering.
*/

/* ───────────────────────── Chats ───────────────────────── */

/** Chats listed before "Show all". */
export const LANE_CHATS_CAP = 8;

export type LaneChatRow = {
  sessionId: string;
  toolType: TerminalToolType | null;
  title: string;
  preview: string | null;
  /** The Work tab's status word for the row, or null for a settled or ended one. */
  presentation: SessionStatusPresentation | null;
  /** Where the status' live elapsed counts from. */
  elapsedSince: string | null;
  /** When the row last did anything; the sort key inside a rank. */
  activityAt: string;
  /** 0 needs you, 1 working, 2 open and waiting, 3 done. */
  rank: number;
};

function phaseRank(phase: string): number {
  if (phase === "needs_you") return 0;
  if (phase === "running" || phase === "starting" || phase === "stale") return 1;
  if (phase === "ready" || phase === "idle") return 2;
  return 3;
}

/** One line of what the session is doing, in the same order the Work row reads it. */
function previewOf(row: TerminalSessionSummary, title: string): string | null {
  if (row.attentionRequestedAt) {
    const ask = sanitizeTerminalInlineText(row.attentionMessage, 140);
    if (ask) return ask;
  }
  const note = sanitizeTerminalInlineText(row.statusNote, 140);
  if (note) return note;
  const output = sanitizeTerminalInlineText(row.lastOutputPreview, 140);
  if (output && output !== title) return output;
  const summary = preferredSessionLabel(row.summary);
  if (summary && summary !== title) return summary;
  const goal = preferredSessionLabel(row.goal);
  if (goal && goal !== title) return goal;
  return null;
}

/** CLI titles often start with the tool's spinner glyph ("◐ Fix lanes"); drop it. */
function stripLeadingGlyph(title: string): string {
  return title.replace(/^[^\p{L}\p{N}"'#([]+/u, "").trim() || title;
}

function rowFromTerminal(row: TerminalSessionSummary, nowMs: number): LaneChatRow {
  const input = canonicalInputFromSummary(row);
  const state = sessionCanonicalUiState({ ...input, nowMs });
  const snoozed = isSessionSnoozed(row, nowMs);
  const title = stripLeadingGlyph(primarySessionLabel(row));
  return {
    sessionId: row.id,
    toolType: row.toolType ?? null,
    title,
    preview: previewOf(row, title),
    presentation: sessionStatusDisplay({ ...input, nowMs }, {
      snoozed,
      woke: !snoozed && Boolean(sessionWokeMarker(row)),
      snoozeWakeLabel: snoozed ? snoozeWakeLabel(row.snoozedUntil, nowMs) : null,
    }),
    elapsedSince: sessionElapsedAnchor(row, state.phase, state.liveness),
    activityAt: sessionActivityInstant(row),
    rank: phaseRank(state.phase),
  };
}

/** A chat with no terminal row of its own (older chats): read its state from the chat summary. */
function rowFromChat(chat: AgentChatSessionSummary, nowMs: number): LaneChatRow {
  const input: SessionCanonicalUiInput = {
    // An ended chat reads "Stopped", as its closed terminal row would in Work.
    status: chat.status === "ended" ? "disposed" : "running",
    runtimeState: chat.status === "ended"
      ? "exited"
      : chat.awaitingInput ? "waiting-input" : chat.status === "active" ? "running" : "idle",
    toolType: chatToolTypeForProvider(chat.provider),
    lastActivityAt: chat.lastActivityAt ?? null,
    lastOutputPreview: chat.lastOutputPreview ?? null,
    nowMs,
  };
  const state = sessionCanonicalUiState(input);
  const title = chat.title?.trim() || chat.goal?.trim() || "Chat";
  const preview = sanitizeTerminalInlineText(chat.summary ?? chat.lastOutputPreview, 140);
  const activityAt = chat.lastActivityAt ?? chat.endedAt ?? chat.startedAt;
  return {
    sessionId: chat.sessionId,
    toolType: input.toolType ?? null,
    title,
    preview: preview && preview !== title ? preview : null,
    presentation: sessionStatusDisplay(input),
    elapsedSince: activityAt,
    activityAt,
    rank: phaseRank(state.phase),
  };
}

/**
 * The lane's chats and agent CLIs as Work-style rows: what needs you first,
 * then what is working, then open chats, then finished ones, newest first
 * within each. Plain shells and a chat's own terminals are not listed.
 */
export function buildLaneChatRows(args: {
  laneId: string;
  chats: AgentChatSessionSummary[];
  terminals: TerminalSessionSummary[];
  nowMs?: number;
}): LaneChatRow[] {
  const nowMs = args.nowMs ?? Date.now();
  const rows: LaneChatRow[] = [];
  const seen = new Set<string>();
  for (const row of args.terminals) {
    if (row.laneId !== args.laneId || row.archivedAt || seen.has(row.id)) continue;
    if (!row.toolType || row.toolType === "shell" || row.chatSessionId) continue;
    seen.add(row.id);
    rows.push(rowFromTerminal(row, nowMs));
  }
  for (const chat of args.chats) {
    if (chat.laneId !== args.laneId || chat.archivedAt || seen.has(chat.sessionId)) continue;
    seen.add(chat.sessionId);
    rows.push(rowFromChat(chat, nowMs));
  }
  return rows.sort((a, b) => (a.rank - b.rank) || b.activityAt.localeCompare(a.activityAt));
}

/** The rows to show and how many "Show all" would add. */
export function capRows<T>(rows: T[], expanded: boolean, cap = LANE_CHATS_CAP): { visible: T[]; hidden: number } {
  if (expanded || rows.length <= cap) return { visible: rows, hidden: 0 };
  return { visible: rows.slice(0, cap), hidden: rows.length - cap };
}

/* ───────────────────────── Lane identity ───────────────────────── */

/** How close to the lane's creation a chat must start to count as the one that made it. */
const CREATED_BY_WINDOW_MS = 10 * 60_000;

/** The chat that started with the lane, when one started within minutes of it. */
export function laneCreatedBy(
  lane: Pick<LaneSummary, "createdAt" | "laneType">,
  sessions: Pick<LaneHistorySession, "sessionId" | "provider" | "startedAt" | "title">[],
): Pick<LaneHistorySession, "sessionId" | "provider" | "title"> | null {
  if (lane.laneType === "primary") return null;
  const createdTs = Date.parse(lane.createdAt);
  if (!Number.isFinite(createdTs)) return null;
  let first: (typeof sessions)[number] | null = null;
  let firstTs = Infinity;
  for (const session of sessions) {
    const ts = Date.parse(session.startedAt);
    if (!Number.isFinite(ts) || ts < createdTs - 60_000 || ts > createdTs + CREATED_BY_WINDOW_MS) continue;
    if (ts < firstTs) {
      first = session;
      firstTs = ts;
    }
  }
  return first;
}

/* ───────────────────────── Status line ───────────────────────── */

export type LaneStatusTone = "muted" | "accent" | "warning" | "success";

export type LaneStatusItem = {
  key: "ahead" | "behind" | "changes" | "remote";
  glyph: "up" | "down" | "dot" | "cloud" | "check";
  text: string;
  tone: LaneStatusTone;
  title: string;
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The lane's git state as a few short facts: how far from its base, what is
 * uncommitted, and what is waiting to push or pull. Counts of zero are left
 * out, except that a lane with nothing to say reads "Up to date".
 */
export function laneStatusItems(args: {
  lane: Pick<LaneSummary, "laneType" | "status">;
  baseLabel: string;
  upstream: GitUpstreamSyncStatus | null;
}): LaneStatusItem[] {
  const { lane, baseLabel, upstream } = args;
  const items: LaneStatusItem[] = [];
  if (lane.laneType !== "primary") {
    const { ahead, behind } = lane.status;
    if (ahead > 0) {
      items.push({ key: "ahead", glyph: "up", text: `${ahead} ahead`, tone: "accent", title: `${plural(ahead, "commit")} ahead of ${baseLabel}` });
    }
    if (behind > 0) {
      items.push({ key: "behind", glyph: "down", text: `${behind} behind ${baseLabel}`, tone: "warning", title: `${plural(behind, "commit")} behind ${baseLabel}` });
    } else if (ahead > 0) {
      items[items.length - 1]!.text = `${ahead} ahead of ${baseLabel}`;
    }
  }
  const changed = lane.status.changedFileCount ?? 0;
  if (lane.status.dirty || changed > 0) {
    items.push({
      key: "changes",
      glyph: "dot",
      text: changed > 0 ? `${plural(changed, "uncommitted change")}` : "Uncommitted changes",
      tone: "warning",
      title: "Changes in the worktree that are not committed yet",
    });
  }
  if (upstream) {
    if (!upstream.hasUpstream) {
      items.push({
        key: "remote",
        glyph: "cloud",
        text: upstream.upstreamState === "missing" ? "Remote branch gone" : "Not published",
        tone: "muted",
        title: upstream.upstreamState === "missing"
          ? "The remote branch this lane tracked no longer exists"
          : "This branch is not on the remote yet",
      });
    } else if (upstream.ahead > 0 || upstream.behind > 0) {
      const parts: string[] = [];
      if (upstream.ahead > 0) parts.push(`${upstream.ahead} to push`);
      if (upstream.behind > 0) parts.push(`${upstream.behind} to pull`);
      items.push({
        key: "remote",
        glyph: "cloud",
        text: parts.join(", "),
        tone: upstream.behind > 0 ? "warning" : "muted",
        title: `Compared to ${upstream.upstreamRef ?? "the remote branch"}`,
      });
    }
  }
  if (items.length === 0) {
    items.push({
      key: "remote",
      glyph: "check",
      text: upstream?.hasUpstream ? "Up to date" : "Clean",
      tone: "success",
      title: upstream?.hasUpstream ? `In sync with ${upstream.upstreamRef ?? "the remote"}` : "No uncommitted changes",
    });
  }
  return items;
}

/* ───────────────────────── Pull requests ───────────────────────── */

function prSortTs(pr: LaneHistoryPr): number {
  return Date.parse(pr.createdAt) || Date.parse(pr.updatedAt) || 0;
}

/**
 * Splits the lane's PRs into the one shown up front (the newest open or draft
 * PR, or the newest PR when none is open) and the earlier ones behind the
 * "N earlier" disclosure. Other open PRs join the earlier list.
 */
export function splitLanePrs(prs: LaneHistoryPr[]): { current: LaneHistoryPr | null; earlier: LaneHistoryPr[] } {
  const sorted = [...prs].sort((a, b) => prSortTs(b) - prSortTs(a));
  const current = sorted.find((pr) => pr.state === "open" || pr.state === "draft") ?? sorted[0] ?? null;
  return { current, earlier: sorted.filter((pr) => pr !== current) };
}

export function isLivePr(pr: Pick<LaneHistoryPr, "state"> | null | undefined): boolean {
  return pr?.state === "open" || pr?.state === "draft";
}

export type PrCheckRow = { name: string; state: PrPipelineState; url: string | null; durationMs: number | null };

export type PrChecksSummary = {
  total: number;
  /** Failing, running, queued and unknown checks, worst first. */
  attention: PrCheckRow[];
  /** Passed and skipped checks. */
  quiet: PrCheckRow[];
  passed: number;
  failed: number;
  running: number;
};

function checkDurationMs(check: PrCheck): number | null {
  const start = check.startedAt ? Date.parse(check.startedAt) : NaN;
  const end = check.completedAt ? Date.parse(check.completedAt) : NaN;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

/**
 * Splits a PR's checks into the ones worth a row each (not passing yet) and
 * the quiet rest, which the section folds into "N checks passed".
 */
export function summarizePrChecks(checks: PrCheck[]): PrChecksSummary {
  const rows: PrCheckRow[] = checks.map((check) => ({
    name: check.name,
    state: pipelineStateOf(check),
    url: check.detailsUrl ?? null,
    durationMs: checkDurationMs(check),
  }));
  const attention = rows
    .filter((row) => row.state !== "passed" && row.state !== "skipped")
    .sort((a, b) => (STATE_RANK[a.state] - STATE_RANK[b.state]) || a.name.localeCompare(b.name));
  const quiet = rows
    .filter((row) => row.state === "passed" || row.state === "skipped")
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    total: rows.length,
    attention,
    quiet,
    passed: rows.filter((row) => row.state === "passed").length,
    failed: rows.filter((row) => row.state === "failed").length,
    running: rows.filter((row) => row.state === "running" || row.state === "queued").length,
  };
}

export type PrFactTone = "success" | "danger" | "warning" | "muted";
export type PrFact = { text: string; tone: PrFactTone };

/**
 * One line about reviews. Each reviewer counts once, by their latest review
 * that approved or asked for changes; comments alone do not.
 */
export function prReviewFact(args: {
  reviews: PrReview[];
  reviewStatus: LaneHistoryPr["reviewStatus"];
  isDraft: boolean;
}): PrFact | null {
  const latest = new Map<string, PrReview>();
  const ordered = [...args.reviews].sort((a, b) => (Date.parse(a.submittedAt ?? "") || 0) - (Date.parse(b.submittedAt ?? "") || 0));
  for (const review of ordered) {
    if (review.state !== "approved" && review.state !== "changes_requested" && review.state !== "dismissed") continue;
    latest.set(review.reviewer, review);
  }
  const changes = [...latest.values()].filter((review) => review.state === "changes_requested").map((review) => review.reviewer);
  const approved = [...latest.values()].filter((review) => review.state === "approved").map((review) => review.reviewer);
  const names = (list: string[]) => (list.length > 2 ? `${list.slice(0, 2).join(", ")} and ${list.length - 2} more` : list.join(" and "));
  if (changes.length > 0) return { text: `Changes requested by ${names(changes)}`, tone: "warning" };
  if (approved.length > 0) return { text: `Approved by ${names(approved)}`, tone: "success" };
  if (args.reviewStatus === "changes_requested") return { text: "Changes requested", tone: "warning" };
  if (args.reviewStatus === "approved") return { text: "Approved", tone: "success" };
  if (args.isDraft) return null;
  if (args.reviewStatus === "requested") return { text: "Review requested", tone: "muted" };
  return { text: "No reviews yet", tone: "muted" };
}

/** One line about merging: conflicts first, then how far behind the base, then ready. */
export function prMergeFact(args: {
  status: Pick<PrStatus, "mergeConflicts" | "isMergeable" | "behindBaseBy"> | null;
  mergeConflicts: boolean | null;
  baseLabel: string;
  isDraft: boolean;
  checksFailing: boolean;
  approved: boolean;
}): PrFact | null {
  const conflicts = args.status?.mergeConflicts ?? args.mergeConflicts;
  if (conflicts) return { text: `Conflicts with ${args.baseLabel}`, tone: "danger" };
  const behind = args.status?.behindBaseBy ?? 0;
  if (behind > 0) return { text: `${plural(behind, "commit")} behind ${args.baseLabel}`, tone: "warning" };
  if (args.isDraft) return conflicts === false ? { text: "No conflicts", tone: "muted" } : null;
  if (args.status?.isMergeable && !args.checksFailing && args.approved) return { text: "Ready to merge", tone: "success" };
  if (conflicts === false || args.status) return { text: "No conflicts", tone: "muted" };
  return null;
}

/* ───────────────────────── Sections ───────────────────────── */

export type LaneOverviewSections = {
  pr: boolean;
  chats: boolean;
  stack: boolean;
  changes: "pr-files" | "commits" | null;
};

/** Which sections the overview shows. A section with nothing in it is left out. */
export function laneOverviewSections(args: {
  prs: LaneHistoryPr[];
  chatCount: number;
  hasParent: boolean;
  childCount: number;
  livePrFileCount: number;
  laneCommitCount: number;
}): LaneOverviewSections {
  const current = splitLanePrs(args.prs).current;
  const showFiles = isLivePr(current) && args.livePrFileCount > 0;
  return {
    pr: args.prs.length > 0,
    chats: args.chatCount > 0,
    stack: args.hasParent || args.childCount > 0,
    changes: showFiles ? "pr-files" : args.laneCommitCount > 0 ? "commits" : null,
  };
}
