import { useEffect, useState } from "react";
import type { MacosVmEventPayload, MacosVmLifecycleState } from "../../../../shared/types";
import { cn } from "../../ui/cn";

export type MacosVmTabDotKind = "running" | "transitioning" | "stopped" | "none";

export function macosVmStateToDot(
  state: MacosVmLifecycleState | null | undefined,
): MacosVmTabDotKind {
  if (!state) return "none";
  switch (state) {
    case "running":
      return "running";
    case "creating":
    case "installing":
    case "starting":
    case "stopping":
      return "transitioning";
    case "not_created":
    case "ready":
    case "unknown":
      return "none";
    case "setup_required":
    case "stopped":
    case "paused":
    case "failed":
      return "stopped";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export function MacosVmTabDot({ kind }: { kind: MacosVmTabDotKind }) {
  if (kind === "none") return null;
  const cls =
    kind === "running"
      ? "bg-emerald-400 shadow-[0_0_4px_rgba(16,185,129,0.65)]"
      : kind === "transitioning"
      ? "bg-amber-300 animate-pulse"
      : "bg-white/30";
  const label = `macOS VM ${kind}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="macos-vm-tab-dot"
      data-kind={kind}
      className={cn("absolute top-1 right-1 h-1.5 w-1.5 rounded-full", cls)}
    />
  );
}

export function useMacosVmTabDotKind(laneId: string | null): MacosVmTabDotKind {
  const [state, setState] = useState<MacosVmLifecycleState | null>(null);

  useEffect(() => {
    if (!laneId) {
      setState(null);
      return undefined;
    }
    let cancelled = false;
    let eventReceived = false;
    setState(null);
    void window.ade.macosVm
      .getStatus({ laneId })
      .then((status) => {
        if (cancelled || eventReceived) return;
        setState(status.laneVm?.state ?? null);
      })
      .catch(() => {
        if (!cancelled) setState(null);
      });
    const unsubscribe = window.ade.macosVm.onEvent((event: MacosVmEventPayload) => {
      if (cancelled) return;
      eventReceived = true;
      if (event.type === "status") {
        if (event.status.laneVm?.laneId === laneId) {
          setState(event.status.laneVm.state);
        }
      } else if (event.type === "vm-updated" && event.vm.laneId === laneId) {
        setState(event.vm.state);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [laneId]);

  return macosVmStateToDot(state);
}
