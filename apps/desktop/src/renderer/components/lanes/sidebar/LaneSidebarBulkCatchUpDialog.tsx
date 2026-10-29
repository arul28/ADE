import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwise, CircleNotch, GitMerge, Sparkle, Stack } from "@phosphor-icons/react";
import type { LaneSummary } from "../../../../shared/types";
import { buildLaneCatchUpPrompt, type LaneCatchUpPromptInput } from "../../../lib/laneCatchUpPrompt";
import { useAppStore } from "../../../state/appStore";
import { READABLE_TOAST_DURATION_MS, showToast } from "../../app/toast/toastStore";
import { Button } from "../../ui/Button";
import { LaneDialogShell } from "../LaneDialogShell";
import { laneCatchUpOptions } from "../laneCatchUp";
import { runLaneCatchUpDirect, useLaneCatchUpAskAgent, type LaneCatchUpTarget } from "../LaneCatchUpMenu";
import { getLaneAccent } from "../laneColorPalette";
import { COLORS } from "../laneDesignTokens";
import type { LaneRebaseLine } from "../laneRebaseNeeds";
import { laneBranchLabel } from "./laneSidebarModel";

export type LaneBulkCatchUpTarget = {
  /** Row key. */
  key: string;
  lane: LaneSummary;
  colorIndex: number;
  line: LaneRebaseLine;
  target: LaneCatchUpTarget;
  hasPr: boolean;
};

type Plan =
  | { kind: "rebase" | "merge" }
  | { kind: "agent"; reason: string };

function promptFor(item: LaneBulkCatchUpTarget, pushed: boolean | null) {
  return (failure: LaneCatchUpPromptInput["failure"] = null): LaneCatchUpPromptInput => ({
    laneName: item.lane.name,
    branch: laneBranchLabel(item.lane.branchRef),
    baseBranch: item.line.baseBranch,
    kind: item.line.kind,
    behindBy: item.line.behindBy,
    mergedPrNumber: item.line.mergedPrNumber,
    pushed,
    conflictingFiles: item.line.conflictingFiles,
    failure,
  });
}

/** One lane's "Ask an agent", on that lane's machine. */
function AskAgentButton({ item, pushed, onAsked }: { item: LaneBulkCatchUpTarget; pushed: boolean | null; onAsked: () => void }) {
  const target = item.target;
  const askAgent = useLaneCatchUpAskAgent(target.ok ? target.pin : null);
  return (
    <button
      type="button"
      className="kit-btn shrink-0"
      data-size="xs"
      style={{ gap: 4 }}
      disabled={!target.ok}
      data-testid="lane-bulk-catch-up-agent"
      onClick={() => {
        if (!target.ok) return;
        onAsked();
        void askAgent(target.laneId, buildLaneCatchUpPrompt(promptFor(item, pushed)()));
      }}
    >
      <Sparkle size={10} weight="duotone" aria-hidden style={{ color: COLORS.accent }} />
      Ask an agent
    </button>
  );
}

/**
 * "Catch up all" for the Behind group. Each lane gets what its own Catch up
 * menu would offer as safe: a rebase when its branch was never pushed, else a
 * merge of its base, both undone on a conflict. A lane where neither is safe
 * (uncommitted changes, conflicts expected) is listed with the reason and its
 * own "Ask an agent". Lanes run one at a time on their own machines; nothing
 * is pushed.
 */
