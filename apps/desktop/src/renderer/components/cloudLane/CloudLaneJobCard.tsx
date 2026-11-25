import React, { useEffect, useId, useState, useSyncExternalStore } from "react";
import {
  ArrowClockwise,
  ArrowsOutSimple,
  CaretDown,
  Copy,
  FloppyDisk,
  HardDrives,
  Play,
  PlugsConnected,
  Trash,
  Warning,
  X,
  type Icon,
} from "@phosphor-icons/react";
import {
  CLOUD_LANE_JOB_STAGE_LABELS,
  cloudLaneJobGrowsDiskOnly,
  cloudLaneJobIsLive,
  type CloudLaneJobSnapshot,
  type CloudLaneJobStage,
  type CloudLaneJobStageId,
} from "../../../shared/cloudLaneLife";
import { cloudCatalogOf, type CloudAccountState } from "../../../shared/adeCloud";
import { cloudTier } from "../../../shared/cloudTiers";
import { ipcErrorMessage } from "../../lib/format";
import {
  Chip,
  StageErrorCallout,
  StageLine,
  StepCardHeader,
  TILE_TONE,
  TextAction,
  copyStepCardDetails,
  stepCardFrameClass,
} from "../chat/launch/stepCardParts";
import { LaunchProgressRail } from "../chat/launch/LaunchProgressRail";
import { useLaunchDurationText } from "../chat/launch/launchClock";
import { CloudMark, CloudSizeIcon } from "../remoteTargets/cloudBrand";
import { LaneIcon } from "../ui/vcsIcons";
import { Banner } from "../ui/notice";
import { cn } from "../ui/cn";
import type { NoticeTone } from "../ui/notice/noticeTones";
import { cancelCloudLaneJob, dismissCloudLaneJob, retryCloudLaneJob } from "./cloudLaneActions";
import { setCloudLaneJobBar, useCloudLaneJobBar } from "./cloudLaneStores";
import "./cloudLane.css";

/**
 * The steps of a tier change or a move, in the same card a new cloud lane
 * shows (`LaneSetupCard`): the header with the ADE Cloud mark, the segmented
 * rail, one row per step with its time, Retry on a failure, Cancel only
 * while the job waits or saves (a move: until its copy starts), and Copy
 * details. A move saves while it makes the new computer, so two steps can
 * run at once.
 *
 * It reads the job record main keeps (`cloud.laneLife`, `onLaneJob`), so it
 * goes on with every window closed and shows the same in the chat and on
 * the dashboard. The lane says Online only at `phase === "online"`.
 *
 * `CloudLaneJobBar` is the same job as one slim line above a chat's prompt
 * box, opening to this card's steps.
 */

/** A finished job's bar stays this long, then goes. A failure stays for Retry. */
const JOB_BAR_FINISHED_MS = 20_000;

const STAGE_ICON: Record<CloudLaneJobStageId, Icon> = {
  save: FloppyDisk,
  resize: ArrowsOutSimple,
  computer: HardDrives,
  copy: Copy,
  start: Play,
  connect: PlugsConnected,
  remove: Trash,
};

/** "a Large", "an X-Large": the article a size's name reads with. */
function withArticle(label: string): string {
  return /^(?:[aeiou]|x-)/i.test(label) ? `an ${label}` : `a ${label}`;
}

function sizeLabel(account: CloudAccountState | null, id: string | null): string | null {
  if (!id) return null;
  return cloudTier(cloudCatalogOf(account), id)?.label ?? id;
}

/**
 * How every surface words and colours a job, by phase, in one place: the chat
 * card, the corner panel and the dashboard's row all read from here.
 * - `title`: the job in one line. A finished move says plainly that the chat
 *   follows the lane to its new computer (same chat, same lane).
 * - `stepLine`: the step running now (or why it failed), "Copy lane · Copying files…".
 * - `tone`: the corner panel's tone for the row.
 * - `note`: the card's sentence under the steps.
 * - `row`: what the dashboard row's State cell says; null when it says the computer's own state.
 */
export type CloudLaneJobPresentation = {
  title: string;
  stepLine: string | null;
  tone: NoticeTone;
  note: string | null;
  row: { state: "starting" | "failed" | "awake"; label: string } | null;
};

