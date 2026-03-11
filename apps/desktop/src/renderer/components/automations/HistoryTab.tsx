import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise as RefreshCw,
  Funnel,
} from "@phosphor-icons/react";
import { motion } from "motion/react";
import type { AutomationRun, AutomationRunDetail, AutomationRuleSummary } from "../../../shared/types";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { RunHistoryRow } from "./components/RunHistoryRow";
import { RunDetailPanel } from "./components/RunDetailPanel";

export function HistoryTab() {
  const [rules, setRules] = useState<AutomationRuleSummary[]>([]);
  const [allRuns, setAllRuns] = useState<(AutomationRun & { ruleName?: string })[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AutomationRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filterRule, setFilterRule] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("");

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const ruleList = await window.ade.automations.list();
      setRules(ruleList);
      const runs = await window.ade.automations.listRuns({ limit: 120 });
      const byRule = new Map(ruleList.map((rule) => [rule.id, rule.name]));
      setAllRuns(runs.map((run) => ({ ...run, ruleName: byRule.get(run.automationId) ?? run.automationId })));
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadAll().catch(() => {}); }, [loadAll]);

  const loadDetail = useCallback(async (runId: string) => {
    setSelectedRunId(runId);
    setDetailLoading(true);
    setDetail(null);
    try {
      const d = await window.ade.automations.getRunDetail(runId);
      setDetail(d);
    } catch { /* ignore */ }
    finally { setDetailLoading(false); }
  }, []);

  const refreshSelectedRun = useCallback(async () => {
    if (!selectedRunId) return;
    await Promise.all([loadAll(), loadDetail(selectedRunId)]);
  }, [loadAll, loadDetail, selectedRunId]);

  const filtered = useMemo(() => {
    let runs = allRuns;
    if (filterRule) runs = runs.filter((r) => r.ruleName === filterRule);
    if (filterStatus) runs = runs.filter((r) => r.status === filterStatus);
    return runs;
  }, [allRuns, filterRule, filterStatus]);

  const SELECT_CLS = "h-7 px-2 font-mono text-[9px] text-[#FAFAFA]";
  const SELECT_STYLE: React.CSSProperties = { background: "#0B0A0F", border: "1px solid #2D284080" };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      className="flex h-full min-h-0"
      style={{ background: "#0F0D14" }}
    >
      {/* Left: run list */}
      <div className="flex min-h-0 w-[45%] flex-col" style={{ borderRight: "1px solid #2D2840" }}>
        <div className="shrink-0 flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid #2D284060" }}>
          <div>
            <div
              className="text-[13px] font-bold text-[#FAFAFA] tracking-[-0.3px]"
              style={{ fontFamily: "'Space Grotesk', sans-serif" }}
            >
              Run History
            </div>
            <div className="font-mono text-[9px] text-[#71717A]">
              {loading ? "Loading..." : `${filtered.length} runs`}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => loadAll().catch(() => {})}>
            <RefreshCw size={12} weight="regular" className={cn(loading && "animate-spin")} />
          </Button>
        </div>

        {/* Filters */}
        <div className="shrink-0 flex items-center gap-2 px-4 py-2" style={{ borderBottom: "1px solid #2D284040" }}>
          <Funnel size={10} weight="regular" className="text-[#71717A]" />
          <select className={SELECT_CLS} style={SELECT_STYLE} value={filterRule} onChange={(e) => setFilterRule(e.target.value)}>
            <option value="">All rules</option>
            {rules.map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
          </select>
          <select className={SELECT_CLS} style={SELECT_STYLE} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="succeeded">succeeded</option>
            <option value="failed">failed</option>
            <option value="running">running</option>
            <option value="needs_review">needs_review</option>
            <option value="cancelled">cancelled</option>
          </select>
        </div>

        {/* Runs */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {filtered.length === 0 ? (
            <EmptyState title="No run history" description="Runs will appear here after rules execute." />
          ) : (
            filtered.map((run) => (
              <RunHistoryRow
                key={run.id}
                run={run}
                ruleName={run.ruleName}
                selected={run.id === selectedRunId}
                onSelect={() => loadDetail(run.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* Right: detail */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <RunDetailPanel detail={detail} loading={detailLoading} onActionComplete={() => void refreshSelectedRun()} />
      </div>
    </motion.div>
  );
}
