import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Moon,
  Clock,
  CalendarBlank,
  ArrowClockwise as RefreshCw,
  ArrowUp,
  ArrowDown,
  Pause,
  Play,
  Trash,
  RocketLaunch,
  Archive,
  CheckCircle,
  Eye,
} from "@phosphor-icons/react";
import { motion } from "motion/react";
import type {
  AutomationRuleSummary,
  BudgetCapConfig,
  NightShiftBriefingCard,
  NightShiftQueueItem,
  NightShiftState,
} from "../../../shared/types";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";
import { CARD_SHADOW_STYLE, extractError, getAutomationsBridge, INPUT_STYLE } from "./shared";

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

const DEFAULT_BUDGET_CONFIG: BudgetCapConfig = {
  budgetCaps: [],
  nightShiftReservePercent: 0,
};

function triggerBadge(rule: AutomationRuleSummary | undefined): string {
  const trigger = rule?.triggers?.[0];
  if (!trigger) return "manual";
  if (trigger.type === "github-webhook") return "github relay";
  if (trigger.type === "webhook") return "local webhook";
  return trigger.type;
}

function QueueMutationButtons({
  item,
  index,
  total,
  disabled,
  available,
  onMutate,
}: {
  item: NightShiftQueueItem;
  index: number;
  total: number;
  disabled: boolean;
  available: boolean;
  onMutate: (action: "remove" | "run-now" | "pause" | "resume" | "move", position?: number) => void;
}) {
  if (!available) {
    return <div className="text-[10px] text-[#71717A]">Queue runtime controls waiting on W5b bridge</div>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size="sm" variant="ghost" disabled={disabled || index === 0} onClick={() => onMutate("move", index - 1)}>
        <ArrowUp size={12} weight="regular" />
      </Button>
      <Button size="sm" variant="ghost" disabled={disabled || index === total - 1} onClick={() => onMutate("move", index + 1)}>
        <ArrowDown size={12} weight="regular" />
      </Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onMutate(item.status === "paused" ? "resume" : "pause")}>
        {item.status === "paused" ? <Play size={12} weight="regular" /> : <Pause size={12} weight="regular" />}
      </Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onMutate("run-now")}>
        <RocketLaunch size={12} weight="regular" />
      </Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onMutate("remove")}>
        <Trash size={12} weight="regular" />
      </Button>
    </div>
  );
}

function BriefingActionBar({
  card,
  onQueueAction,
}: {
  card: NightShiftBriefingCard;
  onQueueAction: (queueItemId: string, action: "accept" | "archive" | "queue-overnight") => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" onClick={() => onQueueAction(card.queueItemId, "accept")}>
        <CheckCircle size={12} weight="regular" />
        Accept
      </Button>
      <Button size="sm" variant="outline" onClick={() => onQueueAction(card.queueItemId, "archive")}>
        <Archive size={12} weight="regular" />
        Archive
      </Button>
      <Button size="sm" variant="outline" onClick={() => onQueueAction(card.queueItemId, "queue-overnight")}>
        <Moon size={12} weight="regular" />
        Requeue
      </Button>
      <div className="inline-flex items-center gap-1 rounded-full px-2 py-1 font-mono text-[9px] text-[#71717A]" style={{ border: "1px solid #2D284080" }}>
        <Eye size={10} weight="regular" />
        inspect in history
      </div>
    </div>
  );
}

