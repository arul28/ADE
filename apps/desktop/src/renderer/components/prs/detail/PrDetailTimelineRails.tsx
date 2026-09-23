import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ChatCircleText, GitMerge, Tag, UserCircle, Users } from "@phosphor-icons/react";
import { buildPrsRouteSearch, parsePrsRouteState, prRouteCoordinatesMatch, type ParsedPrsRouteState } from "../prsRouteState";
import type {
  MergeMethod,
  PrActionRun,
  PrActivityEvent,
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
  ReviewerRequest,
  UpdateBranchStrategy,
} from "../../../../shared/types";
import { PrTimeline, type PrTimelineRef } from "../shared/PrTimeline";
import { PrCommandPalettes, type PaletteKind } from "../shared/PrCommandPalettes";
import type { PrReviewEvent } from "../shared/PrReviewSubmitModal";
import type { PrMergeDialogResult } from "../shared/PrMergeDialog";
import { COLORS } from "../../lanes/laneDesignTokens";
import { buildDigestTimelineModel, type DigestPushTick } from "../shared/prDigestTimelineModel";
import { PrPushTickRail } from "../shared/PrPushTickRail";
import {
  NEXT_STEP_TONE_COLOR,
  PrAssigneesCard,
  PrCommentCard,
  PrFloatingDock,
  PrLabelsCard,
  PrMergeCard,
  PrReviewersCard,
  collectPrReviewers,
  type PrDockId,
  type PrDockItem,
  type PrMergeCardActions,
  type PrMergeCardButton,
} from "../shared/PrFloatingDock";
import { buildUnifiedChecks, summarizePipelineStates } from "../shared/prUnifiedChecks";
import { buildPrChatPrompt, prFailingCheckNames, prOpenFindings } from "../shared/prChatActions";
import { resolvePrNextStepFromStatus, type PrNextStepAction } from "../../../../shared/prNextStep";
import { isPrBotAuthor } from "../../../../shared/prBotIdentity";
import { PR_DESCRIPTION_BOT_EVENT_PREFIX, splitPrBodyBotSections } from "../../../../shared/prBodyBotSections";
import type { PrNeedsAttentionItem } from "../../../../shared/prConversationDigest";
import { PrMarkdownEnvContext, type PrMarkdownEnv } from "../shared/prMarkdownContext";
import { usePrs } from "../state/PrsContext";

/**
 * The Overview is one column: the thread, with the push tick rail and the
 * floating dock laid over its right edge. There is no rail to protect any
 * more, so the floor is what the thread and one open dock card need.
 */
export const PR_OVERVIEW_MIN_PX = 520;

/** The PR state changes the Merge card can ask the host to make. */
export type PrStateAction = Extract<PrNextStepAction, "ready_for_review" | "enable_auto_merge" | "disable_auto_merge">;

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

