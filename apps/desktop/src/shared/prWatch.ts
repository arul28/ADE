/**
 * PR Watch / Ship: what a chat watching its pull request is told, and when.
 *
 * Watch wakes the chat once per change on the PR — a check failed, the checks
 * passed, someone commented or reviewed, the branch began conflicting, the PR
 * merged or closed. Ship is Watch plus standing instructions to take the PR
 * all the way to merged, and it holds its news until CI and the review bots
 * have both finished on the current head, so the agent fixes everything in one
 * push instead of reacting to half a signal.
 *
 * This module is pure: the main-process reactor reads GitHub, calls
 * {@link evaluatePrWatch}, delivers the wake, and only then records `next`.
 * Readiness stays with the agent — a wake is news, not a merge decision.
 */

import type { AdeCardPayload, AdeCardRow } from "./adeCard";
import { classifyPrAuthor } from "./prBotIdentity";
import type { PrCheck, PrChecksStatus, PrState } from "./types/prs";

export type PrWatchMode = "watch" | "ship";

/** A wire `mode`: "watch", "ship", or empty for off. Anything else is refused, not read as off. */
export function parsePrWatchMode(value: unknown): PrWatchMode | null {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!mode || mode === "off") return null;
  if (mode === "watch" || mode === "ship") return mode;
  throw new Error(`Unknown PR watch mode "${String(value)}". Use watch, ship, or off.`);
}
export type PrWatchArmedBy = "user" | "agent";

/** Comment-only wakes in a row before the watch stops itself (a bot loop). */
export const PR_WATCH_COMMENT_ONLY_WAKE_LIMIT = 10;
/** A PR that cannot be read for this long ends the watch with a final wake. */
export const PR_WATCH_UNREADABLE_LIMIT_MS = 15 * 60_000;
/**
 * Ship mode waits this long after a new head for review bots to show up.
 * Past it, a bot with no activity is treated as not running on this PR.
 */
export const PR_SHIP_REVIEW_BOT_GRACE_MS = 12 * 60_000;

const LISTED_ITEMS = 10;
const SNIPPET_LENGTH = 220;

/** One comment, review, or inline review comment on the PR. */
export type PrWatchRemark = {
  id: string;
  author: string;
  authorIsBot?: boolean;
  body: string | null;
  path?: string | null;
  line?: number | null;
  url?: string | null;
  createdAt: string | null;
  kind: "comment" | "review" | "review_comment";
  /** Set on a submitted review. */
  reviewState?: "approved" | "changes_requested" | "commented" | "dismissed" | "pending" | null;
};

/**
 * Key recorded for a review ADE submitted. A review has no id in ADE's
 * review list, so it is matched by its submission time.
 */
export function adeReviewRemarkKey(submittedAt: string): string {
  return `review-at:${submittedAt}`;
}

export type PrWatchFailedCheck = { name: string; url: string | null; conclusion: string | null };

export type PrWatchChange =
  | { kind: "checks_failed"; failed: PrWatchFailedCheck[] }
  | { kind: "checks_passed" }
  | { kind: "remarks"; remarks: PrWatchRemark[] }
  | { kind: "conflicting" }
  | { kind: "merged" }
  | { kind: "closed" }
  | { kind: "unreadable"; reason: string };

/** What the agent was last told, plus the news Ship is still holding. */
export type PrWatchState = {
  headSha: string | null;
  /**
   * When a head pushed after the watch began was first seen; Ship's review-bot
   * grace counts from here. Null for the head the watch started on: its bots
   * had their chance before anyone asked to ship.
   */
  headSeenAt: string | null;
  failedChecks: string[];
  passed: boolean;
  remarksThrough: string | null;
  remarkIds: string[];
  conflicting: boolean;
  commentOnlyWakes: number;
  unreadableSince: string | null;
  /** Ship mode: news found but not yet released. */
  held: PrWatchChange[];
};

export type PrWatchPrInput = {
  githubPrNumber: number;
  githubUrl: string;
  baseBranch: string;
  state: PrState;
  headSha?: string | null;
  checksStatus: PrChecksStatus;
  mergeConflicts?: boolean | null;
};

