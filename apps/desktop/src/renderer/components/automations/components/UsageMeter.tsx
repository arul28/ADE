import { cn } from "../../ui/cn";

export function UsageMeter({
  label,
  percent,
  sublabel,
  modelBreakdown,
  className,
}: {
  label: string;
  percent: number;
  sublabel?: string;
  modelBreakdown?: Record<string, number>;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const breakdownEntries = modelBreakdown ? Object.entries(modelBreakdown) : [];
  const hasBreakdown = breakdownEntries.length > 0;

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">
          {label}
        </span>
        <span className="font-mono text-[10px] font-bold text-[#FAFAFA]">
          {clamped.toFixed(1)}%
        </span>
      </div>

      <div
        className="relative h-2 w-full overflow-hidden"
        style={{ background: "#1A1720", border: "1px solid #1E1B26" }}
      >
        {hasBreakdown ? (
          <StackedBar entries={breakdownEntries} total={clamped} />
        ) : (
          <div
            className="absolute inset-y-0 left-0 transition-all duration-500 ease-out"
            style={{
              width: `${clamped}%`,
              background: clamped > 90 ? "#EF4444" : clamped > 70 ? "#F59E0B" : "#A78BFA",
            }}
          />
        )}
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
                style={{ background: MODEL_COLORS[i % MODEL_COLORS.length] }}
              />
              <span className="font-mono text-[9px] text-[#8B8B9A]">
                {model} {pct.toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const MODEL_COLORS = ["#A78BFA", "#7C3AED", "#C4B5FD", "#6D28D9"];

function StackedBar({
  entries,
  total,
}: {
  entries: [string, number][];
  total: number;
}) {
  let offset = 0;
  return (
    <>
      {entries.map(([model, pct], i) => {
        const width = total > 0 ? (pct / 100) * 100 : 0;
        const left = offset;
        offset += width;
        return (
          <div
            key={model}
            className="absolute inset-y-0 transition-all duration-500 ease-out"
            style={{
              left: `${left}%`,
              width: `${width}%`,
              background: MODEL_COLORS[i % MODEL_COLORS.length],
            }}
          />
        );
      })}
    </>
  );
}