export function buildTimelineVisibleEventHash(args: {
  currentHash: string;
  nextSearch: string;
}): string | null {
  if (!args.currentHash.startsWith("#/prs")) return null;
  const queryIndex = args.currentHash.indexOf("?");
  const routePrefix = queryIndex >= 0 ? args.currentHash.slice(0, queryIndex) : args.currentHash;
  return `${routePrefix}${args.nextSearch}`;
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
  writeViewerLogin?: string | null;
  commentDraft: string;
  setCommentDraft: (value: string) => void;
  actionBusy: boolean;
  onAddComment: () => void;
  deepLink: { eventId: string | null; threadId: string | null; commitSha: string | null };
  actionRuns: PrActionRun[];
  onOpenChecksTab?: () => void;
  onRerunChecks?: (target?: PrRerunChecksTarget) => void;
  mergeMethod: MergeMethod;
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
  onReopen?: () => void;
  onSubmitReview: (event: PrReviewEvent, body: string) => void;
  /** Put a prompt in the PR's chat (linked, else a new lane chat). Omitted without a lane. */
  onHandPrompt?: (prompt: string) => void;
  /** Draft and auto-merge toggles from the Merge card. */
  onPrStateAction?: (action: PrStateAction) => Promise<void>;
  /** A file chip in the description: open that file's diff in the Files tab. */
  onOpenPrFile?: (path: string) => void;
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
    // Bots append to the description (CodeRabbit notes, Cursor summary, Devin
    // badge). Keep the description the author's; each block becomes that
    // bot's comment, dated at PR creation so it lands in the first section.
    const split = splitPrBodyBotSections(args.detail.body);
    const openedAt = args.pr.createdAt ?? new Date(0).toISOString();
    events.push({
      id: `desc:${args.pr.id}`,
      type: "description",
      timestamp: openedAt,
      author: args.detail.author?.login ?? null,
      avatarUrl: args.detail.author?.avatarUrl ?? null,
      body: split.body,
      subjectId: args.detail.nodeId ?? null,
      reactions: args.detail.reactions ?? [],
    });
    for (const section of split.sections) {
      events.push({
        id: `${PR_DESCRIPTION_BOT_EVENT_PREFIX}${args.pr.id}:${section.id}`,
        type: "issue_comment",
        timestamp: openedAt,
        author: section.login,
        avatarUrl: null,
        commentId: `${PR_DESCRIPTION_BOT_EVENT_PREFIX}${section.id}`,
        body: section.body,
        isBot: true,
      });
    }
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
      isBot: isPrBotAuthor(review.reviewer, review.reviewerIsBot),
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
        isBot: isPrBotAuthor(comment.author, comment.authorIsBot),
        commentGithubId: comment.githubId ?? null,
        commentNodeId: comment.nodeId ?? null,
        reactions: comment.reactions ?? [],
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
        isBot: isPrBotAuthor(act.author),
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
        isBot: isPrBotAuthor(act.author),
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

/** A commit (or force-push marker) as the commit palette lists it. */
export type PrCommitTick = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authoredAt: string;
  /** True for the force-push entry (a branch action, not a real commit). */
  forcePushed?: boolean;
};

