import React, { useEffect, useMemo } from "react";
import { ArrowClockwise, CheckCircle, CircleNotch, GithubLogo, WarningCircle } from "@phosphor-icons/react";
import {
  isBatchLaunchInFlight,
  type BatchLaunchItemState,
  type BatchLaunchItemStatus,
  type LaunchIssue,
} from "../../lib/linearBatchLaunch";
import { LinearMark, LinearStateIcon } from "../lanes/linearBrand";
import { GitHubIssueStateIcon } from "../lanes/githubBrand";
import { JiraMark, JiraStatusIcon } from "../lanes/jiraBrand";
import { noticeTone, type NoticeTone } from "../ui/notice/noticeTones";
import { dismissToast, READABLE_TOAST_DURATION_MS, showToast } from "./toast/toastStore";

/** One batch at a time, so a new launch (or retry) takes over the same card. */
export const BATCH_LAUNCH_TOAST_ID = "issue-batch-launch";

function statusLabel(status: BatchLaunchItemStatus): string {
  switch (status) {
    case "creating-lane": return "Creating lane";
    case "launching-agent": return "Launching agent";
    case "initializing-agent": return "Starting agent";
    case "agent-error": return "Needs attention";
    case "done": return "Ready";
    case "failed": return "Failed";
    default: return "Queued";
  }
}

function StatusIcon({ status }: { status: BatchLaunchItemStatus }): React.ReactElement {
  if (status === "done") return <CheckCircle size={13} weight="fill" style={{ color: noticeTone("success").color }} />;
  if (status === "failed" || status === "agent-error") {
    return (
      <WarningCircle
        size={13}
        weight="fill"
        style={{ color: noticeTone(status === "failed" ? "error" : "warning").color }}
      />
    );
  }
  if (isBatchLaunchInFlight(status)) {
    return <CircleNotch size={13} className="animate-spin" style={{ color: noticeTone("info").color }} />;
  }
  return <span className="kit-dot" />;
}

function statusTextStyle(status: BatchLaunchItemStatus): React.CSSProperties {
  if (status === "failed") return { color: noticeTone("error").text };
  if (status === "agent-error") return { color: noticeTone("warning").text };
  return { color: "var(--kit-text-3)" };
}

function IssueMark({ issue }: { issue: LaunchIssue }): React.ReactElement {
  if (issue.tracker === "linear") return <LinearMark size={12} className="shrink-0" />;
  if (issue.tracker === "jira") return <JiraMark size={12} className="shrink-0" />;
  return <GithubLogo size={12} weight="fill" className="shrink-0" />;
}

function IssueStateIcon({ issue }: { issue: LaunchIssue }): React.ReactElement {
  const link = issue.createLaneLink;
  if ("linearIssue" in link) return <LinearStateIcon stateType={link.linearIssue.stateType} size={11} />;
  if ("githubIssue" in link) {
    return <GitHubIssueStateIcon state={link.githubIssue.state} stateReason={link.githubIssue.stateReason} size={11} />;
  }
  return <JiraStatusIcon category={link.jiraIssue.statusCategory} size={11} />;
}

function batchHeadline({
  rowCount,
  readyCount,
  failedCount,
  attentionCount,
  inFlight,
}: {
  rowCount: number;
  readyCount: number;
  failedCount: number;
  attentionCount: number;
  inFlight: boolean;
}): string {
  if (inFlight) return `Launching ${rowCount} ${rowCount === 1 ? "lane" : "lanes"}…`;
  const parts: string[] = [];
  if (readyCount > 0) parts.push(`${readyCount} ready`);
  if (failedCount > 0) parts.push(`${failedCount} failed`);
  if (attentionCount > 0) parts.push(`${attentionCount} needs attention`);
  return parts.join(" · ");
}

