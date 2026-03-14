import { Stack } from "@phosphor-icons/react";
import type { AutoRebaseLaneStatus, LaneSummary, RebaseSuggestion } from "../../../shared/types";
import { COLORS, LABEL_STYLE, inlineBadge, outlineButton, primaryButton } from "./laneDesignTokens";

export function LaneRebaseBanner({
  visibleRebaseSuggestions,
  visibleAutoRebaseNeedsAttention,
  showAutoRebaseSettingsHint,
  lanesById,
  rebaseBusyLaneId,
  rebaseSuggestionError,
  onRebaseNowLocal,
  onRebaseAndPush,
  onViewRebaseDetails,
  onDismissRebase,
  onDeferRebase,
  onOpenAutoRebaseSettings,
  onOpenRebaseConflictResolver
}: {
  visibleRebaseSuggestions: RebaseSuggestion[];
  visibleAutoRebaseNeedsAttention: AutoRebaseLaneStatus[];
  showAutoRebaseSettingsHint: boolean;
  lanesById: Map<string, LaneSummary>;
  rebaseBusyLaneId: string | null;
  rebaseSuggestionError: string | null;
  onRebaseNowLocal: (laneId: string) => void;
  onRebaseAndPush: (laneId: string) => void;
  onViewRebaseDetails: () => void;
  onDismissRebase: (laneId: string) => void;
  onDeferRebase: (laneId: string, minutes: number) => void;
  onOpenAutoRebaseSettings: () => void;
  onOpenRebaseConflictResolver: (laneId: string, parentLaneId: string | null) => void;
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
          {showAutoRebaseSettingsHint ? (
            <div
              style={{
                marginTop: 8,
                background: `${COLORS.info}10`,
                border: `1px solid ${COLORS.info}30`,
                padding: "8px 10px",
              }}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <span style={{ fontSize: 12, color: COLORS.info }}>
                Auto-rebase is off. Enable it in Settings {" > "} Lane Templates to auto-rebase child lanes after parent updates.
              </span>
              <button type="button" style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })} onClick={onOpenAutoRebaseSettings}>
                SETTINGS
              </button>
            </div>
          ) : null}
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {visibleRebaseSuggestions.slice(0, 3).map((s) => {
              const lane = lanesById.get(s.laneId) ?? null;
              if (!lane) return null;
              const busy = rebaseBusyLaneId === s.laneId;
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
                      Rebase this lane onto its parent to pick up new commits.
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                      disabled={Boolean(rebaseBusyLaneId)}
                      onClick={() => onDeferRebase(s.laneId, 60)}
                    >
                      Defer 1 hour
                    </button>
                    <button
                      type="button"
                      style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                      disabled={Boolean(rebaseBusyLaneId)}
                      onClick={() => onDismissRebase(s.laneId)}
                    >
                      Dismiss
                    </button>
                    <button
                      type="button"
                      style={primaryButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                      disabled={Boolean(rebaseBusyLaneId)}
                      onClick={() => onRebaseNowLocal(s.laneId)}
                    >
                      <Stack size={12} />
                      {busy ? "Rebasing..." : "Rebase now (local only)"}
                    </button>
                    <button
                      type="button"
                      style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                      disabled={Boolean(rebaseBusyLaneId)}
                      onClick={() => onRebaseAndPush(s.laneId)}
                    >
                      Rebase and push (local + remote)
                    </button>
                    <button
                      type="button"
                      style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                      disabled={Boolean(rebaseBusyLaneId)}
                      onClick={onViewRebaseDetails}
                    >
                      View rebase details
                    </button>
                  </div>
                </div>
              );
            })}
            {visibleRebaseSuggestions.length > 3 ? (
              <div style={{ fontSize: 11, color: COLORS.textMuted }}>+ {visibleRebaseSuggestions.length - 3} more suggestions.</div>
            ) : null}
            {rebaseSuggestionError ? (
              <div style={{ background: `${COLORS.danger}15`, border: `1px solid ${COLORS.danger}30`, padding: 8, fontSize: 12, color: COLORS.danger }}>
                {rebaseSuggestionError}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {showAutoRebaseSettingsHint && visibleRebaseSuggestions.length === 0 ? (
        <div style={{ background: `${COLORS.info}08`, borderBottom: `1px solid ${COLORS.border}`, padding: "8px 12px" }}>
          <div
            className="flex flex-wrap items-center justify-between gap-2"
            style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.info}30`, padding: "8px 10px" }}
          >
            <span style={{ fontSize: 12, color: COLORS.info }}>
              Auto-rebase is off. Enable it in Settings {" > "} Lane Templates to auto-rebase child lanes after parent updates.
            </span>
            <button type="button" style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })} onClick={onOpenAutoRebaseSettings}>
              SETTINGS
            </button>
          </div>
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
                      ) : (
                        <span style={inlineBadge(COLORS.warning, { fontSize: 9 })}>PENDING</span>
                      )}
                    </div>
                    <div style={{ marginTop: 2, fontSize: 11, color: COLORS.textMuted }}>
                      {status.message ?? "Manual rebase and publish may be required for this lane."}
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-1.5">
                    {status.state === "rebaseConflict" ? (
                      <button
                        type="button"
                        style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                        onClick={() => onOpenRebaseConflictResolver(status.laneId, status.parentLaneId ?? lane.parentLaneId ?? null)}
                      >
                        RESOLVE IN CONFLICTS
                      </button>
                    ) : (
                      <button
                        type="button"
                        style={primaryButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                        onClick={() => onRebaseNowLocal(status.laneId)}
                      >
                        <Stack size={12} />
                        Rebase now (local only)
                      </button>
                    )}
                    <button
                      type="button"
                      style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                      onClick={onViewRebaseDetails}
                    >
                      View rebase details
                    </button>
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
