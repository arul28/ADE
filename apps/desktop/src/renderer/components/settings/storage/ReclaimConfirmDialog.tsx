import { X } from "@phosphor-icons/react";
import type { LaneReclaimRisk } from "../../../../shared/types";
import { COLORS, SANS_FONT, outlineButton, primaryButton } from "../../lanes/laneDesignTokens";
import { Banner } from "../../ui/notice";
import { StorageDialogFrame } from "./StorageCleanupDialog";
import { formatBytes } from "./storageView";

/**
 * Archive & reclaim one lane: keeps the lane, branch and chats, removes its
 * worktree. Typed confirmation, and a separate acknowledgement before
 * uncommitted changes are discarded.
 */
export function ReclaimConfirmDialog({
  risk,
  busy,
  value,
  discardDirtyConfirmed,
  onChange,
  onDiscardDirtyChange,
  onClose,
  onConfirm,
}: {
  risk: LaneReclaimRisk;
  busy: boolean;
  value: string;
  discardDirtyConfirmed: boolean;
  onChange: (value: string) => void;
  onDiscardDirtyChange: (checked: boolean) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const warnings = risk.blockedReasons;
  const blocked = warnings.some((reason) => reason.disposition === "blocked");
  const dirtyNotConfirmed = risk.dirty && !discardDirtyConfirmed;
  return (
    <StorageDialogFrame
      title={`Archive & reclaim ${risk.laneName}`}
      canClose={!busy}
      onClose={onClose}
      panelStyleOverride={{
        width: "min(560px, 100%)",
        padding: 20,
        boxShadow: "0 28px 90px rgba(0,0,0,0.55)",
        overflow: "visible",
      }}
    >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 15, color: COLORS.textPrimary }}>Archive & reclaim “{risk.laneName}”</h3>
            <p style={{ margin: "7px 0 0", fontFamily: SANS_FONT, fontSize: 11.5, lineHeight: 1.55, color: COLORS.textMuted }}>
              Keeps the lane, branch, chats, and metadata. Removes its local worktree and generated lane data.
              Restoring the lane recreates the worktree.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" style={{ ...outlineButton({ height: 30 }), width: 30, padding: 0 }}>
            <X size={14} />
          </button>
        </div>
        <div style={{ marginTop: 14, padding: 12, borderRadius: 9, border: `1px solid ${COLORS.borderMuted}`, background: COLORS.recessedBg }}>
          <div style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textPrimary }}>
            Estimated space: <strong>{formatBytes(risk.reclaimableBytes)}</strong>
          </div>
          <div style={{ marginTop: 4, fontFamily: SANS_FONT, fontSize: 10.5, color: COLORS.textMuted }}>
            Worktree {formatBytes(risk.worktreeBytes)} · generated data {formatBytes(risk.generatedBytes)}
          </div>
        </div>
        {warnings.length > 0 ? (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 7 }}>
            {warnings.map((warning) => (
              <Banner
                key={warning.code}
                layout="inline"
                model={{ id: `lane-reclaim-warning:${warning.code}`, tone: "warning", title: warning.message }}
              />
            ))}
          </div>
        ) : null}
        {risk.dirty ? (
          <label style={{ display: "flex", alignItems: "flex-start", gap: 9, marginTop: 14, color: COLORS.warning, fontFamily: SANS_FONT, fontSize: 11, lineHeight: 1.45 }}>
            <input
              type="checkbox"
              checked={discardDirtyConfirmed}
              disabled={busy}
              onChange={(event) => onDiscardDirtyChange(event.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>Discard uncommitted changes in this lane. These file changes cannot be restored.</span>
          </label>
        ) : null}
        <label style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 14 }}>
          <span style={{ fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textSecondary }}>
            Type <strong>RECLAIM</strong> to confirm
          </span>
          <input
            autoFocus
            value={value}
            onChange={(event) => onChange(event.target.value)}
            style={{ height: 36, borderRadius: 8, border: `1px solid ${COLORS.outlineBorder}`, background: COLORS.recessedBg, color: COLORS.textPrimary, padding: "0 10px", fontFamily: SANS_FONT }}
          />
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button type="button" onClick={onClose} disabled={busy} style={outlineButton()}>Cancel</button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || blocked || dirtyNotConfirmed || value !== "RECLAIM"}
            style={{ ...primaryButton(), opacity: busy || blocked || dirtyNotConfirmed || value !== "RECLAIM" ? 0.55 : 1 }}
          >
            {busy
              ? "Reclaiming…"
              : blocked
                ? "Cannot reclaim this folder"
                : dirtyNotConfirmed
                  ? "Confirm discarded changes"
                  : `Reclaim ${formatBytes(risk.reclaimableBytes)}`}
          </button>
        </div>
    </StorageDialogFrame>
  );
}
