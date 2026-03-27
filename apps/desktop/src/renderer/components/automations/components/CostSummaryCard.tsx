import { cn } from "../../ui/cn";
import { formatCost, formatTokens } from "../../../lib/format";
import { CARD_SHADOW_STYLE } from "../shared";

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
