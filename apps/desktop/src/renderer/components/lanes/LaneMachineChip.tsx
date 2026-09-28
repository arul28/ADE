import { Desktop, DesktopTower } from "@phosphor-icons/react";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";

export type LaneMachineChipModel = {
  machineId: string;
  /** Absolute machine name; never "remote". */
  machineName: string;
  online: boolean;
  /** The Mac this app runs on (desktop glyph instead of the tower). */
  isThisMachine: boolean;
};

/**
 * Compact machine chip for a lane row: which machine owns the lane.
 *
 * Unlike the Work sidebar's amber `LaneMachineMarker`, which flags only other
 * machines' lanes, this is a neutral pill: it is on every row (including this
 * Mac's) whenever a project has lanes on more than one machine, because a flat
 * list across machines needs the owner on each row. Amber would read as a
 * warning on every row. An offline machine's chip is
 * greyed and its tooltip says so.
 */
export function LaneMachineChip({ machine, className }: { machine: LaneMachineChipModel; className?: string }) {
  const Icon = machine.isThisMachine ? Desktop : DesktopTower;
  return (
    <SmartTooltip
      forceEnabled
      content={{
        label: machine.machineName,
        description: machine.online
          ? "The machine this lane lives on. Its actions run there."
          : `${machine.machineName} is offline. Its lanes are shown as last reported and cannot be acted on.`,
      }}
    >
      <span
        role="img"
        className={cn(
          "inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium leading-none",
          machine.online
            ? "border-border/60 bg-fg/[0.04] text-muted-fg/80"
            : "border-border/30 bg-transparent text-muted-fg/45",
          className,
        )}
        aria-label={machine.online ? machine.machineName : `${machine.machineName}, offline`}
        data-machine-id={machine.machineId}
        data-machine-online={machine.online ? "true" : "false"}
      >
        <Icon
          size={10}
          weight="duotone"
          className={cn("shrink-0", machine.online ? "text-muted-fg/70" : "text-muted-fg/40")}
        />
        <span className="max-w-20 truncate">{machine.machineName}</span>
      </span>
    </SmartTooltip>
  );
}

/**
 * "All" plus one chip per machine, each with a status dot. Rendered only when
 * the project has lanes on more than one machine.
 */
export function LaneMachineFilterChips({
  machines,
  value,
  onChange,
}: {
  machines: readonly (LaneMachineChipModel & { laneCount: number })[];
  /** `"all"` or a machine id. */
  value: string;
  onChange: (next: string) => void;
}) {
  if (machines.length <= 1) return null;
  const chip = (key: string, label: string, active: boolean, dot: "online" | "offline" | null, title: string) => (
    <button
      key={key}
      type="button"
      aria-pressed={active}
      title={title}
      data-testid={`lane-machine-filter-${key}`}
      onClick={() => onChange(key)}
      className={cn(
        "inline-flex min-w-0 max-w-[140px] shrink-0 items-center gap-1 rounded-full px-2 py-[3px] text-[11px] leading-none transition-colors",
        active
          ? "bg-fg/[0.10] text-fg"
          : "text-muted-fg/70 hover:bg-fg/[0.05] hover:text-fg/90",
      )}
    >
      {dot ? (
        <span
          aria-hidden
          className={cn(
            "inline-block h-[6px] w-[6px] shrink-0 rounded-full",
            dot === "online" ? "bg-emerald-400/85" : "bg-muted-fg/40",
          )}
        />
      ) : null}
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
  return (
    <div
      // Wraps rather than scrolls: an overflowing row painted a stray
      // horizontal scrollbar under the chips. The hairline keeps a scrolled
      // list from butting up against them.
      className="mx-1.5 mb-1 flex shrink-0 flex-wrap items-center gap-1 border-b border-border/20 px-0.5 pb-2"
      role="group"
      aria-label="Filter lanes by machine"
      data-testid="lane-machine-filter"
    >
      {chip("all", "All", value === "all", null, "Lanes on every machine")}
      {machines.map((machine) =>
        chip(
          machine.machineId,
          machine.machineName,
          value === machine.machineId,
          machine.online ? "online" : "offline",
          machine.online
            ? `${machine.machineName} · ${machine.laneCount} lane${machine.laneCount === 1 ? "" : "s"}`
            : `${machine.machineName} is offline`,
        ))}
    </div>
  );
}