export function LaneSidebarBulkCatchUpDialog({
  open,
  targets,
  onOpenChange,
}: {
  open: boolean;
  targets: LaneBulkCatchUpTarget[];
  onOpenChange: (open: boolean) => void;
}) {
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const [progress, setProgress] = useState<{ index: number; total: number; laneName: string } | null>(null);
  const busy = progress != null;
  // Whether each lane's branch is on the remote, read once per machine on open.
  const [syncPushed, setSyncPushed] = useState<ReadonlyMap<string, boolean> | null>(null);
  // Keyed on the lanes and their machines, not the array: the page rebuilds it on every refresh.
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const targetsKey = targets
    .map((item) => `${item.key}@${item.target.ok ? item.target.pin?.key ?? "tab" : "-"}`)
    .join("|");

  useEffect(() => {
    const targets = targetsRef.current;
    if (!open) {
      setProgress(null);
      setSyncPushed(null);
      return;
    }
    let cancelled = false;
    const byMachine = new Map<string, { pin: LaneCatchUpTarget & { ok: true }; items: LaneBulkCatchUpTarget[] }>();
    for (const item of targets) {
      if (!item.target.ok) continue;
      const machineKey = item.target.pin?.key ?? "tab";
      const group = byMachine.get(machineKey) ?? { pin: item.target, items: [] };
      group.items.push(item);
      byMachine.set(machineKey, group);
    }
    void Promise.all([...byMachine.values()].map(async ({ pin, items }) => {
      const statuses = await window.ade.git
        .getSyncStatuses({ laneIds: items.map((item) => (item.target.ok ? item.target.laneId : "")) }, pin.pin)
        .catch(() => ({}) as Record<string, { hasUpstream: boolean } | null>);
      return items.flatMap((item) => {
        const status = item.target.ok ? statuses[item.target.laneId] : null;
        return status ? [[item.key, status.hasUpstream] as const] : [];
      });
    })).then((entries) => {
      if (!cancelled) setSyncPushed(new Map(entries.flat()));
    });
    return () => { cancelled = true; };
  }, [open, targetsKey]);

  const mergeAvailable = typeof window.ade?.git?.mergeBaseIn === "function";
  const rows = useMemo(() => targets.map((item) => {
    const statusPushed = item.hasPr || (item.lane.status?.remoteBehind ?? -1) >= 0;
    const pushed = statusPushed ? true : syncPushed?.get(item.key) ?? null;
    if (!item.target.ok) return { item, pushed, plan: { kind: "agent", reason: item.target.reason } as Plan };
    const options = laneCatchUpOptions({
      line: item.line,
      dirty: Boolean(item.lane.status?.dirty),
      inProgress: Boolean(item.lane.status?.rebaseInProgress),
      pushed,
      mergeAvailable,
    });
    const plan: Plan = options.rebase
      ? { kind: "rebase" }
      : options.merge
        ? { kind: "merge" }
        : { kind: "agent", reason: options.blocker ?? "Needs a closer look" };
    return { item, pushed, plan };
  }), [mergeAvailable, syncPushed, targets]);

  const direct = rows.filter((row) => row.plan.kind !== "agent");
  const checking = open && syncPushed == null;

  const run = async () => {
    const failures: string[] = [];
    let updated = 0;
    for (const [index, row] of direct.entries()) {
      const target = row.item.target;
      if (!target.ok || row.plan.kind === "agent") continue;
      setProgress({ index, total: direct.length, laneName: row.item.lane.name });
      const outcome = await runLaneCatchUpDirect({
        action: row.plan.kind,
        laneId: target.laneId,
        pin: target.pin,
        machineId: target.machineId,
        laneName: row.item.lane.name,
        baseBranch: row.item.line.baseBranch,
        prompt: promptFor(row.item, row.pushed),
        refreshLanes,
        quiet: true,
      });
      if (outcome && !outcome.ok) failures.push(`${row.item.lane.name}: ${outcome.failure.message}`);
      else if (outcome?.ok) updated += 1;
    }
    setProgress(null);
    onOpenChange(false);
    if (failures.length === 0) {
      showToast({ tone: "success", title: updated === 1 ? "Caught up 1 lane" : `Caught up ${updated} lanes`, message: "Nothing was pushed." });
    } else {
      showToast({
        tone: "error",
        title: `${failures.length} of ${direct.length} lanes didn't catch up`,
        // Each lane's overview shows its own failure, with "Ask an agent".
        message: `${failures.join("\n")}\nOpen a lane to ask an agent.`,
        durationMs: READABLE_TOAST_DURATION_MS,
      });
    }
  };

  const count = direct.length;
  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={targets.length === 1 ? "Catch up 1 lane" : `Catch up ${targets.length} lanes`}
      description="Lanes that were never pushed are rebased; pushed ones get their base merged in. A conflict undoes itself. Nothing is pushed."
      icon={ArrowsClockwise}
      width="min(560px, calc(100vw - 1rem))"
      busy={busy}
      footer={(
        <div className="flex items-center justify-end gap-2">
          {progress ? (
            <span className="mr-auto flex min-w-0 items-center gap-1.5 text-xs" style={{ color: COLORS.textMuted }}>
              <CircleNotch size={12} className="shrink-0 animate-spin" />
              <span className="truncate">{`Catching up ${progress.index + 1} of ${progress.total} · ${progress.laneName}`}</span>
            </span>
          ) : checking ? (
            <span className="mr-auto text-xs" style={{ color: COLORS.textMuted }}>Checking which branches are pushed…</span>
          ) : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            data-testid="lane-bulk-catch-up-confirm"
            disabled={busy || checking || count === 0}
            onClick={() => { void run(); }}
          >
            {count === 1 ? "Catch up 1 lane" : `Catch up ${count} lanes`}
          </Button>
        </div>
      )}
    >
      <ul className="space-y-1" data-testid="lane-bulk-catch-up-list">
        {rows.map(({ item, pushed, plan }) => (
          <li
            key={item.key}
            className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-xs"
            style={{ background: COLORS.cardBg }}
            data-plan={plan.kind}
          >
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: getLaneAccent(item.lane, item.colorIndex) }} />
            <span className="min-w-0 shrink truncate font-medium" style={{ color: COLORS.textPrimary }}>{item.lane.name}</span>
            <span className="min-w-0 flex-1 truncate tabular-nums" style={{ color: COLORS.textMuted }}>{item.line.text}</span>
            {plan.kind === "agent" ? (
              <>
                <span className="shrink-0 truncate" style={{ color: COLORS.warning, maxWidth: 200 }} title={plan.reason}>{plan.reason}</span>
                <AskAgentButton item={item} pushed={pushed} onAsked={() => onOpenChange(false)} />
              </>
            ) : (
              <span className="inline-flex shrink-0 items-center gap-1" style={{ color: COLORS.textSecondary }}>
                {plan.kind === "rebase" ? <Stack size={12} aria-hidden /> : <GitMerge size={12} aria-hidden />}
                {plan.kind === "rebase" ? "Rebase" : `Merge ${item.line.baseBranch} in`}
              </span>
            )}
          </li>
        ))}
      </ul>
    </LaneDialogShell>
  );
}
