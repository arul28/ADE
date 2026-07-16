import type { LaneSummary } from "../../../shared/types";
import {
  COLORS,
  LABEL_STYLE,
  MONO_FONT,
  outlineButton,
  primaryButton,
} from "./laneDesignTokens";

export function AdoptAttachedLaneConfirmDialog({
  open,
  lane,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  lane: LaneSummary | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
      <div style={{ width: "min(620px, 100%)", background: COLORS.cardBgSolid, backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 16, padding: 20 }}>
        <div style={{ ...LABEL_STYLE, color: COLORS.info }}>MOVE ATTACHED LANE</div>
        <div style={{ marginTop: 10, fontSize: 13, color: COLORS.textPrimary }}>
          Move <strong>{lane?.name ?? "this lane"}</strong> into <code>.ade/worktrees</code>.
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: COLORS.textSecondary, lineHeight: 1.5 }}>
          ADE uses <code>git worktree move</code>, so branch history and commits stay exactly the same.
        </div>
        {lane ? (
          <div style={{ marginTop: 10, padding: "8px 10px", background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, borderRadius: 12 }}>
            <div style={{ fontSize: 11, color: COLORS.textSecondary }}>Current path</div>
            <div className="truncate" style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textPrimary }}>
              {lane.worktreePath}
            </div>
          </div>
        ) : null}
        {error ? (
          <div style={{ marginTop: 10, padding: "8px 10px", background: "color-mix(in srgb, var(--color-error) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--color-error) 40%, transparent)", borderRadius: 8, color: "#FCA5A5", fontSize: 12 }}>
            {error}
          </div>
        ) : null}
        <div className="flex justify-end gap-2" style={{ marginTop: 12 }}>
          <button
            type="button"
            style={outlineButton({ height: 30, padding: "0 10px", fontSize: 10 })}
            disabled={busy}
            onClick={onCancel}
          >
            CANCEL
          </button>
          <button
            type="button"
            style={primaryButton({ height: 30, padding: "0 10px", fontSize: 10 })}
            disabled={busy || !lane}
            onClick={onConfirm}
          >
            {busy ? "MOVING..." : "MOVE TO .ADE"}
          </button>
        </div>
      </div>
    </div>
  );
}
