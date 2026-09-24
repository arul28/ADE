import React, { useEffect, useState } from "react";
import { CaretDown, CaretRight, Check, Square, X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { formatSubagentDurationMs } from "../../lib/format";
import { pluralCount } from "../../../shared/formatting";
import type { BackgroundJobGroupMember, BackgroundJobLineRenderEvent } from "./chatTranscriptRows";
import { backgroundJobStatusWord, countBackgroundJobs } from "./chatBackgroundJobRuns";

/**
 * Live elapsed since a start timestamp, ticking once a second while `running`.
 * Anchored to the real start timestamp, so a row scrolled out of the
 * virtualizer and back keeps the true elapsed. A state tick on a leaf that
 * renders one line, so the per-second commit never reaches the memoized rows
 * around it. Null for an absent or unparseable timestamp.
 */
function useLiveDurationMs(startedAt: string | null, running: boolean): number | null {
  const startMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const anchored = Number.isFinite(startMs) ? startMs : null;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!running || anchored == null) return undefined;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [running, anchored]);
  if (anchored == null) return null;
  return Math.max(0, nowMs - anchored);
}

/**
 * A job's duration: live while it runs, the recorded one once it ends. A job
 * whose session ended without a terminal update shows none — a frozen counter
 * reading `1440h` is accurate arithmetic and a useless claim.
 */
function useJobDuration(job: BackgroundJobLineRenderEvent, sessionEnded: boolean): string | null {
  const running = job.status === "running";
  const liveMs = useLiveDurationMs(job.startedAt, running && !sessionEnded);
  if (running) return sessionEnded ? null : formatSubagentDurationMs(liveMs);
  return formatSubagentDurationMs(job.durationMs);
}

const ROW_TEXT = "font-sans text-[length:var(--chat-font-size)]";
const CONTROL_FOCUS = "focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-300/40";

function JobStatusIcon({ status }: { status: BackgroundJobLineRenderEvent["status"] }) {
  if (status === "running") {
    return <span className="inline-flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden><span className="h-1.5 w-1.5 rounded-full bg-sky-300/80" /></span>;
  }
  if (status === "completed") return <Check size={11} weight="bold" className="shrink-0 text-emerald-300/75" aria-hidden />;
  if (status === "failed") return <X size={11} weight="bold" className="shrink-0 text-red-400/85" aria-hidden />;
  return <Square size={9} weight="fill" className="shrink-0 text-fg/35" aria-hidden />;
}

function statusTone(status: BackgroundJobLineRenderEvent["status"]): string {
  if (status === "running") return "text-sky-200/75";
  if (status === "failed") return "text-red-400/85";
  return "text-fg/45";
}

function StopButton({ label, taskId, onStop }: { label: string; taskId: string; onStop: (taskId: string) => void }) {
  return (
    <button
      type="button"
      aria-label={`Stop ${label}`}
      title="Stop this background job"
      onClick={(clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        onStop(taskId);
      }}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1 text-[length:calc(var(--chat-font-size)*11/14)] text-fg/45 transition-colors hover:bg-rose-500/10 hover:text-rose-200/90",
        CONTROL_FOCUS,
      )}
    >
      <Square size={8} weight="fill" aria-hidden />
      Stop
    </button>
  );
}

