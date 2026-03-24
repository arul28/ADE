import type { Logger } from "../logging/logger";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createPrService } from "./prService";
import type { PrEventPayload, PrNotificationKind, PrSummary } from "../../../shared/types";
import { nowIso } from "../shared/utils";

function clampMs(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function jitterMs(value: number): number {
  // +/- 10% jitter to avoid synchronized polling.
  const pct = 0.1;
  const delta = value * pct;
  const rand = (Math.random() * 2 - 1) * delta;
  return Math.max(1000, Math.round(value + rand));
}

function summarizeNotification(args: { kind: PrNotificationKind; pr: PrSummary }): { title: string; message: string } {
  if (args.kind === "checks_failing") {
    return {
      title: "Checks failing",
      message: "One or more required CI checks failed on this pull request.",
    };
  }
  if (args.kind === "review_requested") {
    return {
      title: "Review requested",
      message: "This pull request is waiting on an approving review.",
    };
  }
  if (args.kind === "changes_requested") {
    return {
      title: "Changes requested",
      message: "A reviewer requested changes before this pull request can merge.",
    };
  }
  return {
    title: "Ready to merge",
    message: "Required checks are passing and the pull request has approval.",
  };
}

/**
 * Build a fingerprint string from a PR, excluding volatile timing fields
 * (lastSyncedAt, createdAt, updatedAt, projectId) so that the polling
 * loop only fires events when meaningful PR data actually changes.
 */
function getPrFingerprint(pr: PrSummary): string {
  const { projectId: _, lastSyncedAt: _ls, createdAt: _ca, updatedAt: _ua, ...stable } = pr;
  return JSON.stringify(stable);
}

export function createPrPollingService({
  logger,
  prService,
  projectConfigService,
  onEvent,
  onPullRequestsChanged
}: {
  logger: Logger;
  prService: ReturnType<typeof createPrService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  onEvent: (event: PrEventPayload) => void;
  onPullRequestsChanged?: (args: {
    prs: PrSummary[];
    changedPrs: PrSummary[];
    changes: Array<{
      pr: PrSummary;
      previousState: PrSummary["state"] | null;
      previousChecksStatus: PrSummary["checksStatus"] | null;
      previousReviewStatus: PrSummary["reviewStatus"] | null;
    }>;
    polledAt: string;
  }) => void | Promise<void>;
}) {
  const DEFAULT_INTERVAL_MS = 60_000;
  const MIN_INTERVAL_MS = 5_000;
  const MAX_INTERVAL_MS = 5 * 60_000;

  const readIntervalMs = (): number => {
    const seconds = projectConfigService.get().effective.github?.prPollingIntervalSeconds;
    if (typeof seconds === "number" && Number.isFinite(seconds)) {
      return clampMs(Math.round(seconds * 1000), MIN_INTERVAL_MS, MAX_INTERVAL_MS);
    }
    return DEFAULT_INTERVAL_MS;
  };

  let stopped = false;
  let started = false;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let initialized = false;
  let consecutiveFailures = 0;
  let nextDelayOverrideMs: number | null = null;
  let rateLimitResumeAtMs = 0;
  let lastPrFingerprint = "";
  const lastFingerprintByPrId = new Map<string, string>();

  const lastByPrId = new Map<
    string,
    {
      checksStatus: PrSummary["checksStatus"];
      reviewStatus: PrSummary["reviewStatus"];
      state: PrSummary["state"];
      mergeReady: boolean;
    }
  >();

  const schedule = (delayMs: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void tick(), delayMs);
  };

  const computeBackoffMs = (): number => {
    const base = readIntervalMs();
    if (consecutiveFailures <= 0) return base;
    const factor = Math.min(6, consecutiveFailures);
    return clampMs(base * Math.pow(2, factor), base, MAX_INTERVAL_MS);
  };

  const poke = () => {
    if (stopped) return;
    if (running) return;
    if (rateLimitResumeAtMs > Date.now()) return;
    if (!started) {
      start();
    }
    schedule(0);
  };

  const tick = async () => {
    if (stopped) return;
    if (running) {
      schedule(jitterMs(readIntervalMs()));
      return;
    }
    running = true;

    const polledAt = nowIso();
    try {
      const existing = prService.listAll();
      if (existing.length === 0) {
        consecutiveFailures = 0;
        initialized = true;
        lastByPrId.clear();
        lastFingerprintByPrId.clear();
        if (lastPrFingerprint !== "[]") {
          onEvent({ type: "prs-updated", polledAt, prs: [] });
          lastPrFingerprint = "[]";
        }
        return;
      }

      const hotPrIds = prService.getHotRefreshPrIds();
      if (hotPrIds.length > 0) {
        await prService.refresh({ prIds: hotPrIds });
      } else {
        await prService.refresh();
      }
      const prs = prService.listAll();
      const fingerprintPrs = [...prs].sort((left, right) => left.id.localeCompare(right.id));

      // Only notify the renderer when PR data actually changed —
      // avoids unnecessary re-render cascades on every poll tick.
      const fingerprint = JSON.stringify(fingerprintPrs.map((p) => getPrFingerprint(p)));
      if (fingerprint !== lastPrFingerprint) {
        onEvent({ type: "prs-updated", polledAt, prs });
        lastPrFingerprint = fingerprint;
      }

      if (!initialized) {
        lastByPrId.clear();
        lastFingerprintByPrId.clear();
        for (const pr of prs) {
          lastByPrId.set(pr.id, {
            checksStatus: pr.checksStatus,
            reviewStatus: pr.reviewStatus,
            state: pr.state,
            mergeReady: pr.state === "open" && pr.checksStatus === "passing" && pr.reviewStatus === "approved"
          });
          lastFingerprintByPrId.set(pr.id, getPrFingerprint(pr));
        }
        initialized = true;
        consecutiveFailures = 0;
        return;
      }

      const changedPrs: PrSummary[] = [];
      const changes: Array<{
        pr: PrSummary;
        previousState: PrSummary["state"] | null;
        previousChecksStatus: PrSummary["checksStatus"] | null;
        previousReviewStatus: PrSummary["reviewStatus"] | null;
      }> = [];
      for (const pr of prs) {
        const prev = lastByPrId.get(pr.id) ?? null;
        const prevFingerprint = lastFingerprintByPrId.get(pr.id) ?? null;
        const nextFingerprint = getPrFingerprint(pr);
        const mergeReady = pr.state === "open" && pr.checksStatus === "passing" && pr.reviewStatus === "approved";
        const changed =
          !prev
          || prevFingerprint !== nextFingerprint
          || prev.checksStatus !== pr.checksStatus
          || prev.reviewStatus !== pr.reviewStatus
          || prev.state !== pr.state;
        if (changed) {
          changedPrs.push(pr);
          changes.push({
            pr,
            previousState: prev?.state ?? null,
            previousChecksStatus: prev?.checksStatus ?? null,
            previousReviewStatus: prev?.reviewStatus ?? null,
          });
        }

        const shouldNotify = (kind: PrNotificationKind): boolean => {
          if (pr.state !== "open" && pr.state !== "draft") return false;
          if (!prev) return false;
          if (kind === "checks_failing") return prev.checksStatus !== "failing" && pr.checksStatus === "failing";
          if (kind === "review_requested") return prev.reviewStatus !== "requested" && pr.reviewStatus === "requested";
          if (kind === "changes_requested") return prev.reviewStatus !== "changes_requested" && pr.reviewStatus === "changes_requested";
          if (kind === "merge_ready") return prev.mergeReady !== true && mergeReady === true && pr.state === "open";
          return false;
        };

        const kinds: PrNotificationKind[] = ["checks_failing", "review_requested", "changes_requested", "merge_ready"];
        for (const kind of kinds) {
          if (!shouldNotify(kind)) continue;
          const summary = summarizeNotification({ kind, pr });
          onEvent({
            type: "pr-notification",
            polledAt,
            kind,
            laneId: pr.laneId,
            prId: pr.id,
            prNumber: pr.githubPrNumber,
            title: summary.title,
            prTitle: pr.title ?? null,
            githubUrl: pr.githubUrl,
            message: summary.message,
            state: pr.state,
            checksStatus: pr.checksStatus,
            reviewStatus: pr.reviewStatus,
            repoOwner: pr.repoOwner ?? null,
            repoName: pr.repoName ?? null,
            headBranch: pr.headBranch ?? null,
            baseBranch: pr.baseBranch ?? null
          });
        }

        lastByPrId.set(pr.id, {
          checksStatus: pr.checksStatus,
          reviewStatus: pr.reviewStatus,
          state: pr.state,
          mergeReady
        });
        lastFingerprintByPrId.set(pr.id, nextFingerprint);
      }

      if (changedPrs.length > 0) {
        try {
          await onPullRequestsChanged?.({
            prs,
            changedPrs,
            changes,
            polledAt,
          });
        } catch (error) {
          logger.warn("prs.changed_hook_failed", {
            error: error instanceof Error ? error.message : String(error),
            prIds: changedPrs.map((pr) => pr.id),
          });
        }
      }

      // Drop any PRs removed from the DB.
      const seen = new Set(prs.map((pr) => pr.id));
      for (const prId of Array.from(lastByPrId.keys())) {
        if (!seen.has(prId)) {
          lastByPrId.delete(prId);
          lastFingerprintByPrId.delete(prId);
        }
      }

      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      logger.warn("prs.poll_failed", { error: error instanceof Error ? error.message : String(error) });

      const resetAtMs = (error as any)?.rateLimitResetAtMs;
      if (typeof resetAtMs === "number" && Number.isFinite(resetAtMs)) {
        // Wait until the rate limit actually resets (+ buffer). Don't clamp to MAX_INTERVAL_MS
        // because rate limits can take up to 60 minutes to reset.
        const untilReset = Math.max(10_000, resetAtMs - Date.now() + 5_000);
        nextDelayOverrideMs = untilReset;
        rateLimitResumeAtMs = Date.now() + untilReset;
      }
    } finally {
      running = false;
      const hotDelay = prService.getHotRefreshDelayMs();
      const base = hotDelay ?? computeBackoffMs();
      const delay = jitterMs(Math.max(base, nextDelayOverrideMs ?? 0));
      nextDelayOverrideMs = null;
      if (rateLimitResumeAtMs > 0 && Date.now() >= rateLimitResumeAtMs) {
        rateLimitResumeAtMs = 0;
      }
      schedule(delay);
    }
  };

  const start = () => {
    if (stopped || started) return;
    started = true;
    // PR polling is a background enhancement, not launch-critical work.
    // Give the rest of the app time to settle before the first GitHub refresh.
    schedule(12_000);
  };

  return {
    start,
    poke,
    dispose() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}