export type PrWatchEvaluation = {
  /** What to tell the agent now. Empty means no wake. */
  changes: PrWatchChange[];
  /** The state to record once the wake (if any) is delivered. */
  next: PrWatchState;
  /** This wake spends the last comment-only wake; the watch stops after it. */
  exhausted: boolean;
  /** The watch is over after this wake (merged, closed, unreadable, exhausted). */
  stop: PrWatchStopReason | null;
};

export type PrWatchStopReason = "merged" | "closed" | "unreadable" | "exhausted" | "unwatched" | "chat_gone";

export function initialPrWatchState(startedAtIso: string, headSha: string | null): PrWatchState {
  return {
    headSha,
    headSeenAt: null,
    failedChecks: [],
    passed: false,
    // Comments from before the watch began are not news.
    remarksThrough: startedAtIso,
    remarkIds: [],
    conflicting: false,
    commentOnlyWakes: 0,
    unreadableSince: null,
    held: [],
  };
}

/** A finished check that needs someone. */
function isFailedCheck(check: PrCheck): boolean {
  return check.status === "completed" && (
    check.conclusion === "failure"
    || check.conclusion === "cancelled"
    || check.conclusion === "timed_out"
    || check.conclusion === "action_required"
  );
}

/**
 * Remarks that should wake an agent: from people and from agent reviewers.
 * Deploy previews, CI reporters, and dependency bots rewrite their comment on
 * every push and would wake the agent for nothing.
 */
export function isPrWatchRemarkAuthorRelevant(author: string, authorIsBot?: boolean): boolean {
  const identity = classifyPrAuthor(author, authorIsBot);
  return identity.role === "human" || identity.role === "agent-reviewer";
}

function isAgentReviewer(remark: PrWatchRemark): boolean {
  return classifyPrAuthor(remark.author, remark.authorIsBot).role === "agent-reviewer";
}

function timeMs(iso: string | null | undefined): number {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(value) ? value : 0;
}

/** Merge newly found news into what Ship already holds, one entry per kind. */
function mergeHeld(held: PrWatchChange[], incoming: PrWatchChange[]): PrWatchChange[] {
  const out = [...held];
  for (const change of incoming) {
    const index = out.findIndex((entry) => entry.kind === change.kind);
    if (index < 0) {
      out.push(change);
      continue;
    }
    const existing = out[index]!;
    if (existing.kind === "checks_failed" && change.kind === "checks_failed") {
      const names = new Set(existing.failed.map((check) => check.name));
      out[index] = { kind: "checks_failed", failed: [...existing.failed, ...change.failed.filter((check) => !names.has(check.name))] };
    } else if (existing.kind === "remarks" && change.kind === "remarks") {
      const ids = new Set(existing.remarks.map((remark) => remark.id));
      out[index] = { kind: "remarks", remarks: [...existing.remarks, ...change.remarks.filter((remark) => !ids.has(remark.id))] };
    } else {
      out[index] = change;
    }
  }
  // A pass makes held failures stale, and the reverse.
  const lastCheckKind = [...incoming].reverse().find((change) => change.kind === "checks_failed" || change.kind === "checks_passed")?.kind;
  if (lastCheckKind === "checks_passed") return out.filter((change) => change.kind !== "checks_failed");
  if (lastCheckKind === "checks_failed") return out.filter((change) => change.kind !== "checks_passed");
  return out;
}

