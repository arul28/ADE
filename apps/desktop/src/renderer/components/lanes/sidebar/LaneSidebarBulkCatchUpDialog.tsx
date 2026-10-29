import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwise, CircleNotch, GitMerge, Sparkle, Stack } from "@phosphor-icons/react";
import type { LaneSummary, OpenProjectBinding } from "../../../../shared/types";
import { buildLaneCatchUpPrompt, type LaneCatchUpPromptInput } from "../../../lib/laneCatchUpPrompt";
import { useAppStore } from "../../../state/appStore";
import { READABLE_TOAST_DURATION_MS, showToast } from "../../app/toast/toastStore";
import { LaneDialogShell } from "../LaneDialogShell";
import {
  laneCatchUpMergeAvailable,
  laneCatchUpOptions,
  laneCatchUpPromptInput,
  lanePushedFromStatus,
  readLaneCatchUpConflict,
  runLaneCatchUpDirect,
  useLaneCatchUpAskAgent,
  type LaneCatchUpConflict,
} from "../laneCatchUp";
import type { LaneCatchUpTarget } from "../LaneCatchUpMenu";
import { getLaneAccent } from "../laneColorPalette";
import { COLORS } from "../laneDesignTokens";
import type { LaneRebaseLine } from "../laneRebaseNeeds";

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

const CHECKING: LaneCatchUpConflict = { state: "checking" };

/** One lane's "Ask an agent", on that lane's machine. */
function AskAgentButton({ item, prompt, onAsked }: { item: LaneBulkCatchUpTarget; prompt: LaneCatchUpPromptInput; onAsked: () => void }) {
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
        void askAgent(target.laneId, buildLaneCatchUpPrompt(prompt));
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
  // A fresh conflict check per lane, on its own machine.
  const [conflicts, setConflicts] = useState<ReadonlyMap<string, LaneCatchUpConflict> | null>(null);
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
      setConflicts(null);
      return;
    }
    let cancelled = false;
    // Each lane by its machine, already narrowed to the ones that can run.
    const byMachine = new Map<string, { pin: OpenProjectBinding | null; lanes: { laneId: string; key: string }[] }>();
    for (const item of targets) {
      const target = item.target;
      if (!target.ok) continue;
      const machineKey = target.pin?.key ?? "tab";
      const group = byMachine.get(machineKey) ?? { pin: target.pin, lanes: [] };
      group.lanes.push({ laneId: target.laneId, key: item.key });
      byMachine.set(machineKey, group);
    }
    const groups = [...byMachine.values()];
    void Promise.all(groups.flatMap(({ pin, lanes }) => lanes.map(async ({ laneId, key }) => (
      [key, await readLaneCatchUpConflict(laneId, pin)] as const
    )))).then((entries) => {
      if (!cancelled) setConflicts(new Map(entries));
    });
    void Promise.all(groups.map(async ({ pin, lanes }) => {
      const statuses = await window.ade.git
        .getSyncStatuses({ laneIds: lanes.map((lane) => lane.laneId) }, pin)
        .catch((error) => {
          // Unknown means not pushed is unproven: those lanes get no rebase.
          console.warn("lane_catch_up.sync_statuses_failed", error);
          return {} as Record<string, { hasUpstream: boolean } | null>;
        });
      return lanes.flatMap(({ laneId, key }) => {
        const status = statuses[laneId];
        return status ? [[key, status.hasUpstream] as const] : [];
      });
    })).then((entries) => {
      if (!cancelled) setSyncPushed(new Map(entries.flat()));
    });
    return () => { cancelled = true; };
  }, [open, targetsKey]);

  const rows = useMemo(() => targets.map((item) => {
    const pushed = lanePushedFromStatus(item.lane, item.hasPr) ?? syncPushed?.get(item.key) ?? null;
    const conflict = conflicts?.get(item.key) ?? CHECKING;
    const prompt = laneCatchUpPromptInput(item.lane, item.line, pushed, conflict);
    if (!item.target.ok) return { item, prompt, plan: { kind: "agent", reason: item.target.reason } as Plan };
    const options = laneCatchUpOptions({
      conflict,
      dirty: Boolean(item.lane.status?.dirty),
      inProgress: Boolean(item.lane.status?.rebaseInProgress),
      pushed,
      mergeAvailable: laneCatchUpMergeAvailable(item.target.pin),
    });
    const plan: Plan = options.rebase
      ? { kind: "rebase" }
      : options.merge
        ? { kind: "merge" }
        : { kind: "agent", reason: options.blocker ?? "Needs a closer look" };
    return { item, prompt, plan };
  }), [conflicts, syncPushed, targets]);

  const direct = rows.filter((row) => row.plan.kind !== "agent");
  const checking = open && (syncPushed == null || conflicts == null);

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
        prompt: row.prompt,
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
            <span className="mr-auto text-xs" style={{ color: COLORS.textMuted }}>Checking each lane…</span>
          ) : null}
          <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="kit-btn kit-btn-primary"
            data-size="sm"
            data-testid="lane-bulk-catch-up-confirm"
            disabled={busy || checking || count === 0}
            onClick={() => { void run(); }}
          >
            {count === 1 ? "Catch up 1 lane" : `Catch up ${count} lanes`}
          </button>
        </div>
      )}
    >
      <ul className="space-y-1" data-testid="lane-bulk-catch-up-list">
        {rows.map(({ item, prompt, plan }) => (
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
                <AskAgentButton item={item} prompt={prompt} onAsked={() => onOpenChange(false)} />
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
