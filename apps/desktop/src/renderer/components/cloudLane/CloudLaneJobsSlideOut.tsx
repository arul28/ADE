import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CaretRight, Check, Warning, X } from "@phosphor-icons/react";
import type { CloudAccountState } from "../../../shared/adeCloud";
import type { CloudLaneJobSnapshot } from "../../../shared/cloudLaneLife";
import { STANDARD_EASE } from "../../lib/motion";
import { useCloudAccount } from "../../state/cloudAccountStore";
import { LaunchProgressRail } from "../chat/launch/LaunchProgressRail";
import { LaunchStageGlyph } from "../chat/launch/stepCardParts";
import { useLaunchDurationText } from "../chat/launch/launchClock";
import { CloudMark } from "../remoteTargets/cloudBrand";
import { cn } from "../ui/cn";
import { NoticeIcon } from "../ui/notice/NoticeParts";
import { noticeTone, type NoticeTone } from "../ui/notice/noticeTones";
import { ToastCard } from "../ui/notice/ToastCard";
import { LaneIcon } from "../ui/vcsIcons";
import { CloudLaneJobCard, cloudLaneJobStepLine, cloudLaneJobTitle } from "./CloudLaneJobCard";
import { cloudLaneLifeAvailable, dismissCloudLaneJob } from "./cloudLaneActions";
import { cloudLaneJobVisible, useCloudLaneJobs } from "./cloudLaneStores";
import "./cloudLane.css";

/**
 * The ADE Cloud size changes and moves of this app, in the bottom-right
 * corner below the toasts, in the same look as the Launches panel
 * (`ChatLaunchesSlideOut`): one line per job with its step rail, expanding to
 * the steps and their actions. The app stays usable while a job runs; the
 * lane's row on the dashboard and the card in its chat show the same job.
 *
 * - A running job stays while it runs. Closing the panel hides it here only:
 *   the job goes on (main runs it), and the chat and the dashboard still show it.
 * - A finished job this window saw running says so for a short beat ("Moved to
 *   a Large computer · your chat follows"), then leaves.
 * - A failed job stays with its reason until it is retried or dismissed. Its
 *   × (or the panel's) dismisses it for real, in every window, so the
 *   dashboard never keeps a failure the person already read.
 *
 * It reads the one job store (`listJobs` once, then `onLaneJob` events): no
 * read of its own, no poll; one timer only while a finished row is in view.
 */

/** How long a finished job stays in the panel after it ended. */
export const CLOUD_LANE_JOB_PANEL_DONE_MS = 20_000;

/* ── Which jobs this window shows ──────────────────────────────────────── */

/** Jobs this window saw waiting or running: only these say "done" here. */
const seenLive = new Set<string>();
/** Jobs the person closed from this panel (live or finished); failures are dismissed for real instead. */
const hiddenHere = new Set<string>();
const hiddenListeners = new Set<() => void>();
let hiddenVersion = 0;

function hideHere(jobIds: readonly string[]): void {
  for (const id of jobIds) hiddenHere.add(id);
  hiddenVersion += 1;
  for (const listener of hiddenListeners) listener();
}

function useHiddenVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      hiddenListeners.add(listener);
      return () => hiddenListeners.delete(listener);
    },
    () => hiddenVersion,
    () => 0,
  );
}

const isLive = (job: CloudLaneJobSnapshot) => job.phase === "waiting" || job.phase === "running";

/**
 * The jobs the panel shows, oldest first. Pure apart from the `seen` set it
 * is handed (live jobs are added to it as they are seen).
 */
