import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowClockwise } from "@phosphor-icons/react";
import type { AutomationRun, AutomationRunDetail } from "../../../shared/types";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";
import { RunHistoryRow } from "./components/RunHistoryRow";
import { RunDetailPanel } from "./components/RunDetailPanel";
import { extractError } from "./shared";

export function RuleHistoryPanel({
  automationId,
  ruleName,
}: {
  automationId: string;
  ruleName: string;
}) {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AutomationRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await window.ade.automations.listRuns({ automationId, limit: 80 });
      setRuns(next);
      setSelectedRunId((current) => current ?? next[0]?.id ?? null);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setLoading(false);
    }
  }, [automationId]);

  const loadDetail = useCallback(async (runId: string) => {
    setSelectedRunId(runId);
    setDetailLoading(true);
    setError(null);
    try {
      const next = await window.ade.automations.getRunDetail(runId);
      setDetail(next);
    } catch (err) {
      setError(extractError(err));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    setSelectedRunId(null);
    setDetail(null);
  }, [automationId, load]);

  useEffect(() => {
    const unsubscribe = window.ade.automations.onEvent(() => {
      void load();
      if (selectedRunId) {
        void loadDetail(selectedRunId);
      }
    });
    return () => unsubscribe();
  }, [load, loadDetail, selectedRunId]);

  useEffect(() => {
    if (selectedRunId && !detail) {
      void loadDetail(selectedRunId);
    }
  }, [detail, loadDetail, selectedRunId]);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[340px] shrink-0 min-h-0 flex-col border-r border-white/[0.06]">
        <div className="shrink-0 border-b border-white/[0.06] px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-[#F5FAFF]">{ruleName}</div>
              <div className="mt-0.5 text-[11px] text-[#93A4B8]">Runs for this rule</div>
            </div>
            <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
              <ArrowClockwise size={12} weight="regular" className={cn(loading && "animate-spin")} />
            </Button>
          </div>
          {error ? (
            <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
          {runs.length === 0 ? (
            <EmptyState
              title="No runs yet"
              description="This rule has not executed. Trigger it manually or wait for the next event."
            />
          ) : (
            <div className="space-y-3">
              {runs.map((run) => (
                <RunHistoryRow
                  key={run.id}
                  run={run}
                  selected={run.id === selectedRunId}
                  onSelect={() => void loadDetail(run.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto">
        <RunDetailPanel
          detail={detail}
          loading={detailLoading}
          onOpenMission={(missionId) => navigate(`/missions?missionId=${encodeURIComponent(missionId)}`)}
        />
      </div>
    </div>
  );
}
