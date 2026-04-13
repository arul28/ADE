import { Stack } from "@phosphor-icons/react";
import type { AutoRebaseLaneStatus, LaneSummary, RebaseSuggestion } from "../../../shared/types";
import { COLORS, LABEL_STYLE, inlineBadge, outlineButton, primaryButton } from "./laneDesignTokens";
import { SmartTooltip } from "../ui/SmartTooltip";

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
  onViewRebaseDetails: (laneId?: string | null) => void;
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
                Auto-rebase is off. Enable in Settings &gt; Lane Templates.
              </span>
              <SmartTooltip content={{ label: "Settings", description: "Open Lane Templates settings to enable auto-rebase for child lanes." }}>
                <button type="button" style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })} onClick={onOpenAutoRebaseSettings}>
                  SETTINGS
                </button>
              </SmartTooltip>
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
                      Rebase this lane onto {s.baseLabel?.trim() || "parent branch"} to pick up new commits.
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <SmartTooltip content={{ label: "Rebase", description: "Replay this lane's commits on top of the parent branch locally without pushing.", gitCommand: "git rebase <parent>", effect: `Rebase ${lane?.name ?? "lane"} onto ${s.baseLabel?.trim() || "parent"}` }}>
                      <button
                        type="button"
                        style={primaryButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                        disabled={Boolean(rebaseBusyLaneId)}
                        onClick={() => onRebaseNowLocal(s.laneId)}
                      >
                        <Stack size={12} />
                        {busy ? "Rebasing..." : "Rebase"}
                      </button>
                    </SmartTooltip>
                    <SmartTooltip content={{ label: "Rebase + Push", description: "Rebase onto parent and immediately push the rewritten branch to remote.", gitCommand: "git rebase <parent> && git push" }}>
                      <button
                        type="button"
                        style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                        disabled={Boolean(rebaseBusyLaneId)}
                        onClick={() => onRebaseAndPush(s.laneId)}
                      >
                        Rebase + Push
                      </button>
                    </SmartTooltip>
                    <SmartTooltip content={{ label: "Details", description: "View detailed rebase history including conflicts and timing." }}>
                      <button
                        type="button"
                        style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                        disabled={Boolean(rebaseBusyLaneId)}
                        onClick={() => onViewRebaseDetails(s.laneId)}
                      >
                        Details
                      </button>
                    </SmartTooltip>
                    <SmartTooltip content={{ label: "Defer", description: "Hide this suggestion for 1 hour. It will reappear after the deferral period." }}>
                      <button
                        type="button"
                        style={outlineButton({ height: 24, padding: "0 6px", fontSize: 10 })}
                        disabled={Boolean(rebaseBusyLaneId)}
                        onClick={() => onDeferRebase(s.laneId, 60)}
                        title="Defer this suggestion for 1 hour"
                      >
                        Defer
                      </button>
                    </SmartTooltip>
                    <SmartTooltip content={{ label: "Dismiss", description: "Remove this rebase suggestion permanently until new parent commits arrive." }}>
                      <button
                        type="button"
                        style={outlineButton({ height: 24, padding: "0 6px", fontSize: 10 })}
                        disabled={Boolean(rebaseBusyLaneId)}
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
            <SmartTooltip content={{ label: "Settings", description: "Open Lane Templates settings to enable auto-rebase for child lanes." }}>
              <button type="button" style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })} onClick={onOpenAutoRebaseSettings}>
                SETTINGS
              </button>
            </SmartTooltip>
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
                    {status.state === "rebaseConflict" ? (
                      <SmartTooltip content={{ label: "Resolve in Conflicts", description: "Open the conflict resolver to manually resolve rebase conflicts for this lane." }}>
                        <button
                          type="button"
                          style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                          onClick={() => onOpenRebaseConflictResolver(status.laneId, status.parentLaneId ?? lane.parentLaneId ?? null)}
                        >
                          RESOLVE IN CONFLICTS
                        </button>
                      </SmartTooltip>
                    ) : status.state === "rebaseFailed" ? (
                      <SmartTooltip content={{ label: "Open Rebase Tab", description: "Open the rebase tab to inspect failure details and retry the rebase." }}>
                        <button
                          type="button"
                          style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                          onClick={() => onViewRebaseDetails(status.laneId)}
                        >
                          OPEN REBASE TAB
                        </button>
                      </SmartTooltip>
                    ) : (
                      <SmartTooltip content={{ label: "Rebase Now", description: "Replay this lane's commits on top of the parent branch locally without pushing.", gitCommand: "git rebase <parent>" }}>
                        <button
                          type="button"
                          style={primaryButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                          onClick={() => onRebaseNowLocal(status.laneId)}
                        >
                          <Stack size={12} />
                          Rebase now (local only)
                        </button>
                      </SmartTooltip>
                    )}
                    <SmartTooltip content={{ label: status.state === "rebaseFailed" ? "Rebase Now" : "View Rebase Details", description: status.state === "rebaseFailed" ? "Retry the rebase operation for this lane." : "View detailed rebase history including conflicts and timing." }}>
                      <button
                        type="button"
                        style={outlineButton({ height: 24, padding: "0 8px", fontSize: 10 })}
                        onClick={() => (status.state === "rebaseFailed" ? onRebaseNowLocal(status.laneId) : onViewRebaseDetails(status.laneId))}
                      >
                        {status.state === "rebaseFailed" ? "REBASE NOW" : "VIEW REBASE DETAILS"}
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
