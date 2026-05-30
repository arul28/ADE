import React, { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { ArrowClockwise, CheckCircle, CircleNotch, WarningCircle, X } from "@phosphor-icons/react";
import type { BatchLaunchItemState, BatchLaunchItemStatus } from "../../lib/linearBatchLaunch";
import { LINEAR_BRAND } from "../lanes/linearBrand";

function statusLabel(status: BatchLaunchItemStatus): string {
  switch (status) {
    case "creating-lane": return "Creating lane";
    case "launching-agent": return "Launching agent";
    case "done": return "Ready";
    case "failed": return "Failed";
    default: return "Queued";
  }
}

function StatusIcon({ status }: { status: BatchLaunchItemStatus }): React.ReactElement {
  if (status === "done") return <CheckCircle size={13} weight="fill" className="text-emerald-400" />;
  if (status === "failed") return <WarningCircle size={13} weight="fill" className="text-rose-400" />;
  if (status === "creating-lane" || status === "launching-agent") {
    return <CircleNotch size={13} className="animate-spin text-[color:var(--ade-linear,#7B8AF0)]" />;
  }
  return <span className="inline-block h-2 w-2 rounded-full bg-white/25" />;
}

/**
 * Floating status for an in-flight batch launch. The launch itself is not a
 * progress view (the user already rerouted to Lanes), but this toast keeps
 * per-issue state visible, lets the user jump to a created lane, and offers
 * Retry failed without losing the successful siblings.
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
}) {
  const rows = useMemo(() => [...states.values()], [states]);
  const failedCount = rows.filter((row) => row.status === "failed").length;
  const doneCount = rows.filter((row) => row.status === "done").length;
  const inFlight = rows.some((row) => row.status === "creating-lane" || row.status === "launching-agent" || row.status === "pending");

  // Auto-dismiss a fully-successful run after a short beat.
  useEffect(() => {
    if (!rows.length) return;
    if (inFlight || failedCount > 0) return;
    const timer = window.setTimeout(onDismiss, 3200);
    return () => window.clearTimeout(timer);
  }, [rows.length, inFlight, failedCount, onDismiss]);

  if (!rows.length) return null;

  return createPortal(
    <div className="fixed bottom-4 right-4 z-[10001] w-[min(340px,calc(100vw-32px))]">
      <div
        className="overflow-hidden rounded-xl border bg-[color:var(--ade-shell-surface,#121019)] shadow-2xl shadow-black/50"
        style={{ borderColor: LINEAR_BRAND.border }}
      >
        <div
          className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2"
          style={{ background: LINEAR_BRAND.surface }}
        >
          <span className="text-[12px] font-semibold text-fg/90">
            {inFlight
              ? `Launching ${rows.length} ${rows.length === 1 ? "lane" : "lanes"}…`
              : failedCount > 0
                ? `${doneCount} launched · ${failedCount} failed`
                : `${doneCount} ${doneCount === 1 ? "lane" : "lanes"} launched`}
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={onDismiss}
            className="grid h-5 w-5 place-items-center rounded text-muted-fg/55 transition-colors hover:bg-white/[0.08] hover:text-fg/85"
          >
            <X size={11} />
          </button>
        </div>
        <div className="max-h-64 overflow-y-auto px-1.5 py-1.5">
          {rows.map((row) => {
            const clickable = Boolean(row.laneId);
            return (
              <button
                key={row.issue.id}
                type="button"
                disabled={!clickable}
                onClick={() => row.laneId && onOpenLane(row.laneId)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors enabled:hover:bg-white/[0.05] disabled:cursor-default"
                title={row.error ?? (clickable ? "Open lane" : undefined)}
              >
                <StatusIcon status={row.status} />
                <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-fg/80">
                  {row.issue.identifier}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-fg/75">{row.issue.title}</span>
                <span
                  className={
                    row.status === "failed"
                      ? "shrink-0 text-[10px] font-medium text-rose-300/90"
                      : "shrink-0 text-[10px] text-muted-fg/55"
                  }
                >
                  {statusLabel(row.status)}
                </span>
              </button>
            );
          })}
        </div>
        {failedCount > 0 && !inFlight ? (
          <div className="border-t border-white/10 px-3 py-2">
            <button
              type="button"
              onClick={onRetryFailed}
              className="inline-flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-white/[0.12] bg-white/[0.04] text-[11.5px] font-medium text-fg/85 transition-colors hover:border-white/[0.2] hover:bg-white/[0.08]"
            >
              <ArrowClockwise size={12} weight="bold" />
              Retry {failedCount} failed
            </button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
