import { useMemo, useState } from "react";
import { ArrowRight, Desktop, Stop } from "@phosphor-icons/react";
import type { MacosVmRecord, MacosVmStatus } from "../../../../shared/types";
import { useAppStore } from "../../../state/appStore";

export type MacosVmRunningBarProps = {
  status: MacosVmStatus | null;
  activeLaneId: string | null;
};

export function MacosVmRunningBar({ status, activeLaneId }: MacosVmRunningBarProps) {
  const lanes = useAppStore((s) => s.lanes);
  const selectLane = useAppStore((s) => s.selectLane);
  const [actionError, setActionError] = useState<string | null>(null);

  const running = useMemo<MacosVmRecord[]>(
    () => (status?.vms ?? []).filter((vm) => vm.state === "running"),
    [status],
  );

  if (running.length < 2) return null;

  return (
    <div
      role="status"
      data-testid="macos-vm-running-bar"
      className="sticky top-0 z-10 flex flex-col gap-1 rounded-md border border-white/[0.08] bg-white/[0.035] px-2.5 py-1.5 text-[11px]"
    >
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-fg/70">
        <span>Running macOS VMs</span>
        <span className="font-mono text-fg/80">{running.length}</span>
      </div>
      <ul className="flex flex-col gap-1">
        {running.map((vm) => {
          const laneLabel =
            lanes.find((lane) => lane.id === vm.laneId)?.name ?? vm.laneName ?? vm.laneId;
          const isActive = vm.laneId === activeLaneId;
          return (
            <li
              key={vm.id}
              className="flex items-center gap-2 rounded-sm px-1 py-0.5"
              data-active={isActive ? "true" : "false"}
            >
              <span
                aria-hidden="true"
                className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(16,185,129,0.65)]"
              />
              <span className="min-w-0 flex-1 truncate">
                <span className="text-muted-fg/70">lane </span>
                <span className={isActive ? "font-medium text-fg" : "text-fg/85"}>
                  {laneLabel}
                </span>
                <span className="ml-1 font-mono text-muted-fg/60">
                  · {vm.cpuCores} vCPU · {vm.memory}
                </span>
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  className="ade-shell-control inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[10px]"
                  data-variant="ghost"
                  onClick={() => {
                    setActionError(null);
                    void window.ade.macosVm.focusWindow({ laneId: vm.laneId }).catch((err) => {
                      console.error("Failed to focus macOS VM window", { laneId: vm.laneId, err });
                      setActionError(err instanceof Error ? err.message : String(err));
                    });
                  }}
                  aria-label={`Focus VM window for lane ${laneLabel}`}
                >
                  <Desktop size={10} />
                  Focus
                </button>
                <button
                  type="button"
                  className="ade-shell-control inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[10px]"
                  data-variant="ghost"
                  onClick={() => {
                    setActionError(null);
                    void window.ade.macosVm.stop({ laneId: vm.laneId }).catch((err) => {
                      console.error("Failed to stop macOS VM", { laneId: vm.laneId, err });
                      setActionError(err instanceof Error ? err.message : String(err));
                    });
                  }}
                  aria-label={`Stop VM for lane ${laneLabel}`}
                >
                  <Stop size={10} weight="fill" />
                  Stop
                </button>
                {!isActive ? (
                  <button
                    type="button"
                    className="ade-shell-control inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[10px]"
                    data-variant="ghost"
                    onClick={() => selectLane(vm.laneId)}
                    aria-label={`Switch to lane ${laneLabel}`}
                  >
                    <ArrowRight size={10} weight="bold" />
                    Switch
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {actionError ? <div className="text-[11px] text-rose-200/85" role="alert">{actionError}</div> : null}
    </div>
  );
}
