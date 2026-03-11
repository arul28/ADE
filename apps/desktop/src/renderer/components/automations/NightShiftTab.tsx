import { useCallback, useEffect, useState } from "react";
import { Moon, Clock, CalendarBlank, ArrowClockwise as RefreshCw } from "@phosphor-icons/react";
import { motion } from "motion/react";
import type { NightShiftState } from "../../../shared/types";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Chip } from "../ui/Chip";
import { CARD_SHADOW_STYLE } from "./shared";

const DEFAULT_STATE: NightShiftState = {
  settings: {
    activeHours: { start: "22:00", end: "06:00", timezone: "Local" },
    utilizationPreset: "conservative",
    paused: false,
    updatedAt: "",
  },
  queue: [],
  latestBriefing: null,
};

export function NightShiftTab() {
  const [state, setState] = useState<NightShiftState>(DEFAULT_STATE);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setState(await window.ade.automations.getNightShiftState());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = window.ade.automations.onEvent((event) => {
      if (event.type === "night-shift-updated" || event.type === "queue-updated") {
        void refresh();
      }
    });
    return () => unsubscribe();
  }, [refresh]);

  const updateSettings = async (patch: Partial<NightShiftState["settings"]>) => {
    const next = await window.ade.automations.updateNightShiftSettings({
      activeHours: patch.activeHours,
      utilizationPreset: patch.utilizationPreset,
      paused: patch.paused,
    });
    setState(next);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="h-full overflow-y-auto p-6"
      style={{ background: "#0F0D14" }}
    >
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Moon size={18} weight="regular" className="text-[#A78BFA]" />
              <span className="text-[16px] font-bold text-[#FAFAFA] tracking-[-0.4px]" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                Night Shift
              </span>
            </div>
            <div className="mt-1 font-mono text-[10px] text-[#71717A]">
              Queue unattended review and monitoring work for overnight execution.
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void refresh()}>
            <RefreshCw size={12} weight="regular" className={loading ? "animate-spin" : ""} />
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.2fr_1fr]">
          <div className="space-y-4">
            <div className="p-4 space-y-3" style={CARD_SHADOW_STYLE}>
              <div className="flex items-center gap-2">
                <Clock size={14} weight="regular" className="text-[#A78BFA]" />
                <span className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">Schedule</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <div className="font-mono text-[9px] text-[#71717A]">Start</div>
                  <input
                    className="h-8 w-full px-3 font-mono text-[10px] text-[#FAFAFA]"
                    style={{ background: "#0B0A0F", border: "1px solid #2D284080" }}
                    value={state.settings.activeHours.start}
                    onChange={(e) => void updateSettings({ activeHours: { ...state.settings.activeHours, start: e.target.value } })}
                  />
                </label>
                <label className="space-y-1">
                  <div className="font-mono text-[9px] text-[#71717A]">End</div>
                  <input
                    className="h-8 w-full px-3 font-mono text-[10px] text-[#FAFAFA]"
                    style={{ background: "#0B0A0F", border: "1px solid #2D284080" }}
                    value={state.settings.activeHours.end}
                    onChange={(e) => void updateSettings({ activeHours: { ...state.settings.activeHours, end: e.target.value } })}
                  />
                </label>
              </div>
              <div className="flex items-center gap-3">
                <select
                  className="h-8 px-3 font-mono text-[10px] text-[#FAFAFA]"
                  style={{ background: "#0B0A0F", border: "1px solid #2D284080" }}
                  value={state.settings.utilizationPreset}
                  onChange={(e) => void updateSettings({ utilizationPreset: e.target.value as NightShiftState["settings"]["utilizationPreset"] })}
                >
                  <option value="conservative">conservative</option>
                  <option value="maximize">maximize</option>
                  <option value="fixed">fixed</option>
                </select>
                <label className="flex items-center gap-2 text-[10px] font-mono text-[#C4B5FD]">
                  <input
                    type="checkbox"
                    checked={!state.settings.paused}
                    onChange={(e) => void updateSettings({ paused: !e.target.checked })}
                    className="accent-[#A78BFA]"
                  />
                  active
                </label>
              </div>
            </div>

            <div className="p-4 space-y-3" style={CARD_SHADOW_STYLE}>
              <div className="flex items-center gap-2">
                <CalendarBlank size={14} weight="regular" className="text-[#A78BFA]" />
                <span className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">Queue</span>
              </div>
              {state.queue.length === 0 ? (
                <EmptyState title="No overnight queue" description="Rules using Night Shift or queue-overnight will appear here." icon={Moon} />
              ) : (
                <div className="space-y-2">
                  {state.queue.map((item) => (
                    <div key={item.id} className="p-3" style={{ background: "#14111D", border: "1px solid #1E1B26" }}>
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="text-xs font-semibold text-[#FAFAFA]">{item.title}</div>
                          <div className="mt-1 font-mono text-[9px] text-[#71717A]">
                            {item.reviewProfile} · {item.scheduledWindow ?? "overnight"}
                          </div>
                        </div>
                        <Chip className="text-[9px]">{item.status}</Chip>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="p-4 space-y-3" style={CARD_SHADOW_STYLE}>
            <div className="flex items-center gap-2">
              <Moon size={14} weight="regular" className="text-[#A78BFA]" />
              <span className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">Morning Briefing</span>
            </div>
            {!state.latestBriefing ? (
              <EmptyState title="No briefing yet" description="Completed overnight work will roll up here with confidence, spend, and follow-up actions." icon={Moon} />
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  <div className="p-2" style={{ background: "#14111D", border: "1px solid #1E1B26" }}>
                    <div className="font-mono text-[9px] text-[#71717A]">runs</div>
                    <div className="mt-1 font-mono text-[16px] text-[#FAFAFA]">{state.latestBriefing.totalRuns}</div>
                  </div>
                  <div className="p-2" style={{ background: "#14111D", border: "1px solid #1E1B26" }}>
                    <div className="font-mono text-[9px] text-[#71717A]">clean</div>
                    <div className="mt-1 font-mono text-[16px] text-[#22C55E]">{state.latestBriefing.succeededRuns}</div>
                  </div>
                  <div className="p-2" style={{ background: "#14111D", border: "1px solid #1E1B26" }}>
                    <div className="font-mono text-[9px] text-[#71717A]">needs follow-up</div>
                    <div className="mt-1 font-mono text-[16px] text-[#F59E0B]">{state.latestBriefing.failedRuns}</div>
                  </div>
                </div>
                <div className="space-y-2">
                  {state.latestBriefing.cards.map((card) => (
                    <div key={card.queueItemId} className="p-3" style={{ background: "#14111D", border: "1px solid #1E1B26" }}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs font-semibold text-[#FAFAFA]">{card.title}</div>
                        {card.confidence ? <Chip className="text-[9px]">{card.confidence.label}</Chip> : null}
                      </div>
                      <div className="mt-1 text-xs text-[#A1A1AA]">{card.summary}</div>
                      {card.procedureSignals.length ? (
                        <div className="mt-2 font-mono text-[9px] text-[#8B8B9A]">{card.procedureSignals.join(" · ")}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
