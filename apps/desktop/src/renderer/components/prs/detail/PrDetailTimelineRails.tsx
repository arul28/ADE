import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { buildPrsRouteSearch, parsePrsRouteState } from "../prsRouteState";
import type {
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
import { PrTimeline, DEFAULT_PR_TIMELINE_FILTERS, type PrTimelineFilters, type PrTimelineRef } from "../shared/PrTimeline";
import { PrCommitRail, type PrCommitRailCommit } from "../shared/PrCommitRail";
import { PrStatusRail, type PrStatusRailMergeState } from "../shared/PrStatusRail";
import { PrCommandPalettes, type PaletteKind } from "../shared/PrCommandPalettes";
import { PrCheckLogDrawer } from "../shared/PrCheckLogDrawer";
import { COLORS } from "../../lanes/laneDesignTokens";

export type PrDetailTimelineRailsRef = {
  scrollToEventId: (id: string) => void;
  focusEvent: (id: string) => void;
  nextUnresolvedThread: () => void;
  prevUnresolvedThread: () => void;
  openPalette: (kind: PaletteKind) => void;
  closePalette: () => void;
};

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
  deepLink: { eventId: string | null; threadId: string | null; commitSha: string | null };
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

  // Description as first event.
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

  // Checks — one event per check (latest state).
  for (const check of args.checks) {
    const ts = check.completedAt ?? check.startedAt ?? args.pr.updatedAt ?? new Date(0).toISOString();
    events.push({
      id: `check:${check.name}:${ts}`,
      type: "check_update",
      timestamp: ts,
      author: null,
      avatarUrl: null,
      checkName: check.name,
      status: check.status,
      conclusion: check.conclusion,
      detailsUrl: check.detailsUrl,
    });
  }

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

function deriveMergeState(
  pr: PrWithConflicts,
  status: PrStatus | null,
  reviews: PrReview[],
  checks: PrCheck[],
): PrStatusRailMergeState {
  const approvals = reviews.filter((r) => r.state === "approved").length;
  const failingChecks = checks.filter((c) => c.status === "completed" && (c.conclusion === "failure" || c.conclusion === "cancelled")).length;
  const pendingChecks = checks.filter((c) => c.status !== "completed").length;
  const mergeable: "clean" | "dirty" | "unknown" = status
    ? status.mergeConflicts
      ? "dirty"
      : status.isMergeable
        ? "clean"
        : "unknown"
    : "unknown";
  return {
    mergeable,
    hasConflicts: Boolean(status?.mergeConflicts),
    approvals,
    requiredApprovals: null,
    failingChecks,
    pendingChecks,
    githubUrl: pr.githubUrl,
  };
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
      deepLink,
    } = props;

    const timelineRef = useRef<PrTimelineRef | null>(null);
    const navigate = useNavigate();
    const location = useLocation();
    const [activeCommitSha, setActiveCommitSha] = useState<string | null>(null);
    const [logDrawerCheck, setLogDrawerCheck] = useState<PrCheck | null>(null);
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

    const mergeState = useMemo(
      () => deriveMergeState(pr, status, reviews, checks),
      [pr, status, reviews, checks],
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

    const handleOpenLog = useCallback((check: PrCheck) => {
      setLogDrawerCheck(check);
    }, []);

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
        const tab = current.tab === "github" || current.tab === "normal" ? current.tab : "normal";
        const nextSearch = buildPrsRouteSearch({
          activeTab: tab,
          selectedPrId: pr.id,
          selectedQueueGroupId: null,
          selectedRebaseItemId: null,
          eventId,
          threadId: current.threadId,
          commitSha: current.commitSha,
        });
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
          <PrCommitRail
            commits={commits}
            activeSha={activeCommitSha}
            viewerLogin={viewerLogin}
            onSelectCommit={handleSelectCommit}
          />
        </div>

        <div className="min-h-0">
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

        <div className="min-h-0">
          <PrStatusRail
            checks={checks}
            deployments={deployments}
            mergeState={mergeState}
            onOpenLog={handleOpenLog}
            onOpenExternal={handleOpenExternal}
          />
        </div>

        <PrCheckLogDrawer check={logDrawerCheck} onClose={() => setLogDrawerCheck(null)} />

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

export { DEFAULT_PR_TIMELINE_FILTERS };
