import { useState, useCallback, useEffect, type ElementType } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Lightning,
  ListBullets,
  BookOpen,
  ClockCounterClockwise,
  Moon,
  CheckCircle,
} from "@phosphor-icons/react";
import type { AutomationRuleDraft } from "../../../shared/types";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { RulesTab } from "./RulesTab";
import { TemplatesTab } from "./TemplatesTab";
import { HistoryTab } from "./HistoryTab";
import { NightShiftTab } from "./NightShiftTab";

/* ── Tab types ── */

type TabId = "rules" | "templates" | "history" | "nightshift";

const TABS: { id: TabId; label: string; icon: ElementType }[] = [
  { id: "rules", label: "Rules", icon: ListBullets },
  { id: "templates", label: "Templates", icon: BookOpen },
  { id: "history", label: "History", icon: ClockCounterClockwise },
  { id: "nightshift", label: "Night Shift", icon: Moon },
];

/* ── Main Page ── */

export function AutomationsPage() {
  const [activeTab, setActiveTab] = useState<TabId>("rules");
  const [pendingDraft, setPendingDraft] = useState<AutomationRuleDraft | null>(null);
  const [morningBriefing, setMorningBriefing] = useState<Awaited<ReturnType<typeof window.ade.automations.getMorningBriefing>>>(null);
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [briefingBusy, setBriefingBusy] = useState(false);

  const handleUseTemplate = useCallback((draft: Omit<AutomationRuleDraft, "id">) => {
    setPendingDraft(draft as AutomationRuleDraft);
    setActiveTab("rules");
  }, []);

  const loadMorningBriefing = useCallback(async () => {
    try {
      const briefing = await window.ade.automations.getMorningBriefing();
      setMorningBriefing(briefing);
      setBriefingOpen(Boolean(briefing));
    } catch {
      setMorningBriefing(null);
    }
  }, []);

  useEffect(() => {
    void loadMorningBriefing();
    const unsubscribe = window.ade.automations.onEvent((event) => {
      if (event.type === "night-shift-updated" || event.type === "review-updated") {
        void loadMorningBriefing();
      }
    });
    return () => unsubscribe();
  }, [loadMorningBriefing]);

  useEffect(() => {
    console.info(`renderer.tab_change ${JSON.stringify({
      page: "automations",
      tab: activeTab,
    })}`);
  }, [activeTab]);

  const acknowledgeBriefing = useCallback(async () => {
    if (!morningBriefing) return;
    setBriefingBusy(true);
    try {
      await window.ade.automations.acknowledgeMorningBriefing({ id: morningBriefing.id });
      setMorningBriefing(null);
      setBriefingOpen(false);
    } finally {
      setBriefingBusy(false);
    }
  }, [morningBriefing]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg text-fg" data-testid="automations-page">
      {/* Tab bar */}
      <div
        className="shrink-0 flex items-center gap-0 border-b border-white/[0.06] bg-white/[0.02] backdrop-blur-xl"
        style={{ minHeight: 36 }}
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
        {activeTab === "nightshift" && <NightShiftTab />}
      </div>

      <Dialog.Root open={briefingOpen} onOpenChange={setBriefingOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content
            className="fixed left-1/2 top-[10%] z-50 w-[min(720px,calc(100vw-24px))] -translate-x-1/2 rounded-xl bg-white/[0.03] backdrop-blur-xl border border-white/[0.06] p-4 focus:outline-none"
            style={{ boxShadow: "0 8px 32px -8px rgba(0,0,0,0.8)" }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Dialog.Title className="text-sm font-sans font-semibold text-[#FAFAFA]">
                  Morning Briefing
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-xs text-[#8B8B9A]">
                  Review overnight automation outcomes before you clear the queue.
                </Dialog.Description>
              </div>
              {morningBriefing ? <Chip className="text-[9px]">{morningBriefing.totalRuns} runs</Chip> : null}
            </div>

            {morningBriefing ? (
              <div className="mt-4 space-y-3">
                <div className="grid grid-cols-4 gap-2">
                  <div className="rounded-xl p-3 bg-white/[0.03] border border-white/[0.06]">
                    <div className="font-mono text-[9px] text-[#71717A]">runs</div>
                    <div className="mt-1 text-lg text-[#FAFAFA]">{morningBriefing.totalRuns}</div>
                  </div>
                  <div className="rounded-xl p-3 bg-white/[0.03] border border-white/[0.06]">
                    <div className="font-mono text-[9px] text-[#71717A]">clean</div>
                    <div className="mt-1 text-lg text-[#22C55E]">{morningBriefing.succeededRuns}</div>
                  </div>
                  <div className="rounded-xl p-3 bg-white/[0.03] border border-white/[0.06]">
                    <div className="font-mono text-[9px] text-[#71717A]">follow-up</div>
                    <div className="mt-1 text-lg text-[#F59E0B]">{morningBriefing.failedRuns}</div>
                  </div>
                  <div className="rounded-xl p-3 bg-white/[0.03] border border-white/[0.06]">
                    <div className="font-mono text-[9px] text-[#71717A]">spend</div>
                    <div className="mt-1 text-lg text-[#FAFAFA]">${morningBriefing.totalSpendUsd.toFixed(2)}</div>
                  </div>
                </div>

                <div className="max-h-[40vh] space-y-2 overflow-y-auto">
                  {morningBriefing.cards.map((card) => (
                    <div key={card.queueItemId} className="rounded-xl p-3 bg-white/[0.03] border border-white/[0.06]">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs font-semibold text-[#FAFAFA]">{card.title}</div>
                        {card.confidence ? <Chip className="text-[9px]">{card.confidence.label}</Chip> : null}
                      </div>
                      <div className="mt-1 text-xs text-[#A1A1AA]">{card.summary}</div>
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => { setActiveTab("nightshift"); setBriefingOpen(false); }}>
                    <Moon size={12} weight="regular" />
                    Open Night Shift
                  </Button>
                  <Button size="sm" variant="primary" disabled={briefingBusy} onClick={() => void acknowledgeBriefing()}>
                    <CheckCircle size={12} weight="regular" />
                    Acknowledge
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-4 text-xs text-[#8B8B9A]">No unacknowledged briefing available.</div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
