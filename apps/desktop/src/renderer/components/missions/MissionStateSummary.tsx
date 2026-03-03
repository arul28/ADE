import { useCallback, useEffect, useRef, useState } from "react";
import type { MissionStateDocument } from "../../../shared/types";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";
import { relativeWhen } from "../../lib/format";
import { useMissionPollingImmediate } from "./useMissionPolling";

type MissionStateSummaryProps = {
  runId: string | null;
};

const STATUS_HEX: Record<string, string> = {
  succeeded: "#22C55E",
  failed: "#EF4444",
  skipped: "#71717A",
  in_progress: "#3B82F6",
};

const VERDICT_HEX: Record<string, string> = {
  pass: "#22C55E",
  fail: "#EF4444",
  none: "#71717A",
};

const ISSUE_HEX: Record<string, string> = {
  low: "#3B82F6",
  medium: "#F59E0B",
  high: "#EF4444",
};

function statusLabel(status: string): string {
  if (status === "in_progress") return "IN PROGRESS";
  return status.replace(/_/g, " ").toUpperCase();
}

function validationLabel(verdict: "pass" | "fail" | null | undefined): string {
  if (verdict === "pass") return "PASS";
  if (verdict === "fail") return "FAIL";
  return "NONE";
}

export function MissionStateSummary({ runId }: MissionStateSummaryProps) {
  const [stateDoc, setStateDoc] = useState<MissionStateDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!runId) {
      setStateDoc(null);
      setError(null);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const next = await window.ade.orchestrator.getMissionStateDocument({ runId });
      setStateDoc(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [runId]);

  // Initial load
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ── Polling via shared coordinator (replaces per-component setInterval) ──
  const pollRefresh = useCallback(() => { void refresh(); }, [refresh]);
  const { fireNow } = useMissionPollingImmediate(pollRefresh, 10_000, !!runId);

  // ── Event-driven immediate refresh (debounced) ──
  useEffect(() => {
    if (!runId) return;
    const scheduleRefresh = (delayMs = 250) => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        fireNow();
      }, delayMs);
    };

    const unsubRuntime = window.ade.orchestrator.onEvent((event) => {
      if (event.runId !== runId) return;
      scheduleRefresh();
    });

    const unsubThread = window.ade.orchestrator.onThreadEvent((event) => {
      if (event.runId !== runId) return;
      scheduleRefresh();
    });

    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      unsubRuntime();
      unsubThread();
    };
  }, [runId, fireNow]);

  const progress = stateDoc?.progress ?? null;
  const completed = progress?.completedSteps ?? 0;
  const total = progress?.totalSteps ?? 0;
  const progressPct = total > 0 ? Math.max(0, Math.min(100, Math.round((completed / total) * 100))) : 0;
  const stepOutcomes = stateDoc?.stepOutcomes ?? [];
  const activeIssues = (stateDoc?.activeIssues ?? []).filter((issue) => issue.status !== "resolved");
  const pendingInterventions = stateDoc?.pendingInterventions ?? [];
  const recentDecisions = (stateDoc?.decisions ?? []).slice(-8).reverse();
  const modifiedFiles = stateDoc?.modifiedFiles ?? [];

  return (
    <div className="space-y-3">
      <div className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
            Mission State
          </div>
          {stateDoc?.updatedAt ? (
            <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
              updated {relativeWhen(stateDoc.updatedAt)}
            </div>
          ) : null}
        </div>

        {!runId ? (
          <div className="mt-2 text-[11px]" style={{ color: COLORS.textMuted }}>
            Start a run to build mission state.
          </div>
        ) : loading && !stateDoc ? (
          <div className="mt-2 text-[11px]" style={{ color: COLORS.textMuted }}>
            Loading mission state...
          </div>
        ) : error ? (
          <div className="mt-2 text-[11px]" style={{ color: COLORS.danger }}>
            Failed to load mission state: {error}
          </div>
        ) : !stateDoc ? (
          <div className="mt-2 text-[11px]" style={{ color: COLORS.textMuted }}>
            No mission state document found yet.
          </div>
        ) : (
          <>
            <div className="mt-3 space-y-1">
              <div className="flex items-center justify-between text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                <span>PHASE: {progress?.currentPhase ?? "unknown"}</span>
                <span>{completed}/{total} steps</span>
              </div>
              <div style={{ height: 8, background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
                <div
                  style={{
                    width: `${progressPct}%`,
                    height: "100%",
                    background: COLORS.accent,
                    transition: "width 180ms ease",
                  }}
                />
              </div>
            </div>

            <div className="mt-3">
              <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                Step Outcomes
              </div>
              {stepOutcomes.length === 0 ? (
                <div className="mt-1 text-[11px]" style={{ color: COLORS.textMuted }}>
                  No step outcomes yet.
                </div>
              ) : (
                <div className="mt-2 overflow-auto" style={{ maxHeight: 280, border: `1px solid ${COLORS.border}` }}>
                  <table className="w-full text-[10px]" style={{ fontFamily: MONO_FONT }}>
                    <thead style={{ background: COLORS.recessedBg }}>
                      <tr>
                        <th className="px-2 py-1 text-left" style={{ color: COLORS.textMuted, borderBottom: `1px solid ${COLORS.border}` }}>STEP</th>
                        <th className="px-2 py-1 text-left" style={{ color: COLORS.textMuted, borderBottom: `1px solid ${COLORS.border}` }}>STATUS</th>
                        <th className="px-2 py-1 text-left" style={{ color: COLORS.textMuted, borderBottom: `1px solid ${COLORS.border}` }}>SUMMARY</th>
                        <th className="px-2 py-1 text-left" style={{ color: COLORS.textMuted, borderBottom: `1px solid ${COLORS.border}` }}>VALIDATION</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...stepOutcomes].reverse().map((outcome) => {
                        const statusHex = STATUS_HEX[outcome.status] ?? COLORS.textMuted;
                        const verdict = outcome.validation?.verdict ?? null;
                        const verdictHex = VERDICT_HEX[verdict ?? "none"] ?? COLORS.textMuted;
                        return (
                          <tr key={outcome.stepKey}>
                            <td className="px-2 py-1 align-top" style={{ color: COLORS.textPrimary, borderBottom: `1px solid ${COLORS.border}` }}>
                              <div>
                                {(outcome.phase === "validation" || outcome.stepName.toLowerCase().includes("milestone")) && (
                                  <span style={{ color: COLORS.accent, marginRight: 4 }}>{"\u25C6"}</span>
                                )}
                                {outcome.stepName}
                              </div>
                              <div style={{ color: COLORS.textMuted }}>{outcome.stepKey}</div>
                            </td>
                            <td className="px-2 py-1 align-top" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                              <span className="px-1 py-0.5 text-[9px] font-bold" style={{ color: statusHex, border: `1px solid ${statusHex}40`, background: `${statusHex}12` }}>
                                {statusLabel(outcome.status)}
                              </span>
                            </td>
                            <td className="px-2 py-1 align-top" style={{ color: COLORS.textSecondary, borderBottom: `1px solid ${COLORS.border}` }}>
                              {outcome.summary || "--"}
                            </td>
                            <td className="px-2 py-1 align-top" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                              <span className="px-1 py-0.5 text-[9px] font-bold" style={{ color: verdictHex, border: `1px solid ${verdictHex}40`, background: `${verdictHex}12` }}>
                                {validationLabel(verdict)}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                  Active Issues
                </div>
                {activeIssues.length === 0 ? (
                  <div className="mt-1 text-[11px]" style={{ color: COLORS.textMuted }}>No active issues.</div>
                ) : (
                  <div className="mt-1 space-y-1.5 overflow-y-auto" style={{ maxHeight: 200 }}>
                    {activeIssues.map((issue) => {
                      const issueHex = ISSUE_HEX[issue.severity] ?? COLORS.textMuted;
                      return (
                        <div key={issue.id} className="p-2" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
                          <div className="flex items-center gap-2">
                            <span className="px-1 py-0.5 text-[9px] font-bold uppercase" style={{ color: issueHex, border: `1px solid ${issueHex}40`, background: `${issueHex}12` }}>
                              {issue.severity}
                            </span>
                            <span className="text-[10px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>{issue.id}</span>
                          </div>
                          <div className="mt-1 text-[10px]" style={{ color: COLORS.textSecondary }}>{issue.description}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                  Recent Decisions
                </div>
                {recentDecisions.length === 0 ? (
                  <div className="mt-1 text-[11px]" style={{ color: COLORS.textMuted }}>No decisions logged yet.</div>
                ) : (
                  <div className="mt-1 space-y-1.5 overflow-y-auto" style={{ maxHeight: 200 }}>
                    {recentDecisions.map((decision, index) => (
                      <div key={`${decision.timestamp}:${index}`} className="p-2" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
                        <div className="text-[10px]" style={{ color: COLORS.textPrimary }}>{decision.decision}</div>
                        <div className="mt-1 text-[10px]" style={{ color: COLORS.textSecondary }}>{decision.rationale}</div>
                        <div className="mt-1 text-[9px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                          {relativeWhen(decision.timestamp)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {pendingInterventions.length > 0 && (
              <div className="mt-3">
                <div className="flex items-center gap-2">
                  <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                    Pending Interventions
                  </div>
                  <span
                    className="px-1.5 py-0.5 text-[9px] font-bold"
                    style={{ color: "#F59E0B", border: "1px solid #F59E0B40", background: "#F59E0B18", fontFamily: MONO_FONT }}
                  >
                    {pendingInterventions.length}
                  </span>
                </div>
                <div className="mt-1 space-y-1.5 overflow-y-auto" style={{ maxHeight: 200 }}>
                  {pendingInterventions.map((intervention) => (
                    <div key={intervention.id} className="p-2" style={{ background: COLORS.recessedBg, border: "1px solid #F59E0B30" }}>
                      <div className="flex items-center gap-2">
                        <span
                          className="px-1 py-0.5 text-[9px] font-bold uppercase"
                          style={{ color: "#F59E0B", border: "1px solid #F59E0B40", background: "#F59E0B18", fontFamily: MONO_FONT }}
                        >
                          {intervention.type}
                        </span>
                        <span className="text-[10px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>{intervention.title}</span>
                      </div>
                      <div className="mt-1 text-[9px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                        {relativeWhen(intervention.createdAt)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-3">
              <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                Modified Files ({modifiedFiles.length})
              </div>
              {modifiedFiles.length === 0 ? (
                <div className="mt-1 text-[11px]" style={{ color: COLORS.textMuted }}>No files recorded yet.</div>
              ) : (
                <div className="mt-1 overflow-auto" style={{ maxHeight: 140, border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg }}>
                  <div className="p-2 text-[10px] space-y-0.5" style={{ fontFamily: MONO_FONT, color: COLORS.textSecondary }}>
                    {modifiedFiles.map((file) => (
                      <div key={file}>{file}</div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