function BatchLaunchRows({
  rows,
  onOpenLane,
}: {
  rows: BatchLaunchItemState[];
  onOpenLane: (laneId: string) => void;
}) {
  return (
    <div className="kit-card max-h-64 overflow-y-auto" data-testid="batch-launch-rows">
      <div className="kit-card-body p-1" data-flush="true">
        {rows.map((row) => {
          const clickable = Boolean(row.laneId);
          return (
            <button
              key={`${row.issue.tracker}:${row.issue.id}`}
              type="button"
              disabled={!clickable}
              onClick={() => row.laneId && onOpenLane(row.laneId)}
              className="kit-row flex w-full items-center gap-2 px-2 py-1.5 text-left disabled:cursor-default"
              title={row.error ?? (clickable ? "Open lane" : undefined)}
            >
              <IssueMark issue={row.issue} />
              <IssueStateIcon issue={row.issue} />
              <span className="kit-num shrink-0 text-[10.5px] text-[color:var(--kit-text-2)]">
                {row.issue.key}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-fg">{row.issue.title}</span>
              <StatusIcon status={row.status} />
              <span className="shrink-0 text-[10px]" style={statusTextStyle(row.status)}>
                {statusLabel(row.status)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Status for an in-flight batch launch, as a card in the shared toast stack.
 * The launch itself is not a progress view (the user already rerouted to
 * Lanes), but this toast keeps per-issue state visible, lets the user jump to a
 * created lane, and offers Retry failed without losing the successful siblings.
 *
 * Renders nothing itself: it mirrors `states` into one store toast (stable id,
 * updated in place) and takes it down when the states clear or it unmounts.
 */
export function BatchLaunchStatusToast({
  states,
  onRetryFailed,
  onDismiss,
  onOpenLane,
}: {
  states: Map<string, BatchLaunchItemState>;
  onRetryFailed: () => void;
  onDismiss: () => void;
  onOpenLane: (laneId: string) => void;
}): null {
  const rows = useMemo(() => [...states.values()], [states]);
  const failedCount = rows.filter((row) => row.status === "failed").length;
  const attentionCount = rows.filter((row) => row.status === "agent-error").length;
  const doneCount = rows.filter((row) => row.status === "done").length;
  const inFlight = rows.some((row) => isBatchLaunchInFlight(row.status));

  useEffect(() => {
    if (!rows.length) {
      dismissToast(BATCH_LAUNCH_TOAST_ID);
      return;
    }
    const tone: NoticeTone = inFlight
      ? "info"
      : failedCount > 0
        ? "error"
        : attentionCount > 0
          ? "warning"
          : "success";
    showToast({
      id: BATCH_LAUNCH_TOAST_ID,
      tone,
      icon: rows.length === 1 ? <IssueMark issue={rows[0]!.issue} /> : undefined,
      title: batchHeadline({
        rowCount: rows.length,
        readyCount: doneCount,
        failedCount,
        attentionCount,
        inFlight,
      }),
      content: <BatchLaunchRows rows={rows} onOpenLane={onOpenLane} />,
      actions: failedCount > 0 && !inFlight
        ? [{
            label: `Retry ${failedCount} failed`,
            variant: "primary",
            icon: <ArrowClockwise size={12} weight="bold" />,
            keepOpen: true,
            onClick: onRetryFailed,
          }]
        : undefined,
      onClose: onDismiss,
      // The card's lifetime is the batch's: it closes with × or the success beat below.
      durationMs: 0,
    });
  }, [rows, inFlight, failedCount, attentionCount, doneCount, onOpenLane, onRetryFailed, onDismiss]);

  // Auto-dismiss a fully-successful run after a short beat.
  useEffect(() => {
    if (!rows.length) return;
    if (inFlight || failedCount > 0 || attentionCount > 0) return;
    const timer = window.setTimeout(onDismiss, READABLE_TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [rows.length, inFlight, failedCount, attentionCount, onDismiss]);

  useEffect(() => () => dismissToast(BATCH_LAUNCH_TOAST_ID), []);

  return null;
}
