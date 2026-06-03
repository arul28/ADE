import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { buildPrsRouteSearch, parsePrsRouteState, type ParsedPrsRouteState } from "../prsRouteState";
import type {
  LaneSummary,
  MergeMethod,
  PrActivityEvent,
  PrAiSummary,
  PrCheck,
  PrCommit,
  PrComment,
  PrDeployment,
  PrDetail,
  PrReview,
  PrReviewThread,
  PrStatus,
  PrTimelineEvent,
  PrWithConflicts,
} from "../../../../shared/types";
import { PrTimeline, type PrTimelineFilters, type PrTimelineRef } from "../shared/PrTimeline";
import { PrDetailLeftRail } from "../shared/PrDetailLeftRail";
import type { PrCommitRailCommit } from "../shared/PrCommitRail";
import { PrDetailRightRail } from "../shared/PrDetailRightRail";
import type { ReviewerRequest } from "../shared/PrDetailRightMetadataRail";
import { PrCommentComposer } from "../shared/PrCommentComposer";
import { deriveParticipants } from "../shared/prMergeRailUtils";
import { PrCommandPalettes, type PaletteKind } from "../shared/PrCommandPalettes";
import type { PrReviewEvent } from "../shared/PrReviewSubmitModal";
import { COLORS } from "../../lanes/laneDesignTokens";

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
    selectedPrId: args.prId,
    selectedQueueGroupId: null,
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
  onSelectCheck?: (check: PrCheck) => void;
  onOpenChecksTab?: () => void;
  mergeMethod: MergeMethod;
  showReviewerEditor: boolean;
  setShowReviewerEditor: (value: boolean) => void;
  reviewerInput: string;
  setReviewerInput: (value: string) => void;
  showLabelEditor: boolean;
  setShowLabelEditor: (value: boolean) => void;
  labelInput: string;
  setLabelInput: (value: string) => void;
  onMerge: (method: MergeMethod, options?: { bypassRules?: boolean }) => void;
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

function readActivityString(event: PrActivityEvent, key: string): string | null {
  const value = (event.metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
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
  return thread.updatedAt ?? thread.createdAt ?? new Date(0).toISOString();
}

function stableSortByTs<T extends { timestamp: string }>(events: T[]): T[] {
  return [...events].sort((a, b) => {
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return -1;
    if (Number.isNaN(tb)) return 1;
    return ta - tb;
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

  events.push({
    id: `opened:${args.pr.id}`,
    type: "pr_opened",
    timestamp: args.pr.createdAt ?? new Date(0).toISOString(),
    author: args.detail?.author?.login ?? null,
    avatarUrl: args.detail?.author?.avatarUrl ?? null,
    title: args.pr.title,
    githubPrNumber: args.pr.githubPrNumber,
    repoOwner: args.pr.repoOwner,
    repoName: args.pr.repoName,
    baseBranch: args.pr.baseBranch,
    headBranch: args.pr.headBranch,
    isDraft: args.detail?.isDraft ?? args.pr.state === "draft",
    additions: args.pr.additions,
    deletions: args.pr.deletions,
  });

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
        avatarUrl: act.avatarUrl ?? null,
        sha,
        shortSha: shortenSha(sha),
        subject,
        commitCount: 1,
        forcePushed: false,
      });
    } else if (act.type === "force_push") {
      const sha = readActivityString(act, "sha") ?? act.id;
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
        });
      }
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
      timestamp: commit.committedDate || args.pr.updatedAt || new Date(0).toISOString(),
      author: commit.author.login ?? commit.author.name ?? null,
      avatarUrl: null,
      sha: commit.sha,
      shortSha: commit.shortSha || shortenSha(commit.sha),
      subject: commit.message,
      commitCount: 1,
      forcePushed: false,
    });
  }

  // Reviews
  for (const review of args.reviews) {
    const ts = review.submittedAt ?? args.pr.updatedAt ?? new Date(0).toISOString();
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
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      commentCount: thread.comments.length,
      firstCommentBody: threadFirstCommentBody(thread),
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

  return stableSortByTs(events);
}

