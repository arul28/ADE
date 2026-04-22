import type { AutoRebaseLaneStatus, LaneSummary, RebaseSuggestion } from "../../../shared/types";
import { COLORS, LABEL_STYLE, inlineBadge, outlineButton, primaryButton } from "./laneDesignTokens";
import { SmartTooltip } from "../ui/SmartTooltip";

export function LaneRebaseBanner({
  visibleRebaseSuggestions,
  visibleAutoRebaseNeedsAttention,
  lanesById,
  rebaseSuggestionError,
  onViewRebaseDetails,
  onDismissRebase,
  onDismissAutoRebase,
}: {
  visibleRebaseSuggestions: RebaseSuggestion[];
  visibleAutoRebaseNeedsAttention: AutoRebaseLaneStatus[];
  lanesById: Map<string, LaneSummary>;
  rebaseSuggestionError: string | null;
  onViewRebaseDetails: (laneId?: string | null) => void;
  onDismissRebase: (laneId: string) => void;
  onDismissAutoRebase: (laneId: string) => void;
}) {
  return (
    <>
      {visibleRebaseSuggestions.length > 0 ? (
        <div style={{ background: `${COLORS.warning}08`, borderBottom: `1px solid ${COLORS.border}`, padding: "8px 12px" }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span style={LABEL_STYLE}>REBASE SUGGESTED</span>
            <span style={inlineBadge(COLORS.warning, { fontSize: 9 })}>
              {visibleRebaseSuggestions.length} LANE{visibleRebaseSuggestions.length === 1 ? "" : "S"}
            </span>
          </div>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {visibleRebaseSuggestions.slice(0, 3).map((s) => {
              const lane = lanesById.get(s.laneId) ?? null;
              if (!lane) return null;
              return (
                <div
                  key={`rebase:${s.laneId}`}
                  style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, padding: 10 }}
                  className="flex flex-wrap items-start justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }} className="truncate">{lane.name}</span>
                      {s.hasPr ? <span style={inlineBadge(COLORS.info, { fontSize: 9 })}>PR</span> : null}
                      <span style={inlineBadge(COLORS.warning, { fontSize: 9 })}>{s.behindCount} BEHIND</span>
                    </div>
                    <div style={{ marginTop: 2, fontSize: 11, color: COLORS.textMuted }}>
                      Rebase this lane onto {s.baseLabel?.trim() || "parent branch"} to pick up new commits.
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <SmartTooltip content={{ label: "View in Rebase tab", description: "Open the Rebase tab for this lane." }}>
                      <button
                        type="button"
                        style={primaryButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                        onClick={() => onViewRebaseDetails(s.laneId)}
                      >
                        View in Rebase tab
                      </button>
                    </SmartTooltip>
                    <SmartTooltip content={{ label: "Dismiss", description: "Remove this rebase suggestion permanently until new parent commits arrive." }}>
                      <button
                        type="button"
                        style={outlineButton({ height: 24, padding: "0 6px", fontSize: 10 })}
                        onClick={() => onDismissRebase(s.laneId)}
                        title="Dismiss this rebase suggestion"
                      >
                        Dismiss
                      </button>
                    </SmartTooltip>
                  </div>
                </div>
              );
            })}
            {visibleRebaseSuggestions.length > 3 ? (
              <div style={{ fontSize: 11, color: COLORS.textMuted }}>+ {visibleRebaseSuggestions.length - 3} more suggestions.</div>
            ) : null}
          </div>
        </div>
      ) : null}

      {rebaseSuggestionError ? (
        <div style={{ background: `${COLORS.danger}15`, borderBottom: `1px solid ${COLORS.danger}30`, padding: "8px 12px", fontSize: 12, color: COLORS.danger }}>
          {rebaseSuggestionError}
        </div>
      ) : null}

      {visibleAutoRebaseNeedsAttention.length > 0 ? (
        <div style={{ background: `${COLORS.warning}08`, borderBottom: `1px solid ${COLORS.border}`, padding: "8px 12px" }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span style={LABEL_STYLE}>AUTO-REBASE NEEDS ATTENTION</span>
            <span style={inlineBadge(COLORS.warning, { fontSize: 9 })}>
              {visibleAutoRebaseNeedsAttention.length} LANE{visibleAutoRebaseNeedsAttention.length === 1 ? "" : "S"}
            </span>
          </div>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {visibleAutoRebaseNeedsAttention.slice(0, 3).map((status) => {
              const lane = lanesById.get(status.laneId) ?? null;
              if (!lane) return null;
              return (
                <div
                  key={`auto-rebase:${status.laneId}`}
                  style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, padding: 10 }}
                  className="flex flex-wrap items-start justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }} className="truncate">{lane.name}</span>
                      {status.state === "rebaseConflict" ? (
                        <span style={inlineBadge(COLORS.danger, { fontSize: 9 })}>CONFLICT</span>
                      ) : status.state === "rebaseFailed" ? (
                        <span style={inlineBadge(COLORS.danger, { fontSize: 9 })}>FAILED</span>
                      ) : (
                        <span style={inlineBadge(COLORS.warning, { fontSize: 9 })}>PENDING</span>
                      )}
                    </div>
                    <div style={{ marginTop: 2, fontSize: 11, color: COLORS.textMuted }}>
                      {status.message ?? "Manual rebase and publish may be required for this lane."}
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-1.5">
                    <SmartTooltip content={{ label: "View in Rebase tab", description: "Open the Rebase tab for this lane." }}>
                      <button
                        type="button"
                        style={primaryButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                        onClick={() => onViewRebaseDetails(status.laneId)}
                      >
                        View in Rebase tab
                      </button>
                    </SmartTooltip>
                    <SmartTooltip content={{ label: "Dismiss", description: "Hide this alert until the parent or base changes again." }}>
                      <button
                        type="button"
                        style={outlineButton({ height: 24, padding: "0 6px", fontSize: 10 })}
                        onClick={() => onDismissAutoRebase(status.laneId)}
                      >
                        Dismiss
                      </button>
                    </SmartTooltip>
                  </div>
                </div>
              );
            })}
            {visibleAutoRebaseNeedsAttention.length > 3 ? (
              <div style={{ fontSize: 11, color: COLORS.textMuted }}>+ {visibleAutoRebaseNeedsAttention.length - 3} more lanes.</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
