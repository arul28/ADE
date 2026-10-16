import { cn } from "../ui/cn";
import type { MachineChipModel } from "../../state/laneMachineRouting";

/**
 * "All" plus one chip per machine, each with a status dot. Rendered only when
 * the project has lanes on more than one machine.
 */
export function LaneMachineFilterChips({
  machines,
  value,
  onChange,
}: {
  machines: readonly (MachineChipModel & { laneCount: number })[];
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
