import type { UsagePacingStatus } from "../../../../shared/types";
import { cn } from "../../ui/cn";

const PACING_STYLES: Record<UsagePacingStatus, { bg: string; border: string; text: string; label: string }> = {
  "on-track": { bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.30)", text: "#22C55E", label: "ON TRACK" },
  "ahead":    { bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.30)", text: "#F59E0B", label: "AHEAD" },
  "behind":   { bg: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.25)", text: "#71717A", label: "BEHIND" },
};

export function UsagePacingBadge({
  status,
  projectedPercent,
  className,
}: {
  status: UsagePacingStatus;
  projectedPercent?: number;
  className?: string;
}) {
  const style = PACING_STYLES[status] ?? PACING_STYLES["on-track"];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[1px]",
        className,
      )}
      style={{ background: style.bg, border: `1px solid ${style.border}`, color: style.text }}
    >
      <span
        className="h-1.5 w-1.5 animate-pulse"
        style={{ background: style.text }}
      />
      {style.label}
      {projectedPercent != null && (
        <span className="text-[#8B8B9A] font-normal ml-1">
          ~{projectedPercent.toFixed(0)}% EOW
        </span>
      )}
    </span>
  );
}
