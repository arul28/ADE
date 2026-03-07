import { useState } from "react";
import type { BudgetCapConfig, BudgetCapScope, BudgetCapType, BudgetCapProvider, BudgetCapAction } from "../../../../shared/types";
import { Button } from "../../ui/Button";
import { Chip } from "../../ui/Chip";
import { cn } from "../../ui/cn";
import { CARD_SHADOW_STYLE } from "../shared";

export function BudgetCapEditor({
  config,
  className,
}: {
  config: BudgetCapConfig | null;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!config) {
    return (
      <div
        className={cn("p-3", className)}
        style={{ background: "#181423", border: "1px solid #2D2840" }}
      >
        <div className="font-mono text-[10px] text-[#71717A]">No budget configuration loaded.</div>
      </div>
    );
  }

  const caps = config.budgetCaps ?? [];

  return (
    <div
      className={cn("p-3 space-y-2", className)}
      style={CARD_SHADOW_STYLE}
    >
      <div className="flex items-center justify-between">
        <span
          className="text-[11px] font-bold tracking-[-0.2px] text-[#FAFAFA]"
          style={{ fontFamily: "'Space Grotesk', sans-serif" }}
        >
          Budget Caps
        </span>
        <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Collapse" : `${caps.length} cap${caps.length !== 1 ? "s" : ""}`}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {config.preset && (
          <Chip className="text-[9px] text-[#A78BFA]">Preset: {config.preset}</Chip>
        )}
        {config.nightShiftReservePercent != null && (
          <Chip className="text-[9px] text-[#A78BFA]">
            Night Shift Reserve: {config.nightShiftReservePercent}%
          </Chip>
        )}
        {config.alertAtWeeklyPercent != null && (
          <Chip className="text-[9px] text-[#F59E0B]">
            Alert at {config.alertAtWeeklyPercent}% weekly
          </Chip>
        )}
      </div>

      {expanded && caps.length > 0 && (
        <div className="space-y-1.5 pt-1" style={{ borderTop: "1px solid #2D284060" }}>
          {caps.map((cap, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-2 px-2 py-1.5 font-mono text-[9px]"
              style={{ background: "#14111D", border: "1px solid #1E1B26" }}
            >
              <div className="flex items-center gap-2 text-[#A1A1AA]">
                <span className="font-bold text-[#FAFAFA]">{cap.scope}</span>
                {cap.scopeId && <span className="text-[#71717A]">{cap.scopeId}</span>}
                <span>{cap.provider}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[#FAFAFA]">
                  {cap.limit}{cap.capType.includes("percent") ? "%" : " USD"}
                </span>
                <Chip className={cn(
                  "text-[8px] py-0",
                  cap.action === "block" ? "text-red-300" : cap.action === "warn" ? "text-amber-300" : "text-[#71717A]"
                )}>
                  {cap.action}
                </Chip>
              </div>
            </div>
          ))}
        </div>
      )}

      {expanded && caps.length === 0 && (
        <div className="font-mono text-[10px] text-[#71717A] pt-1">No caps configured.</div>
      )}
    </div>
  );
}
