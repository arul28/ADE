import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowsClockwise, Funnel } from "@phosphor-icons/react";
import type { AutomationRun, AutomationRunDetail, AutomationRuleSummary } from "../../../shared/types";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { RunHistoryRow } from "./components/RunHistoryRow";
import { RunDetailPanel } from "./components/RunDetailPanel";

export function HistoryTab({
  focusAutomationId,
  focusRunId,
}: {
  focusAutomationId?: string | null;
  focusRunId?: string | null;
}) {
  const [rules, setRules] = useState<AutomationRuleSummary[]>([]);
  const [runs, setRuns] = useState<Array<AutomationRun & { ruleName?: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AutomationRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filterRuleId, setFilterRuleId] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("");

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [ruleList, runList] = await Promise.all([
        window.ade.automations.list(),
        window.ade.automations.listRuns({ limit: 160 }),
      ]);
      const byRule = new Map(ruleList.map((rule) => [rule.id, rule.name]));
      setRules(ruleList);
      setRuns(runList.map((run) => ({ ...run, ruleName: byRule.get(run.automationId) ?? run.automationId })));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (runId: string) => {
    setSelectedRunId(runId);
    setDetailLoading(true);
    try {
      const next = await window.ade.automations.getRunDetail(runId);
      setDetail(next);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
    const unsubscribe = window.ade.automations.onEvent(() => {
      void loadAll();
      if (selectedRunId) {
        void loadDetail(selectedRunId);
      }
    });
    return () => unsubscribe();
  }, [loadAll, loadDetail, selectedRunId]);

  useEffect(() => {
    if (!focusAutomationId) return;
    setFilterRuleId(focusAutomationId);
  }, [focusAutomationId]);

  useEffect(() => {
    if (!focusRunId) return;
    void loadDetail(focusRunId);
  }, [focusRunId, loadDetail]);

  const filteredRuns = useMemo(() => {
    let next = runs;
    if (filterRuleId) {
      next = next.filter((run) => run.automationId === filterRuleId);
    }
    if (filterStatus) {
      next = next.filter((run) => run.status === filterStatus);
    }
    return next;
  }, [filterRuleId, filterStatus, runs]);

  return (
    <div className="flex h-full min-h-0" style={{ background: "#0F0D14" }}>
      <div className="flex w-[420px] min-h-0 flex-col border-r border-white/[0.06]">
        <div className="border-b border-white/[0.06] px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-[#FAFAFA]">History</div>
              <div className="mt-1 text-xs leading-5 text-[#9894AF]">
                Inspect automation threads, mission launches, and built-in task runs.
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={() => void loadAll()} disabled={loading}>
              <ArrowsClockwise size={12} weight="regular" className={cn(loading && "animate-spin")} />
            </Button>
          </div>

          <div className="mt-4 grid grid-cols-[20px_1fr_1fr] items-center gap-2">
            <Funnel size={12} className="text-[#8E8AA6]" />
            <select
              className="h-9 rounded-md px-3 text-xs text-[#F5F7FA] font-mono"
              style={{ background: "rgba(7, 15, 24, 0.82)", border: "1px solid rgba(74, 99, 122, 0.42)" }}
              value={filterRuleId}
              onChange={(event) => setFilterRuleId(event.target.value)}
            >
              <option value="">All rules</option>
              {rules.map((rule) => (
                <option key={rule.id} value={rule.id}>{rule.name}</option>
              ))}
            </select>
            <select
              className="h-9 rounded-md px-3 text-xs text-[#F5F7FA] font-mono"
              style={{ background: "rgba(7, 15, 24, 0.82)", border: "1px solid rgba(74, 99, 122, 0.42)" }}
              value={filterStatus}
              onChange={(event) => setFilterStatus(event.target.value)}
            >
              <option value="">All statuses</option>
              <option value="queued">queued</option>
              <option value="running">running</option>
              <option value="succeeded">succeeded</option>
              <option value="failed">failed</option>
              <option value="cancelled">cancelled</option>
            </select>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3">
          {filteredRuns.length === 0 ? (
            <EmptyState
              title="No runs yet"
              description="Run history appears here after an automation executes."
            />
          ) : (
            <div className="space-y-3">
              {filteredRuns.map((run) => (
                <RunHistoryRow
                  key={run.id}
                  run={run}
                  ruleName={run.ruleName}
                  selected={run.id === selectedRunId}
                  onSelect={() => void loadDetail(run.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto">
        <RunDetailPanel detail={detail} loading={detailLoading} />
      </div>
    </div>
  );
}
