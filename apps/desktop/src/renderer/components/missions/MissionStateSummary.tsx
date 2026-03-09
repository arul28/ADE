import { useState, useMemo } from "react";
import { CaretDown, CaretRight, WarningCircle, CheckCircle } from "@phosphor-icons/react";
import type { MissionStateDocument } from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { relativeWhen } from "../../lib/format";

type MissionStateSummaryProps = {
  runId: string | null;
  stateDoc?: MissionStateDocument | null;
  loading?: boolean;
  error?: string | null;
  onOpenIntervention?: (interventionId: string) => void;
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

/* ─── Compact Stat Pill ─── */

function StatPill({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px]" style={{ fontFamily: MONO_FONT }}>
      <span style={{ color: COLORS.textDim }}>{label}</span>
      <span style={{ color: color ?? COLORS.textPrimary, fontWeight: 600 }}>{value}</span>
    </div>
  );
}

/* ─── Main Component ─── */

export function MissionStateSummary({
  runId,
  stateDoc,
  loading = false,
  error = null,
  onOpenIntervention,
}: MissionStateSummaryProps) {
  const [showOutcomes, setShowOutcomes] = useState(false);
  const [showDecisions, setShowDecisions] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [showFinalization, setShowFinalization] = useState(false);

  const progress = stateDoc?.progress ?? null;
  const completed = progress?.completedSteps ?? 0;
  const total = progress?.totalSteps ?? 0;
  const progressPct = total > 0 ? Math.max(0, Math.min(100, Math.round((completed / total) * 100))) : 0;
  const stepOutcomes = stateDoc?.stepOutcomes ?? [];
  const activeIssues = (stateDoc?.activeIssues ?? []).filter((issue) => issue.status !== "resolved");
  const pendingInterventions = stateDoc?.pendingInterventions ?? [];
  const recentDecisions = (stateDoc?.decisions ?? []).slice(-8).reverse();
  const modifiedFiles = stateDoc?.modifiedFiles ?? [];
  const finalization = stateDoc?.finalization ?? null;
  const coordinatorAvailability = stateDoc?.coordinatorAvailability ?? null;
  const reversedOutcomes = useMemo(() => [...stepOutcomes].reverse(), [stepOutcomes]);

  /* No run yet → show nothing */
  if (!runId) return null;

  /* Loading with no data → minimal indicator */
  if (loading && !stateDoc) {
    return (
      <div className="text-[11px] py-2" style={{ color: COLORS.textDim }}>
        Loading state...
      </div>
    );
  }

  /* Error */
  if (error) {
    return (
      <div className="text-[11px] py-2" style={{ color: COLORS.danger }}>
        {error}
      </div>
    );
  }

  /* No state doc yet */
  if (!stateDoc) return null;

  const succeededSteps = stepOutcomes.filter((o) => o.status === "succeeded").length;
  const failedSteps = stepOutcomes.filter((o) => o.status === "failed").length;

  return (
    <div className="space-y-3">
      {/* ─── Progress ─── */}
      <div className="p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
              {progress?.currentPhase ?? "Unknown phase"}
            </span>
            {stateDoc.updatedAt && (
              <span className="text-[9px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
                · {relativeWhen(stateDoc.updatedAt)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            <StatPill label="Steps" value={`${completed}/${total}`} />
            {succeededSteps > 0 && <StatPill label="Done" value={succeededSteps} color={COLORS.success} />}
            {failedSteps > 0 && <StatPill label="Failed" value={failedSteps} color={COLORS.danger} />}
            {modifiedFiles.length > 0 && <StatPill label="Files" value={modifiedFiles.length} />}
          </div>
        </div>

        {/* Progress bar */}
        {total > 0 && (
          <div className="mt-2" style={{ height: 4, background: COLORS.recessedBg, borderRadius: 2 }}>
            <div
              style={{
                width: `${progressPct}%`,
                height: "100%",
                background: failedSteps > 0 ? COLORS.danger : COLORS.accent,
                borderRadius: 2,
                transition: "width 200ms ease",
              }}
            />
          </div>
        )}
      </div>

      {/* ─── Pending Interventions (prominent) ─── */}
      {pendingInterventions.length > 0 && (
        <div
          className="px-3 py-2 space-y-1.5"
          style={{
            background: `${COLORS.warning}08`,
            borderLeft: `3px solid ${COLORS.warning}`,
          }}
        >
          <div className="flex items-center gap-1.5">
            <WarningCircle weight="bold" style={{ color: COLORS.warning, width: 13, height: 13 }} />
            <span className="text-[11px] font-semibold" style={{ color: COLORS.warning }}>
              {pendingInterventions.length} pending intervention{pendingInterventions.length !== 1 ? "s" : ""}
            </span>
          </div>
          {pendingInterventions.map((intervention) => (
            <div
              key={intervention.id}
              className="flex items-center justify-between gap-3 px-2 py-1.5"
              style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="px-1 py-0.5 text-[8px] font-bold uppercase shrink-0"
                  style={{
                    color: COLORS.warning,
                    border: `1px solid ${COLORS.warning}40`,
                    background: `${COLORS.warning}12`,
                    fontFamily: MONO_FONT,
                  }}
                >
                  {intervention.type.replace(/_/g, " ")}
                </span>
                <span className="text-[11px] truncate" style={{ color: COLORS.textPrimary }}>
                  {intervention.title}
                </span>
              </div>
              <span className="text-[9px] shrink-0" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
                {relativeWhen(intervention.createdAt)}
              </span>
              {onOpenIntervention ? (
                <button
                  type="button"
                  onClick={() => onOpenIntervention(intervention.id)}
                  className="shrink-0 px-2 py-1 text-[9px] font-bold uppercase tracking-[1px]"
                  style={{
                    color: COLORS.warning,
                    background: `${COLORS.warning}12`,
                    border: `1px solid ${COLORS.warning}35`,
                    fontFamily: MONO_FONT,
                  }}
                >
                  OPEN
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {/* ─── Active Issues ─── */}
      {activeIssues.length > 0 && (
        <div className="px-3 py-2 space-y-1" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
          <span className="text-[10px] font-semibold" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
            {activeIssues.length} active issue{activeIssues.length !== 1 ? "s" : ""}
          </span>
          {activeIssues.map((issue) => {
            const hex = ISSUE_HEX[issue.severity] ?? COLORS.textMuted;
            return (
              <div key={issue.id} className="flex items-start gap-2">
                <span
                  className="px-1 py-0.5 text-[8px] font-bold uppercase shrink-0 mt-0.5"
                  style={{ color: hex, border: `1px solid ${hex}40`, background: `${hex}12`, fontFamily: MONO_FONT }}
                >
                  {issue.severity}
                </span>
                <span className="text-[10px]" style={{ color: COLORS.textSecondary }}>{issue.description}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* ─── Collapsible Sections ─── */}
      <div className="space-y-0">
        {/* Step Outcomes */}
        {stepOutcomes.length > 0 && (
          <CollapsibleSection
            label={`Step outcomes (${stepOutcomes.length})`}
            open={showOutcomes}
            onToggle={() => setShowOutcomes((p) => !p)}
          >
            <div className="overflow-auto" style={{ maxHeight: 240, border: `1px solid ${COLORS.border}` }}>
              <table className="w-full text-[10px]" style={{ fontFamily: MONO_FONT }}>
                <thead style={{ background: COLORS.recessedBg, position: "sticky", top: 0 }}>
                  <tr>
                    <th className="px-2 py-1 text-left" style={{ color: COLORS.textDim, borderBottom: `1px solid ${COLORS.border}` }}>Step</th>
                    <th className="px-2 py-1 text-left" style={{ color: COLORS.textDim, borderBottom: `1px solid ${COLORS.border}` }}>Status</th>
                    <th className="px-2 py-1 text-left" style={{ color: COLORS.textDim, borderBottom: `1px solid ${COLORS.border}` }}>Summary</th>
                    <th className="px-2 py-1 text-left" style={{ color: COLORS.textDim, borderBottom: `1px solid ${COLORS.border}` }}>Validation</th>
                  </tr>
                </thead>
                <tbody>
                  {reversedOutcomes.map((outcome) => {
                    const statusHex = STATUS_HEX[outcome.status] ?? COLORS.textMuted;
                    const verdict = outcome.validation?.verdict ?? null;
                    const verdictHex = VERDICT_HEX[verdict ?? "none"] ?? COLORS.textMuted;
                    return (
                      <tr key={outcome.stepKey}>
                        <td className="px-2 py-1 align-top" style={{ color: COLORS.textPrimary, borderBottom: `1px solid ${COLORS.border}` }}>
                          {outcome.stepName}
                        </td>
                        <td className="px-2 py-1 align-top" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                          <span className="px-1 py-0.5 text-[8px] font-bold" style={{ color: statusHex, border: `1px solid ${statusHex}40`, background: `${statusHex}12` }}>
                            {outcome.status.replace(/_/g, " ").toUpperCase()}
                          </span>
                        </td>
                        <td className="px-2 py-1 align-top" style={{ color: COLORS.textSecondary, borderBottom: `1px solid ${COLORS.border}` }}>
                          {outcome.summary || "—"}
                        </td>
                        <td className="px-2 py-1 align-top" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                          <span className="px-1 py-0.5 text-[8px] font-bold" style={{ color: verdictHex, border: `1px solid ${verdictHex}40`, background: `${verdictHex}12` }}>
                            {verdict ? verdict.toUpperCase() : "—"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CollapsibleSection>
        )}

        {/* Recent Decisions */}
        {recentDecisions.length > 0 && (
          <CollapsibleSection
            label={`Recent decisions (${recentDecisions.length})`}
            open={showDecisions}
            onToggle={() => setShowDecisions((p) => !p)}
          >
            <div className="space-y-1 overflow-y-auto" style={{ maxHeight: 180 }}>
              {recentDecisions.map((decision, index) => (
                <div key={`${decision.timestamp}:${index}`} className="flex items-start gap-2 text-[10px]">
                  <span className="shrink-0" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
                    {relativeWhen(decision.timestamp)}
                  </span>
                  <div className="min-w-0">
                    <div style={{ color: COLORS.textPrimary }}>{decision.decision}</div>
                    {decision.rationale && (
                      <div style={{ color: COLORS.textDim }}>{decision.rationale}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* Finalization */}
        {finalization && (
          <CollapsibleSection
            label={`Finalization · ${finalization.status.replace(/_/g, " ")}`}
            open={showFinalization}
            onToggle={() => setShowFinalization((p) => !p)}
          >
            <div className="space-y-1.5 text-[10px]" style={{ fontFamily: MONO_FONT }}>
              <div className="flex items-center gap-2" style={{ color: COLORS.textSecondary }}>
                <span>{finalization.policy.kind}</span>
                <span style={{ color: finalization.contractSatisfied ? COLORS.success : COLORS.warning }}>
                  {finalization.contractSatisfied ? (
                    <><CheckCircle weight="fill" className="inline h-3 w-3 mr-0.5" style={{ color: COLORS.success }} />satisfied</>
                  ) : "open"}
                </span>
              </div>
              {finalization.summary && (
                <div style={{ color: COLORS.textPrimary }}>{finalization.summary}</div>
              )}
              {finalization.detail && (
                <div style={{ color: COLORS.textDim }}>{finalization.detail}</div>
              )}
              {finalization.blocked && finalization.blockedReason && (
                <div style={{ color: COLORS.warning }}>Blocked: {finalization.blockedReason}</div>
              )}
              {finalization.prUrls.length > 0 && finalization.prUrls.map((url) => (
                <div key={url} style={{ color: COLORS.accent }}>{url}</div>
              ))}
              {finalization.requirements.length > 0 && finalization.requirements.map((req) => (
                <div key={req.key} className="flex items-center justify-between gap-2">
                  <span style={{ color: COLORS.textSecondary }}>{req.label}</span>
                  <span style={{ color: req.status === "present" || req.status === "waived" ? COLORS.success : COLORS.warning }}>
                    {req.status.replace(/_/g, " ")}
                  </span>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* Modified Files */}
        {modifiedFiles.length > 0 && (
          <CollapsibleSection
            label={`Modified files (${modifiedFiles.length})`}
            open={showFiles}
            onToggle={() => setShowFiles((p) => !p)}
          >
            <div
              className="overflow-auto text-[10px] space-y-0.5 p-2"
              style={{ maxHeight: 120, background: COLORS.recessedBg, fontFamily: MONO_FONT, color: COLORS.textSecondary }}
            >
              {modifiedFiles.map((file) => (
                <div key={file}>{file}</div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {/* Coordinator */}
        {coordinatorAvailability && (
          <div className="flex items-center gap-2 py-1.5 text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
            <span>Coordinator: {coordinatorAvailability.available ? "available" : "offline"}</span>
            <span>· {coordinatorAvailability.mode.replace(/_/g, " ")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Collapsible Section ─── */

function CollapsibleSection({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ borderBottom: `1px solid ${COLORS.border}` }}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 py-2 text-[10px]"
        style={{ color: COLORS.textDim, fontFamily: MONO_FONT, background: "none", border: "none", cursor: "pointer", textAlign: "left" }}
      >
        {open ? <CaretDown weight="bold" className="h-2.5 w-2.5" /> : <CaretRight weight="bold" className="h-2.5 w-2.5" />}
        {label}
      </button>
      {open && <div className="pb-2">{children}</div>}
    </div>
  );
}
