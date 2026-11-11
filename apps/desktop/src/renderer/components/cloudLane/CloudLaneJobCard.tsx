import React, { useMemo, useState } from "react";
import {
  ArrowClockwise,
  ArrowsOutSimple,
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
import type { ChatLaunchStage } from "../../../shared/types";
import { cloudCatalogOf, type CloudAccountState } from "../../../shared/adeCloud";
import { cloudTier } from "../../../shared/cloudTiers";
import { ipcErrorMessage } from "../../lib/format";
import { copyTextToClipboard } from "../../lib/launchPromptClipboard";
import { CHAT_CARD_WIDTH_CLASS } from "../chat/chatCardPrimitives";
import { Chip, StageErrorCallout, StageLine, TextAction, TILE_TONE } from "../chat/launch/LaneSetupCard";
import { LaunchProgressRail } from "../chat/launch/LaunchProgressRail";
import { useLaunchDurationText } from "../chat/launch/launchClock";
import { CloudMark, CloudSizeIcon } from "../remoteTargets/cloudBrand";
import { LaneIcon } from "../ui/vcsIcons";
import { cn } from "../ui/cn";
import { cancelCloudLaneJob, retryCloudLaneJob } from "./cloudLaneActions";
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

function railStage(stage: CloudLaneJobStage): ChatLaunchStage {
  // The rail reads only the status, so the job's step id stands in for a launch's.
  return { id: stage.id as unknown as ChatLaunchStage["id"], status: stage.status, startedAt: stage.startedAt, endedAt: stage.endedAt, percent: null, detail: stage.detail, error: stage.error };
}

function sizeLabel(account: CloudAccountState | null, id: string | null): string | null {
  if (!id) return null;
  return cloudTier(cloudCatalogOf(account), id)?.label ?? id;
}

export function cloudLaneJobTitle(job: CloudLaneJobSnapshot, account: CloudAccountState | null): string {
  const to = sizeLabel(account, job.toSizeId) ?? "the new size";
  switch (job.phase) {
    case "waiting":
      return `${job.laneName} changes to ${to} when the agent is idle`;
    case "running":
      return job.kind === "move" ? `Moving ${job.laneName} to a ${to} computer` : `Changing ${job.laneName} to ${to}`;
    case "online":
      return `${job.laneName} is online at ${to}`;
    case "failed":
      return job.kind === "move" ? `The move to ${to} stopped` : `The change to ${to} stopped`;
    case "cancelled":
      return `Kept ${job.laneName} at ${sizeLabel(account, job.fromSizeId) ?? "its size"}`;
  }
}

/** Cancel works only before the size changes: while the job waits, or saves the work. */
function canCancel(job: CloudLaneJobSnapshot): boolean {
  if (job.phase === "waiting") return true;
  if (job.phase !== "running") return false;
  return job.stages.every((stage) => stage.id === "save" || stage.status === "pending");
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
  className,
}: {
  job: CloudLaneJobSnapshot;
  /** For the size names and rates; null shows the size ids' own names. */
  account: CloudAccountState | null;
  /** `thread`: a chat card. `panel`: inside the dashboard's lane panel. */
  variant?: "thread" | "panel";
  className?: string;
}) {
  const [busy, setBusy] = useState<"retry" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const compact = variant === "panel";
  const failed = job.phase === "failed";
  const live = job.phase === "waiting" || job.phase === "running";
  const rail = useMemo(() => job.stages.map(railStage), [job.stages]);
  const textSize = compact ? "text-[11.5px]" : "text-[length:calc(var(--chat-font-size)*12/14)]";
  const metaSize = compact ? "text-[10.5px]" : "text-[length:calc(var(--chat-font-size)*11/14)]";
  const tileTone = live ? "adec-tile" : failed ? TILE_TONE.failed : job.phase === "online" ? TILE_TONE.done : TILE_TONE.skipped;
  const fromLabel = sizeLabel(account, job.fromSizeId);
  const toLabel = sizeLabel(account, job.toSizeId);

  const run = async (kind: "retry" | "cancel") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "retry") await retryCloudLaneJob(job.jobId);
      else await cancelCloudLaneJob(job.jobId);
    } catch (runError) {
      setError(ipcErrorMessage(runError) || "ADE couldn't do that. Try again in a moment.");
    } finally {
      setBusy(null);
    }
  };

  const copyDetails = () => {
    const failedStage = job.stages.find((stage) => stage.status === "failed");
    void copyTextToClipboard([
      cloudLaneJobTitle(job, account),
      `Lane: ${job.laneName}`,
      `Computer: ${job.instanceId}${job.fromInstanceId !== job.instanceId ? ` (from ${job.fromInstanceId})` : ""}`,
      `Size: ${job.fromSizeId ?? "?"} to ${job.toSizeId} (${job.kind}, ${job.timing})`,
      failedStage ? `Step: ${CLOUD_LANE_JOB_STAGE_LABELS[failedStage.id]}` : null,
      job.error ?? failedStage?.error ?? null,
      `Job: ${job.jobId}`,
    ].filter(Boolean).join("\n"));
  };

  const notice = job.phase === "waiting"
    ? "ADE waits for the agent to finish its turn. Your files and chats stay."
    : job.phase === "running"
      ? "Your files and chats stay. A message you send waits until ADE on the computer answers. You can close this window."
      : job.phase === "online"
        ? "ADE connected to the computer again."
        : null;

  return (
    <div
      data-cloud-lane-job={job.jobId}
      data-job-phase={job.phase}
      className={cn(
        "font-sans",
        textSize,
        compact
          ? "adecl-jobpanel"
          : cn(
            CHAT_CARD_WIDTH_CLASS,
            "ade-launch-card-enter rounded-[calc(var(--chat-radius-card,16px)-6px)] border bg-fg/[0.022] px-3.5 pb-2 pt-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]",
            failed ? "border-amber-400/20" : "border-fg/[0.07]",
          ),
        className,
      )}
    >
      <div className="relative flex min-w-0 items-start gap-2.5">
        <span className={cn("relative mt-px grid h-6 w-6 shrink-0 place-items-center rounded-[7px] border transition-colors duration-300", tileTone)} aria-hidden>
          {failed ? <Warning size={13} weight="bold" /> : <CloudMark size={13} bold />}
        </span>
        <div className="relative min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn("min-w-0 truncate font-medium", failed ? "text-amber-200/90" : "text-fg/82")} role="status">
              {cloudLaneJobTitle(job, account)}
            </span>
            <JobElapsed job={job} className={cn("ml-auto text-fg/38", metaSize)} />
          </div>
          <div className={cn("mt-1 flex min-w-0 flex-wrap items-center gap-1.5", metaSize)}>
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
          </div>
        </div>
      </div>
      <LaunchProgressRail stages={rail} cloud className="mb-1 mt-3" />
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
      {error ? <p className={cn("adecl-error mt-1.5", metaSize)} role="alert">{error}</p> : null}
      {!error && failed && job.error ? <p className={cn("adecl-error mt-1.5", metaSize)}>{job.error}</p> : null}
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
  );
});