export function cloudLaneJobPresentation(job: CloudLaneJobSnapshot, account: CloudAccountState | null): CloudLaneJobPresentation {
  const to = sizeLabel(account, job.toSizeId) ?? "the new size";
  const move = job.kind === "move";
  // The same size with a bigger disk: a disk grow (the Android pane's Grow the disk).
  if (cloudLaneJobGrowsDiskOnly(job)) {
    const disk = `${job.laneName}'s disk`;
    switch (job.phase) {
      case "waiting":
        return { title: `${disk} grows to ${job.diskGb} GB when the agent is idle`, stepLine: liveStepLine(job), tone: "accent", note: "ADE waits for the agent to finish its turn. Your files and chats stay.", row: { state: "starting", label: "Grows when idle" } };
      case "running":
        return { title: `Growing ${disk} to ${job.diskGb} GB`, stepLine: liveStepLine(job), tone: "accent", note: "The computer restarts for a moment. Your files and chats stay. You can close this window.", row: { state: "starting", label: "Growing disk" } };
      case "online":
        return { title: `${disk} grew to ${job.diskGb} GB`, stepLine: null, tone: "success", note: "ADE connected to the computer again.", row: { state: "awake", label: "Disk grown" } };
      case "failed":
        return { title: "The disk grow stopped", stepLine: job.error ?? job.stages.find((stage) => stage.status === "failed")?.error ?? null, tone: "error", note: null, row: { state: "failed", label: "Disk grow stopped" } };
      case "cancelled":
        return { title: `Kept ${disk} as it is`, stepLine: null, tone: "neutral", note: null, row: null };
    }
  }
  switch (job.phase) {
    case "waiting":
      return {
        title: `${job.laneName} changes to ${to} when the agent is idle`,
        stepLine: liveStepLine(job),
        tone: "accent",
        note: "ADE waits for the agent to finish its turn. Your files and chats stay.",
        row: { state: "starting", label: "Changes when idle" },
      };
    case "running":
      return {
        title: move ? `Moving ${job.laneName} to ${withArticle(to)} computer` : `Changing ${job.laneName} to ${to}`,
        stepLine: liveStepLine(job),
        tone: "accent",
        // A message sent meanwhile waits on ADE Cloud until the change is done (`AgentChatPane` submit).
        note: move
          ? "Your files and chats stay. A message you send now waits on ADE Cloud, and the agent gets it on the new computer. You can close this window."
          : "Your files and chats stay. A message you send waits until the computer is back. You can close this window.",
        row: { state: "starting", label: move ? "Moving" : "Changing size" },
      };
    case "online":
      return {
        title: move ? `Moved to ${withArticle(to)} computer · your chat follows` : `${job.laneName} is online at ${to}`,
        stepLine: move ? `${job.laneName} is online. The old computer is gone.` : null,
        tone: "success",
        note: move
          ? "Same lane, same chats, on the new computer. ADE points this chat, its tools and Android there."
          : "ADE connected to the computer again.",
        row: { state: "awake", label: move ? "Moved" : "Resized" },
      };
    case "failed":
      return {
        title: move ? `The move to ${to} stopped` : `The change to ${to} stopped`,
        stepLine: job.error ?? job.stages.find((stage) => stage.status === "failed")?.error ?? null,
        tone: "error",
        note: null,
        row: { state: "failed", label: move ? "Move stopped" : "Size change stopped" },
      };
    case "cancelled":
      return {
        title: `Kept ${job.laneName} at ${sizeLabel(account, job.fromSizeId) ?? "its size"}`,
        stepLine: null,
        tone: "neutral",
        note: null,
        row: null,
      };
  }
}

/** The job in one line, the same in the chat, on the dashboard and in the corner panel. */
export function cloudLaneJobTitle(job: CloudLaneJobSnapshot, account: CloudAccountState | null): string {
  return cloudLaneJobPresentation(job, account).title;
}

