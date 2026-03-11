import { useState, useCallback } from "react";
import {
  Lightning,
  ListBullets,
  BookOpen,
  ClockCounterClockwise,
  ChartBar,
  Moon,
} from "@phosphor-icons/react";
import type { AutomationRuleDraft } from "../../../shared/types";
import { cn } from "../ui/cn";
import { RulesTab } from "./RulesTab";
import { TemplatesTab } from "./TemplatesTab";
import { HistoryTab } from "./HistoryTab";
import { UsageTab } from "./UsageTab";
import { NightShiftTab } from "./NightShiftTab";

/* ── Tab types ── */

type TabId = "rules" | "templates" | "history" | "usage" | "nightshift";

const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: "rules", label: "Rules", icon: ListBullets },
  { id: "templates", label: "Templates", icon: BookOpen },
  { id: "history", label: "History", icon: ClockCounterClockwise },
  { id: "usage", label: "Usage", icon: ChartBar },
  { id: "nightshift", label: "Night Shift", icon: Moon },
];

/* ── Main Page ── */

export function AutomationsPage() {
  const [activeTab, setActiveTab] = useState<TabId>("rules");
  const [pendingDraft, setPendingDraft] = useState<AutomationRuleDraft | null>(null);

  const handleUseTemplate = useCallback((draft: Omit<AutomationRuleDraft, "id">) => {
    setPendingDraft(draft as AutomationRuleDraft);
    setActiveTab("rules");
  }, []);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg text-fg" data-testid="automations-page">
      {/* Tab bar */}
      <div
        className="shrink-0 flex items-center gap-0"
        style={{ background: "var(--color-surface)", borderBottom: "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)", minHeight: 36 }}
      >
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className={cn(
              "flex items-center gap-1.5 px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-[1px] transition-all duration-100 border-b-2",
              activeTab === id
                ? "border-b-accent text-accent"
                : "border-b-transparent text-muted-fg hover:text-fg",
            )}
          >
            <Icon size={12} weight={activeTab === id ? "bold" : "regular"} />
            {label}
          </button>
        ))}

        {/* Right side: page context */}
        <div className="ml-auto flex items-center gap-2 pr-4">
          <Lightning size={10} weight="fill" className="text-accent" />
          <span className="font-mono text-[9px] text-muted-fg/70">AUTOMATIONS</span>
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === "rules" && <RulesTab pendingDraft={pendingDraft} onDraftConsumed={() => setPendingDraft(null)} />}
        {activeTab === "templates" && <TemplatesTab onUseTemplate={handleUseTemplate} />}
        {activeTab === "history" && <HistoryTab />}
        {activeTab === "usage" && <UsageTab />}
        {activeTab === "nightshift" && <NightShiftTab />}
      </div>
    </div>
  );
}
