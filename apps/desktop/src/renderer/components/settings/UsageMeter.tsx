import { cn } from "../ui/cn";

export function UsageMeter({
  label,
  percent,
  sublabel,
  modelBreakdown,
  mode = "used",
  toneColor = "#A78BFA",
  className,
}: {
  label: string;
  percent: number;
  sublabel?: string;
  modelBreakdown?: Record<string, number>;
  mode?: "used" | "remaining";
  toneColor?: string;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const breakdownEntries = modelBreakdown ? Object.entries(modelBreakdown) : [];
  const hasBreakdown = breakdownEntries.length > 0;
  const fillColor =
    mode === "remaining"
      ? clamped <= 10
        ? "#EF4444"
        : clamped <= 30
          ? "#F59E0B"
          : "#22C55E"
      : clamped > 90
        ? "#EF4444"
        : clamped > 70
          ? "#F59E0B"
          : toneColor;

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">
          {label}
        </span>
        <span className="font-mono text-[10px] font-bold text-[#FAFAFA]">
          {clamped.toFixed(1)}% {mode}
        </span>
      </div>

      <div
        className="relative h-2 w-full overflow-hidden rounded-sm"
        style={{ background: "#1A1720", border: "1px solid #1E1B26" }}
      >
        <div
          className="absolute inset-y-0 left-0 transition-all duration-500 ease-out"
          style={{
            width: `${clamped}%`,
            background: fillColor,
          }}
        />
        {hasBreakdown
          ? breakdownEntries.map(([model, pct], i) => {
              const subClamped = Math.max(0, Math.min(100, pct));
              if (subClamped <= 0) return null;
              const tickLeft = Math.min(99, subClamped);
              return (
                <span
                  key={`tick-${model}`}
                  className="absolute top-0 bottom-0 w-px"
                  style={{
                    left: `${tickLeft}%`,
                    background: i === 0 ? toneColor : MODEL_COLORS[i % MODEL_COLORS.length],
                    opacity: 0.85,
                  }}
                  aria-hidden
                />
              );
            })
          : null}
      </div>

      {sublabel && (
        <div className="font-mono text-[9px] text-[#71717A]">{sublabel}</div>
      )}

      {hasBreakdown && (
        <div className="flex flex-wrap gap-3 pt-0.5">
          {breakdownEntries.map(([model, pct], i) => (
            <div key={model} className="flex items-center gap-1.5">
              <div
                className="h-1.5 w-1.5"
                style={{ background: i === 0 ? toneColor : MODEL_COLORS[i % MODEL_COLORS.length] }}
              />
              <span className="font-mono text-[9px] text-[#8B8B9A]">
                {model} {pct.toFixed(1)}% {mode}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const MODEL_COLORS = ["#A78BFA", "#7C3AED", "#C4B5FD", "#6D28D9"];