/** A waiting or running job's step now, as one line. */
function liveStepLine(job: CloudLaneJobSnapshot): string | null {
  const running = job.stages.filter((entry) => entry.status === "running");
  // Two at once (a move saves while it makes the new computer): both names, and the later one's detail.
  const stage = running.at(-1) ?? job.stages.find((entry) => entry.status === "pending") ?? null;
  if (!stage) return null;
  const label = running.length > 1 ? running.map((entry) => CLOUD_LANE_JOB_STAGE_LABELS[entry.id]).join(" and ") : CLOUD_LANE_JOB_STAGE_LABELS[stage.id];
  return stage.detail?.trim() ? `${label} · ${stage.detail.trim()}` : label;
}

/** Cards stay until the person closes them only when the job is over. */
function cloudLaneJobDismissable(job: CloudLaneJobSnapshot): boolean {
  return job.phase === "failed" || job.phase === "online" || job.phase === "cancelled";
}

/** Cancel works only before the size changes: while the job waits, or saves the work, and a move until its copy starts. */
function canCancel(job: CloudLaneJobSnapshot): boolean {
  if (job.phase === "waiting") return true;
  if (job.phase !== "running") return false;
  // A move until its copy starts: the cancel takes the new computer away (`cancelJob` in main).
  if (job.kind === "move") return job.stages.find((stage) => stage.id === "copy")?.status === "pending";
  return job.stages.every((stage) => stage.id === "save" || stage.status === "pending");
}

/**
 * One card per job speaks its state to a screen reader: the same job can show
 * in the chat, on the dashboard and in the size dialog at once, and each
 * would announce the same failure. The card mounted last (the one the person
 * just opened) owns the announcement.
 */
const announcers = new Map<string, string[]>();
const announcerListeners = new Set<() => void>();
function subscribeAnnouncers(listener: () => void) {
  announcerListeners.add(listener);
  return () => announcerListeners.delete(listener);
}
function changeAnnouncers(jobId: string, cardId: string, add: boolean) {
  const list = (announcers.get(jobId) ?? []).filter((id) => id !== cardId);
  if (add) list.push(cardId);
  if (list.length) announcers.set(jobId, list);
  else announcers.delete(jobId);
  for (const listener of announcerListeners) listener();
}
/** Null: a card without a title to speak (headless) leaves the announcement to the row or bar around it. */
function useAnnouncesJob(jobId: string | null): boolean {
  const cardId = useId();
  useEffect(() => {
    if (!jobId) return;
    changeAnnouncers(jobId, cardId, true);
    return () => changeAnnouncers(jobId, cardId, false);
  }, [cardId, jobId]);
  return useSyncExternalStore(
    subscribeAnnouncers,
    () => jobId != null && announcers.get(jobId)?.at(-1) === cardId,
    () => false,
  );
}

/** How long the job has run (or ran), on the shared launch clock. */
export function JobElapsed({ job, className }: { job: CloudLaneJobSnapshot; className?: string }) {
  const text = useLaunchDurationText(job.startedAt, job.endedAt, cloudLaneJobIsLive(job));
  return <span className={cn("shrink-0 tabular-nums", className)}>{text}</span>;
}

/** A finished job's bar: true a moment after the finish (one timer, only while a finished bar shows). */
function useFinishedBarExpired(job: CloudLaneJobSnapshot): boolean {
  const finished = job.phase === "online" || job.phase === "cancelled";
  const endedAt = job.endedAt ?? job.updatedAt;
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!finished || !endedAt) {
      setExpired(false);
      return;
    }
    const left = JOB_BAR_FINISHED_MS - (Date.now() - Date.parse(endedAt));
    if (!(left > 0)) {
      setExpired(true);
      return;
    }
    setExpired(false);
    const timer = window.setTimeout(() => setExpired(true), left);
    return () => window.clearTimeout(timer);
  }, [endedAt, finished]);
  return expired;
}

function StageTime({ stage }: { stage: CloudLaneJobStage }) {
  const live = stage.status === "running" && Boolean(stage.startedAt) && !stage.endedAt;
  const text = useLaunchDurationText(stage.startedAt, stage.endedAt, live);
  return <span className="min-w-[3rem] shrink-0 text-right tabular-nums text-fg/35">{text}</span>;
}