export function selectPanelJobs(
  jobs: ReadonlyMap<string, CloudLaneJobSnapshot>,
  input: { seen: Set<string>; hidden: ReadonlySet<string>; now: number },
): CloudLaneJobSnapshot[] {
  const shown: CloudLaneJobSnapshot[] = [];
  for (const job of jobs.values()) {
    if (isLive(job)) input.seen.add(job.jobId);
    if (input.hidden.has(job.jobId) || job.dismissedAt) continue;
    if (isLive(job)) {
      shown.push(job);
      continue;
    }
    if (job.phase === "failed") {
      if (cloudLaneJobVisible(job, input.now)) shown.push(job);
      continue;
    }
    // Online or cancelled: only a finish this window watched, and only for a beat.
    if (!input.seen.has(job.jobId)) continue;
    const endedAt = Date.parse(job.endedAt ?? job.updatedAt);
    if (Number.isFinite(endedAt) && input.now - endedAt <= CLOUD_LANE_JOB_PANEL_DONE_MS) shown.push(job);
  }
  return shown.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

/** The jobs the corner panel shows now, re-read when a finished row's beat ends. */
function usePanelJobs(): CloudLaneJobSnapshot[] {
  const jobs = useCloudLaneJobs(cloudLaneLifeAvailable());
  const hidden = useHiddenVersion();
  const [now, setNow] = useState(() => Date.now());
  const shown = useMemo(
    () => selectPanelJobs(jobs, { seen: seenLive, hidden: hiddenHere, now: Math.max(now, Date.now()) }),
    // `hidden` stands in for the module set it versions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jobs, hidden, now],
  );
  // One timer for the first finished row to leave; nothing while every row runs.
  const nextExpiry = useMemo(() => {
    let soonest: number | null = null;
    for (const job of shown) {
      if (isLive(job) || job.phase === "failed") continue;
      const endedAt = Date.parse(job.endedAt ?? job.updatedAt);
      if (!Number.isFinite(endedAt)) continue;
      const at = endedAt + CLOUD_LANE_JOB_PANEL_DONE_MS;
      if (soonest == null || at < soonest) soonest = at;
    }
    return soonest;
  }, [shown]);
  useEffect(() => {
    if (nextExpiry == null) return undefined;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, nextExpiry - Date.now()) + 50);
    return () => window.clearTimeout(timer);
  }, [nextExpiry]);
  return shown;
}

/** Cheap boolean for the app shell: is there anything for the panel to show? */
export function useCloudLaneJobsSlideOutVisible(): boolean {
  return usePanelJobs().length > 0;
}

/* ── The panel ─────────────────────────────────────────────────────────── */

function jobTone(job: CloudLaneJobSnapshot): NoticeTone {
  if (job.phase === "failed") return "error";
  if (job.phase === "online") return "success";
  if (job.phase === "cancelled") return "neutral";
  return "accent";
}

export function cloudLaneJobsHeadline(jobs: readonly CloudLaneJobSnapshot[], account: CloudAccountState | null): string {
  if (jobs.length === 1) return cloudLaneJobTitle(jobs[0]!, account);
  const running = jobs.filter(isLive).length;
  if (running > 0) return `Changing ${running} cloud lane${running === 1 ? "" : "s"}…`;
  const done = jobs.filter((job) => job.phase === "online").length;
  const failed = jobs.filter((job) => job.phase === "failed").length;
  return [done ? `${done} done` : null, failed ? `${failed} failed` : null].filter(Boolean).join(" · ") || "ADE Cloud lanes";
}

function JobElapsed({ job }: { job: CloudLaneJobSnapshot }) {
  const text = useLaunchDurationText(job.startedAt, job.endedAt, isLive(job));
  return <span className="shrink-0 tabular-nums text-fg/40">{text}</span>;
}

