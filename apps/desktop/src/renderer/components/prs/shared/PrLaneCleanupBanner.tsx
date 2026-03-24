import React from "react";
import { Archive, CheckCircle, GitBranch, Trash, Warning } from "@phosphor-icons/react";
import type { LaneSummary, PrSummary } from "../../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, cardStyle, inlineBadge, outlineButton, primaryButton } from "../../lanes/laneDesignTokens";

type PrLaneCleanupBannerProps = {
  pr: Pick<PrSummary, "state"> | null;
  lane: LaneSummary | null;
  actionBusy?: boolean;
  compact?: boolean;
  onNavigate: (path: string) => void;
};

export function PrLaneCleanupBanner({
  pr,
  lane,
  actionBusy = false,
  compact = false,
  onNavigate,
}: PrLaneCleanupBannerProps) {
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [deleteMode, setDeleteMode] = React.useState<"worktree" | "local_branch" | "remote_branch">("local_branch");
  const [remoteName, setRemoteName] = React.useState("origin");
  const [forceDelete, setForceDelete] = React.useState(false);
  const [confirmText, setConfirmText] = React.useState("");

  if (!pr || !lane) return null;
  if (pr.state !== "merged" && pr.state !== "closed") return null;
  if (lane.laneType === "primary") return null;

  const isAttached = lane.laneType === "attached";
  const deletePhrase = `delete ${lane.name}`;
  const confirmMatch = confirmText.trim().toLowerCase() === deletePhrase.toLowerCase();
  const isDisabled = busy || actionBusy;

  const shellPadding = compact ? "10px 12px" : "12px 16px";
  const bodyPadding = compact ? "12px 12px 14px" : "14px 16px";
  const titleSize = compact ? 12 : 13;
  const textSize = compact ? 11 : 12;

  const handleArchive = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.ade.lanes.archive({ laneId: lane.id });
      setDone("Lane archived successfully");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmMatch) return;
    setBusy(true);
    setError(null);
    try {
      await window.ade.lanes.delete({
        laneId: lane.id,
        deleteBranch: deleteMode !== "worktree",
        deleteRemoteBranch: deleteMode === "remote_branch",
        remoteName: remoteName.trim() || "origin",
        force: forceDelete,
      });
      setDone(
        deleteMode === "remote_branch" ? "Lane deleted with local + remote branches"
        : deleteMode === "local_branch" ? "Lane deleted with local branch"
        : "Lane worktree removed",
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div style={{ ...cardStyle({ padding: 0, overflow: "hidden" }), flexShrink: 0, borderColor: `${COLORS.success}30`, background: `${COLORS.success}08` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: shellPadding }}>
          <CheckCircle size={14} weight="fill" style={{ color: COLORS.success }} />
          <span style={{ fontFamily: SANS_FONT, fontSize: titleSize, color: COLORS.success }}>{done}</span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...cardStyle({ padding: 0, overflow: "hidden" }), flexShrink: 0, borderColor: pr.state === "merged" ? `${COLORS.success}25` : COLORS.border }}>
      <div style={{
        padding: shellPadding,
        borderBottom: `1px solid ${COLORS.border}`,
        background: pr.state === "merged" ? `${COLORS.success}06` : "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <GitBranch size={14} style={{ color: pr.state === "merged" ? COLORS.success : COLORS.textMuted, flexShrink: 0 }} />
          <span style={{ fontFamily: SANS_FONT, fontSize: titleSize, fontWeight: 600, color: COLORS.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Manage Lane: {lane.name}
          </span>
          <span style={inlineBadge(pr.state === "merged" ? COLORS.success : COLORS.textMuted, { padding: "1px 8px", fontSize: 10 })}>
            {pr.state === "merged" ? "PR merged" : "PR closed"}
          </span>
          {lane.status?.dirty ? (
            <span style={inlineBadge(COLORS.warning, { padding: "1px 8px", fontSize: 10 })}>dirty</span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => onNavigate(`/lanes?laneId=${encodeURIComponent(lane.id)}`)}
          style={{ ...outlineButton({ height: compact ? 24 : 26, padding: compact ? "0 8px" : "0 10px", fontSize: compact ? 10 : 11 }), color: COLORS.textMuted, flexShrink: 0 }}
        >
          View in Lanes
        </button>
      </div>

      <div style={{ padding: bodyPadding, display: "flex", flexDirection: "column", gap: compact ? 12 : 14 }}>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: textSize, fontFamily: MONO_FONT, color: COLORS.textSecondary }}>
          <span>Branch: <span style={{ color: COLORS.textPrimary }}>{lane.branchRef}</span></span>
          <span>Type: <span style={{ color: COLORS.textPrimary }}>{lane.laneType}</span></span>
        </div>

        <div style={{ display: "flex", alignItems: compact ? "flex-start" : "center", justifyContent: "space-between", gap: 12, padding: compact ? "10px 12px" : "10px 14px", background: `${COLORS.accent}06`, border: `1px solid ${COLORS.accent}18`, borderRadius: 8, flexDirection: compact ? "column" : "row" }}>
          <div>
            <div style={{ fontFamily: SANS_FONT, fontSize: titleSize, fontWeight: 600, color: COLORS.textPrimary }}>Archive</div>
            <div style={{ fontFamily: SANS_FONT, fontSize: textSize, color: COLORS.textMuted, marginTop: 2 }}>
              Hide from ADE without deleting worktree or branches
            </div>
          </div>
          <button type="button" disabled={isDisabled} onClick={() => void handleArchive()} style={outlineButton({ height: compact ? 30 : 32, padding: "0 16px", color: COLORS.accent, borderColor: `${COLORS.accent}40` })}>
            <Archive size={13} /> Archive
          </button>
        </div>

        <div style={{ padding: compact ? "12px" : "14px", background: `${COLORS.danger}06`, border: `1px solid ${COLORS.danger}18`, borderRadius: 8 }}>
          <div style={{ fontFamily: SANS_FONT, fontSize: titleSize, fontWeight: 600, color: COLORS.danger, marginBottom: 10 }}>
            {isAttached ? "Detach / Delete" : "Delete Lane"}
          </div>

          {lane.status?.dirty ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", marginBottom: 10, background: `${COLORS.warning}0A`, border: `1px solid ${COLORS.warning}20`, borderRadius: 6, fontSize: textSize, color: COLORS.warning, fontFamily: SANS_FONT }}>
              <Warning size={13} weight="fill" style={{ flexShrink: 0 }} />
              This lane has uncommitted changes.
            </div>
          ) : null}

          <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
            {([
              { value: "worktree" as const, label: isAttached ? "Detach only" : "Worktree only" },
              { value: "local_branch" as const, label: isAttached ? "Detach + local branch" : "+ local branch" },
              { value: "remote_branch" as const, label: isAttached ? "Detach + local + remote" : "+ local + remote" },
            ]).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setDeleteMode(opt.value)}
                style={{
                  padding: "8px 10px",
                  fontSize: textSize,
                  fontFamily: SANS_FONT,
                  background: deleteMode === opt.value ? `${COLORS.danger}14` : "rgba(255,255,255,0.03)",
                  border: `1px solid ${deleteMode === opt.value ? `${COLORS.danger}40` : COLORS.border}`,
                  borderRadius: 6,
                  cursor: "pointer",
                  textAlign: "left",
                  color: deleteMode === opt.value ? COLORS.danger : COLORS.textSecondary,
                  fontWeight: deleteMode === opt.value ? 600 : 400,
                  transition: "all 100ms ease",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {deleteMode === "remote_branch" ? (
            <div style={{ marginBottom: 10 }}>
              <label style={{ display: "block", fontSize: textSize, color: COLORS.textMuted, fontFamily: SANS_FONT, marginBottom: 4 }}>Remote name</label>
              <input
                value={remoteName}
                onChange={(e) => setRemoteName(e.target.value)}
                placeholder="origin"
                style={{
                  width: "100%",
                  height: 30,
                  padding: "0 10px",
                  fontSize: 12,
                  fontFamily: MONO_FONT,
                  background: "rgba(255,255,255,0.03)",
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 6,
                  color: COLORS.textPrimary,
                  outline: "none",
                }}
              />
            </div>
          ) : null}

          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: textSize, color: COLORS.textSecondary, fontFamily: SANS_FONT, cursor: "pointer" }}>
            <input type="checkbox" checked={forceDelete} onChange={(e) => setForceDelete(e.target.checked)} />
            Force delete (skip safety checks)
          </label>

          <div style={{ marginBottom: 10 }}>
            <label style={{ display: "block", fontSize: textSize, color: COLORS.textMuted, fontFamily: SANS_FONT, marginBottom: 4 }}>
              Type <span style={{ fontWeight: 600, color: COLORS.danger }}>{deletePhrase}</span> to confirm
            </label>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              style={{
                width: "100%",
                height: 30,
                padding: "0 10px",
                fontSize: 12,
                fontFamily: MONO_FONT,
                background: "rgba(255,255,255,0.03)",
                border: `1px solid ${confirmMatch ? `${COLORS.danger}60` : COLORS.border}`,
                borderRadius: 6,
                color: COLORS.textPrimary,
                outline: "none",
              }}
            />
          </div>

          {error ? (
            <div style={{ marginBottom: 10, padding: "8px 10px", background: `${COLORS.danger}0A`, border: `1px solid ${COLORS.danger}20`, borderRadius: 6, fontSize: textSize, color: COLORS.danger, fontFamily: SANS_FONT }}>
              {error}
            </div>
          ) : null}

          <button
            type="button"
            disabled={isDisabled || !confirmMatch}
            onClick={() => void handleDelete()}
            style={{
              ...primaryButton({ height: 32, padding: "0 20px", opacity: (isDisabled || !confirmMatch) ? 0.4 : 1 }),
              background: COLORS.danger,
            }}
          >
            <Trash size={13} /> {busy ? "Deleting..." : "Delete Lane"}
          </button>
        </div>
      </div>
    </div>
  );
}