/** Remarks newer than what the watch already told, and the new high-water mark. */
function readFreshRemarks(
  previous: PrWatchState,
  remarks: PrWatchRemark[] | null,
  ignoredRemarkIds: ReadonlySet<string> | undefined,
): { fresh: PrWatchRemark[]; remarksThrough: string | null; remarkIds: string[] } {
  const unchanged = { fresh: [], remarksThrough: previous.remarksThrough, remarkIds: previous.remarkIds };
  if (!remarks) return unchanged;
  const through = timeMs(previous.remarksThrough);
  const ignored = ignoredRemarkIds ?? new Set<string>();
  const fresh = remarks.filter((remark) => {
    if (ignored.has(remark.id)) return false;
    if (!isPrWatchRemarkAuthorRelevant(remark.author, remark.authorIsBot)) return false;
    const at = timeMs(remark.createdAt);
    // GitHub times are per second; remarks on the boundary are told apart by id.
    return at > through || (at === through && !previous.remarkIds.includes(remark.id));
  }).sort((left, right) => timeMs(left.createdAt) - timeMs(right.createdAt));
  if (fresh.length === 0) return unchanged;
  const latest = Math.max(through, ...fresh.map((remark) => timeMs(remark.createdAt)));
  const atLatest = fresh.filter((remark) => timeMs(remark.createdAt) === latest);
  return {
    fresh,
    remarksThrough: latest === through ? previous.remarksThrough : (atLatest[0]?.createdAt ?? previous.remarksThrough),
    remarkIds: latest === through
      ? [...previous.remarkIds, ...atLatest.map((remark) => remark.id)]
      : atLatest.map((remark) => remark.id),
  };
}

/**
 * Compare the PR with what its agent was last told.
 *
 * `checks` / `remarks` are null when they could not be read this pass; their
 * news then waits for a later pass. `ignoredRemarkIds` are comments ADE itself
 * posted for the agent — its own replies must never wake it. The user's own
 * comments are not ignored: a reviewer who is also the account owner still
 * gets heard.
 */
export function evaluatePrWatch(args: {
  mode: PrWatchMode;
  state: PrWatchState;
  pr: PrWatchPrInput;
  checks: PrCheck[] | null;
  remarks: PrWatchRemark[] | null;
  ignoredRemarkIds?: ReadonlySet<string>;
  nowMs: number;
}): PrWatchEvaluation {
  const { mode, pr, nowMs } = args;
  const nowIso = new Date(nowMs).toISOString();
  const previous = args.state;

  if (pr.state === "merged" || pr.state === "closed") {
    const kind = pr.state === "merged" ? "merged" : "closed";
    // Remarks left on the way out (a "thanks", a follow-up ask) still go out.
    const last = readFreshRemarks(previous, args.remarks, args.ignoredRemarkIds);
    const heldRemarks = previous.held.filter((change) => change.kind === "remarks");
    const remarks = last.fresh.length > 0
      ? mergeHeld(heldRemarks, [{ kind: "remarks", remarks: last.fresh }])
      : heldRemarks;
    return {
      changes: [...remarks, { kind }],
      next: { ...previous, held: [], remarksThrough: last.remarksThrough, remarkIds: last.remarkIds },
      exhausted: false,
      stop: kind,
    };
  }

  const headSha = pr.headSha ?? previous.headSha;
  const headMoved = Boolean(pr.headSha) && pr.headSha !== previous.headSha;
  const found: PrWatchChange[] = [];

  let failedChecks = headMoved ? [] : previous.failedChecks;
  let passed = headMoved ? false : previous.passed;
  let held = headMoved
    ? previous.held.filter((change) => change.kind !== "checks_failed" && change.kind !== "checks_passed")
    : previous.held;

  if (args.checks && args.checks.length > 0) {
    const failed = args.checks.filter(isFailedCheck);
    const newlyFailed = failed.filter((check) => !failedChecks.includes(check.name));
    if (newlyFailed.length > 0) {
      found.push({
        kind: "checks_failed",
        failed: newlyFailed.map((check) => ({ name: check.name, url: check.detailsUrl, conclusion: check.conclusion })),
      });
    }
    // A check that reruns leaves the list, so a rerun that fails again is news.
    failedChecks = failed.map((check) => check.name);
  }
  // ADE's rollup already knows which checks the base branch requires.
  const passedNow = pr.checksStatus === "passing";
  if (passedNow && !passed) found.push({ kind: "checks_passed" });
  passed = passedNow;

  const { fresh, remarksThrough, remarkIds } = readFreshRemarks(previous, args.remarks, args.ignoredRemarkIds);
  if (fresh.length > 0) found.push({ kind: "remarks", remarks: fresh });

  // `null` is GitHub still computing after a push: only a clean answer clears it.
  const conflictingNow = pr.mergeConflicts == null ? previous.conflicting : pr.mergeConflicts === true;
  if (conflictingNow && !previous.conflicting) found.push({ kind: "conflicting" });

  const unreadable = args.checks === null && args.remarks === null;
  const unreadableSince = unreadable ? (previous.unreadableSince ?? nowIso) : null;
  if (unreadable && nowMs - timeMs(unreadableSince) >= PR_WATCH_UNREADABLE_LIMIT_MS) {
    return {
      changes: [...held, { kind: "unreadable", reason: "ADE could not read this pull request from GitHub for 15 minutes." }],
      next: { ...previous, unreadableSince, held: [] },
      exhausted: false,
      stop: "unreadable",
    };
  }

  // The first head a watch reads is the head it started on, even when the row
  // had none recorded yet.
  const headSeenAt = headMoved && previous.headSha !== null ? nowIso : previous.headSeenAt;
  let changes: PrWatchChange[];
  if (mode === "ship") {
    held = mergeHeld(held, found);
    const graceOver = headSeenAt === null || nowMs - timeMs(headSeenAt) >= PR_SHIP_REVIEW_BOT_GRACE_MS;
    // No checks yet right after a push means CI has not registered, not that
    // it finished; a repo with no CI at all is released by the grace.
    const checksTerminal = args.checks !== null
      && (args.checks.length > 0 || graceOver)
      && args.checks.every((check) => check.status === "completed");
    const botsHeard = headSeenAt !== null && held.some((change) =>
      change.kind === "remarks" && change.remarks.some((remark) =>
        isAgentReviewer(remark) && timeMs(remark.createdAt) >= timeMs(headSeenAt)));
    // A conflict blocks CI from ever settling, so it never waits.
    const urgent = held.some((change) => change.kind === "conflicting");
    const release = held.length > 0 && (urgent || (checksTerminal && (botsHeard || graceOver)));
    changes = release ? held : [];
    if (release) held = [];
  } else {
    // News Ship was holding (the watch switched from Ship) goes out now.
    changes = mergeHeld(held, found);
    held = [];
  }

  const commentsOnly = changes.length > 0 && changes.every((change) => change.kind === "remarks");
  const progress = headMoved || (changes.length > 0 && !commentsOnly);
  const commentOnlyWakes = (progress ? 0 : previous.commentOnlyWakes) + (commentsOnly ? 1 : 0);
  const exhausted = commentsOnly && commentOnlyWakes >= PR_WATCH_COMMENT_ONLY_WAKE_LIMIT;

  return {
    changes,
    next: {
      headSha,
      headSeenAt,
      failedChecks,
      passed,
      remarksThrough,
      remarkIds,
      conflicting: conflictingNow,
      commentOnlyWakes,
      unreadableSince,
      held,
    },
    exhausted,
    stop: exhausted ? "exhausted" : null,
  };
}