const JobRow = React.memo(function JobRow({ job, account, single }: { job: CloudLaneJobSnapshot; account: CloudAccountState | null; single: boolean }) {
  const reduceMotion = useReducedMotion();
  const failed = job.phase === "failed";
  const done = job.phase === "online";
  const live = isLive(job);
  const [expanded, setExpanded] = useState(failed);
  useEffect(() => {
    if (failed) setExpanded(true);
  }, [failed]);
  const tone = jobTone(job);
  const line = cloudLaneJobStepLine(job);
  const [dismissing, setDismissing] = useState(false);
  const dismiss = () => {
    if (!failed) {
      hideHere([job.jobId]);
      return;
    }
    setDismissing(true);
    void dismissCloudLaneJob(job.jobId).catch(() => {
      // Hidden here at least; the dashboard keeps its own × for another try.
      hideHere([job.jobId]);
    }).finally(() => setDismissing(false));
  };
  return (
    <li data-cloud-lane-job-row={job.jobId} data-job-phase={job.phase} className={cn("px-3 py-2.5 transition-colors", expanded ? "bg-fg/[0.025]" : "hover:bg-fg/[0.03]")}>
      <div className="flex w-full min-w-0 items-start gap-1">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 flex-col gap-1.5 text-left"
        >
          <span className="flex w-full min-w-0 items-start gap-2.5">
            <span className="relative shrink-0" aria-hidden>
              {live ? (
                <span className="adec-tile grid h-[22px] w-[22px] place-items-center rounded-[6px] border">
                  <CloudMark size={13} bold />
                </span>
              ) : (
                <NoticeIcon tone={tone} size="sm" icon={<CloudMark size={13} bold />} />
              )}
              <span className="absolute -bottom-1 -right-1 grid h-3 w-3 place-items-center rounded-full bg-card">
                {failed ? (
                  <LaunchStageGlyph status="failed" size={8} />
                ) : done ? (
                  <Check size={7} weight="bold" style={{ color: noticeTone("success").color }} />
                ) : live ? (
                  <LaunchStageGlyph status="running" size={9} />
                ) : (
                  <LaunchStageGlyph status="skipped" size={8} />
                )}
              </span>
            </span>
            {/* With one job the panel's own title already says it; the row then leads with the lane. */}
            <span className="line-clamp-2 min-w-0 flex-1 text-[12.5px] font-medium leading-snug text-fg" title={single ? job.laneName : cloudLaneJobTitle(job, account)}>
              {single ? job.laneName : cloudLaneJobTitle(job, account)}
            </span>
            <CaretRight
              size={10}
              weight="bold"
              aria-hidden
              className={cn("mt-1 shrink-0 self-start text-muted-fg/70 transition-transform duration-150", expanded && "rotate-90")}
            />
          </span>
          {line ? (
            <span className="flex w-full min-w-0 items-start gap-2 pl-[32px] text-[11px]">
              <span
                className="line-clamp-2 min-w-0 flex-1 leading-snug"
                style={{ color: failed || done ? noticeTone(tone).text : "var(--color-muted-fg)" }}
              >
                {line}
              </span>
              <JobElapsed job={job} />
            </span>
          ) : null}
          {single ? null : (
            <span className="flex min-w-0 items-center gap-1 pl-[32px] text-[11px] text-muted-fg" title={job.laneName}>
              <LaneIcon size={10} style={{ color: noticeTone("accent").text }} />
              <span className="min-w-0 truncate">{job.laneName}</span>
            </span>
          )}
          <span className="block w-full pl-[32px]">
            <LaunchProgressRail stages={job.stages} cloud />
          </span>
        </button>
        {!live && !single ? (
          <button
            type="button"
            className="adecl-job-fold"
            aria-label={failed ? `Dismiss: ${cloudLaneJobTitle(job, account)}` : "Hide"}
            title={failed ? "Dismiss" : "Hide"}
            disabled={dismissing}
            onClick={dismiss}
          >
            <X size={10} weight="bold" aria-hidden />
          </button>
        ) : null}
      </div>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="steps"
            initial={reduceMotion ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={reduceMotion ? undefined : { opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: STANDARD_EASE }}
            className="overflow-hidden"
          >
            <div className="ml-[32px] mt-2.5 rounded-lg border border-fg/[0.07] bg-fg/[0.03] px-2.5 pt-1.5 pb-1">
              <CloudLaneJobCard job={job} account={account} variant="panel" headless className="adecl-jobpanel-bare" />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
});

export function CloudLaneJobsSlideOut() {
  const jobs = usePanelJobs();
  // Size names from the account the header already keeps (no read of its own).
  const account = useCloudAccount();
  if (jobs.length === 0) return null;
  const anyLive = jobs.some(isLive);
  const anyFailed = jobs.some((job) => job.phase === "failed");
  const tone: NoticeTone = anyFailed ? "error" : anyLive ? "accent" : jobs.every((job) => job.phase === "online") ? "success" : "neutral";
  return (
    <ToastCard
      testId="cloud-lane-jobs-slide-out"
      model={{
        tone,
        title: <span data-testid="cloud-lane-jobs-headline">{cloudLaneJobsHeadline(jobs, account)}</span>,
        icon: anyLive ? <CloudMark size={12} bold /> : anyFailed ? <Warning size={12} weight="bold" /> : <Check size={12} weight="bold" />,
        content: (
          <ul className="max-h-[min(60vh,420px)] divide-y divide-fg/[0.07] overflow-y-auto">
            {jobs.map((job) => <JobRow key={job.jobId} job={job} account={account} single={jobs.length === 1} />)}
          </ul>
        ),
        closeLabel: anyFailed ? "Dismiss" : "Hide",
        closeTitle: anyFailed ? "Dismiss" : "Hide. The change goes on; its steps stay in the lane's chat and on the ADE Cloud page.",
        // Session replay: the lane names are the person's content.
        replayMask: { title: true },
      }}
      onClose={() => {
        // Failures are dismissed for real; running and finished jobs only leave this corner.
        for (const job of jobs) {
          if (job.phase === "failed") void dismissCloudLaneJob(job.jobId).catch(() => undefined);
        }
        hideHere(jobs.map((job) => job.jobId));
      }}
    />
  );
}
