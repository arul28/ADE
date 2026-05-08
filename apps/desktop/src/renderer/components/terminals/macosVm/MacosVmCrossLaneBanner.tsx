import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Desktop, Stop, X } from "@phosphor-icons/react";
import type { MacosVmRecord, MacosVmStatus } from "../../../../shared/types";
import { useAppStore } from "../../../state/appStore";

const SIBLING_STATES = new Set(["running", "starting", "installing"]);

function uptimeLabel(vm: MacosVmRecord): string | null {
  if (vm.state !== "running" || !vm.lastStartedAt) return null;
  const startedAt = Date.parse(vm.lastStartedAt);
  if (!Number.isFinite(startedAt)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin}m`;
}

function stateBadge(state: MacosVmRecord["state"]): { label: string; className: string } {
  if (state === "running") {
    return { label: "running", className: "bg-emerald-400/20 text-emerald-100" };
  }
  if (state === "starting") {
    return { label: "starting", className: "bg-amber-400/20 text-amber-100" };
  }
  return { label: "installing", className: "bg-amber-400/20 text-amber-100" };
}

export type MacosVmCrossLaneBannerProps = {
  status: MacosVmStatus | null;
  activeLaneId: string;
};

export function MacosVmCrossLaneBanner({ status, activeLaneId }: MacosVmCrossLaneBannerProps) {
  const [dismissedLaneIds, setDismissedLaneIds] = useState<Set<string>>(() => new Set());
  const [tick, setTick] = useState(0);
  const selectLane = useAppStore((s) => s.selectLane);
  const lanes = useAppStore((s) => s.lanes);

  const sibling = useMemo<MacosVmRecord | null>(() => {
    if (!status) return null;
    const found = status.vms.find(
      (vm) => vm.laneId !== activeLaneId && SIBLING_STATES.has(vm.state) && !dismissedLaneIds.has(vm.laneId),
    );
    return found ?? null;
  }, [status, activeLaneId, dismissedLaneIds]);

  useEffect(() => {
    if (!sibling || sibling.state !== "running") return undefined;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [sibling]);
  void tick;

  if (!sibling) return null;

  const badge = stateBadge(sibling.state);
  const uptime = uptimeLabel(sibling);
  const laneLabel =
    lanes.find((lane) => lane.id === sibling.laneId)?.name ?? sibling.laneName ?? sibling.laneId;

  const onSwitchLane = () => selectLane(sibling.laneId);
  const onFocus = () => {
    void window.ade.macosVm.focusWindow({ laneId: sibling.laneId }).catch(() => {});
  };
  const onStop = () => {
    void window.ade.macosVm.stop({ laneId: sibling.laneId }).catch(() => {});
  };
  const onDismiss = () => {
    setDismissedLaneIds((prev) => {
      const next = new Set(prev);
      next.add(sibling.laneId);
      return next;
    });
  };

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="macos-vm-cross-lane-banner"
      className="sticky top-0 z-10 flex items-center gap-2 rounded-md border border-amber-400/25 bg-amber-500/[0.07] px-2.5 py-1.5 text-[11px] text-amber-100/90"
    >
      <span
        className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${badge.className}`}
      >
        {badge.label}
      </span>
      <span className="min-w-0 truncate">
        <span className="text-muted-fg/70">lane </span>
        <span className="font-medium text-fg">{laneLabel}</span>
        {uptime ? <span className="ml-1 font-mono text-muted-fg/60">· {uptime}</span> : null}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <button
          type="button"
          className="ade-shell-control inline-flex h-6 items-center gap-1 rounded-md px-2 text-[10px]"
          data-variant="ghost"
          onClick={onSwitchLane}
          aria-label={`Switch to lane ${laneLabel}`}
        >
          <ArrowRight size={11} weight="bold" />
          Switch lane
        </button>
        <button
          type="button"
          className="ade-shell-control inline-flex h-6 items-center gap-1 rounded-md px-2 text-[10px]"
          data-variant="ghost"
          onClick={onFocus}
          aria-label="Bring VM window forward"
        >
          <Desktop size={11} weight="regular" />
          Focus
        </button>
        <button
          type="button"
          className="ade-shell-control inline-flex h-6 items-center gap-1 rounded-md px-2 text-[10px]"
          data-variant="ghost"
          onClick={onStop}
          aria-label={`Stop VM for lane ${laneLabel}`}
        >
          <Stop size={11} weight="fill" />
          Stop
        </button>
        <button
          type="button"
          className="ade-shell-control inline-flex h-6 w-6 items-center justify-center rounded-md"
          data-variant="ghost"
          onClick={onDismiss}
          aria-label="Dismiss cross-lane banner"
        >
          <X size={11} />
        </button>
      </div>
    </div>
  );
}