export const CloudLaneJobCard = React.memo(function CloudLaneJobCard({
  job,
  account,
  variant = "thread",
  headless = false,
  className,
}: {
  job: CloudLaneJobSnapshot;
  /** For the size names and rates; null shows the size ids' own names. */
  account: CloudAccountState | null;
  /** `thread`: a chat card. `panel`: inside the dashboard's lane panel, the corner panel or the chat's bar. */
  variant?: "thread" | "panel";
  /** Inside a row that already shows the title (the corner panel, the chat's bar): only the steps and actions. */
  headless?: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState<"retry" | "cancel" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const compact = variant === "panel";
  const failed = job.phase === "failed";
  const live = cloudLaneJobIsLive(job);
  const announces = useAnnouncesJob(headless ? null : job.jobId);
  // A thread card folds to one line. It is open by default only while a
  // step runs or has failed; the person's own choice holds until the job's
  // phase changes.
  const foldable = variant === "thread" && !headless;
  const openByDefault = job.phase === "running" || failed;
  const [openChoice, setOpenChoice] = useState<{ phase: CloudLaneJobSnapshot["phase"]; open: boolean } | null>(null);
  const open = !foldable || (openChoice?.phase === job.phase ? openChoice.open : openByDefault);
  const bodyId = `adecl-job-body-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  // The job's own error shows once: under its failed step when that step carries it, else below the steps.
  const stageErrors = new Set(job.stages.filter((stage) => (stage.status === "failed" || stage.status === "warning") && stage.error).map((stage) => stage.error!.trim()));
  const jobErrorLine = failed && job.error && !stageErrors.has(job.error.trim()) ? job.error : null;
  const textSize = compact ? "text-[11.5px]" : "text-[length:calc(var(--chat-font-size)*12/14)]";
  const metaSize = compact ? "text-[10.5px]" : "text-[length:calc(var(--chat-font-size)*11/14)]";
  // Running wears the ADE Cloud blue; a failed step card stays amber, as the launch card does.
  const tileTone = live ? "adec-tile" : failed ? TILE_TONE.failed : job.phase === "online" ? TILE_TONE.done : TILE_TONE.skipped;
  const fromLabel = sizeLabel(account, job.fromSizeId);
  const toLabel = sizeLabel(account, job.toSizeId);

  const run = async (kind: "retry" | "cancel" | "dismiss") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "retry") await retryCloudLaneJob(job.jobId);
      else if (kind === "dismiss") await dismissCloudLaneJob(job.jobId);
      else await cancelCloudLaneJob(job.jobId);
    } catch (runError) {
      setError(ipcErrorMessage(runError) || "ADE couldn't do that. Try again in a moment.");
    } finally {
      setBusy(null);
    }
  };

  const copyDetails = () => {
    const failedStage = job.stages.find((stage) => stage.status === "failed");
    copyStepCardDetails([
      cloudLaneJobTitle(job, account),
      `Lane: ${job.laneName}`,
      `Computer: ${job.instanceId}${job.fromInstanceId !== job.instanceId ? ` (from ${job.fromInstanceId})` : ""}`,
      `Size: ${job.fromSizeId ?? "?"} to ${job.toSizeId} (${job.kind}, ${job.timing})`,
      failedStage ? `Step: ${CLOUD_LANE_JOB_STAGE_LABELS[failedStage.id]}` : null,
      job.error ?? failedStage?.error ?? null,
      `Job: ${job.jobId}`,
    ]);
  };

  const notice = cloudLaneJobPresentation(job, account).note;
  const dismissable = cloudLaneJobDismissable(job);

  return (
    <div
      data-cloud-lane-job={job.jobId}
      data-job-phase={job.phase}
      className={cn(
        "font-sans",
        textSize,
        compact
          ? "adecl-jobpanel"
          : stepCardFrameClass(failed),
        className,
      )}
    >
      {headless ? null : (
      <StepCardHeader
        tileTone={tileTone}
        tileIcon={failed ? <Warning size={13} weight="bold" /> : <CloudMark size={13} bold />}
        title={cloudLaneJobTitle(job, account)}
        titleRole={announces ? "status" : undefined}
        failed={failed}
        metaSize={metaSize}
        trailing={(
          <>
            <JobElapsed job={job} className={cn("ml-auto text-fg/38", metaSize)} />
            {dismissable ? (
              <button
                type="button"
                className="adecl-job-dismiss"
                aria-label={failed ? "Dismiss this failure" : "Dismiss"}
                title="Dismiss"
                disabled={busy != null}
                onClick={() => void run("dismiss")}
              >
                <X size={10} weight="bold" aria-hidden />
              </button>
            ) : null}
            {foldable ? (
              <button
                type="button"
                className="adecl-job-fold"
                aria-expanded={open}
                aria-controls={bodyId}
                aria-label={open ? "Hide the steps" : "Show the steps"}
                onClick={() => setOpenChoice({ phase: job.phase, open: !open })}
              >
                <CaretDown size={11} weight="bold" aria-hidden data-open={open ? "1" : "0"} />
              </button>
            ) : null}
          </>
        )}
        chips={open ? (
          <>
            <Chip title={job.laneName}>
              <LaneIcon size={10} className="adecl-lane-ic" />
              <span className="min-w-0 truncate">{job.laneName}</span>
            </Chip>
            {cloudLaneJobGrowsDiskOnly(job) ? null : (
              <Chip title={`${fromLabel ?? "?"} to ${toLabel ?? job.toSizeId}`}>
                {job.fromSizeId ? <CloudSizeIcon tier={job.fromSizeId} size={11} /> : null}
                {fromLabel ? <span>{fromLabel}</span> : null}
                <span aria-hidden className="text-fg/30">to</span>
                <CloudSizeIcon tier={job.toSizeId} size={11} />
                <span>{toLabel}</span>
              </Chip>
            )}
            {job.kind === "move" ? <Chip title="A new computer gets the lane's files, then the old one goes">New computer</Chip> : null}
            {job.diskGb ? <Chip title="The disk grows in the same restart">Disk to {job.diskGb} GB</Chip> : null}
          </>
        ) : null}
      />
      )}
      {open ? (
      <div id={bodyId}>
      <LaunchProgressRail stages={job.stages} cloud className={headless ? "mb-1" : "mb-1 mt-3"} />
      <ul className="divide-y divide-fg/[0.045]" aria-label="Steps">
        {job.stages.map((stage) => (
          <li key={stage.id} data-stage-id={stage.id} data-stage-status={stage.status}>
            <StageLine
              icon={STAGE_ICON[stage.id]}
              status={stage.status}
              label={CLOUD_LANE_JOB_STAGE_LABELS[stage.id]}
              detail={stage.detail?.trim() || null}
              compact={compact}
              cloud
              trailing={<StageTime stage={stage} />}
            />
            {(stage.status === "failed" || stage.status === "warning") && stage.error ? (
              <StageErrorCallout error={stage.error} className={metaSize} />
            ) : null}
          </li>
        ))}
      </ul>
      {error ? (
        <Banner
          layout="inline"
          style={{ marginTop: 6 }}
          model={{
            id: "cloud-lane-job-action-error",
            tone: "error",
            title: error,
            report: { surface: "cloud_lane_job_action" },
            dismiss: { onDismiss: () => setError(null) },
          }}
        />
      ) : jobErrorLine ? <StageErrorCallout error={jobErrorLine} className={cn("ml-0 mt-1.5", metaSize)} /> : null}
      {notice ? <p className={cn("mt-1.5 leading-snug text-fg/55", metaSize)}>{notice}</p> : null}
      {failed || canCancel(job) ? (
        <div className={cn("mt-1 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 border-t border-fg/[0.05] pt-1.5 -mx-1.5", metaSize)}>
          <span className="ml-auto" aria-hidden />
          {failed ? (
            <TextAction tone="primary" disabled={busy != null} onClick={() => void run("retry")}>
              <ArrowClockwise size={11} weight="bold" aria-hidden />
              {busy === "retry" ? "Retrying…" : "Retry"}
            </TextAction>
          ) : null}
          {failed ? (
            <TextAction onClick={copyDetails}>
              <Copy size={11} aria-hidden />
              Copy details
            </TextAction>
          ) : null}
          {canCancel(job) ? (
            <TextAction disabled={busy != null} onClick={() => void run("cancel")}>
              <X size={10} weight="bold" aria-hidden />
              {busy === "cancel" ? "Cancelling…" : "Cancel"}
            </TextAction>
          ) : null}
        </div>
      ) : null}
      </div>
      ) : null}
    </div>
  );
});

/** A job's steps and actions alone, inside a row or bar that already shows its title (the chat's bar, the corner panel). */
export function CloudLaneJobSteps({ job, account }: { job: CloudLaneJobSnapshot; account: CloudAccountState | null }) {
  return <CloudLaneJobCard job={job} account={account} variant="panel" headless className="adecl-jobpanel-bare" />;
}

/**
 * A lane's size change or move as one slim line above a chat's prompt box:
 * its title, step now and time, opening to its steps (the panel card,
 * headless). Its × hides it while the job runs (the job goes on; a failure
 * shows it again) and dismisses it once it ended. A finish leaves a moment
 * later unless its steps are open; a failure opens on them. Its open and
 * hidden state is the window's (`setCloudLaneJobBar`), so the chat's cloud
 * button opens it.
 */
export const CloudLaneJobBar = React.memo(function CloudLaneJobBar({
  job,
  account,
  className,
}: {
  job: CloudLaneJobSnapshot;
  /** For the size names and rates; null shows the size ids' own names. */
  account: CloudAccountState | null;
  className?: string;
}) {
  const [closing, setClosing] = useState(false);
  const failed = job.phase === "failed";
  const live = cloudLaneJobIsLive(job);
  const announces = useAnnouncesJob(job.jobId);
  const { open, hidden } = useCloudLaneJobBar(job.jobId);
  const expired = useFinishedBarExpired(job);
  // A failure opens its bar on its steps (Retry is there); a bar closed while the job ran comes back for it.
  useEffect(() => {
    if (failed) setCloudLaneJobBar(job.jobId, { open: true, hidden: false });
  }, [failed, job.jobId]);
  const bodyId = `adecl-jobbar-body-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const presentation = cloudLaneJobPresentation(job, account);

  /** The ×: hidden while the job runs (it goes on), dismissed everywhere once it ended. */
  const close = async () => {
    if (live) {
      setCloudLaneJobBar(job.jobId, { hidden: true });
      return;
    }
    setClosing(true);
    try {
      await dismissCloudLaneJob(job.jobId);
    } catch (dismissError) {
      console.warn("[cloud] dismissing a lane job failed", ipcErrorMessage(dismissError));
    } finally {
      setClosing(false);
      setCloudLaneJobBar(job.jobId, { hidden: true });
    }
  };

  if (hidden || (expired && !open)) return null;

  return (
    <div
      data-cloud-lane-job-bar={job.jobId}
      data-job-phase={job.phase}
      data-tone={failed ? "error" : live ? "live" : "done"}
      className={cn("font-sans text-[11.5px] adecl-jobbar", className)}
    >
      <div className="adecl-jobbar-row">
        <button
          type="button"
          className="adecl-jobbar-main"
          aria-expanded={open}
          aria-controls={bodyId}
          title={open ? "Hide the steps" : "Show the steps"}
          onClick={() => setCloudLaneJobBar(job.jobId, { open: !open })}
        >
          <span className="adecl-jobbar-mark" aria-hidden>
            {failed ? <Warning size={12} weight="bold" /> : <CloudMark size={12} bold />}
          </span>
          <span className="adecl-jobbar-text" role={announces ? "status" : undefined}>
            <b>{presentation.title}</b>
            {presentation.stepLine ? <span className="adecl-jobbar-step">{presentation.stepLine}</span> : null}
          </span>
          <JobElapsed job={job} className="adecl-jobbar-time" />
          <CaretDown size={11} weight="bold" aria-hidden data-open={open ? "1" : "0"} className="adecl-jobbar-caret" />
        </button>
        <button
          type="button"
          className="adecl-job-dismiss"
          aria-label={live ? "Hide this bar (the change goes on)" : failed ? "Dismiss this failure" : "Dismiss"}
          title={live ? "Hide (the change goes on)" : "Dismiss"}
          disabled={closing}
          onClick={() => void close()}
        >
          <X size={10} weight="bold" aria-hidden />
        </button>
      </div>
      {open ? (
        <div id={bodyId} className="adecl-jobbar-steps">
          <CloudLaneJobSteps job={job} account={account} />
        </div>
      ) : null}
    </div>
  );
});