function buildCommitRailCommits(
  activity: PrActivityEvent[],
  commitSnapshots: PrCommit[],
  reviewThreads: PrReviewThread[],
): PrCommitRailCommit[] {
  const commits: PrCommitRailCommit[] = [];
  for (const act of activity) {
    if (act.type !== "commit" && act.type !== "force_push") continue;
    const sha = readActivityString(act, "sha") ?? act.id;
    const subject = readActivityString(act, "subject") ?? act.body ?? "";
    commits.push({
      sha,
      shortSha: shortenSha(sha),
      subject,
      author: act.author ?? "unknown",
      authoredAt: act.timestamp,
      threadCount: 0,
      resolvedCount: 0,
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
      onSelectCheck,
      onOpenChecksTab,
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

    const participants = useMemo(
      () => deriveParticipants({ detail, reviews, comments }),
      [detail, reviews, comments],
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

    const handleOpenExternal = useCallback((url: string) => {
      if (!url) return;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      } catch {
        return;
      }
      const opener = window.ade?.app?.openExternal;
      if (opener) {
        void opener(url).catch((err: unknown) => {
          console.warn("[PrDetailTimelineRails] openExternal failed", { url, err });
        });
      }
    }, []);

    const handleOpenLog = useCallback(
      (check: PrCheck) => {
        if (!check.detailsUrl) return;
        handleOpenExternal(check.detailsUrl);
      },
      [handleOpenExternal],
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
    const locationPathnameRef = useRef(location.pathname);
    useEffect(() => {
      locationSearchRef.current = location.search;
      locationPathnameRef.current = location.pathname;
    }, [location.pathname, location.search]);
    const handleVisibleEventChange = useCallback(
      (eventId: string | null) => {
        const current = parsePrsRouteState({ search: locationSearchRef.current });
        if ((current.eventId ?? null) === eventId) return;
        // Only write URL for PR-scoped tabs with a selected PR.
        if (current.prId !== pr.id) return;
        const nextSearch = buildTimelineVisibleEventSearch({ current, prId: pr.id, eventId });
        if (nextSearch === locationSearchRef.current) return;
        void navigate({ pathname: locationPathnameRef.current, search: nextSearch }, { replace: true });
      },
      [pr.id, navigate],
    );

    const summaryForTimeline = aiSummaryDismissed ? null : aiSummary ?? null;

    return (
      <div
        className="grid h-full min-h-0 w-full"
        style={{
          gridTemplateColumns: "220px minmax(0, 1fr) 260px",
          gridTemplateRows: "minmax(0, 1fr)",
          background: COLORS.pageBg,
        }}
        data-testid="pr-detail-timeline-rails"
      >
        <div className="min-h-0">
          <PrDetailLeftRail
            commits={commits}
            activeSha={activeCommitSha}
            onSelectCommit={handleSelectCommit}
            checks={checks}
            onOpenLog={handleOpenLog}
            onSelectCheck={onSelectCheck}
            onOpenChecksTab={onOpenChecksTab}
          />
        </div>

        <div className="flex min-h-0 flex-col">
          <div className="min-h-0 flex-1">
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
            />
          </div>
          <PrCommentComposer
            value={commentDraft}
            onChange={setCommentDraft}
            busy={actionBusy}
            onSubmit={onAddComment}
          />
        </div>

        <div className="min-h-0">
          <PrDetailRightRail
            pr={pr}
            detail={detail}
            status={status}
            checks={checks}
            reviews={reviews}
            comments={comments}
            participants={participants}
            mergeMethod={mergeMethod}
            actionBusy={actionBusy}
            lane={lane}
            onOpenManageLane={onOpenManageLane}
            showReviewerEditor={showReviewerEditor}
            setShowReviewerEditor={setShowReviewerEditor}
            reviewerInput={reviewerInput}
            setReviewerInput={setReviewerInput}
            showLabelEditor={showLabelEditor}
            setShowLabelEditor={setShowLabelEditor}
            labelInput={labelInput}
            setLabelInput={setLabelInput}
            onMerge={onMerge}
            onRequestReviewers={onRequestReviewers}
            onSetLabels={onSetLabels}
            onDeleteBranch={onDeleteBranch}
            deleteBranchBusy={deleteBranchBusy}
            onClose={onClose}
            onReopen={onReopen}
            onSubmitReview={onSubmitReview}
          />
        </div>

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
      </div>
    );
  },
);
