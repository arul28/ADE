import type { Logger } from "../logging/logger";
import type {
  AutomationTriggerIssueContext,
  AutomationTriggerPrContext,
  AutomationTriggerType,
} from "../../../shared/types";
import type { GithubService, GitHubIssue, GitHubPullRequest } from "../github/githubService";

type AutomationServiceHandle = {
  getIngressCursor(source: "github-polling" | "linear-relay" | "github-relay" | "local-webhook"): string | null;
  setIngressCursor(args: { source: "github-polling"; cursor: string | null }): void;
  dispatchIngressTrigger(args: {
    source: "github-polling";
    eventKey: string;
    triggerType: AutomationTriggerType;
    eventName?: string | null;
    summary?: string | null;
    author?: string | null;
    labels?: string[];
    keywords?: string[];
    branch?: string | null;
    targetBranch?: string | null;
    draftState?: "draft" | "ready" | "any";
    cursor?: string | null;
    rawPayload?: Record<string, unknown> | null;
    repo?: string | null;
    issue?: AutomationTriggerIssueContext | null;
    pr?: AutomationTriggerPrContext | null;
  }): Promise<unknown>;
};

type RepoRef = { owner: string; name: string };

type GithubPollingServiceArgs = {
  logger: Logger;
  githubService: GithubService;
  automationService: AutomationServiceHandle;
  /** Extra repos to poll in addition to the detected origin. */
  extraRepos?: RepoRef[];
  pollIntervalMs?: number;
};

const DEFAULT_POLL_INTERVAL_MS = 30_000;

function labelsToStrings(raw: GitHubIssue["labels"] | GitHubPullRequest["labels"]): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === "string") return entry.trim();
      if (entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string") {
        return ((entry as { name: string }).name ?? "").trim();
      }
      return "";
    })
    .filter(Boolean);
}

function repoSlug(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

function issueContext(repo: RepoRef, issue: GitHubIssue): AutomationTriggerIssueContext {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? undefined,
    author: issue.user?.login ?? undefined,
    labels: labelsToStrings(issue.labels),
    repo: repoSlug(repo),
    url: issue.html_url,
  };
}

function prContext(repo: RepoRef, pr: GitHubPullRequest): AutomationTriggerPrContext {
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? undefined,
    author: pr.user?.login ?? undefined,
    labels: labelsToStrings(pr.labels),
    repo: repoSlug(repo),
    url: pr.html_url,
    baseBranch: pr.base?.ref,
    headBranch: pr.head?.ref,
    draft: pr.draft ?? undefined,
    merged: pr.merged ?? Boolean(pr.merged_at),
  };
}

type IssueSnapshot = {
  labels: string[];
  updatedAt: string;
  state: "open" | "closed";
  commentCount: number;
};

type PrSnapshot = {
  updatedAt: string;
  state: "open" | "closed";
  merged: boolean;
  mergedAt: string | null;
  commentCount: number;
  title: string;
  body: string | null;
  draft: boolean | null;
  baseRef: string | null;
  baseSha: string | null;
  headRef: string | null;
  headSha: string | null;
  labels: string[];
};

type ParsedCommentCursor = {
  createdAt: string;
  id: number;
};

function parseCursorPart(part: string): { key: string; value: string } | null {
  const eqIdx = part.indexOf("=");
  if (eqIdx <= 0) return null;
  const key = part.slice(0, eqIdx);
  const value = part.slice(eqIdx + 1);
  if (!key || !value) return null;
  return { key, value };
}

function parseCommentCursor(value: string | undefined): ParsedCommentCursor | null {
  if (!value) return null;
  const [createdAt, rawId] = value.split("#");
  const id = Number(rawId);
  return { createdAt, id: Number.isFinite(id) ? id : 0 };
}

function formatCommentCursor(comment: { created_at: string; id: number }): string {
  return `${comment.created_at}#${comment.id}`;
}

function isCommentAtOrBeforeCursor(
  comment: { created_at: string; id: number },
  cursor: ParsedCommentCursor,
): boolean {
  if (comment.created_at < cursor.createdAt) return true;
  if (comment.created_at > cursor.createdAt) return false;
  return comment.id <= cursor.id;
}

