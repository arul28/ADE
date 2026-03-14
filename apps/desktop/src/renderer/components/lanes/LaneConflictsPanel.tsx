import React from "react";
import { useNavigate } from "react-router-dom";
import type { ConflictOverlap, ConflictStatus } from "../../../shared/types";
import { EmptyState } from "../ui/EmptyState";
import { COLORS, LABEL_STYLE, MONO_FONT, inlineBadge, outlineButton, primaryButton } from "./laneDesignTokens";

function statusBadge(status: ConflictStatus["status"]): { label: string; color: string } {
  if (status === "conflict-active") return { label: "CONFLICT-ACTIVE", color: COLORS.danger };
  if (status === "conflict-predicted") return { label: "CONFLICT-PREDICTED", color: COLORS.warning };
  if (status === "behind-base") return { label: "BEHIND-BASE", color: COLORS.warning };
  if (status === "merge-ready") return { label: "MERGE-READY", color: COLORS.success };
  return { label: "UNKNOWN", color: COLORS.textMuted };
}

function riskColor(level: string): string {
  if (level === "high") return COLORS.danger;
  if (level === "medium") return COLORS.warning;
  if (level === "low") return COLORS.success;
  return COLORS.textMuted;
}

export function LaneConflictsPanel({ laneId }: { laneId: string | null }) {
  const navigate = useNavigate();
  const [status, setStatus] = React.useState<ConflictStatus | null>(null);
  const [overlaps, setOverlaps] = React.useState<ConflictOverlap[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    if (!laneId) return;
    setLoading(true);
    setError(null);
    try {
      const [s, o] = await Promise.all([
        window.ade.conflicts.getLaneStatus({ laneId }),
        window.ade.conflicts.listOverlaps({ laneId })
      ]);
      setStatus(s);
      setOverlaps(o);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus(null);
      setOverlaps([]);
    } finally {
      setLoading(false);
    }
  }, [laneId]);

  React.useEffect(() => {
    setStatus(null);
    setOverlaps([]);
    setError(null);
    if (!laneId) return;
    void refresh();
  }, [laneId, refresh]);

  if (!laneId) {
    return <EmptyState title="No lane selected" description="Select a lane to view its conflict status." />;
  }

  const badge = status ? statusBadge(status.status) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span style={LABEL_STYLE}>LANE CONFLICTS</span>
          {badge ? (
            <span style={inlineBadge(badge.color, { fontSize: 9 })}>{badge.label}</span>
          ) : (
            <span style={inlineBadge(COLORS.textMuted, { fontSize: 9 })}>{loading ? "LOADING..." : "UNKNOWN"}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" style={outlineButton({ height: 28, padding: "0 10px", fontSize: 10 })} onClick={() => void refresh()} disabled={loading}>
            REFRESH
          </button>
          <button
            type="button"
            style={primaryButton({ height: 28, padding: "0 10px", fontSize: 10 })}
            onClick={() => navigate(`/graph?focusLane=${encodeURIComponent(laneId)}`)}
          >
            OPEN GRAPH
          </button>
        </div>
      </div>

      {status ? (
        <div className="mt-2 grid grid-cols-3 gap-2" style={{ fontSize: 12 }}>
          <div style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, padding: 10 }}>
            <div style={LABEL_STYLE}>OVERLAPS</div>
            <div style={{
              fontFamily: MONO_FONT, fontSize: 13, fontWeight: 700, marginTop: 4,
              color: status.overlappingFileCount > 0 ? COLORS.warning : COLORS.textPrimary
            }}>
              {status.overlappingFileCount}
            </div>
          </div>
          <div style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, padding: 10 }}>
            <div style={LABEL_STYLE}>PEERS</div>
            <div style={{
              fontFamily: MONO_FONT, fontSize: 13, fontWeight: 700, marginTop: 4,
              color: status.peerConflictCount > 0 ? COLORS.danger : COLORS.textPrimary
            }}>
              {status.peerConflictCount}
            </div>
          </div>
          <div style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, padding: 10 }}>
            <div style={LABEL_STYLE}>PREDICTED</div>
            <div style={{ fontFamily: MONO_FONT, fontSize: 11, fontWeight: 700, marginTop: 4, color: COLORS.textPrimary }}>
              {status.lastPredictedAt ? new Date(status.lastPredictedAt).toLocaleString() : "---"}
            </div>
          </div>
        </div>
      ) : null}

      {error ? (
        <div style={{ marginTop: 8, background: `${COLORS.danger}15`, border: `1px solid ${COLORS.danger}30`, padding: 10, fontSize: 12, color: COLORS.danger }}>
          {error}
        </div>
      ) : null}

      <div
        className="mt-2 flex-1 min-h-0 overflow-auto"
        style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}
      >
        <div style={{ padding: "6px 12px", borderBottom: `1px solid ${COLORS.border}`, background: COLORS.cardBg }}>
          <span style={LABEL_STYLE}>OVERLAPS</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {overlaps.map((overlap) => {
            const rc = riskColor(overlap.riskLevel);
            return (
              <div
                key={overlap.peerId ?? "base"}
                style={{
                  padding: "10px 12px",
                  fontSize: 12,
                  borderBottom: `1px solid ${COLORS.border}`,
                  borderLeft: `3px solid ${rc}`,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate" style={{ fontWeight: 600, color: COLORS.textPrimary }}>{overlap.peerName}</div>
                    <div className="truncate" style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>
                      risk: <span style={{ color: rc }}>{overlap.riskLevel}</span> · files: {overlap.files.length}
                    </div>
                  </div>
                  <span style={inlineBadge(rc, { fontSize: 9 })}>{overlap.riskLevel.toUpperCase()}</span>
                </div>
                {overlap.files.length ? (
                  <div style={{ marginTop: 6, maxHeight: 120, overflow: "auto", background: COLORS.recessedBg, padding: 6 }}>
                    {overlap.files.slice(0, 12).map((file) => (
                      <div key={file.path} className="truncate" style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted, padding: "1px 0" }} title={file.path}>
                        {file.path}
                      </div>
                    ))}
                    {overlap.files.length > 12 ? (
                      <div style={{ fontSize: 11, color: COLORS.textDim, padding: "2px 0" }}>+{overlap.files.length - 12} more...</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          {!overlaps.length && !loading ? (
            <div style={{ padding: 12, textAlign: "center", fontSize: 12, color: COLORS.textDim, fontStyle: "italic" }}>No overlaps detected.</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
