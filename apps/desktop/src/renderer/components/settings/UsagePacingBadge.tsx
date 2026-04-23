import type { UsagePacing, UsagePacingStatus } from "../../../shared/types";
import { cn } from "../ui/cn";

const PACING_STYLES: Record<string, { bg: string; border: string; text: string; label: string }> = {
  "far-behind":     { bg: "rgba(113,113,122,0.08)", border: "rgba(113,113,122,0.25)", text: "#71717A", label: "FAR BEHIND" },
  "behind":         { bg: "rgba(113,113,122,0.08)", border: "rgba(113,113,122,0.25)", text: "#A1A1AA", label: "BEHIND" },
  "slightly-behind":{ bg: "rgba(34,197,94,0.06)",   border: "rgba(34,197,94,0.20)",   text: "#71717A", label: "SLIGHTLY BEHIND" },
  "on-track":       { bg: "rgba(34,197,94,0.10)",   border: "rgba(34,197,94,0.30)",   text: "#22C55E", label: "ON TRACK" },
  "slightly-ahead": { bg: "rgba(245,158,11,0.08)",  border: "rgba(245,158,11,0.25)",  text: "#F59E0B", label: "SLIGHTLY AHEAD" },
  "ahead":          { bg: "rgba(245,158,11,0.10)",   border: "rgba(245,158,11,0.30)",  text: "#F59E0B", label: "AHEAD" },
  "far-ahead":      { bg: "rgba(239,68,68,0.10)",   border: "rgba(239,68,68,0.30)",   text: "#EF4444", label: "FAR AHEAD" },
};

function formatEta(hours: number | null): string {
  if (hours == null) return "";
  if (hours <= 0) return "exhausted";
  if (hours < 1) return `${Math.round(hours * 60)}m left`;
  if (hours < 24) return `${hours.toFixed(1)}h left`;
  const days = Math.floor(hours / 24);
  const h = Math.round(hours % 24);
  return h > 0 ? `${days}d ${h}h left` : `${days}d left`;
}

function formatResetIn(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(0)}h`;
  const days = Math.floor(hours / 24);
  const h = Math.round(hours % 24);
  return h > 0 ? `${days}d ${h}h` : `${days}d`;
}

export function UsagePacingBadge({
  status,
  projectedPercent,
  pacing,
  className,
}: {
  status: UsagePacingStatus;
  projectedPercent?: number;
  pacing?: UsagePacing | null;
  className?: string;
}) {
  const style = PACING_STYLES[status] ?? PACING_STYLES["on-track"];

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {/* Status badge */}
      <div className="flex items-center gap-2">
        <span
          className="inline-flex items-center gap-1.5 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[1px]"
          style={{ background: style.bg, border: `1px solid ${style.border}`, color: style.text }}
        >
          <span
            className="h-1.5 w-1.5 animate-pulse"
            style={{ background: style.text }}
          />
          {style.label}
        </span>
      </div>

      {/* Detailed pacing info */}
      {pacing && pacing.weekElapsedPercent > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[9px] text-[#8B8B9A]">
          {/* Expected vs actual */}
          <span>
            {pacing.deltaPercent > 0 ? "+" : ""}{pacing.deltaPercent.toFixed(1)}% vs expected
          </span>

          {/* ETA to exhaustion */}
          {pacing.etaHours != null && (
            <span className={cn(pacing.willLastToReset ? "text-[#22C55E]" : "text-[#F59E0B]")}>
              {pacing.etaHours <= 0
                ? "quota exhausted"
                : pacing.willLastToReset
                  ? `runs out in ${formatEta(pacing.etaHours)} (resets in ${formatResetIn(pacing.resetsInHours)})`
                  : `runs out in ${formatEta(pacing.etaHours)} — resets in ${formatResetIn(pacing.resetsInHours)}`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
