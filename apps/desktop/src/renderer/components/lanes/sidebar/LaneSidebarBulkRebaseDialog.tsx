import React, { useEffect, useState } from "react";
import { ArrowsClockwise, CircleNotch } from "@phosphor-icons/react";
import type { LaneSummary } from "../../../../shared/types";
import { showToast } from "../../app/toast/toastStore";
import { Button } from "../../ui/Button";
import { BranchIcon } from "../../ui/vcsIcons";
import { LaneDialogShell } from "../LaneDialogShell";
import { getLaneAccent } from "../laneColorPalette";
import { COLORS } from "../laneDesignTokens";
import { laneBranchLabel } from "./laneSidebarModel";

export type LaneBulkRebaseTarget = {
  lane: LaneSummary;
  colorIndex: number;
  /** Commits behind its base, when known. */
  behind: number;
};

/**
 * Confirm step for the Behind group's "Rebase all". Lists every lane it will
 * touch, then rebases them one at a time (parents before children, the order
 * the list gives) and reports failures in one toast at the end. Each lane is
 * rebased on its own; pushing stays a separate, reviewed step.
 */
export function LaneSidebarBulkRebaseDialog({
  open,
  targets,
  onOpenChange,
  rebaseLane,
  onFinished,
}: {
  open: boolean;
  targets: LaneBulkRebaseTarget[];
  onOpenChange: (open: boolean) => void;
  /** Rebases one lane. Resolves to an error message, or null on success. */
  rebaseLane: (laneId: string) => Promise<string | null>;
  onFinished: () => void;
}) {
  const [progress, setProgress] = useState<{ index: number; laneName: string } | null>(null);
  const busy = progress != null;

  useEffect(() => {
    if (!open) setProgress(null);
  }, [open]);

  const run = async () => {
    const failures: string[] = [];
    for (const [index, target] of targets.entries()) {
      setProgress({ index, laneName: target.lane.name });
      try {
        const error = await rebaseLane(target.lane.id);
        if (error) failures.push(`${target.lane.name}: ${error}`);
      } catch (err) {
        failures.push(`${target.lane.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setProgress(null);
    onOpenChange(false);
    onFinished();
    const succeeded = targets.length - failures.length;
    if (failures.length === 0) {
      showToast({ title: succeeded === 1 ? "Rebased 1 lane" : `Rebased ${succeeded} lanes`, tone: "success" });
    } else {
      showToast({
        title: `${failures.length} of ${targets.length} rebases need attention`,
        message: failures.join("\n"),
        tone: "error",
      });
    }
  };

  const count = targets.length;
  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={count === 1 ? "Rebase 1 lane" : `Rebase ${count} lanes`}
      description="Each lane is rebased onto its base, one at a time. Nothing is pushed."
      icon={ArrowsClockwise}
      widthClassName="w-[min(520px,calc(100vw-1rem))]"
      busy={busy}
      footer={(
        <div className="flex items-center justify-end gap-2">
          {progress ? (
            <span className="mr-auto flex min-w-0 items-center gap-1.5 text-xs" style={{ color: COLORS.textMuted }}>
              <CircleNotch size={12} className="shrink-0 animate-spin" />
              <span className="truncate">
                {`Rebasing ${progress.index + 1} of ${count} · ${progress.laneName}`}
              </span>
            </span>
          ) : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            data-testid="lane-bulk-rebase-confirm"
            disabled={busy || count === 0}
            onClick={() => { void run(); }}
          >
            {count === 1 ? "Rebase lane" : `Rebase ${count} lanes`}
          </Button>
        </div>
      )}
    >
      <ul className="space-y-1" data-testid="lane-bulk-rebase-list">
        {targets.map((target) => (
          <li
            key={target.lane.id}
            className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs"
            style={{ background: "color-mix(in srgb, var(--color-fg) 3%, transparent)" }}
          >
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: getLaneAccent(target.lane, target.colorIndex) }}
            />
            <span className="min-w-0 shrink truncate font-medium" style={{ color: COLORS.textPrimary }}>
              {target.lane.name}
            </span>
            <BranchIcon size={10} className="shrink-0 opacity-50" />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: COLORS.textMuted }}>
              {laneBranchLabel(target.lane.branchRef)}
            </span>
            {target.behind > 0 ? (
              <span className="shrink-0 font-mono text-[11px] tabular-nums" style={{ color: "#a78bfa" }}>
                {target.behind} behind
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </LaneDialogShell>
  );
}