export function NightShiftTab() {
  const [state, setState] = useState<NightShiftState>(DEFAULT_STATE);
  const [rules, setRules] = useState<AutomationRuleSummary[]>([]);
  const [budgetConfig, setBudgetConfig] = useState<BudgetCapConfig>(DEFAULT_BUDGET_CONFIG);
  const [loading, setLoading] = useState(false);
  const [mutatingQueueId, setMutatingQueueId] = useState<string | null>(null);
  const [briefingQueueId, setBriefingQueueId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const automationsBridge = getAutomationsBridge();
  const queueControlsAvailable = Boolean(automationsBridge.mutateNightShiftQueue);
  const ruleById = useMemo(() => new Map(rules.map((rule) => [rule.id, rule])), [rules]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nightShiftState, ruleList, nextBudgetConfig] = await Promise.all([
        window.ade.automations.getNightShiftState(),
        window.ade.automations.list(),
        window.ade.usage.getBudgetConfig().catch(() => DEFAULT_BUDGET_CONFIG),
      ]);
      setState(nightShiftState);
      setRules(ruleList);
      setBudgetConfig(nextBudgetConfig);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = window.ade.automations.onEvent((event) => {
      if (
        event.type === "night-shift-updated"
        || event.type === "queue-updated"
        || event.type === "review-updated"
        || event.type === "ingress-updated"
      ) {
        void refresh();
      }
    });
    return () => unsubscribe();
  }, [refresh]);

  const updateSettings = async (patch: Partial<NightShiftState["settings"]>) => {
    try {
      const next = await window.ade.automations.updateNightShiftSettings({
        activeHours: patch.activeHours,
        utilizationPreset: patch.utilizationPreset,
        paused: patch.paused,
      });
      setState(next);
    } catch (err) {
      setError(extractError(err));
    }
  };

  const mutateQueue = async (
    queueItemId: string,
    action: "remove" | "run-now" | "pause" | "resume" | "move",
    position?: number,
  ) => {
    if (!automationsBridge.mutateNightShiftQueue) return;
    setMutatingQueueId(queueItemId);
    setError(null);
    try {
      const next = await automationsBridge.mutateNightShiftQueue(
        action === "move" ? { action, queueItemId, position: position ?? 0 } : { action, queueItemId },
      );
      setState(next);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setMutatingQueueId(null);
    }
  };

  const updateQueueItem = async (queueItemId: string, action: "accept" | "archive" | "queue-overnight") => {
    setBriefingQueueId(queueItemId);
    setError(null);
    try {
      await window.ade.automations.updateQueueItem({ queueItemId, action });
      await refresh();
    } catch (err) {
      setError(extractError(err));
    } finally {
      setBriefingQueueId(null);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="h-full overflow-y-auto p-6"
      style={{ background: "#0F0D14" }}
    >
      <div className="max-w-5xl mx-auto space-y-6">
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

        {error ? (
          <div className="rounded p-3 text-xs text-red-300" style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.18)" }}>
            {error}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
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
                    style={INPUT_STYLE}
                    value={state.settings.activeHours.start}
                    onChange={(e) => void updateSettings({ activeHours: { ...state.settings.activeHours, start: e.target.value } })}
                  />
                </label>
                <label className="space-y-1">
                  <div className="font-mono text-[9px] text-[#71717A]">End</div>
                  <input
                    className="h-8 w-full px-3 font-mono text-[10px] text-[#FAFAFA]"
                    style={INPUT_STYLE}
                    value={state.settings.activeHours.end}
                    onChange={(e) => void updateSettings({ activeHours: { ...state.settings.activeHours, end: e.target.value } })}
                  />
                </label>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto_auto] md:items-center">
                <select
                  className="h-8 px-3 font-mono text-[10px] text-[#FAFAFA]"
                  style={INPUT_STYLE}
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
                <Chip className={cn("text-[9px]", state.settings.paused ? "bg-amber-500/15 text-amber-300" : "bg-emerald-500/15 text-emerald-300")}>
                  {state.settings.paused ? "paused" : "ready"}
                </Chip>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded p-2" style={{ background: "#14111D", border: "1px solid #1E1B26" }}>
                  <div className="font-mono text-[9px] text-[#71717A]">reserve budget</div>
                  <div className="mt-1 text-xs text-[#FAFAFA]">{budgetConfig.nightShiftReservePercent}%</div>
                </div>
                <div className="rounded p-2" style={{ background: "#14111D", border: "1px solid #1E1B26" }}>
                  <div className="font-mono text-[9px] text-[#71717A]">queue capacity</div>
                  <div className="mt-1 text-xs text-[#FAFAFA]">{state.settings.utilizationPreset}</div>
                </div>
              </div>
            </div>

            <div className="p-4 space-y-3" style={CARD_SHADOW_STYLE}>
              <div className="flex items-center gap-2">
                <CalendarBlank size={14} weight="regular" className="text-[#A78BFA]" />
                <span className="font-mono text-[10px] font-bold uppercase tracking-[1px] text-[#A1A1AA]">Night Shift Queue</span>
              </div>
              {state.queue.length === 0 ? (
                <EmptyState title="No overnight queue" description="Rules using Night Shift or queue-overnight will appear here." icon={Moon} />
              ) : (
                <div className="space-y-2">
                  {state.queue.map((item, index) => {
                    const rule = ruleById.get(item.automationId);
                    const disabled = mutatingQueueId === item.id;
                    return (
                      <div key={item.id} className="p-3 space-y-3" style={{ background: "#14111D", border: "1px solid #1E1B26" }}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-[#FAFAFA]">{item.title}</div>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              <Chip className="text-[9px]">{item.status}</Chip>
                              <Chip className="text-[9px]">{item.executorMode}</Chip>
                              {item.targetLabel ? <Chip className="text-[9px]">{item.targetLabel}</Chip> : null}
                              <Chip className="text-[9px]">{triggerBadge(rule)}</Chip>
                            </div>
                            <div className="mt-2 font-mono text-[9px] text-[#71717A]">
                              #{item.position + 1} · {item.reviewProfile} · {item.scheduledWindow ?? "overnight"}
                            </div>
                          </div>
                          <QueueMutationButtons
                            item={item}
                            index={index}
                            total={state.queue.length}
                            disabled={disabled}
                            available={queueControlsAvailable}
                            onMutate={(action, position) => void mutateQueue(item.id, action, position)}
                          />
                        </div>
                      </div>
                    );
                  })}
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
                <div className="grid grid-cols-4 gap-2">
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
                  <div className="p-2" style={{ background: "#14111D", border: "1px solid #1E1B26" }}>
                    <div className="font-mono text-[9px] text-[#71717A]">spend</div>
                    <div className="mt-1 font-mono text-[16px] text-[#FAFAFA]">${state.latestBriefing.totalSpendUsd.toFixed(2)}</div>
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
                      <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[9px] text-[#8B8B9A]">
                        <span>${card.spendUsd.toFixed(2)}</span>
                        {card.suggestedActions.map((action) => (
                          <span key={action}>{action}</span>
                        ))}
                        {card.procedureSignals.map((signal) => (
                          <span key={signal}>{signal}</span>
                        ))}
                      </div>
                      <div className={cn(briefingQueueId === card.queueItemId && "opacity-60")}>
                        <BriefingActionBar card={card} onQueueAction={(queueItemId, action) => void updateQueueItem(queueItemId, action)} />
                      </div>
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
