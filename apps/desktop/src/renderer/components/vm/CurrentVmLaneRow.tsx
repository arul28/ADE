import { ArrowSquareOut, GitBranch, SpinnerGap, XCircle } from "@phosphor-icons/react";
import type { LaneSummary } from "../../../shared/types";

export function CurrentVmLaneRow({
  lane,
  busy,
  onOpenInWork,
  onDetach,
}: {
  lane: LaneSummary | null;
  busy?: boolean;
  onOpenInWork: (laneId: string) => void;
  onDetach: (laneId: string) => void;
}) {
  if (!lane) {
    return (
      <div
        className="flex items-center gap-2 rounded-md px-3 py-2.5 text-[12px]"
        style={{ background: "#13101A", border: "1px solid #1E1B26", color: "#A1A1AA" }}
      >
        <GitBranch size={14} style={{ color: "#52525B" }} />
        No VM lane. Create one via + New lane → Mac VM.
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-3 rounded-md px-3 py-2.5"
      style={{
        background: "color-mix(in srgb, var(--color-accent, #A78BFA) 8%, transparent)",
        border: "1px solid color-mix(in srgb, var(--color-accent, #A78BFA) 30%, transparent)",
      }}
    >
      <GitBranch size={15} weight="bold" style={{ color: "#A78BFA" }} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-semibold" style={{ color: "#FAFAFA" }}>
          {lane.name}
        </div>
        <div className="mt-0.5 truncate text-[11px]" style={{ color: "#71717A" }}>
          Mac VM lane
        </div>
      </div>
      <button
        type="button"
        onClick={() => onOpenInWork(lane.id)}
        disabled={busy}
        className="ade-shell-control inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 font-mono text-[10px] font-bold uppercase tracking-[1px]"
        data-variant="ghost"
      >
        <ArrowSquareOut size={11} />
        Open in Work
      </button>
      <button
        type="button"
        onClick={() => {
          const confirmed = window.confirm(
            `Detach "${lane.name}" from the Mac VM? The lane becomes a normal local worktree; further turns run locally.`,
          );
          if (confirmed) onDetach(lane.id);
        }}
        disabled={busy}
        className="ade-shell-control inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 font-mono text-[10px] font-bold uppercase tracking-[1px]"
        data-variant="ghost"
        style={{
          color: "var(--color-error, #ef4444)",
          borderColor: "color-mix(in srgb, var(--color-error, #ef4444) 35%, transparent)",
        }}
      >
        {busy ? <SpinnerGap size={11} className="animate-spin" /> : <XCircle size={11} />}
        Detach (→ local lane)
      </button>
    </div>
  );
}