function OpenButton({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Open ${label} in the chat actions pane`}
      title="Show background jobs in the chat actions pane"
      onClick={(clickEvent) => {
        clickEvent.stopPropagation();
        onOpen();
      }}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 text-[length:calc(var(--chat-font-size)*11/14)] text-fg/40 transition-colors hover:text-fg/80",
        CONTROL_FOCUS,
      )}
    >
      open<CaretRight size={9} weight="bold" aria-hidden />
    </button>
  );
}

/** One job inside an expanded group: status, label, duration, open and Stop. */
function BackgroundJobListItem({
  job,
  sessionEnded,
  onOpenJob,
  onStop,
}: {
  job: BackgroundJobLineRenderEvent;
  sessionEnded: boolean;
  onOpenJob?: (taskId: string | null) => void;
  onStop?: (taskId: string) => void;
}) {
  const duration = useJobDuration(job, sessionEnded);
  const running = job.status === "running";
  return (
    <li
      className="flex min-w-0 items-center gap-2 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*12.5/14)]"
      data-background-job={job.agentKey}
      data-background-job-status={job.status}
    >
      <JobStatusIcon status={job.status} />
      <span className="min-w-0 flex-1 truncate text-fg/65" title={job.label}>{job.label}</span>
      {duration ? <span className="shrink-0 font-mono tabular-nums text-fg/40">{duration}</span> : null}
      {job.status === "failed" || job.status === "stopped" ? (
        <span className={cn("shrink-0", statusTone(job.status))}>{backgroundJobStatusWord(job.status)}</span>
      ) : null}
      {running && !sessionEnded && job.taskId && onStop ? <StopButton label={job.label} taskId={job.taskId} onStop={onStop} /> : null}
      {onOpenJob ? <OpenButton label={job.label} onOpen={() => onOpenJob(job.taskId ?? null)} /> : null}
    </li>
  );
}

/** The single-job row: `$ Search kimi binary … · 3m · done  open ›`. */
function SingleBackgroundJobRow({
  member,
  sessionEnded,
  onOpenJob,
  onStop,
}: {
  member: BackgroundJobGroupMember;
  sessionEnded: boolean;
  onOpenJob?: (taskId: string | null) => void;
  onStop?: (taskId: string) => void;
}) {
  const job = member.event;
  const duration = useJobDuration(job, sessionEnded);
  const running = job.status === "running";
  const statusWord = running ? (sessionEnded ? null : "running") : backgroundJobStatusWord(job.status);
  return (
    <div
      className={cn("flex min-w-0 max-w-full items-center gap-2 py-0.5", ROW_TEXT)}
      data-background-job={job.agentKey}
      data-background-job-status={job.status}
      data-background-job-count={1}
    >
      <span className="shrink-0 font-mono text-fg/35" aria-hidden>$</span>
      <span className="min-w-0 truncate text-fg/60" title={job.label}>{job.label}</span>
      {duration ? <span className="shrink-0 text-fg/40"><span className="text-fg/25" aria-hidden>· </span><span className="font-mono tabular-nums">{duration}</span></span> : null}
      {statusWord ? (
        <span className={cn("shrink-0", statusTone(job.status))}><span className="text-fg/25" aria-hidden>· </span>{statusWord}</span>
      ) : null}
      {running && !sessionEnded && job.taskId && onStop ? <StopButton label={job.label} taskId={job.taskId} onStop={onStop} /> : null}
      {onOpenJob ? <OpenButton label={job.label} onOpen={() => onOpenJob(job.taskId ?? null)} /> : null}
    </div>
  );
}

/** Live ticker for the oldest running job in a group, for the header. */
function RunningSince({ startedAt, sessionEnded }: { startedAt: string | null; sessionEnded: boolean }) {
  const liveMs = useLiveDurationMs(startedAt, !sessionEnded);
  const label = sessionEnded ? null : formatSubagentDurationMs(liveMs);
  return label ? <span className="font-mono tabular-nums"> {label}</span> : null;
}

/**
 * The in-thread presence of backgrounded shell commands: one compact,
 * left-aligned row in thread text size. A single job reads
 * `$ <label> · 3m · done  open ›`; a run of jobs reads
 * `$ 5 background jobs · 1 running · 3 done · 1 failed ›` and expands inline to
 * one line per job with its status, duration, `open`, and Stop while running.
 * The chat actions pane holds each job's full state and output; `open` points
 * there and is omitted on a host with no pane.
 *
 * A lone line and a group render through this one component, so a job line
 * that gains a neighbour (same row key) stays mounted.
 */
export function BackgroundJobRunRow({
  members,
  sessionEnded = false,
  onOpenJob,
  onStop,
}: {
  members: readonly BackgroundJobGroupMember[];
  /** Freezes every ticker: an ended session's `running` jobs will never report. */
  sessionEnded?: boolean;
  onOpenJob?: (taskId: string | null) => void;
  onStop?: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (members.length === 1) {
    return <SingleBackgroundJobRow member={members[0]!} sessionEnded={sessionEnded} onOpenJob={onOpenJob} onStop={onStop} />;
  }
  const jobs = members.map((member) => member.event);
  const counts = countBackgroundJobs(jobs);
  const oldestRunningStart = jobs
    .filter((job) => job.status === "running" && job.startedAt)
    .map((job) => job.startedAt!)
    .sort()[0] ?? null;
  const parts: Array<{ key: string; node: React.ReactNode; tone: string }> = [];
  if (counts.running) {
    parts.push({
      key: "running",
      tone: "text-sky-200/75",
      node: <>{counts.running} running<RunningSince startedAt={oldestRunningStart} sessionEnded={sessionEnded} /></>,
    });
  }
  if (counts.done) parts.push({ key: "done", tone: "text-fg/45", node: `${counts.done} done` });
  if (counts.failed) parts.push({ key: "failed", tone: "text-red-400/85", node: `${counts.failed} failed` });
  if (counts.stopped) parts.push({ key: "stopped", tone: "text-fg/45", node: `${counts.stopped} stopped` });
  const summary = pluralCount(counts.total, "background job");
  return (
    <div
      className="min-w-0 max-w-full"
      data-background-job={members[0]!.event.agentKey}
      data-background-job-count={members.length}
      data-background-job-status={counts.running ? "running" : counts.failed ? "failed" : "completed"}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${summary}: ${[
          counts.running ? `${counts.running} running` : null,
          counts.done ? `${counts.done} done` : null,
          counts.failed ? `${counts.failed} failed` : null,
          counts.stopped ? `${counts.stopped} stopped` : null,
        ].filter(Boolean).join(", ")}. ${open ? "Hide" : "Show"} the jobs`}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "inline-flex max-w-full items-center gap-2 rounded-md py-0.5 text-left transition-colors hover:text-fg/80",
          ROW_TEXT,
          CONTROL_FOCUS,
        )}
      >
        <span className="shrink-0 font-mono text-fg/35" aria-hidden>$</span>
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
          <span className="shrink-0 text-fg/60">{summary}</span>
          {parts.map((part) => (
            <span key={part.key} className={cn("shrink-0", part.tone)} data-testid={`background-jobs-${part.key}`}>
              <span className="text-fg/25" aria-hidden>· </span>{part.node}
            </span>
          ))}
        </span>
        {open
          ? <CaretDown size={10} weight="bold" className="shrink-0 text-fg/40" aria-hidden />
          : <CaretRight size={10} weight="bold" className="shrink-0 text-fg/40" aria-hidden />}
      </button>
      {open ? (
        <ul className="mt-1 min-w-0 max-w-[var(--chat-content-width,52rem)] border-l border-white/[0.08] pl-3">
          {members.map((member) => (
            <BackgroundJobListItem
              key={member.key}
              job={member.event}
              sessionEnded={sessionEnded}
              onOpenJob={onOpenJob}
              onStop={onStop}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
