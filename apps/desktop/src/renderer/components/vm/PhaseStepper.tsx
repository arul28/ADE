import { CaretDown, Check, CheckCircle, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import type { CSSProperties, ReactNode } from "react";
import type { MacosVmPhaseNumber } from "../../../shared/types";
import { cn } from "../ui/cn";

export type PhaseStatus = "complete" | "active" | "pending" | "blocked";

export type PhaseDescriptor = {
  number: MacosVmPhaseNumber;
  label: string;
  status: PhaseStatus;
  detail?: ReactNode;
};

function PhaseBadge({ status, number }: { status: PhaseStatus; number: MacosVmPhaseNumber }) {
  const baseStyle: CSSProperties = {
    fontFamily: "system-ui, -apple-system, 'Helvetica Neue', sans-serif",
    fontVariantNumeric: "tabular-nums",
  };
  if (status === "complete") {
    return (
      <span
        aria-hidden
        className="inline-flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[6px]"
        style={{
          background: "color-mix(in srgb, var(--color-success, #34d399) 18%, transparent)",
          border: "1px solid color-mix(in srgb, var(--color-success, #34d399) 55%, transparent)",
          ...baseStyle,
        }}
      >
        <Check size={11} weight="bold" style={{ color: "var(--color-success, #34d399)" }} />
      </span>
    );
  }
  if (status === "active") {
    return (
      <span
        aria-hidden
        className="relative inline-flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[6px]"
        style={{
          background: "color-mix(in srgb, #A78BFA 18%, transparent)",
          border: "1px solid #A78BFA",
          ...baseStyle,
        }}
      >
        <SpinnerGap size={11} weight="bold" className="animate-spin" style={{ color: "#FAFAFA" }} />
      </span>
    );
  }
  if (status === "blocked") {
    return (
      <span
        aria-hidden
        className="inline-flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[6px]"
        style={{
          background: "color-mix(in srgb, var(--color-error, #ef4444) 18%, transparent)",
          border: "1px solid color-mix(in srgb, var(--color-error, #ef4444) 55%, transparent)",
          ...baseStyle,
        }}
      >
        <WarningCircle size={12} weight="fill" style={{ color: "var(--color-error, #ef4444)" }} />
      </span>
    );
  }
  // pending — plain numeric badge
  return (
    <span
      aria-hidden
      className="inline-flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[6px] text-[10px] font-semibold"
      style={{
        background: "transparent",
        border: "1px solid #27272A",
        color: "#52525B",
        ...baseStyle,
      }}
    >
      {number}
    </span>
  );
}

function rowLabelColor(status: PhaseStatus): string {
  if (status === "complete") return "#A1A1AA";
  if (status === "active") return "#FAFAFA";
  if (status === "blocked") return "#FAFAFA";
  return "#52525B";
}

export function PhaseStepper({
  phases,
  currentPhaseIndex,
  compactMode,
  onToggleCompact,
}: {
  phases: PhaseDescriptor[];
  /** Zero-based index of the active phase within `phases` (not the phase number). */
  currentPhaseIndex: number;
  compactMode: boolean;
  onToggleCompact?: () => void;
}) {
  // Defensive: clamp into bounds so an out-of-range index (e.g. from a future
  // phase enum or a corrupt VM record) never silently skips highlighting.
  const safeIndex = phases.length === 0
    ? -1
    : Math.min(Math.max(currentPhaseIndex, 0), phases.length - 1);
  if (compactMode) {
    return (
      <button
        type="button"
        onClick={onToggleCompact}
        className="group flex w-full items-center justify-between rounded-md px-3 py-2.5 text-left transition-colors duration-150"
        style={{
          background: "color-mix(in srgb, var(--color-success, #34d399) 6%, transparent)",
          border: "1px solid color-mix(in srgb, var(--color-success, #34d399) 22%, transparent)",
        }}
      >
        <span className="flex items-center gap-2.5">
          <CheckCircle size={15} weight="fill" style={{ color: "var(--color-success, #34d399)" }} />
          <span className="text-[12px] font-semibold" style={{ color: "#FAFAFA" }}>
            Setup complete
          </span>
          <span className="text-[11px]" style={{ color: "#A1A1AA" }}>
            10 / 10
          </span>
        </span>
        <span
          className="flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-[1px] opacity-60 group-hover:opacity-100"
          style={{ color: "#71717A" }}
        >
          Expand
          <CaretDown size={11} />
        </span>
      </button>
    );
  }

  return (
    <ol className="flex flex-col gap-1.5" aria-label="Mac VM setup phases">
      {phases.map((phase, index) => {
        const isActive = index === safeIndex && phase.status === "active";
        const isExpanded = isActive || phase.status === "blocked";
        return (
          <li
            key={phase.number}
            className={cn(
              "rounded-md px-3 py-2 transition-colors duration-150",
            )}
            style={{
              background: isExpanded ? "#13101A" : "transparent",
              border: isExpanded ? "1px solid #1E1B26" : "1px solid transparent",
            }}
            aria-current={isActive ? "step" : undefined}
            data-phase={phase.number}
            data-status={phase.status}
          >
            <div className="flex items-center gap-2.5">
              <PhaseBadge status={phase.status} number={phase.number} />
              <span
                className="flex-1 truncate text-[12px] font-semibold"
                style={{ color: rowLabelColor(phase.status) }}
              >
                {phase.label}
              </span>
            </div>
            {isExpanded && phase.detail ? (
              <div className="mt-2 pl-[30px] text-[11px] leading-5" style={{ color: "#A1A1AA" }}>
                {phase.detail}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
