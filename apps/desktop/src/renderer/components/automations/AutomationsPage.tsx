import { useEffect, useState, type ElementType } from "react";
import {
  BookOpen,
  ClockCounterClockwise,
  Lightning,
  ListBullets,
} from "@phosphor-icons/react";
import type { AutomationRuleDraft } from "../../../shared/types";
import { cn } from "../ui/cn";
import { RulesTab } from "./RulesTab";
import { TemplatesTab } from "./TemplatesTab";
import { HistoryTab } from "./HistoryTab";

type TabId = "rules" | "templates" | "history";

const TABS: Array<{ id: TabId; label: string; icon: ElementType }> = [
  { id: "rules", label: "Rules", icon: ListBullets },
  { id: "templates", label: "Templates", icon: BookOpen },
  { id: "history", label: "History", icon: ClockCounterClockwise },
];

export function AutomationsPage() {
  const [activeTab, setActiveTab] = useState<TabId>("rules");
  const [pendingDraft, setPendingDraft] = useState<AutomationRuleDraft | null>(null);
  const [historySelection, setHistorySelection] = useState<{ automationId?: string | null; runId?: string | null }>({});

  useEffect(() => {
    console.info(`renderer.tab_change ${JSON.stringify({ page: "automations", tab: activeTab })}`);
  }, [activeTab]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg text-fg" data-testid="automations-page">
      <div className="shrink-0 flex items-center gap-0 border-b border-white/[0.06] bg-white/[0.02] backdrop-blur-xl" style={{ minHeight: 40 }}>
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

        <div className="ml-auto flex items-center gap-2 pr-4">
          <Lightning size={10} weight="fill" className="text-accent" />
          <span className="font-mono text-[9px] text-muted-fg/70">AUTOMATIONS</span>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === "rules" ? (
          <RulesTab
            pendingDraft={pendingDraft}
            onDraftConsumed={() => setPendingDraft(null)}
            onOpenHistory={(selection) => {
              setHistorySelection(selection);
              setActiveTab("history");
            }}
          />
        ) : null}

        {activeTab === "templates" ? (
          <TemplatesTab
            onUseTemplate={(draft) => {
              setPendingDraft(draft as AutomationRuleDraft);
              setActiveTab("rules");
            }}
          />
        ) : null}

        {activeTab === "history" ? (
          <HistoryTab
            focusAutomationId={historySelection.automationId ?? null}
            focusRunId={historySelection.runId ?? null}
          />
        ) : null}
      </div>
    </div>
  );
}