function snippet(body: string | null | undefined): string {
  const text = (body ?? "")
    .replaceAll(/<!--[\s\S]*?-->/g, " ")
    .replaceAll(/<details>[\s\S]*?<\/details>/gi, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return text.length <= SNIPPET_LENGTH ? text : `${text.slice(0, SNIPPET_LENGTH - 1).trimEnd()}…`;
}

function listed<T>(items: readonly T[], line: (item: T) => string): string[] {
  const lines = items.slice(0, LISTED_ITEMS).map(line);
  if (items.length > LISTED_ITEMS) lines.push(`  - and ${items.length - LISTED_ITEMS} more`);
  return lines;
}

function remarkWhere(remark: PrWatchRemark): string {
  if (!remark.path) return "";
  return remark.line ? ` on ${remark.path}:${remark.line}` : ` on ${remark.path}`;
}

function remarkSaid(remark: PrWatchRemark): string {
  const body = snippet(remark.body);
  if (body) return `"${body}"`;
  if (remark.reviewState === "approved") return "approved";
  if (remark.reviewState === "changes_requested") return "requested changes";
  return "reviewed";
}

const CHANGE_LABEL: Record<PrWatchChange["kind"], string> = {
  checks_failed: "checks failed",
  checks_passed: "checks passed",
  remarks: "new comments",
  conflicting: "merge conflict",
  merged: "merged",
  closed: "closed",
  unreadable: "unreadable",
};

/** One short phrase, e.g. "2 checks failed, 3 new comments". */
export function summarizePrWatchChanges(changes: readonly PrWatchChange[]): string {
  return changes.map((change) => {
    if (change.kind === "checks_failed") {
      return `${change.failed.length} ${change.failed.length === 1 ? "check" : "checks"} failed`;
    }
    if (change.kind === "remarks") {
      return `${change.remarks.length} new ${change.remarks.length === 1 ? "comment" : "comments"}`;
    }
    return CHANGE_LABEL[change.kind];
  }).join(", ");
}

/**
 * Standing instructions for Ship. Written for any repository — it names no
 * skill, script, or bot this repo happens to use.
 */
export const PR_SHIP_STANDING_BRIEF = [
  "You are shipping this pull request: keep going until it is merged. Standing instructions:",
  "1. Read every failing check (open its log) and every new review comment before changing anything. Fix CI failures and valid review findings together, then commit and push once.",
  "2. Verify each fix with the narrowest check that proves it — the failing test file, the touched package's typecheck or lint. Do not run the whole suite.",
  "3. Rebase or merge the base branch only when the PR has a real conflict, then re-run the affected checks.",
  "4. Reply to each review thread you addressed, or explain why a comment is wrong, and resolve the threads you fixed.",
  "5. When the required checks pass and nothing is left unaddressed, merge the PR with the repository's usual merge method (`gh pr merge` or `ade prs land`).",
  "ADE wakes you with the next change once CI and the review bots have finished, so end your turn after you push.",
].join("\n");

export type PrWatchWakeContext = {
  mode: PrWatchMode;
  pr: Pick<PrWatchPrInput, "githubPrNumber" | "githubUrl" | "baseBranch" | "headSha">;
  changes: readonly PrWatchChange[];
  stop: PrWatchStopReason | null;
  /** Failing-check log tails keyed by check name, when the reactor fetched them. */
  logExcerpts?: ReadonlyMap<string, string>;
};

function changeLines(change: PrWatchChange, ctx: PrWatchWakeContext): string[] {
  const commit = ctx.pr.headSha ? ` on ${ctx.pr.headSha.slice(0, 7)}` : "";
  switch (change.kind) {
    case "checks_failed":
      return [
        `- Checks failed${commit}:`,
        ...listed(change.failed, (check) => {
          const conclusion = check.conclusion && check.conclusion !== "failure" ? ` (${check.conclusion})` : "";
          const excerpt = ctx.logExcerpts?.get(check.name);
          const head = `  - ${check.name}${conclusion}${check.url ? ` ${check.url}` : ""}`;
          return excerpt ? `${head}\n    log tail:\n${excerpt.split("\n").map((line) => `      ${line}`).join("\n")}` : head;
        }),
      ];
    case "checks_passed":
      return [`- All required checks passed${commit}.`];
    case "remarks":
      return [
        `- ${change.remarks.length} new ${change.remarks.length === 1 ? "comment" : "comments"}:`,
        ...listed(change.remarks, (remark) =>
          `  - ${remark.author || "someone"}${remarkWhere(remark)}: ${remarkSaid(remark)}${remark.url ? ` ${remark.url}` : ""}`),
      ];
    case "conflicting":
      return [`- The branch now conflicts with ${ctx.pr.baseBranch}.`];
    case "merged":
      return ["- The pull request was merged."];
    case "closed":
      return ["- The pull request was closed without merging."];
    case "unreadable":
      return [`- ${change.reason}`];
  }
}

function closingLine(ctx: PrWatchWakeContext): string {
  switch (ctx.stop) {
    case "merged":
      return ctx.mode === "ship"
        ? "Shipping is done; ADE stopped watching. Wrap up and report what landed."
        : "ADE stopped watching this pull request.";
    case "closed":
      return "ADE stopped watching this pull request.";
    case "unreadable":
      return "ADE stopped watching. Check GitHub access, then run `ade prs watch` to watch it again.";
    case "exhausted":
      return `ADE stopped watching after ${PR_WATCH_COMMENT_ONLY_WAKE_LIMIT} comment-only updates in a row. Run \`ade prs watch\` to watch it again.`;
    default:
      return ctx.mode === "ship"
        ? "Follow your shipping instructions. ADE keeps watching and wakes you on the next change."
        : "Look into each item and act on it as your task requires. ADE keeps watching and wakes you on the next change, so end your turn when you are done. Run `ade prs unwatch` when you no longer need updates.";
  }
}

/** The exact text the agent receives. */
export function buildPrWatchWakeText(ctx: PrWatchWakeContext): string {
  const verb = ctx.mode === "ship" ? "shipping" : "watching";
  const lines = [
    `Update on pull request #${ctx.pr.githubPrNumber} (${ctx.pr.githubUrl}), which ADE is ${verb} for you:`,
    ...ctx.changes.flatMap((change) => changeLines(change, ctx)),
    "",
  ];
  if (ctx.mode === "ship" && ctx.stop === null) lines.push(PR_SHIP_STANDING_BRIEF, "");
  lines.push(closingLine(ctx));
  return lines.join("\n");
}

function changeRows(change: PrWatchChange, baseBranch: string): AdeCardRow[] {
  switch (change.kind) {
    case "checks_failed":
      return change.failed.map((check) => ({
        icon: "fail",
        tone: "warning",
        text: check.name,
        detail: check.conclusion && check.conclusion !== "failure" ? check.conclusion.replace(/_/g, " ") : null,
      }));
    case "checks_passed":
      return [{ icon: "pass", tone: "success", text: "All required checks passed" }];
    case "remarks":
      return change.remarks.map((remark) => ({
        icon: "info",
        text: `${remark.author || "someone"}${remarkWhere(remark)}`,
        detail: snippet(remark.body) || remarkSaid(remark),
      }));
    case "conflicting":
      return [{ icon: "fail", tone: "warning", text: `Conflicts with ${baseBranch}` }];
    case "merged":
      return [{ icon: "pass", tone: "success", text: "Merged" }];
    case "closed":
      return [{ icon: "info", text: "Closed without merging" }];
    case "unreadable":
      return [{ icon: "info", tone: "warning", text: change.reason }];
  }
}

/**
 * The transcript card the wake renders as. The wake message itself is never
 * drawn as a user bubble — the user did not write it — so this card is the
 * whole visible record, with the exact text folded behind it.
 */
export function buildPrWatchWakeCard(ctx: PrWatchWakeContext & { watchId: string; deliveredAt: string }): AdeCardPayload {
  const rows = ctx.changes.flatMap((change) => changeRows(change, ctx.pr.baseBranch));
  const shown = rows.slice(0, 8);
  const status = ctx.stop
    ? "watch stopped"
    : ctx.mode === "ship" ? "shipping" : "watching";
  return {
    cardId: `pr-watch:${ctx.watchId}:${ctx.deliveredAt}`,
    variant: "pr_watch_wake",
    state: "terminal",
    title: `PR #${ctx.pr.githubPrNumber} · ${summarizePrWatchChanges(ctx.changes)}`,
    subtitle: `Agent notified · ${status}`,
    rows: shown,
    ...(rows.length > shown.length ? { rowsTruncated: rows.length - shown.length } : {}),
    fallbackText: `PR #${ctx.pr.githubPrNumber}: ${summarizePrWatchChanges(ctx.changes)} — agent notified`,
    createdAt: ctx.deliveredAt,
  };
}

/** What a chat shows about its PR watch. Carried to every client. */
export type PrChatWatchSummary = {
  watchId: string;
  prId: string;
  sessionId: string;
  githubPrNumber: number | null;
  mode: PrWatchMode;
  armedBy: PrWatchArmedBy;
  status: "active" | "stopped";
  startedAt: string;
  stoppedAt: string | null;
  stopReason: PrWatchStopReason | null;
  lastToldAt: string | null;
  lastToldSummary: string | null;
  /** Ship: news found and held until CI and the review bots finish. */
  holding: boolean;
};

export type SetPrChatWatchArgs = {
  prId: string;
  sessionId: string;
  /** `null` stops watching. */
  mode: PrWatchMode | null;
  armedBy?: PrWatchArmedBy;
};

export type GetPrChatWatchArgs = {
  sessionId?: string;
  prId?: string;
};
