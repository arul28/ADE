import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import type { AutomationIngressStatus, AutomationRuleSummary, AutomationRun, AutomationRunDetail } from "../../../shared/types";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { cn } from "../ui/cn";
import { statusToneAutomation as statusTone } from "../../lib/format";
import { RunDetailPanel } from "../automations/components/RunDetailPanel";
import { getAutomationsBridge } from "../automations/shared";

function formatWhen(ts: string | null): string {
  if (!ts) return "Never";
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return ts;
  return new Date(parsed).toLocaleString();
}

function summarizeActions(rule: AutomationRuleSummary): string {
  if (!rule.actions.length) return "(no actions)";
  return rule.actions.map((a) => a.type).join(", ");
}

export function AutomationsSection() {
  const [rules, setRules] = React.useState<AutomationRuleSummary[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [ingressStatus, setIngressStatus] = React.useState<AutomationIngressStatus | null>(null);
  const [historyDialog, setHistoryDialog] = React.useState<{
    rule: AutomationRuleSummary;
    runs: AutomationRun[];
    selectedRunId: string | null;
    detail: AutomationRunDetail | null;
    busy: boolean;
    detailBusy: boolean;
  } | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const automationsBridge = getAutomationsBridge();
      const [next, nextIngressStatus] = await Promise.all([
        window.ade.automations.list(),
        automationsBridge.getIngressStatus ? automationsBridge.getIngressStatus().catch(() => null) : Promise.resolve(null),
      ]);
      setRules(next);
      setIngressStatus(nextIngressStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const unsub = window.ade.automations.onEvent(() => {
      void refresh();
      setHistoryDialog((prev) => {
        if (!prev) return prev;
        const ruleId = prev.rule.id;
        // Refresh dialog runs list opportunistically.
        window.ade.automations.getHistory({ id: ruleId, limit: 80 }).then((runs) => {
          setHistoryDialog((current) => (current && current.rule.id === ruleId ? { ...current, runs } : current));
        }).catch(() => { });
        return prev;
      });
    });
    return () => {
      try {
        unsub();
      } catch { }
    };
  }, [refresh]);

  const openHistory = React.useCallback(async (rule: AutomationRuleSummary) => {
    setHistoryDialog({
      rule,
      runs: [],
      selectedRunId: null,
      detail: null,
      busy: true,
      detailBusy: false
    });
    try {
      const runs = await window.ade.automations.getHistory({ id: rule.id, limit: 120 });
      setHistoryDialog((prev) => prev ? { ...prev, runs, busy: false } : prev);
    } catch (err) {
      setHistoryDialog(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadRunDetail = React.useCallback(async (runId: string) => {
    setHistoryDialog((prev) => prev ? { ...prev, selectedRunId: runId, detailBusy: true, detail: null } : prev);
    try {
      const detail = await window.ade.automations.getRunDetail(runId);
      setHistoryDialog((prev) => prev ? { ...prev, detail, detailBusy: false } : prev);
    } catch (err) {
      setHistoryDialog((prev) => prev ? { ...prev, detailBusy: false } : prev);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <section className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4 md:col-span-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">Automations</div>
          <div className="mt-0.5 text-xs text-muted-fg">
            Trigger-action workflows. Manage rules in the <Link to="/automations" className="underline">Automations</Link> tab.
          </div>
        </div>
        <Button size="sm" variant="outline" disabled={loading} onClick={() => void refresh()}>
          <ArrowsClockwise size={16} weight="regular" className={cn(loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {error ? (
        <div className="mt-2 rounded-lg bg-red-500/10 p-2 text-xs text-red-400">{error}</div>
      ) : null}

      <div className="mt-3 space-y-2">
        {ingressStatus ? (
          <div className="rounded-lg border border-border/10 bg-card/80 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-xs font-semibold text-fg">Ingress</div>
              <Chip className="text-[11px]">{ingressStatus.githubRelay.status}</Chip>
              <Chip className="text-[11px]">{ingressStatus.localWebhook.status}</Chip>
            </div>
            <div className="mt-1 text-[11px] text-muted-fg">
              GitHub relay cursor: <span className="font-mono">{ingressStatus.githubRelay.lastCursor ?? "none"}</span>
              {" · "}
              Local webhook: <span className="font-mono">{ingressStatus.localWebhook.url ?? "not listening"}</span>
            </div>
          </div>
        ) : null}
        {rules.length === 0 ? (
          <div className="rounded-lg border border-border/10 bg-card/80 p-3 text-xs text-muted-fg">No automation rules configured.</div>
        ) : (
          rules.map((rule) => (
            <div key={rule.id} className="rounded-lg border border-border/10 bg-card/80 p-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="truncate text-xs font-semibold text-fg">{rule.name}</div>
                    <Chip className={cn("text-[11px]", statusTone(rule.running ? "running" : rule.lastRunStatus))}>
                      {rule.running ? "running" : rule.lastRunStatus ?? "never"}
                    </Chip>
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-fg">
                    id: <span className="font-mono">{rule.id}</span> · trigger: <span className="font-mono">{rule.trigger.type}</span>
                    {rule.trigger.type === "schedule" && rule.trigger.cron ? ` (${rule.trigger.cron})` : ""}
                    {rule.trigger.branch ? ` · branch: ${rule.trigger.branch}` : ""}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-fg">actions: {summarizeActions(rule)}</div>
                  <div className="mt-0.5 text-[11px] text-muted-fg">last run: {formatWhen(rule.lastRunAt)}</div>
                  <div className="mt-0.5 text-[11px] text-muted-fg">
                    executor: <span className="font-mono">{rule.executor.mode}</span>
                    {rule.executor.targetId ? ` · target ${rule.executor.targetId}` : ""}
                    {rule.modelConfig?.orchestratorModel.modelId ? ` · ${rule.modelConfig.orchestratorModel.modelId}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void window.ade.automations.triggerManually({ id: rule.id }).catch((err) => setError(String(err)))}
                  >
                    Run now
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void openHistory(rule)}>
                    History
                  </Button>
                  <label className="flex items-center gap-1 text-xs text-muted-fg">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        window.ade.automations
                          .toggle({ id: rule.id, enabled })
                          .then((next) => setRules(next))
                          .catch((err) => setError(err instanceof Error ? err.message : String(err)));
                      }}
                    />
                    enabled
                  </label>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <Dialog.Root open={historyDialog != null} onOpenChange={(open) => setHistoryDialog(open ? historyDialog : null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-[8%] z-50 w-[min(980px,calc(100vw-24px))] -translate-x-1/2 rounded-xl border border-border/20 bg-bg p-4 shadow-2xl focus:outline-none">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <Dialog.Title className="text-sm font-semibold truncate">Automation History</Dialog.Title>
                {historyDialog ? (
                  <div className="mt-0.5 text-xs text-muted-fg truncate">
                    {historyDialog.rule.name} · <span className="font-mono">{historyDialog.rule.id}</span>
                  </div>
                ) : null}
              </div>
              <Dialog.Close asChild>
                <Button variant="ghost" size="sm">
                  Close
                </Button>
              </Dialog.Close>
            </div>

            {historyDialog?.busy ? (
              <div className="rounded-lg border border-border/10 bg-card/80 p-3 text-xs text-muted-fg">Loading runs…</div>
            ) : null}

            {historyDialog ? (
              <div className="grid min-h-0 grid-cols-[360px_1fr] gap-3">
                <div className="max-h-[65vh] overflow-auto rounded-lg border border-border/10 bg-card/80 p-2">
                  {historyDialog.runs.length === 0 ? (
                    <div className="p-2 text-xs text-muted-fg">No runs yet.</div>
                  ) : (
                    <div className="space-y-2">
                      {historyDialog.runs.map((run) => {
                        const selected = historyDialog.selectedRunId === run.id;
                        return (
                          <button
                            key={run.id}
                            type="button"
                            onClick={() => void loadRunDetail(run.id)}
                            className={cn(
                              "w-full rounded border px-2 py-2 text-left",
                              selected ? "border-accent/30 bg-accent/10" : "border-border/15 bg-card/80 hover:bg-muted/60"
                            )}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="truncate text-xs font-semibold">{run.triggerType}</div>
                              <Chip className={cn("text-[11px]", statusTone(run.status))}>{run.status}</Chip>
                            </div>
                            <div className="mt-1 text-[11px] text-muted-fg">{formatWhen(run.startedAt)}</div>
                            <div className="mt-1 text-[11px] text-muted-fg">
                              {run.actionsCompleted}/{run.actionsTotal} actions
                              {run.errorMessage ? ` · ${run.errorMessage}` : ""}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="max-h-[65vh] overflow-auto rounded-lg border border-border/10 bg-card/80 p-3">
                  <RunDetailPanel
                    detail={historyDialog.detail}
                    loading={historyDialog.detailBusy}
                    onActionComplete={() => {
                      if (historyDialog.selectedRunId) {
                        void loadRunDetail(historyDialog.selectedRunId);
                      }
                    }}
                  />
                </div>
              </div>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