function isCommentAfterCursor(
  comment: { created_at: string; id: number },
  cursor: ParsedCommentCursor,
): boolean {
  return !isCommentAtOrBeforeCursor(comment, cursor);
}

function prSnapshot(pr: GitHubPullRequest): PrSnapshot {
  return {
    updatedAt: pr.updated_at,
    state: pr.state,
    merged: Boolean(pr.merged ?? pr.merged_at),
    mergedAt: pr.merged_at ?? null,
    commentCount: pr.comments ?? 0,
    title: pr.title,
    body: pr.body ?? null,
    draft: typeof pr.draft === "boolean" ? pr.draft : null,
    baseRef: pr.base?.ref ?? null,
    baseSha: pr.base?.sha ?? null,
    headRef: pr.head?.ref ?? null,
    headSha: pr.head?.sha ?? null,
    labels: labelsToStrings(pr.labels),
  };
}

function hasPrContentChange(prev: PrSnapshot, current: PrSnapshot): boolean {
  return prev.title !== current.title
    || prev.body !== current.body
    || prev.draft !== current.draft
    || prev.baseRef !== current.baseRef
    || prev.baseSha !== current.baseSha
    || prev.headRef !== current.headRef
    || prev.headSha !== current.headSha
    || prev.labels.join("|") !== current.labels.join("|");
}

