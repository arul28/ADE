import { cn } from "../ui/cn";
import { formatCost, formatTokens } from "../../lib/format";

const CARD_SHADOW_STYLE: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(20, 31, 45, 0.96) 0%, rgba(10, 18, 28, 0.94) 100%)",
  border: "1px solid rgba(87, 108, 128, 0.22)",
  boxShadow: "0 18px 40px -24px rgba(0, 0, 0, 0.78), inset 0 1px 0 rgba(255,255,255,0.04)",
};

export function CostSummaryCard({
  provider,
  todayCostUsd,
  last30dCostUsd,
  tokenBreakdown,
  className,
}: {
  provider: string;
  todayCostUsd: number;
  last30dCostUsd: number;
  tokenBreakdown?: Record<string, { input: number; output: number; cached: number }>;
  className?: string;
}) {
  return (
    <div
      className={cn("p-3 space-y-2", className)}
      style={CARD_SHADOW_STYLE}
    >
      <div className="flex items-center justify-between">
        <span
          className="text-[11px] font-bold tracking-[-0.2px] text-[#FAFAFA]"
          style={{ fontFamily: "var(--font-sans)" }}
        >
          {provider}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Today</div>
          <div className="mt-0.5 font-mono text-[13px] font-bold text-[#FAFAFA]">{formatCost(todayCostUsd)}</div>
        </div>
        <div>
          <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Last 30d</div>
          <div className="mt-0.5 font-mono text-[13px] font-bold text-[#FAFAFA]">{formatCost(last30dCostUsd)}</div>
        </div>
      </div>

      {tokenBreakdown && Object.keys(tokenBreakdown).length > 0 && (
        <div className="space-y-1 pt-1" style={{ borderTop: "1px solid #2D284060" }}>
          <div className="font-mono text-[9px] font-bold uppercase tracking-[1px] text-[#71717A]">Tokens</div>
          {Object.entries(tokenBreakdown).map(([model, tokens]) => (
            <div key={model} className="flex items-center justify-between font-mono text-[9px] text-[#8B8B9A]">
              <span>{model}</span>
              <span>
                {formatTokens(tokens.input)} in / {formatTokens(tokens.output)} out
                {tokens.cached > 0 && ` / ${formatTokens(tokens.cached)} cache`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
