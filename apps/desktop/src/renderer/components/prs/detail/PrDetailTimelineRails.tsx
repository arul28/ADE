import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowSquareOut, Stack } from "@phosphor-icons/react";
import { buildPrsRouteSearch, parsePrsRouteState, prRouteCoordinatesMatch, type ParsedPrsRouteState } from "../prsRouteState";
import type {
  LaneSummary,
  MergeMethod,
  PrActionRun,
  PrActivityEvent,
  PrAiSummary,
  PrCheck,
  PrCommit,
  PrComment,
  PrDeployment,
  PrDetail,
  PrReview,
  PrRerunChecksTarget,
  PrReviewThread,
  PrStatus,
  PrTimelineEvent,
  PrWithConflicts,
  UpdateBranchStrategy,
} from "../../../../shared/types";
import { PrTimeline, type PrTimelineFilters, type PrTimelineRef } from "../shared/PrTimeline";
import { PrCommitRail, type PrCommitRailCommit } from "../shared/PrCommitRail";
import { PrDetailMergeRail } from "../shared/PrDetailMergeRail";
import { PrDetailRightMetadataRail, type ReviewerRequest } from "../shared/PrDetailRightMetadataRail";
import { PrFilesChangedCard } from "../shared/PrFilesChangedCard";
import { PrCommentComposer } from "../shared/PrCommentComposer";
import { PrCommandPalettes, type PaletteKind } from "../shared/PrCommandPalettes";
import type { PrReviewEvent } from "../shared/PrReviewSubmitModal";
import { COLORS, RADII, SANS_FONT, SPACING, floatingPane, primaryButton } from "../../lanes/laneDesignTokens";

/* ── Resizable rails ──────────────────────────────────────────────────────
 * Both rails drag-resize and persist per project, using the same localStorage
 * idiom `GitHubTab` uses for its list/detail split. Widths are per project
 * because a repo's PR shape (long check lists vs. long commit lists) is what
 * decides how you want the space split, and that's a per-project constant.
 */
const OVERVIEW_LEFT_RAIL_WIDTH_KEY = "ade.prs.overviewLeftRailWidth";
const OVERVIEW_RIGHT_RAIL_WIDTH_KEY = "ade.prs.overviewRightRailWidth";
const LEFT_RAIL_MIN_PX = 176;
const LEFT_RAIL_MAX_PX = 420;
const LEFT_RAIL_DEFAULT_PX = 232;
const RIGHT_RAIL_MIN_PX = 232;
const RIGHT_RAIL_MAX_PX = 480;
const RIGHT_RAIL_DEFAULT_PX = 288;
/** The center thread can never be squeezed below this. */
const CENTER_MIN_PX = 320;

function railWidthKey(base: string, projectId: string | null | undefined): string {
  return projectId ? `${base}:${projectId}` : base;
}

