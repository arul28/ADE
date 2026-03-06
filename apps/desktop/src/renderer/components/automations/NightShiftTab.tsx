import { useEffect, useState } from "react";
import { Moon, Clock, CalendarBlank } from "@phosphor-icons/react";
import { motion } from "motion/react";
import type { BudgetCapConfig } from "../../../shared/types";
import { EmptyState } from "../ui/EmptyState";
import { Chip } from "../ui/Chip";

export function NightShiftTab() {
  const [budgetConfig, setBudgetConfig] = useState<BudgetCapConfig | null>(null);

  useEffect(() => {
    if (!window.ade?.usage) return;
    window.ade.usage.getBudgetConfig().then(setBudgetConfig).catch(() => {});
  }, []);

  const reservePercent = budgetConfig?.nightShiftReservePercent ?? 0;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="h-full overflow-y-auto p-6"
      style={{ background: "#0F0D14" }}
    >
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <div className="flex items-center gap-2">
            <Moon size={18} weight="regular" className="text-[#A78BFA]" />
            <span
              className="text-[16px] font-bold text-[#FAFAFA] tracking-[-0.4px]"
              style={{ fontFamily: "'Space Grotesk', sans-serif" }}
            >
              Night Shift
            </span>
          </div>
          <div className="mt-1 font-mono text-[10px] text-[#71717A]">
            Schedule automations to run overnight when usage rates are lowest.
          </div>
        </div>

        {/* Reserve budget display */}
        {reservePercent > 0 && (
          <div
            className="p-4 space-y-2"
            style={{ background: "#181423", border: "1px solid #2D2840", boxShadow: "0 1px 6px -1px rgba(0,0,0,0.6), 0 0 0 1px rgba(45,40,64,0.3)" }}
          >
            <div className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">
              Reserved Budget
            </div>
            <div className="flex items-center gap-3">
              <div className="font-mono text-[20px] font-bold text-[#A78BFA]">{reservePercent}%</div>
              <div className="font-mono text-[10px] text-[#71717A]">
                of weekly quota reserved for Night Shift runs
              </div>
            </div>
          </div>
        )}

        {/* Schedule config placeholder */}
        <div
          className="p-4 space-y-3"
          style={{ background: "#181423", border: "1px solid #2D2840", boxShadow: "0 1px 6px -1px rgba(0,0,0,0.6), 0 0 0 1px rgba(45,40,64,0.3)" }}
        >
          <div className="flex items-center gap-2">
            <Clock size={14} weight="regular" className="text-[#A78BFA]" />
            <span className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">
              Schedule Configuration
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3" style={{ background: "#14111D", border: "1px solid #1E1B26" }}>
              <div className="font-mono text-[9px] text-[#71717A]">Active Hours</div>
              <div className="mt-1 font-mono text-[11px] text-[#8B8B9A]">10:00 PM - 6:00 AM</div>
            </div>
            <div className="p-3" style={{ background: "#14111D", border: "1px solid #1E1B26" }}>
              <div className="font-mono text-[9px] text-[#71717A]">Timezone</div>
              <div className="mt-1 font-mono text-[11px] text-[#8B8B9A]">Local</div>
            </div>
          </div>
          <Chip className="text-[9px] text-[#F59E0B]">Coming in W5b</Chip>
        </div>

        {/* Queue placeholder */}
        <div
          className="p-4"
          style={{ background: "#181423", border: "1px solid #2D2840", boxShadow: "0 1px 6px -1px rgba(0,0,0,0.6), 0 0 0 1px rgba(45,40,64,0.3)" }}
        >
          <div className="flex items-center gap-2 mb-3">
            <CalendarBlank size={14} weight="regular" className="text-[#A78BFA]" />
            <span className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">
              Queue & Morning Briefing
            </span>
          </div>
          <EmptyState
            title="Night Shift Queue"
            description="Queue management and morning briefing will be available in W5b. Configure your Night Shift schedule above to start batching low-priority automations for overnight execution."
            icon={Moon}
          />
        </div>
      </div>
    </motion.div>
  );
}
