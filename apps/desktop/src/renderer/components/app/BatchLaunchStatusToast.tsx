import React, { useEffect, useMemo } from "react";
import { ArrowClockwise, CheckCircle, CircleNotch, WarningCircle } from "@phosphor-icons/react";
import {
  isBatchLaunchInFlight,
  type BatchLaunchItemState,
  type BatchLaunchItemStatus,
} from "../../lib/linearBatchLaunch";
import { LinearMark } from "../lanes/linearBrand";
import { noticeTone, type NoticeTone } from "../ui/notice/noticeTones";
import { dismissToast, showToast } from "./toast/toastStore";

/** One batch at a time, so a new launch (or retry) takes over the same card. */
export const BATCH_LAUNCH_TOAST_ID = "linear-batch-launch";

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
  return <span className="inline-block h-2 w-2 rounded-full bg-fg/25" />;
}

function statusTextStyle(status: BatchLaunchItemStatus): React.CSSProperties {
  if (status === "failed") return { color: noticeTone("error").text, fontWeight: 500 };
  if (status === "agent-error") return { color: noticeTone("warning").text, fontWeight: 500 };
  return { color: "var(--color-muted-fg)" };
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
    <div
      className="-mx-1 max-h-64 overflow-y-auto rounded-lg border border-fg/[0.07] bg-fg/[0.025] p-1"
      data-testid="batch-launch-rows"
    >
      {rows.map((row) => {
        const clickable = Boolean(row.laneId);
        return (
          <button
            key={row.issue.id}
            type="button"
            disabled={!clickable}
            onClick={() => row.laneId && onOpenLane(row.laneId)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors enabled:hover:bg-fg/[0.05] disabled:cursor-default"
            title={row.error ?? (clickable ? "Open lane" : undefined)}
          >
            <StatusIcon status={row.status} />
            <span className="shrink-0 rounded bg-fg/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-fg/80">
              {row.issue.identifier}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-fg">{row.issue.title}</span>
            <span className="shrink-0 text-[10px]" style={statusTextStyle(row.status)}>
              {statusLabel(row.status)}
            </span>
          </button>
        );
      })}
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
      icon: <LinearMark size={14} />,
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
    const timer = window.setTimeout(onDismiss, 3200);
    return () => window.clearTimeout(timer);
  }, [rows.length, inFlight, failedCount, attentionCount, onDismiss]);

  useEffect(() => () => dismissToast(BATCH_LAUNCH_TOAST_ID), []);

  return null;
}