export function createGithubPollingService(args: GithubPollingServiceArgs) {
  const { logger, githubService, automationService } = args;
  const pollIntervalMs = Math.max(10_000, Math.floor(args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));

  // Per-repo memory of last-seen issue/PR state so we can diff on each poll
  // and emit `edited`/`labeled`/`closed` events without a webhook feed.
  const issueSnapshots = new Map<string, Map<number, IssueSnapshot>>();
  const prSnapshots = new Map<string, Map<number, PrSnapshot>>();
  const commentCursors = new Map<string, string>(); // key: `${slug}:${issueNumber}` → last-seen `${created_at}#${id}`
  const reviewCursors = new Map<string, string>(); // key: `${slug}:${prNumber}` → last-seen submitted_at

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let stopped = false;

  const listRepos = async (): Promise<RepoRef[]> => {
    const out: RepoRef[] = [];
    const seen = new Set<string>();
    try {
      const detected = await githubService.detectRepo();
      if (detected) {
        const key = repoSlug(detected);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(detected);
        }
      }
    } catch {
      // ignore detection errors
    }
    for (const repo of args.extraRepos ?? []) {
      const key = repoSlug(repo);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(repo);
    }
    return out;
  };

  const readCursor = (repo: RepoRef): string | null => {
    try {
      // Storage formats we must read: bare `<iso>` for the very-first-ever poll
      // (legacy), `<slug>=<iso>` when a single repo has been polled under the
      // new format, and `<slug>=<iso>|<slug>=<iso>` for multi-repo.
      const stored = automationService.getIngressCursor("github-polling");
      if (!stored) return null;
      const slug = repoSlug(repo);
      if (stored.includes("|")) {
        for (const part of stored.split("|")) {
          const parsed = parseCursorPart(part);
          if (parsed?.key === slug) return parsed.value;
        }
        return null;
      }
      if (stored.includes("=")) {
        const parsed = parseCursorPart(stored);
        if (parsed?.key === slug) return parsed.value;
        return null;
      }
      return stored;
    } catch {
      return null;
    }
  };

  const writeCursor = (repo: RepoRef, cursor: string) => {
    try {
      const prev = automationService.getIngressCursor("github-polling") ?? "";
      const slug = repoSlug(repo);
      const parts = new Map<string, string>();
      for (const part of prev.split("|").filter(Boolean)) {
        const parsed = parseCursorPart(part);
        if (parsed) parts.set(parsed.key, parsed.value);
      }
      parts.set(slug, cursor);
      const joined = [...parts.entries()].map(([k, v]) => `${k}=${v}`).join("|");
      automationService.setIngressCursor({ source: "github-polling", cursor: joined });
    } catch (error) {
      logger.warn("automations.github_polling.cursor_write_failed", {
        repo: repoSlug(repo),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const dispatch = async (
    repo: RepoRef,
    triggerType: AutomationTriggerType,
    eventKey: string,
    ctx: { issue?: AutomationTriggerIssueContext; pr?: AutomationTriggerPrContext; summary: string; rawPayload?: Record<string, unknown> },
  ) => {
    try {
      await automationService.dispatchIngressTrigger({
        source: "github-polling",
        eventKey,
        triggerType,
        eventName: triggerType,
        summary: ctx.summary,
        author: ctx.issue?.author ?? ctx.pr?.author ?? null,
        labels: ctx.issue?.labels ?? ctx.pr?.labels ?? [],
        branch: ctx.pr?.headBranch ?? null,
        targetBranch: ctx.pr?.baseBranch ?? null,
        draftState: ctx.pr?.draft === true ? "draft" : ctx.pr?.draft === false ? "ready" : "any",
        repo: repoSlug(repo),
        issue: ctx.issue ?? null,
        pr: ctx.pr ?? null,
        rawPayload: ctx.rawPayload ?? null,
      });
    } catch (error) {
      logger.warn("automations.github_polling.dispatch_failed", {
        triggerType,
        eventKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const pollIssues = async (repo: RepoRef, since: string | undefined): Promise<string | null> => {
    const issues = await githubService.listRepoIssues(repo.owner, repo.name, {
      state: "all",
      sort: "updated",
      since,
    });
    // GitHub's `issues` endpoint mixes PRs in. Filter those out.
    const realIssues = issues.filter((row) => !row.pull_request);
    let maxUpdatedAt: string | null = null;
    const snapshotByRepo = issueSnapshots.get(repoSlug(repo)) ?? new Map<number, IssueSnapshot>();
    issueSnapshots.set(repoSlug(repo), snapshotByRepo);

    for (const issue of realIssues) {
      if (!maxUpdatedAt || issue.updated_at > maxUpdatedAt) maxUpdatedAt = issue.updated_at;
      const prev = snapshotByRepo.get(issue.number);
      const currentLabels = labelsToStrings(issue.labels);
      const ctx = issueContext(repo, issue);

      if (!prev) {
        // First time seeing this issue. On the very first poll (since is
        // undefined) we treat pre-existing issues as "known" and don't emit
        // `issue_opened` retroactively. If `since` is set, anything we haven't
        // seen but whose `created_at === updated_at` is an open event.
        const isNew = issue.created_at === issue.updated_at;
        if (since !== undefined && isNew) {
          await dispatch(repo, "github.issue_opened", `${repoSlug(repo)}#${issue.number}:opened`, {
            issue: ctx,
            summary: `Issue #${issue.number} opened: ${issue.title}`,
          });
        }
        snapshotByRepo.set(issue.number, {
          labels: currentLabels,
          updatedAt: issue.updated_at,
          state: issue.state,
          commentCount: issue.comments ?? 0,
        });
        if (since === undefined && (issue.comments ?? 0) > 0) {
          await pollComments(repo, issue.number, since, ctx, /* isPr */ false, /* emit */ false);
        }
        continue;
      }

      const newCommentCount = issue.comments ?? prev.commentCount;
      if (
        prev.updatedAt === issue.updated_at &&
        prev.state === issue.state &&
        prev.commentCount === newCommentCount &&
        prev.labels.join("|") === currentLabels.join("|")
      ) {
        continue;
      }

      // Label diff
      const addedLabels = currentLabels.filter((l) => !prev.labels.includes(l));
      if (addedLabels.length) {
        await dispatch(repo, "github.issue_labeled", `${repoSlug(repo)}#${issue.number}:labeled:${issue.updated_at}:${addedLabels.join(",")}`, {
          issue: ctx,
          summary: `Issue #${issue.number} labeled: ${addedLabels.join(", ")}`,
          rawPayload: { addedLabels },
        });
      }

      // State transition
      if (prev.state === "open" && issue.state === "closed") {
        await dispatch(repo, "github.issue_closed", `${repoSlug(repo)}#${issue.number}:closed:${issue.updated_at}`, {
          issue: ctx,
          summary: `Issue #${issue.number} closed: ${issue.title}`,
        });
      }

      // Generic edit (title/body changed without state/label change)
      if (
        prev.updatedAt !== issue.updated_at &&
        prev.state === issue.state &&
        !addedLabels.length &&
        newCommentCount === prev.commentCount
      ) {
        await dispatch(repo, "github.issue_edited", `${repoSlug(repo)}#${issue.number}:edited:${issue.updated_at}`, {
          issue: ctx,
          summary: `Issue #${issue.number} edited: ${issue.title}`,
        });
      }

      snapshotByRepo.set(issue.number, {
        labels: currentLabels,
        updatedAt: issue.updated_at,
        state: issue.state,
        commentCount: issue.comments ?? prev.commentCount,
      });

      // New comments. The `issues` endpoint gives us a count; if it grew we
      // fetch comments since the last cursor.
      if (newCommentCount > prev.commentCount) {
        await pollComments(repo, issue.number, since, ctx, /* isPr */ false);
      }
    }

    return maxUpdatedAt;
  };

  const pollPulls = async (repo: RepoRef, since: string | undefined): Promise<string | null> => {
    const pulls = await githubService.listRepoPulls(repo.owner, repo.name, {
      state: "all",
      sort: "updated",
    });
    // The pulls endpoint doesn't accept `since`; filter client-side.
    const filtered = since ? pulls.filter((pr) => pr.updated_at > since) : pulls;
    let maxUpdatedAt: string | null = null;
    const snapshotByRepo = prSnapshots.get(repoSlug(repo)) ?? new Map<number, PrSnapshot>();
    prSnapshots.set(repoSlug(repo), snapshotByRepo);

    for (const pr of filtered) {
      if (!maxUpdatedAt || pr.updated_at > maxUpdatedAt) maxUpdatedAt = pr.updated_at;
      const prev = snapshotByRepo.get(pr.number);
      const ctx = prContext(repo, pr);
      const currentSnapshot = prSnapshot(pr);

      if (!prev) {
        const isNew = pr.created_at === pr.updated_at;
        if (since !== undefined && isNew) {
          await dispatch(repo, "github.pr_opened", `${repoSlug(repo)}#${pr.number}:pr_opened`, {
            pr: ctx,
            summary: `PR #${pr.number} opened: ${pr.title}`,
          });
        }
        snapshotByRepo.set(pr.number, currentSnapshot);
        if (since === undefined) {
          if ((pr.comments ?? 0) > 0) {
            await pollComments(repo, pr.number, since, ctx, /* isPr */ true, /* emit */ false);
          }
          await pollReviews(repo, pr.number, ctx, /* emit */ false);
        } else {
          await pollReviews(repo, pr.number, ctx);
        }
        continue;
      }

      const newCommentCount = pr.comments ?? 0;
      if (prev.updatedAt === pr.updated_at && prev.state === pr.state && prev.merged === Boolean(pr.merged ?? pr.merged_at) && prev.commentCount === newCommentCount) {
        continue;
      }

      if (prev.state === "open" && pr.state === "closed") {
        if (pr.merged || pr.merged_at) {
          await dispatch(repo, "github.pr_merged", `${repoSlug(repo)}#${pr.number}:pr_merged:${pr.merged_at ?? pr.updated_at}`, {
            pr: ctx,
            summary: `PR #${pr.number} merged: ${pr.title}`,
          });
        } else {
          await dispatch(repo, "github.pr_closed", `${repoSlug(repo)}#${pr.number}:pr_closed:${pr.updated_at}`, {
            pr: ctx,
            summary: `PR #${pr.number} closed: ${pr.title}`,
          });
        }
      } else if (prev.updatedAt !== pr.updated_at && hasPrContentChange(prev, currentSnapshot)) {
        await dispatch(repo, "github.pr_updated", `${repoSlug(repo)}#${pr.number}:pr_updated:${pr.updated_at}`, {
          pr: ctx,
          summary: `PR #${pr.number} updated: ${pr.title}`,
        });
      }

      if (newCommentCount > prev.commentCount) {
        await pollComments(repo, pr.number, since, ctx, /* isPr */ true);
      }
      await pollReviews(repo, pr.number, ctx);

      snapshotByRepo.set(pr.number, currentSnapshot);
    }

    return maxUpdatedAt;
  };

  const pollComments = async (
    repo: RepoRef,
    issueNumber: number,
    since: string | undefined,
    ctx: AutomationTriggerIssueContext | AutomationTriggerPrContext,
    isPr: boolean,
    emit = true,
  ) => {
    const key = `${repoSlug(repo)}:${issueNumber}`;
    const cursor = parseCommentCursor(commentCursors.get(key));
    const comments = await githubService.listIssueComments(repo.owner, repo.name, issueNumber, {
      since: cursor?.createdAt ?? since,
    });
    for (const comment of comments) {
      if (cursor && isCommentAtOrBeforeCursor(comment, cursor)) continue;
      if (emit) {
        await dispatch(
          repo,
          isPr ? "github.pr_commented" : "github.issue_commented",
          `${repoSlug(repo)}#${issueNumber}:comment:${comment.id}`,
          {
            issue: isPr ? undefined : { ...(ctx as AutomationTriggerIssueContext), body: comment.body },
            pr: isPr ? { ...(ctx as AutomationTriggerPrContext), body: comment.body } : undefined,
            summary: `${isPr ? "PR" : "Issue"} #${issueNumber} commented by ${comment.user?.login ?? "unknown"}`,
            rawPayload: { commentId: comment.id, body: comment.body },
          },
        );
      }
      const nextCursor = parseCommentCursor(commentCursors.get(key));
      if (!nextCursor || isCommentAfterCursor(comment, nextCursor)) {
        commentCursors.set(key, formatCommentCursor(comment));
      }
    }
  };

  const pollReviews = async (
    repo: RepoRef,
    prNumber: number,
    ctx: AutomationTriggerPrContext,
    emit = true,
  ) => {
    const key = `${repoSlug(repo)}:${prNumber}`;
    const cursor = reviewCursors.get(key);
    const reviews = await githubService.listPullRequestReviews(repo.owner, repo.name, prNumber);
    for (const review of reviews) {
      const submittedAt = review.submitted_at ?? "";
      if (!submittedAt) continue;
      if (cursor && submittedAt <= cursor) continue;
      if (emit) {
        await dispatch(repo, "github.pr_review_submitted", `${repoSlug(repo)}#${prNumber}:review:${review.id}`, {
          pr: { ...ctx, body: review.body ?? undefined },
          summary: `PR #${prNumber} review submitted by ${review.user?.login ?? "unknown"}`,
          rawPayload: { reviewId: review.id, state: review.state ?? null, body: review.body ?? null },
        });
      }
      const current = reviewCursors.get(key);
      if (!current || submittedAt > current) {
        reviewCursors.set(key, submittedAt);
      }
    }
  };

  const pollOnce = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const repos = await listRepos();
      for (const repo of repos) {
        try {
          const cursor = readCursor(repo) ?? undefined;
          const maxIssues = await pollIssues(repo, cursor);
          const maxPulls = await pollPulls(repo, cursor);
          const maxOverall = [maxIssues, maxPulls].filter((v): v is string => typeof v === "string").sort().at(-1);
          if (maxOverall && maxOverall !== cursor) {
            writeCursor(repo, maxOverall);
          }
        } catch (error) {
          logger.warn("automations.github_polling.repo_failed", {
            repo: repoSlug(repo),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    async start() {
      if (timer || stopped) return;
      // Kick off one poll on start, then schedule the interval.
      void pollOnce().catch(() => {});
      timer = setInterval(() => {
        void pollOnce().catch(() => {});
      }, pollIntervalMs);
    },
    async pollNow() {
      await pollOnce();
    },
    dispose() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

export type GithubPollingService = ReturnType<typeof createGithubPollingService>;
