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
import { cancelCloudLaneJob, dismissCloudLaneJob, retryCloudLaneJob } from "./cloudLaneActions";
import "./cloudLane.css";

/**
 * The steps of a tier change or a move, in the same card a new cloud lane
 * shows (`LaneSetupCard`): the header with the ADE Cloud mark, the segmented
 * rail, one row per step with its time, Retry on a failure, Cancel only
 * while the job waits or saves, and Copy details.
 *
 * It reads the job record main keeps (`cloud.laneLife`, `onLaneJob`), so it
 * goes on with every window closed and shows the same in the chat and on
 * the dashboard. The lane says Online only at `phase === "online"`.
 */

const STAGE_ICON: Record<CloudLaneJobStageId, Icon> = {
  save: FloppyDisk,
  resize: ArrowsOutSimple,
  computer: HardDrives,
  copy: Copy,
  start: Play,
  connect: PlugsConnected,
  remove: Trash,
};

function sizeLabel(account: CloudAccountState | null, id: string | null): string | null {
  if (!id) return null;
  return cloudTier(cloudCatalogOf(account), id)?.label ?? id;
}

/**
 * The job in one line, the same in the chat, on the dashboard and in the
 * corner panel. A finished move says plainly that the chat follows the lane
 * to its new computer (same chat, same lane).
 */
export function cloudLaneJobTitle(job: CloudLaneJobSnapshot, account: CloudAccountState | null): string {
  const to = sizeLabel(account, job.toSizeId) ?? "the new size";
  switch (job.phase) {
    case "waiting":
      return `${job.laneName} changes to ${to} when the agent is idle`;
    case "running":
      return job.kind === "move" ? `Moving ${job.laneName} to a ${to} computer` : `Changing ${job.laneName} to ${to}`;
    case "online":
      return job.kind === "move" ? `Moved to a ${to} computer · your chat follows` : `${job.laneName} is online at ${to}`;
    case "failed":
      return job.kind === "move" ? `The move to ${to} stopped` : `The change to ${to} stopped`;
    case "cancelled":
      return `Kept ${job.laneName} at ${sizeLabel(account, job.fromSizeId) ?? "its size"}`;
  }
}

/** The step running now (or the one that failed), as one line: "Copy lane · Copying files…". */
export function cloudLaneJobStepLine(job: CloudLaneJobSnapshot): string | null {
  if (job.phase === "failed") return job.error ?? job.stages.find((stage) => stage.status === "failed")?.error ?? null;
  if (job.phase === "online") return job.kind === "move" ? `${job.laneName} is online. The old computer is gone.` : null;
  if (job.phase === "cancelled") return null;
  const stage = job.stages.find((entry) => entry.status === "running")
    ?? job.stages.find((entry) => entry.status === "pending")
    ?? null;
  if (!stage) return null;
  const label = CLOUD_LANE_JOB_STAGE_LABELS[stage.id];
  return stage.detail?.trim() ? `${label} · ${stage.detail.trim()}` : label;
}

/** Cards stay until the person closes them only when the job is over. */
export function cloudLaneJobDismissable(job: CloudLaneJobSnapshot): boolean {
  return job.phase === "failed" || job.phase === "online" || job.phase === "cancelled";
}

/** Cancel works only before the size changes: while the job waits, or saves the work. */
function canCancel(job: CloudLaneJobSnapshot): boolean {
  if (job.phase === "waiting") return true;
  if (job.phase !== "running") return false;
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
function useAnnouncesJob(jobId: string): boolean {
  const cardId = useId();
  useEffect(() => {
    changeAnnouncers(jobId, cardId, true);
    return () => changeAnnouncers(jobId, cardId, false);
  }, [cardId, jobId]);
  return useSyncExternalStore(
    subscribeAnnouncers,
    () => announcers.get(jobId)?.at(-1) === cardId,
    () => false,
  );
}

function JobElapsed({ job, className }: { job: CloudLaneJobSnapshot; className?: string }) {
  const live = job.phase === "waiting" || job.phase === "running";
  const text = useLaunchDurationText(job.startedAt, job.endedAt, live);
  return <span className={cn("shrink-0 tabular-nums", className)}>{text}</span>;
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
  /** `thread`: a chat card. `panel`: inside the dashboard's lane panel or the corner panel. */
  variant?: "thread" | "panel";
  /** Inside a row that already shows the title (the corner panel): only the steps and actions. */
  headless?: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState<"retry" | "cancel" | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const compact = variant === "panel";
  const failed = job.phase === "failed";
  const live = job.phase === "waiting" || job.phase === "running";
  const announces = useAnnouncesJob(job.jobId);
  // Above the prompt box the card folds to one line. It is open by default
  // only while a step runs or has failed; the person's own choice holds
  // until the job's phase changes.
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

  const notice = job.phase === "waiting"
    ? "ADE waits for the agent to finish its turn. Your files and chats stay."
    : job.phase === "running"
      ? "Your files and chats stay. A message you send waits until ADE on the computer answers. You can close this window."
      : job.phase === "online"
        ? job.kind === "move"
          ? "Same lane, same chats, on the new computer. ADE points this chat, its tools and Android there."
          : "ADE connected to the computer again."
        : null;
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
                className="adecl-job-fold"
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
            <Chip title={`${fromLabel ?? "?"} to ${toLabel ?? job.toSizeId}`}>
              {job.fromSizeId ? <CloudSizeIcon tier={job.fromSizeId} size={11} /> : null}
              {fromLabel ? <span>{fromLabel}</span> : null}
              <span aria-hidden className="text-fg/30">to</span>
              <CloudSizeIcon tier={job.toSizeId} size={11} />
              <span>{toLabel}</span>
            </Chip>
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