function readPersistedRailPx(key: string, min: number, max: number, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const value = Number(raw);
      if (Number.isFinite(value) && value >= min && value <= max) return value;
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

function persistRailPx(key: string, px: number): void {
  try {
    localStorage.setItem(key, String(Math.round(px)));
  } catch {
    /* ignore */
  }
}

/** 8px gutter between panes that doubles as the drag handle (mid-edge grip). */
function RailSeparator({ id }: { id: string }) {
  return (
    <Separator
      id={id}
      data-testid={`pr-detail-rail-separator-${id}`}
      className="group relative flex items-center justify-center"
      style={{ width: SPACING.sm, cursor: "col-resize" }}
    >
      <span
        aria-hidden
        className="opacity-0 transition-opacity group-hover:opacity-100"
        style={{
          width: 3,
          height: 26,
          borderRadius: RADII.sm,
          background: COLORS.accent,
        }}
      />
    </Separator>
  );
}

export type PrDetailTimelineRailsRef = {
  scrollToEventId: (id: string) => void;
  focusEvent: (id: string) => void;
  nextUnresolvedThread: () => void;
  prevUnresolvedThread: () => void;
  openPalette: (kind: PaletteKind) => void;
  closePalette: () => void;
};

export function buildTimelineVisibleEventSearch(args: {
  current: ParsedPrsRouteState;
  prId: string;
  eventId: string | null;
}): string {
  const tab = args.current.tab === "github" || args.current.tab === "normal" ? args.current.tab : "normal";
  return buildPrsRouteSearch({
    activeTab: tab,
    selectedPrId: args.current.prId ?? (args.current.prNumber != null ? null : args.prId),
    selectedPrNumber: args.current.prNumber,
    repoOwner: args.current.repoOwner,
    repoName: args.current.repoName,
    selectedRebaseItemId: null,
    eventId: args.eventId,
    threadId: args.current.threadId,
    commitSha: args.current.commitSha,
    detailTab: args.current.detailTab,
  });
}

type Props = {
  pr: PrWithConflicts;
  detail: PrDetail | null;
  status: PrStatus | null;
  checks: PrCheck[];
  reviews: PrReview[];
  comments: PrComment[];
  activity: PrActivityEvent[];
  commits: PrCommit[];
  files: Array<{ filename: string; additions: number; deletions: number }>;
  reviewThreads: PrReviewThread[];
  deployments: PrDeployment[];
  viewerLogin: string | null;
  filters: PrTimelineFilters;
  onFiltersChange: (next: PrTimelineFilters) => void;
  aiSummary: PrAiSummary | null;
  aiSummaryDismissed: boolean;
  onDismissAiSummary: () => void;
  onRegenerateAiSummary: () => void;
  commentDraft: string;
  setCommentDraft: (value: string) => void;
  actionBusy: boolean;
  onAddComment: () => void;
  deepLink: { eventId: string | null; threadId: string | null; commitSha: string | null };
  actionRuns: PrActionRun[];
  onSelectCheck?: (check: PrCheck) => void;
  onOpenChecksTab?: () => void;
  onRerunChecks?: (target?: PrRerunChecksTarget) => void;
  onOpenFilesTab?: () => void;
  mergeMethod: MergeMethod;
  showReviewerEditor: boolean;
  setShowReviewerEditor: (value: boolean) => void;
  reviewerInput: string;
  setReviewerInput: (value: string) => void;
  showLabelEditor: boolean;
  setShowLabelEditor: (value: boolean) => void;
  labelInput: string;
  setLabelInput: (value: string) => void;
  onMerge: (method: MergeMethod, options?: {
    bypassRules?: boolean;
    commitTitle?: string;
    commitBody?: string;
    expectedHeadSha?: string;
  }) => void;
  onUpdateBranch?: (strategy: UpdateBranchStrategy) => void;
  updateBranchBusy?: boolean;
  updateBranchNotice?: { tone: "success" | "error"; text: string } | null;
  onRequestReviewers: (request: ReviewerRequest) => void;
  onSetLabels: (labels: string[]) => void;
  onDeleteBranch?: () => void;
  deleteBranchBusy?: boolean;
  lane: LaneSummary | null;
  onOpenManageLane?: () => void;
  onClose?: () => void;
  onReopen?: () => void;
  onSubmitReview: (event: PrReviewEvent, body: string) => void;
};

function shortenSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

// A "commented" review with no summary body is just a container for inline
// thread comments — GitHub doesn't render it as a standalone "X reviewed" row,
// so neither do we (its comments surface as the review-thread blocks).
function isBodylessCommentedReview(state: string, body: string | null | undefined): boolean {
  return state === "commented" && !body?.trim();
}

function readActivityString(event: PrActivityEvent, key: string): string | null {
  const value = (event.metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function readActivityNumber(event: PrActivityEvent, key: string): number | null {
  const value = (event.metadata as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readActivityBoolean(event: PrActivityEvent, key: string): boolean {
  return Boolean((event.metadata as Record<string, unknown>)[key]);
}

function threadFirstCommentAuthor(thread: PrReviewThread): string | null {
  return thread.comments[0]?.author ?? null;
}

function threadFirstCommentAvatar(thread: PrReviewThread): string | null {
  return thread.comments[0]?.authorAvatarUrl ?? null;
}

function threadFirstCommentBody(thread: PrReviewThread): string | null {
  return thread.comments[0]?.body ?? null;
}

function threadTimestamp(thread: PrReviewThread): string {
  // Anchor a thread to its FIRST comment (when it started), not its last —
  // otherwise a recently-replied-to old thread jumps to the bottom of the feed.
  return (
    thread.comments?.[0]?.createdAt
    ?? thread.createdAt
    ?? thread.updatedAt
    ?? new Date(0).toISOString()
  );
}

function stableSortByTs<T extends { timestamp: string; id: string }>(events: T[]): T[] {
  return [...events].sort((a, b) => {
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    const aValid = !Number.isNaN(ta);
    const bValid = !Number.isNaN(tb);
    // Undated events sink to the END (chronological feeds read top→bottom);
    // ties break deterministically by id so order is stable across renders.
    if (!aValid && !bValid) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    if (!aValid) return 1;
    if (!bValid) return -1;
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function isBotLogin(login: string | null | undefined): boolean {
  if (!login) return false;
  const l = login.toLowerCase();
  return l.endsWith("[bot]") || l.endsWith("-bot") || l === "github-actions";
}

export function buildTimelineEvents(args: {
  pr: PrWithConflicts;
  detail: PrDetail | null;
  activity: PrActivityEvent[];
  reviews: PrReview[];
  reviewThreads: PrReviewThread[];
  comments: PrComment[];
  checks: PrCheck[];
  deployments: PrDeployment[];
  commits?: PrCommit[];
}): PrTimelineEvent[] {
  const events: PrTimelineEvent[] = [];

  // PR-opened banner intentionally omitted — the PR state (open/draft/merged/
  // closed) now lives as a tag in the detail header, so the feed starts with the
  // description like GitHub.

  // Description as first comment-like event.
  if (args.detail?.body) {
    events.push({
      id: `desc:${args.pr.id}`,
      type: "description",
      timestamp: args.pr.createdAt ?? new Date(0).toISOString(),
      author: args.detail.author?.login ?? null,
      avatarUrl: args.detail.author?.avatarUrl ?? null,
      body: args.detail.body,
    });
  }

  // The `committed` timeline event only carries the git author (no avatar), so
  // map each commit sha to its GitHub-user avatar from the commit snapshots.
  const commitAvatarBySha = new Map<string, string>();
  for (const c of args.commits ?? []) {
    if (c.sha && c.author.avatarUrl) commitAvatarBySha.set(c.sha, c.author.avatarUrl);
  }

  // Activity events split into push / label / merge.
  for (const act of args.activity) {
    if (act.type === "commit") {
      const sha = readActivityString(act, "sha") ?? act.id;
      const subject = readActivityString(act, "subject") ?? act.body ?? "";
      events.push({
        id: `commit:${sha}`,
        type: "commit_push",
        timestamp: act.timestamp,
        author: act.author ?? null,
        avatarUrl: act.avatarUrl ?? commitAvatarBySha.get(sha) ?? null,
        sha,
        shortSha: shortenSha(sha),
        subject,
        commitCount: 1,
        forcePushed: false,
        bodyText: readActivityString(act, "bodyText"),
      });
    } else if (act.type === "force_push") {
      const beforeSha = readActivityString(act, "beforeSha");
      const afterSha = readActivityString(act, "afterSha");
      // Same key the commit rail uses (`||` so an empty afterSha falls through),
      // so selecting the rail's force-push entry scrolls to this event.
      const sha = afterSha || readActivityString(act, "sha") || act.id;
      events.push({
        id: `fpush:${act.id}`,
        type: "commit_push",
        timestamp: act.timestamp,
        author: act.author ?? null,
        avatarUrl: act.avatarUrl ?? null,
        sha,
        shortSha: shortenSha(sha),
        subject: readActivityString(act, "subject") ?? "Force-pushed",
        commitCount: 1,
        forcePushed: true,
        beforeSha,
        afterSha,
      });
    } else if (act.type === "label") {
      const action = readActivityString(act, "action") === "removed" ? "removed" : "added";
      const label = readActivityString(act, "label") ?? "";
      events.push({
        id: `label:${act.id}`,
        type: "label_change",
        timestamp: act.timestamp,
        author: act.author ?? null,
        avatarUrl: act.avatarUrl ?? null,
        action,
        label,
        color: readActivityString(act, "color"),
      });
    } else if (act.type === "state_change") {
      const newState = readActivityString(act, "state");
      if (newState === "merged") {
        events.push({
          id: `merge:${act.id}`,
          type: "merge",
          timestamp: act.timestamp,
          author: act.author ?? null,
          avatarUrl: act.avatarUrl ?? null,
          mergeCommitSha: readActivityString(act, "mergeCommitSha"),
          method: null,
          baseBranch: args.pr.baseBranch ?? null,
        });
      } else if (
        newState === "closed"
        || newState === "reopened"
        || newState === "ready_for_review"
        || newState === "converted_to_draft"
      ) {
        events.push({
          id: `lifecycle:${act.id}`,
          type: "lifecycle",
          timestamp: act.timestamp,
          author: act.author ?? null,
          avatarUrl: act.avatarUrl ?? null,
          state: newState,
          commitSha: readActivityString(act, "commitSha"),
        });
      }
    } else if (act.type === "review_request") {
      const action = readActivityString(act, "action") === "removed" ? "removed" : "added";
      const reviewer = readActivityString(act, "reviewer");
      const team = readActivityString(act, "team");
      // Skip empty requests where neither a reviewer nor a team is known.
      if (reviewer || team) {
        events.push({
          id: `review-req:${act.id}`,
          type: "review_request",
          timestamp: act.timestamp,
          author: act.author ?? null,
          avatarUrl: act.avatarUrl ?? null,
          reviewer: reviewer ?? team ?? "",
          team,
          action,
        });
      }
    } else if (act.type === "cross_referenced") {
      const refNumber = readActivityNumber(act, "refNumber");
      const rawState = readActivityString(act, "referencedState");
      const referencedState =
        rawState === "closed" || rawState === "merged" || rawState === "draft" ? rawState : "open";
      if (refNumber !== null) {
        events.push({
          id: `xref:${act.id}`,
          type: "cross_reference",
          timestamp: act.timestamp,
          author: act.author ?? null,
          avatarUrl: act.avatarUrl ?? null,
          refNumber,
          refTitle: readActivityString(act, "refTitle") ?? "",
          refUrl: readActivityString(act, "refUrl") ?? "",
          referencedState,
          isPullRequest: readActivityBoolean(act, "isPullRequest"),
        });
      }
    } else if (act.type === "renamed") {
      events.push({
        id: `renamed:${act.id}`,
        type: "renamed",
        timestamp: act.timestamp,
        author: act.author ?? null,
        avatarUrl: act.avatarUrl ?? null,
        from: readActivityString(act, "from") ?? "",
        to: readActivityString(act, "to") ?? "",
      });
    } else if (act.type === "assigned") {
      const assignee = readActivityString(act, "assignee");
      const action = readActivityString(act, "action") === "removed" ? "removed" : "added";
      if (assignee) {
        events.push({
          id: `assign:${act.id}`,
          type: "assignment",
          timestamp: act.timestamp,
          author: act.author ?? null,
          avatarUrl: act.avatarUrl ?? null,
          action,
          assignee,
          assigneeAvatarUrl: readActivityString(act, "assigneeAvatarUrl"),
        });
      }
    } else if (act.type === "head_ref_change") {
      const rawAction = readActivityString(act, "action");
      const action =
        rawAction === "restored" ? "restored" : rawAction === "base_changed" ? "base_changed" : "deleted";
      events.push({
        id: `branchref:${act.id}`,
        type: "branch_ref",
        timestamp: act.timestamp,
        author: act.author ?? null,
        avatarUrl: act.avatarUrl ?? null,
        action,
        branch: readActivityString(act, "branch") ?? "",
        fromBranch: readActivityString(act, "fromBranch"),
      });
    } else if (act.type === "review_dismissed") {
      events.push({
        id: `dismissed:${act.id}`,
        type: "review_dismissed",
        timestamp: act.timestamp,
        author: act.author ?? null,
        avatarUrl: act.avatarUrl ?? null,
        reviewer: readActivityString(act, "reviewer"),
        reason: readActivityString(act, "reason"),
      });
    }
  }

  const seenCommitShas = new Set(
    events
      .filter((event): event is Extract<PrTimelineEvent, { type: "commit_push" }> => event.type === "commit_push")
      .map((event) => event.sha),
  );
  for (const commit of args.commits ?? []) {
    if (!commit.sha || seenCommitShas.has(commit.sha)) continue;
    seenCommitShas.add(commit.sha);
    events.push({
      id: `commit:${commit.sha}`,
      type: "commit_push",
      timestamp: commit.committedDate || args.pr.createdAt || new Date(0).toISOString(),
      author: commit.author.login ?? commit.author.name ?? null,
      avatarUrl: commit.author.avatarUrl ?? null,
      sha: commit.sha,
      shortSha: commit.shortSha || shortenSha(commit.sha),
      subject: commit.message,
      commitCount: 1,
      forcePushed: false,
    });
  }

  // Reviews
  for (const review of args.reviews) {
    // Skip inline-only "commented" reviews with no summary body. GitHub does not
    // show these as standalone "X reviewed" rows — their inline comments surface
    // as the review-thread blocks instead. Approvals / changes-requested /
    // dismissals (and reviews with a real summary body) still render.
    if (isBodylessCommentedReview(review.state, review.body)) continue;
    const ts = review.submittedAt ?? args.pr.createdAt ?? new Date(0).toISOString();
    events.push({
      id: `review:${review.reviewer}:${ts}`,
      type: "review",
      timestamp: ts,
      author: review.reviewer,
      avatarUrl: review.reviewerAvatarUrl,
      reviewId: `${review.reviewer}:${ts}`,
      state: review.state,
      body: review.body,
      isBot: isBotLogin(review.reviewer),
    });
  }

  // Review threads
  for (const thread of args.reviewThreads) {
    events.push({
      id: `thread:${thread.id}`,
      type: "review_thread",
      timestamp: threadTimestamp(thread),
      author: threadFirstCommentAuthor(thread),
      avatarUrl: threadFirstCommentAvatar(thread),
      threadId: thread.id,
      path: thread.path,
      line: thread.line,
      startLine: thread.startLine,
      originalLine: thread.originalLine,
      originalStartLine: thread.originalStartLine,
      diffSide: thread.diffSide,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      commentCount: thread.comments.length,
      firstCommentBody: threadFirstCommentBody(thread),
      comments: thread.comments,
    });
  }

  // Issue comments (not tied to a review thread).
  for (const comment of args.comments) {
    if (comment.source !== "issue") continue;
    events.push({
      id: `comment:${comment.id}`,
      type: "issue_comment",
      timestamp: comment.createdAt ?? new Date(0).toISOString(),
      author: comment.author,
      avatarUrl: comment.authorAvatarUrl,
      commentId: comment.id,
      body: comment.body,
      isBot: isBotLogin(comment.author),
    });
  }

  const seenCommentIds = new Set(
    events
      .filter((event): event is Extract<PrTimelineEvent, { type: "issue_comment" }> => event.type === "issue_comment")
      .map((event) => event.commentId),
  );
  const seenReviewIds = new Set(
    events
      .filter((event): event is Extract<PrTimelineEvent, { type: "review" }> => event.type === "review")
      .map((event) => event.reviewId),
  );
  for (const act of args.activity) {
    if (act.type === "comment") {
      const source = readActivityString(act, "source") ?? "issue";
      if (source !== "issue" || seenCommentIds.has(act.id)) continue;
      seenCommentIds.add(act.id);
      events.push({
        id: `comment:${act.id}`,
        type: "issue_comment",
        timestamp: act.timestamp || new Date(0).toISOString(),
        author: act.author,
        avatarUrl: act.avatarUrl,
        commentId: act.id,
        body: act.body,
        isBot: isBotLogin(act.author),
      });
      continue;
    }
    if (act.type === "review") {
      const reviewId = `${act.author}:${act.timestamp}`;
      if (seenReviewIds.has(reviewId)) continue;
      seenReviewIds.add(reviewId);
      const state = (readActivityString(act, "state") ?? "commented") as PrReview["state"];
      // Same as the reviews loop: inline-only commented reviews are represented
      // by their thread blocks, not a standalone "X reviewed" row.
      if (isBodylessCommentedReview(state, act.body)) continue;
      events.push({
        id: `activity-review:${act.id}`,
        type: "review",
        timestamp: act.timestamp || new Date(0).toISOString(),
        author: act.author,
        avatarUrl: act.avatarUrl,
        reviewId,
        state,
        body: act.body,
        isBot: isBotLogin(act.author),
      });
    }
  }

  // Checks live in the left rail and CI / Checks tab — not the overview feed.

  // Deployments
  for (const dep of args.deployments) {
    events.push({
      id: `deploy:${dep.id}`,
      type: "deployment",
      timestamp: dep.updatedAt ?? dep.createdAt ?? new Date(0).toISOString(),
      author: dep.creator,
      avatarUrl: null,
      deploymentId: dep.id,
      environment: dep.environment,
      state: dep.state,
      environmentUrl: dep.environmentUrl,
    });
  }

  // Pin the description to the top regardless of timestamp integrity. Adopted/
  // linked PRs can carry a wrong `createdAt`, which would otherwise sink the
  // description below later activity; GitHub always renders it first.
  const sorted = stableSortByTs(events);
  const descIndex = sorted.findIndex((event) => event.type === "description");
  if (descIndex > 0) {
    const [description] = sorted.splice(descIndex, 1);
    sorted.unshift(description!);
  }
  return sorted;
}

export function buildCommitRailCommits(
  activity: PrActivityEvent[],
  commitSnapshots: PrCommit[],
  reviewThreads: PrReviewThread[],
): PrCommitRailCommit[] {
  const commits: PrCommitRailCommit[] = [];
  for (const act of activity) {
    if (act.type !== "commit" && act.type !== "force_push") continue;
    const forcePushed = act.type === "force_push";
    // Match the EXACT sha the timeline event keys on (a force-push uses its
    // afterSha) so selecting a rail entry scrolls to it. Use `||` not `??` so an
    // empty-string sha falls through to a non-empty, unique id.
    const afterSha = forcePushed ? readActivityString(act, "afterSha") : null;
    const sha = afterSha || readActivityString(act, "sha") || act.id;
    const subject = readActivityString(act, "subject") ?? act.body ?? (forcePushed ? "Force-pushed branch" : "");
    commits.push({
      sha,
      shortSha: shortenSha(sha),
      subject,
      author: act.author ?? "unknown",
      authoredAt: act.timestamp,
      threadCount: 0,
      resolvedCount: 0,
      forcePushed,
    });
  }
  const seen = new Set(commits.map((commit) => commit.sha));
  for (const commit of commitSnapshots) {
    if (!commit.sha || seen.has(commit.sha)) continue;
    seen.add(commit.sha);
    commits.push({
      sha: commit.sha,
      shortSha: commit.shortSha || shortenSha(commit.sha),
      subject: commit.message,
      author: commit.author.login ?? commit.author.name ?? "unknown",
      authoredAt: commit.committedDate,
      threadCount: 0,
      resolvedCount: 0,
    });
  }
  // Best-effort: attribute resolved/unresolved thread counts to the latest commit
  // touching the relevant file. Without commit<->file diff history, bucket them
  // into the most recent commit.
  if (commits.length > 0) {
    const last = commits[commits.length - 1]!;
    for (const thread of reviewThreads) {
      last.threadCount += 1;
      if (thread.isResolved) last.resolvedCount += 1;
    }
  }
  return commits;
}

export const PrDetailTimelineRails = forwardRef<PrDetailTimelineRailsRef, Props>(
  function PrDetailTimelineRails(props, ref) {
    const {
      pr,
      detail,
      status,
      checks,
      reviews,
      comments,
      activity,
      commits: commitSnapshots,
      files,
      reviewThreads,
      deployments,
      viewerLogin,
      filters,
      onFiltersChange,
      aiSummary,
      aiSummaryDismissed,
      onDismissAiSummary,
      onRegenerateAiSummary,
      commentDraft,
      setCommentDraft,
      actionBusy,
      onAddComment,
      deepLink,
      actionRuns,
      onSelectCheck,
      onOpenChecksTab,
      onRerunChecks,
      onOpenFilesTab,
      mergeMethod,
      showReviewerEditor,
      setShowReviewerEditor,
      reviewerInput,
      setReviewerInput,
      showLabelEditor,
      setShowLabelEditor,
      labelInput,
      setLabelInput,
      onMerge,
      onUpdateBranch,
      updateBranchBusy,
      updateBranchNotice,
      onRequestReviewers,
      onSetLabels,
      onDeleteBranch,
      deleteBranchBusy,
      lane,
      onOpenManageLane,
      onClose,
      onReopen,
      onSubmitReview,
    } = props;

    const timelineRef = useRef<PrTimelineRef | null>(null);
    const navigate = useNavigate();
    const location = useLocation();
    const [activeCommitSha, setActiveCommitSha] = useState<string | null>(null);
    const [paletteKind, setPaletteKind] = useState<PaletteKind | null>(null);

    const events = useMemo(
      () =>
        buildTimelineEvents({
          pr,
          detail,
          activity,
          commits: commitSnapshots,
          reviews,
          reviewThreads,
          comments,
          checks,
          deployments,
        }),
      [pr, detail, activity, commitSnapshots, reviews, reviewThreads, comments, checks, deployments],
    );

    const commits = useMemo(
      () => buildCommitRailCommits(activity, commitSnapshots, reviewThreads),
      [activity, commitSnapshots, reviewThreads],
    );

    const handleSelectCommit = useCallback(
      (sha: string) => {
        setActiveCommitSha(sha);
        const target = events.find((e) => e.type === "commit_push" && e.sha === sha);
        if (target) {
          timelineRef.current?.scrollToEventId(target.id);
          timelineRef.current?.focusEvent(target.id);
        }
      },
      [events],
    );

    const paletteCommits = useMemo(
      () => commits.map((c) => ({ sha: c.sha, subject: c.subject, author: c.author })),
      [commits],
    );
    const paletteThreads = useMemo(
      () =>
        reviewThreads.map((t) => ({
          id: t.id,
          path: t.path,
          line: t.line,
          resolved: t.isResolved,
          firstCommentAuthor: threadFirstCommentAuthor(t),
        })),
      [reviewThreads],
    );
    const paletteFiles = useMemo(
      () =>
        files.map((f) => ({
          path: f.filename,
          additions: f.additions,
          deletions: f.deletions,
        })),
      [files],
    );

    useImperativeHandle(
      ref,
      () => ({
        scrollToEventId: (id) => timelineRef.current?.scrollToEventId(id),
        focusEvent: (id) => timelineRef.current?.focusEvent(id),
        nextUnresolvedThread: () => timelineRef.current?.nextUnresolved(),
        prevUnresolvedThread: () => timelineRef.current?.prevUnresolved(),
        openPalette: (kind) => setPaletteKind(kind),
        closePalette: () => setPaletteKind(null),
      }),
      [],
    );

    // Honor deep-link params once the event list is ready.
    const deepLinkAppliedRef = useRef<string | null>(null);
    useEffect(() => {
      const key = `${deepLink.eventId ?? ""}|${deepLink.threadId ?? ""}|${deepLink.commitSha ?? ""}`;
      if (!key || key === "||") return;
      if (deepLinkAppliedRef.current === key) return;
      if (events.length === 0) return;
      deepLinkAppliedRef.current = key;
      const target =
        (deepLink.eventId && events.find((e) => e.id === deepLink.eventId)) ||
        (deepLink.threadId && events.find((e) => e.type === "review_thread" && e.threadId === deepLink.threadId)) ||
        (deepLink.commitSha && events.find((e) => e.type === "commit_push" && e.sha === deepLink.commitSha));
      if (target) {
        timelineRef.current?.focusEvent(target.id);
      }
      if (deepLink.commitSha) setActiveCommitSha(deepLink.commitSha);
    }, [deepLink, events]);

    // Scroll → URL round-trip. Write eventId to the URL (replace) as the user
    // scrolls, so the address bar reflects the current position for sharing.
    const locationSearchRef = useRef(location.search);
    const locationHashRef = useRef(location.hash);
    const locationPathnameRef = useRef(location.pathname);
    useEffect(() => {
      locationSearchRef.current = location.search;
      locationHashRef.current = location.hash;
      locationPathnameRef.current = location.pathname;
    }, [location.hash, location.pathname, location.search]);
    const handleVisibleEventChange = useCallback(
      (eventId: string | null) => {
        const current = parsePrsRouteState({
          search: locationSearchRef.current,
          hash: locationHashRef.current,
        });
        if ((current.eventId ?? null) === eventId) return;
        // Only write URL for the selected PR. Coordinate-only routes have no
        // local id, so match those by repository and GitHub number.
        const selectedByCoordinates = current.prNumber != null
          && prRouteCoordinatesMatch(
            { prNumber: current.prNumber, repoOwner: current.repoOwner, repoName: current.repoName },
            { prNumber: pr.githubPrNumber, repoOwner: pr.repoOwner, repoName: pr.repoName },
          );
        if (current.prId !== pr.id && !selectedByCoordinates) return;
        const nextSearch = buildTimelineVisibleEventSearch({ current, prId: pr.id, eventId });
        if (nextSearch === locationSearchRef.current) return;
        void navigate({ pathname: locationPathnameRef.current, search: nextSearch }, { replace: true });
      },
      [navigate, pr.githubPrNumber, pr.id, pr.repoName, pr.repoOwner],
    );

    const summaryForTimeline = aiSummaryDismissed ? null : aiSummary ?? null;

    // Per-project persisted rail widths. Read once per project — the Group is
    // keyed on projectId below so switching projects remounts with its own
    // remembered layout rather than carrying the previous one over.
    const leftWidthKey = railWidthKey(OVERVIEW_LEFT_RAIL_WIDTH_KEY, pr.projectId);
    const rightWidthKey = railWidthKey(OVERVIEW_RIGHT_RAIL_WIDTH_KEY, pr.projectId);
    const defaultLeftPx = useMemo(
      () => readPersistedRailPx(leftWidthKey, LEFT_RAIL_MIN_PX, LEFT_RAIL_MAX_PX, LEFT_RAIL_DEFAULT_PX),
      [leftWidthKey],
    );
    const defaultRightPx = useMemo(
      () => readPersistedRailPx(rightWidthKey, RIGHT_RAIL_MIN_PX, RIGHT_RAIL_MAX_PX, RIGHT_RAIL_DEFAULT_PX),
      [rightWidthKey],
    );

    return (
      <>
      <Group
        key={pr.projectId ?? "no-project"}
        id="pr-overview-rails"
        orientation="horizontal"
        className="flex h-full min-h-0 w-full"
        style={{ padding: SPACING.sm, background: COLORS.prSurface }}
        data-testid="pr-detail-timeline-rails"
      >
        {/* LEFT — "what changed": commits (grows) + files changed (capped). */}
        <Panel
          id="pr-overview-left-rail"
          defaultSize={defaultLeftPx}
          minSize={LEFT_RAIL_MIN_PX}
          maxSize={LEFT_RAIL_MAX_PX}
          groupResizeBehavior="preserve-pixel-size"
          onResize={(size) => persistRailPx(leftWidthKey, size.inPixels)}
          className="flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden"
          data-testid="pr-detail-left-rail"
        >
          <div
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
            style={floatingPane({ padding: 0 })}
          >
            <PrCommitRail
              layout="pane"
              commits={commits}
              activeSha={activeCommitSha}
              onSelectCommit={handleSelectCommit}
            />
          </div>
          <PrFilesChangedCard files={files} onOpenFilesTab={onOpenFilesTab} maxHeight="38%" />
        </Panel>

        <RailSeparator id="pr-overview-left-separator" />

        <Panel id="pr-overview-thread" minSize={CENTER_MIN_PX} className="flex min-h-0 min-w-0 flex-col">
          <PrTimeline
            ref={timelineRef}
            events={events}
            prId={pr.id}
            laneId={pr.laneId}
            repoOwner={pr.repoOwner}
            repoName={pr.repoName}
            viewerLogin={viewerLogin}
            filters={filters}
            onFiltersChange={onFiltersChange}
            summary={summaryForTimeline}
            onRegenerateSummary={onRegenerateAiSummary}
            onDismissSummary={onDismissAiSummary}
            onVisibleEventChange={handleVisibleEventChange}
            footer={
              <PrCommentComposer
                value={commentDraft}
                onChange={setCommentDraft}
                repoOwner={pr.repoOwner}
                repoName={pr.repoName}
                busy={actionBusy}
                onSubmit={onAddComment}
                lockedMessage={pr.laneId ? undefined : "Map this PR to a lane to comment"}
              />
            }
          />
        </Panel>

        <RailSeparator id="pr-overview-right-separator" />

        {/* RIGHT — "can this land", in the order you resolve it: who → what's
            running (the growth target) → can I merge (pinned to the bottom). */}
        <Panel
          id="pr-overview-right-rail"
          defaultSize={defaultRightPx}
          minSize={RIGHT_RAIL_MIN_PX}
          maxSize={RIGHT_RAIL_MAX_PX}
          groupResizeBehavior="preserve-pixel-size"
          onResize={(size) => persistRailPx(rightWidthKey, size.inPixels)}
          className="flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden"
          data-testid="pr-detail-right-rail"
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <PrDetailRightMetadataRail
              pr={pr}
              lane={lane}
              detail={detail}
              status={status}
              reviews={reviews}
              checks={checks}
              actionRuns={actionRuns}
              showReviewerEditor={showReviewerEditor}
              setShowReviewerEditor={setShowReviewerEditor}
              reviewerInput={reviewerInput}
              setReviewerInput={setReviewerInput}
              showLabelEditor={showLabelEditor}
              setShowLabelEditor={setShowLabelEditor}
              labelInput={labelInput}
              setLabelInput={setLabelInput}
              onRequestReviewers={onRequestReviewers}
              onSetLabels={onSetLabels}
              actionBusy={actionBusy}
              onSubmitReview={onSubmitReview}
              onSelectCheck={onSelectCheck}
              onOpenChecksTab={onOpenChecksTab}
              onRerunChecks={onRerunChecks}
            />
          </div>

          <div
            className="flex shrink-0 flex-col overflow-hidden"
            style={floatingPane({ padding: 0, maxHeight: "52%" })}
            data-testid="pr-detail-merge-pane"
          >
            <div className="min-h-0 overflow-y-auto">
              {pr.stack ? (
                <div style={{ display: "grid", gap: 10, padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#C4B5FD" }}>
                    <Stack size={16} weight="fill" />
                    <span style={{ fontFamily: SANS_FONT, fontSize: 12, fontWeight: 700 }}>
                      GitHub Stack {pr.stack.position} of {pr.stack.size}
                    </span>
                  </div>
                  <p style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 11, lineHeight: 1.5, color: COLORS.textMuted }}>
                    GitHub manages this stack&apos;s rebases, review requirements, and merge order. Finish the merge on GitHub.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      void window.ade.app.openExternal(pr.githubUrl);
                    }}
                    style={primaryButton({ height: 34, justifyContent: "center" })}
                  >
                    <ArrowSquareOut size={13} />
                    Review and merge on GitHub
                  </button>
                </div>
              ) : (
                <PrDetailMergeRail
                  pr={pr}
                  status={status}
                  checks={checks}
                  reviews={reviews}
                  commits={commitSnapshots}
                  mergeMethod={mergeMethod}
                  actionBusy={actionBusy}
                  onMerge={onMerge}
                  onUpdateBranch={onUpdateBranch}
                  updateBranchBusy={updateBranchBusy}
                  updateBranchNotice={updateBranchNotice}
                  onDeleteBranch={onDeleteBranch}
                  deleteBranchBusy={deleteBranchBusy}
                  onOpenManageLane={onOpenManageLane}
                  onClose={onClose}
                  onReopen={onReopen}
                />
              )}
            </div>
          </div>
        </Panel>
      </Group>

      {/* Outside the Group: only Panel/Separator may be Group children. */}
      <PrCommandPalettes
        open={paletteKind}
        onClose={() => setPaletteKind(null)}
        commits={paletteCommits}
        threads={paletteThreads}
        files={paletteFiles}
        onPickCommit={(sha) => {
          setPaletteKind(null);
          handleSelectCommit(sha);
        }}
        onPickThread={(id) => {
          setPaletteKind(null);
          const target = events.find(
            (e) => e.type === "review_thread" && e.threadId === id,
          );
          if (target) timelineRef.current?.focusEvent(target.id);
        }}
        onPickFile={(path) => {
          setPaletteKind(null);
          if (!path) return;
          navigate("/files", {
            state: {
              openFilePath: path,
              laneId: pr.laneId,
              mode: "diff",
            },
          });
        }}
      />
      </>
    );
  },
);