export function buildCommitRailCommits(
  activity: PrActivityEvent[],
  commitSnapshots: PrCommit[],
): PrCommitTick[] {
  const commits: PrCommitTick[] = [];
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
    });
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
      writeViewerLogin,
      commentDraft,
      setCommentDraft,
      actionBusy,
      onAddComment,
      deepLink,
      actionRuns,
      onOpenChecksTab,
      onRerunChecks,
      mergeMethod,
      onMerge,
      onUpdateBranch,
      updateBranchBusy,
      updateBranchNotice,
      onRequestReviewers,
      onSetLabels,
      onDeleteBranch,
      deleteBranchBusy,
      onReopen,
      onSubmitReview,
      onHandPrompt,
      onPrStateAction,
      onOpenPrFile,
    } = props;
    const { prs: repoPrs } = usePrs();

    const timelineRef = useRef<PrTimelineRef | null>(null);
    const navigate = useNavigate();
    const location = useLocation();
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
      () => buildCommitRailCommits(activity, commitSnapshots),
      [activity, commitSnapshots],
    );

    const handleSelectCommit = useCallback(
      (sha: string) => {
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
        const nextHash = buildTimelineVisibleEventHash({
          currentHash: locationHashRef.current,
          nextSearch,
        });
        if (nextHash
          ? nextHash === locationHashRef.current
          : nextSearch === locationSearchRef.current) return;
        void navigate({
          pathname: locationPathnameRef.current,
          search: nextHash ? locationSearchRef.current : nextSearch,
          ...(nextHash ? { hash: nextHash } : {}),
        }, { replace: true });
      },
      [navigate, pr.githubPrNumber, pr.id, pr.repoName, pr.repoOwner],
    );

    const commandPalettes = (
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
    );

    const digestModel = useMemo(() => buildDigestTimelineModel(events), [events]);

    // Which push section the reader is in: the last push at or above the
    // top-most visible row. Drives the rail's active tick.
    const pushByEventId = useMemo(() => {
      const map = new Map<string, string>();
      let current: string | null = null;
      for (const item of digestModel.items) {
        if (item.kind === "push") current = item.push.id;
        if (!current) continue;
        if (item.kind === "event") map.set(item.event.id, current);
        else if (item.kind === "bot-group") for (const event of item.events) map.set(event.id, current);
        else if (item.kind === "push") for (const commit of item.commits) map.set(commit.id, current);
      }
      return map;
    }, [digestModel]);
    const [activeTickId, setActiveTickId] = useState<string | null>(null);
    const handleVisible = useCallback((eventId: string | null) => {
      setActiveTickId(eventId ? pushByEventId.get(eventId) ?? null : null);
      handleVisibleEventChange(eventId);
    }, [handleVisibleEventChange, pushByEventId]);
    const handleSelectTick = useCallback((tick: DigestPushTick) => {
      setActiveTickId(tick.id);
      timelineRef.current?.scrollToEventId(tick.id);
    }, []);

    // ── The next step and the Merge card ────────────────────────────────
    const unifiedChecks = useMemo(() => buildUnifiedChecks(checks, actionRuns), [checks, actionRuns]);
    const checkBuckets = useMemo(() => summarizePipelineStates(unifiedChecks), [unifiedChecks]);
    const reviewers = useMemo(() => collectPrReviewers(detail, reviews), [detail, reviews]);
    const openFindings = useMemo(() => prOpenFindings(reviewThreads), [reviewThreads]);
    const nextStep = useMemo(() => resolvePrNextStepFromStatus({
      state: pr.state,
      baseBranch: pr.baseBranch,
      status,
      checks: {
        failing: checkBuckets.failed,
        pending: checkBuckets.running + checkBuckets.queued,
        passing: checkBuckets.passed,
      },
      reviews,
      unresolvedThreads: openFindings.length,
      fallback: { mergeConflicts: pr.mergeConflicts, behindBaseBy: pr.behindBaseBy, checksStatus: pr.checksStatus },
    }), [checkBuckets, openFindings.length, pr, reviews, status]);

    const [dockOpen, setDockOpen] = useState<PrDockId | null>("merge");
    const [busyAction, setBusyAction] = useState<PrNextStepAction | null>(null);
    const [deleteArmed, setDeleteArmed] = useState(false);
    useEffect(() => {
      setDockOpen("merge");
      setDeleteArmed(false);
    }, [pr.id]);

    const findingsPrompt = useCallback(
      () => buildPrChatPrompt("fix_findings", pr, { findings: openFindings }),
      [openFindings, pr],
    );

    const runStepAction = useCallback((action: PrNextStepAction) => {
      const busy = async (work: () => Promise<void> | void) => {
        setBusyAction(action);
        try {
          await work();
        } finally {
          setBusyAction(null);
        }
      };
      switch (action) {
        case "delete_branch":
          if (!deleteArmed) {
            setDeleteArmed(true);
            window.setTimeout(() => setDeleteArmed(false), 4000);
            return;
          }
          setDeleteArmed(false);
          onDeleteBranch?.();
          return;
        case "reopen":
          onReopen?.();
          return;
        case "ready_for_review":
        case "enable_auto_merge":
        case "disable_auto_merge":
          void busy(() => onPrStateAction?.(action));
          return;
        case "update_branch":
          onUpdateBranch?.("merge");
          return;
        case "rerun_checks":
          onRerunChecks?.();
          return;
        case "fix_checks":
          if (onHandPrompt) onHandPrompt(buildPrChatPrompt("fix_checks", pr, { failingChecks: prFailingCheckNames(unifiedChecks) }));
          else onOpenChecksTab?.();
          return;
        case "resolve_conflicts":
          if (onHandPrompt) onHandPrompt(buildPrChatPrompt("resolve_conflicts", pr));
          else void window.ade.app.openExternal(`${pr.githubUrl}/conflicts`);
          return;
        case "address_feedback":
        case "fix_threads":
          if (onHandPrompt) onHandPrompt(findingsPrompt());
          else if (digestModel.digest.needsAttention[0]) timelineRef.current?.focusEvent(digestModel.digest.needsAttention[0].entry.id);
          return;
        case "request_review":
          setDockOpen("reviewers");
          return;
        case "merge":
          return;
      }
    }, [deleteArmed, digestModel, findingsPrompt, onDeleteBranch, onHandPrompt, onOpenChecksTab, onPrStateAction, onReopen, onRerunChecks, onUpdateBranch, pr, unifiedChecks]);

    const mergeActions = useMemo<PrMergeCardActions>(() => {
      const labelFor = (action: PrNextStepAction): string => {
        switch (action) {
          case "delete_branch": return deleteArmed ? "Click again to delete" : "Delete branch";
          case "reopen": return "Reopen";
          case "ready_for_review": return "Ready for review";
          case "resolve_conflicts": return onHandPrompt ? "Resolve in chat" : "Resolve on GitHub";
          case "update_branch": return updateBranchBusy ? "Updating…" : "Update branch";
          case "fix_checks": return onHandPrompt ? "Fix in chat" : "Open checks";
          case "rerun_checks": return "Re-run checks";
          case "address_feedback": return "Address in chat";
          case "enable_auto_merge": return "Enable auto-merge";
          case "disable_auto_merge": return "Turn off auto-merge";
          case "request_review": return "Request review";
          case "fix_threads": return onHandPrompt ? "Fix threads in chat" : "Show open threads";
          case "merge": return "Merge…";
        }
      };
      // The host cannot run some actions here (no lane → no chat hand-off).
      const isAvailable = (action: PrNextStepAction): boolean => {
        if (action === "address_feedback") return Boolean(onHandPrompt);
        if (action === "delete_branch") return Boolean(onDeleteBranch);
        if (action === "reopen") return Boolean(onReopen);
        if (action === "update_branch") return Boolean(onUpdateBranch);
        if (action === "rerun_checks") return Boolean(onRerunChecks);
        if (action === "ready_for_review" || action === "enable_auto_merge" || action === "disable_auto_merge") return Boolean(onPrStateAction);
        return true;
      };
      const button = (action: PrNextStepAction | null): PrMergeCardButton | null => {
        if (!action || !isAvailable(action)) return null;
        return {
          action,
          label: labelFor(action),
          busy: busyAction === action
            || (action === "update_branch" && Boolean(updateBranchBusy))
            || (action === "delete_branch" && Boolean(deleteBranchBusy)),
        };
      };
      return {
        primary: button(nextStep.primary),
        secondary: button(nextStep.secondary),
        run: runStepAction,
        onChip: (chip) => {
          if (chip.id === "checks") onOpenChecksTab?.();
          else if (chip.id === "review") setDockOpen("reviewers");
          else if (chip.id === "threads" && digestModel.digest.needsAttention[0]) {
            timelineRef.current?.focusEvent(digestModel.digest.needsAttention[0].entry.id);
          }
        },
      };
    }, [busyAction, deleteArmed, deleteBranchBusy, digestModel, nextStep.primary, nextStep.secondary, onDeleteBranch, onHandPrompt, onOpenChecksTab, onPrStateAction, onReopen, onRerunChecks, onUpdateBranch, runStepAction, updateBranchBusy]);

    const handleDialogMerge = useCallback((result: PrMergeDialogResult) => {
      onMerge(result.method, {
        bypassRules: result.bypassRules,
        commitTitle: result.commitTitle,
        commitBody: result.commitBody,
        expectedHeadSha: result.expectedHeadSha,
      });
    }, [onMerge]);

    const handleFixInChat = useCallback((item: PrNeedsAttentionItem) => {
      if (!onHandPrompt) return;
      onHandPrompt(buildPrChatPrompt("fix_findings", pr, {
        findings: [{
          author: item.entry.author,
          path: item.entry.path ?? null,
          line: item.entry.line ?? null,
          body: item.entry.body,
          url: item.entry.url,
        }],
      }));
    }, [onHandPrompt, pr]);

    const markdownEnv = useMemo<PrMarkdownEnv>(() => {
      const prStateByNumber = new Map<number, PrWithConflicts["state"]>();
      for (const other of repoPrs) {
        if (other.repoOwner === pr.repoOwner && other.repoName === pr.repoName) prStateByNumber.set(other.githubPrNumber, other.state);
      }
      return {
        prFiles: files.map((file) => file.filename),
        prStateByNumber,
        onOpenFile: (path, inPr) => {
          if (inPr && onOpenPrFile) {
            onOpenPrFile(path);
            return;
          }
          navigate("/files", { state: { openFilePath: path, laneId: pr.laneId } });
        },
        onOpenPr: (number) => {
          void navigate({
            pathname: "/prs",
            search: buildPrsRouteSearch({
              activeTab: "github",
              selectedPrId: null,
              selectedPrNumber: number,
              repoOwner: pr.repoOwner,
              repoName: pr.repoName,
              selectedRebaseItemId: null,
            }),
          });
        },
      };
    }, [files, navigate, onOpenPrFile, pr.laneId, pr.repoName, pr.repoOwner, repoPrs]);

    const closeDock = useCallback(() => setDockOpen(null), []);
    const dockItems = useMemo<PrDockItem[]>(() => {
      const reviewerCount = reviewers.length;
      return [
        {
          id: "merge",
          label: "Merge status",
          icon: GitMerge,
          ringColor: NEXT_STEP_TONE_COLOR[nextStep.tone],
          pulseKey: nextStep.kind,
          cardWidth: 380,
          content: (
            <PrMergeCard
              pr={pr}
              status={status}
              step={nextStep}
              commits={commitSnapshots}
              mergeMethod={mergeMethod}
              actionBusy={actionBusy}
              actions={mergeActions}
              onMerge={handleDialogMerge}
              notice={updateBranchNotice}
              onClose={closeDock}
            />
          ),
        },
        {
          id: "comment",
          label: "Comment",
          icon: ChatCircleText,
          cardWidth: 520,
          content: (
            <PrCommentCard
              pr={pr}
              draft={commentDraft}
              setDraft={setCommentDraft}
              busy={actionBusy}
              onComment={onAddComment}
              onSubmitReview={onSubmitReview}
              onClose={closeDock}
            />
          ),
        },
        {
          id: "reviewers",
          label: "Reviewers",
          icon: Users,
          badge: reviewerCount || null,
          content: <PrReviewersCard detail={detail} reviews={reviews} onRequestReviewers={onRequestReviewers} onClose={closeDock} />,
        },
        {
          id: "labels",
          label: "Labels",
          icon: Tag,
          badge: detail?.labels?.length || null,
          content: <PrLabelsCard detail={detail} onSetLabels={onSetLabels} onClose={closeDock} />,
        },
        {
          id: "assignees",
          label: "Assignees",
          icon: UserCircle,
          badge: detail?.assignees?.length || null,
          content: <PrAssigneesCard detail={detail} onClose={closeDock} />,
        },
      ];
    }, [actionBusy, closeDock, commentDraft, commitSnapshots, detail, handleDialogMerge, mergeActions, mergeMethod, nextStep, onAddComment, onRequestReviewers, onSetLabels, onSubmitReview, pr, reviewers, reviews, setCommentDraft, status, updateBranchNotice]);

    return (
      <>
        <div
          className="ade-pr-overview relative flex h-full min-h-0 w-full flex-col"
          style={{ background: COLORS.prSurface, containerType: "inline-size", containerName: "pr-overview" }}
          data-testid="pr-detail-timeline-rails"
        >
          <div className="relative flex min-h-0 flex-1 flex-col" data-testid="pr-detail-thread-panel" style={{ paddingRight: 18 }}>
            <PrMarkdownEnvContext.Provider value={markdownEnv}>
            <PrTimeline
              ref={timelineRef}
              events={events}
              digest={digestModel}
              prId={pr.id}
              laneId={pr.laneId}
              repoOwner={pr.repoOwner}
              repoName={pr.repoName}
              viewerLogin={viewerLogin}
              writeViewerLogin={writeViewerLogin}
              onVisibleEventChange={handleVisible}
              onFixInChat={onHandPrompt ? handleFixInChat : undefined}
              bottomInset={dockOpen ? 300 : 120}
            />
            </PrMarkdownEnvContext.Provider>
          </div>
          <PrPushTickRail ticks={digestModel.ticks} activeId={activeTickId} onSelect={handleSelectTick} />
          <PrFloatingDock items={dockItems} openId={dockOpen} onOpenChange={setDockOpen} />
        </div>
        {commandPalettes}
      </>
    );
  },
);
