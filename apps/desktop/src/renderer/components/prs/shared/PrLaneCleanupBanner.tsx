import React from "react";
import { Archive, CheckCircle, Trash, Warning } from "@phosphor-icons/react";
import { LaneIcon } from "../../ui/vcsIcons";
import type { LaneSummary, PrSummary } from "../../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, cardStyle, inlineBadge, outlineButton, primaryButton, dangerButton } from "../../lanes/laneDesignTokens";
import { branchNameFromRef } from "./laneBranchTargets";

type PrLaneCleanupBannerProps = {
  pr: { id?: string | null; state: PrSummary["state"]; headBranch?: string | null; baseBranch?: string | null } | null;
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
  const [confirmText, setConfirmText] = React.useState("");

  if (!pr || !lane) return null;
  if (pr.state !== "merged" && pr.state !== "closed") return null;

  const prHeadBranch = branchNameFromRef(pr.headBranch);
  const laneBranch = branchNameFromRef(lane.branchRef);
  const isPrimaryBranchMismatch = lane.laneType === "primary" && prHeadBranch && prHeadBranch !== laneBranch;
  const cleanupPhrase = `delete ${prHeadBranch}`;
  const branchConfirmMatch = confirmText.trim().toLowerCase() === cleanupPhrase.toLowerCase();
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

  const handleBranchCleanup = async () => {
    if (!branchConfirmMatch || !prHeadBranch || !pr.id) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.ade.prs.cleanupBranch({
        prId: pr.id,
        deleteLocalBranch: deleteMode !== "remote_branch",
        deleteRemoteBranch: deleteMode !== "worktree",
        remoteName: remoteName.trim() || "origin",
      });
      const parts = [
        result.localDeleted ? "local branch deleted" : null,
        result.remoteDeleted ? "remote branch deleted" : null,
      ].filter(Boolean);
      if (result.localError || result.remoteError) {
        setError([result.localError, result.remoteError].filter(Boolean).join(" "));
      } else {
        setDone(parts.length ? parts.join(" + ") : "No matching branch found to delete");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Surface the shared success banner for every cleanup path — including the
  // primary-branch mismatch case below, which would otherwise stay stuck on
  // the confirmation form even after a successful delete.
  if (done) {
    return (
      <div style={{ ...cardStyle({ padding: 0, overflow: "hidden" }), flexShrink: 0, borderColor: "color-mix(in srgb, var(--color-success) 30%, transparent)", background: "color-mix(in srgb, var(--color-success) 8%, transparent)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: shellPadding }}>
          <CheckCircle size={14} weight="fill" style={{ color: COLORS.success }} />
          <span style={{ fontFamily: SANS_FONT, fontSize: titleSize, color: COLORS.success }}>{done}</span>
        </div>
      </div>
    );
  }

  if (isPrimaryBranchMismatch) {
    return (
      <div style={{ ...cardStyle({ padding: 0, overflow: "hidden" }), flexShrink: 0, borderColor: "color-mix(in srgb, var(--color-warning) 30%, transparent)" }}>
        <div style={{ padding: shellPadding, borderBottom: `1px solid ${COLORS.border}`, background: "color-mix(in srgb, var(--color-warning) 8%, transparent)", display: "flex", alignItems: "center", gap: 8 }}>
          <Warning size={14} weight="fill" style={{ color: COLORS.warning }} />
          <span style={{ fontFamily: SANS_FONT, fontSize: titleSize, fontWeight: 600, color: COLORS.textPrimary }}>
            PR is linked to Primary, but its branch is separate
          </span>
          <span style={inlineBadge(COLORS.warning, { padding: "1px 8px", fontSize: 10 })}>{pr.state}</span>
        </div>
        <div style={{ padding: bodyPadding, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontFamily: SANS_FONT, fontSize: textSize, color: COLORS.textMuted }}>
            ADE will not delete the Primary lane. You can clean up the PR branch instead.
          </div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: textSize, fontFamily: MONO_FONT, color: COLORS.textSecondary }}>
            <span>PR branch: <span style={{ color: COLORS.textPrimary }}>{prHeadBranch}</span></span>
            <span>Primary branch: <span style={{ color: COLORS.textPrimary }}>{laneBranch}</span></span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "1fr 1fr 1fr", gap: 8 }}>
            {([
              { value: "worktree" as const, label: "Local branch only" },
              { value: "remote_branch" as const, label: "Remote branch only" },
              { value: "local_branch" as const, label: "Local + remote" },
            ]).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setDeleteMode(opt.value)}
                style={{
                  padding: "8px 10px",
                  fontSize: textSize,
                  fontFamily: SANS_FONT,
                  background: deleteMode === opt.value ? "color-mix(in srgb, var(--color-error) 14%, transparent)" : "rgba(255,255,255,0.03)",
                  border: `1px solid ${deleteMode === opt.value ? "color-mix(in srgb, var(--color-error) 40%, transparent)" : COLORS.border}`,
                  borderRadius: 6,
                  cursor: "pointer",
                  textAlign: "left",
                  color: deleteMode === opt.value ? COLORS.danger : COLORS.textSecondary,
                  fontWeight: deleteMode === opt.value ? 600 : 400,
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {deleteMode !== "worktree" ? (
            <input
              type="text"
              value={remoteName}
              onChange={(e) => setRemoteName(e.target.value)}
              placeholder="Remote name"
              style={{ height: 30, padding: "0 10px", borderRadius: 6, border: `1px solid ${COLORS.border}`, background: COLORS.recessedBg, color: COLORS.textPrimary, fontFamily: MONO_FONT, fontSize: 11 }}
            />
          ) : null}
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={`Type "${cleanupPhrase}" to confirm`}
            style={{ height: 32, padding: "0 10px", borderRadius: 6, border: `1px solid ${branchConfirmMatch ? "color-mix(in srgb, var(--color-error) 60%, transparent)" : COLORS.border}`, background: COLORS.recessedBg, color: COLORS.textPrimary, fontFamily: MONO_FONT, fontSize: 11 }}
          />
          {error ? <div style={{ color: COLORS.danger, fontFamily: SANS_FONT, fontSize: textSize }}>{error}</div> : null}
          <button type="button" disabled={isDisabled || !branchConfirmMatch || !pr.id} onClick={() => void handleBranchCleanup()} style={dangerButton({ height: compact ? 30 : 32, padding: "0 16px", opacity: isDisabled || !branchConfirmMatch || !pr.id ? 0.45 : 1 })}>
            <Trash size={13} /> Delete PR branch
          </button>
        </div>
      </div>
    );
  }

  if (lane.laneType === "primary") return null;

  return (
    <div style={{ ...cardStyle({ padding: 0, overflow: "hidden" }), flexShrink: 0, borderColor: pr.state === "merged" ? "color-mix(in srgb, var(--color-success) 25%, transparent)" : COLORS.border }}>
      <div style={{
        padding: shellPadding,
        borderBottom: `1px solid ${COLORS.border}`,
        background: pr.state === "merged" ? "color-mix(in srgb, var(--color-success) 6%, transparent)" : "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <LaneIcon size={14} style={{ color: pr.state === "merged" ? COLORS.success : COLORS.textMuted, flexShrink: 0 }} />
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

        <div style={{ display: "flex", alignItems: compact ? "flex-start" : "center", justifyContent: "space-between", gap: 12, padding: compact ? "10px 12px" : "10px 14px", background: "color-mix(in srgb, var(--color-accent) 6%, transparent)", border: "1px solid color-mix(in srgb, var(--color-accent) 18%, transparent)", borderRadius: 8, flexDirection: compact ? "column" : "row" }}>
          <div>
            <div style={{ fontFamily: SANS_FONT, fontSize: titleSize, fontWeight: 600, color: COLORS.textPrimary }}>Archive</div>
            <div style={{ fontFamily: SANS_FONT, fontSize: textSize, color: COLORS.textMuted, marginTop: 2 }}>
              Hide from ADE without deleting worktree or branches
            </div>
          </div>
          <button type="button" disabled={isDisabled} onClick={() => void handleArchive()} style={outlineButton({ height: compact ? 30 : 32, padding: "0 16px", color: COLORS.accent, borderColor: "color-mix(in srgb, var(--color-accent) 40%, transparent)" })}>
            <Archive size={13} /> Archive
          </button>
        </div>

        <div style={{ display: "flex", alignItems: compact ? "flex-start" : "center", justifyContent: "space-between", gap: 12, padding: compact ? "10px 12px" : "10px 14px", background: "color-mix(in srgb, var(--color-error) 6%, transparent)", border: "1px solid color-mix(in srgb, var(--color-error) 18%, transparent)", borderRadius: 8, flexDirection: compact ? "column" : "row" }}>
          <div>
            <div style={{ fontFamily: SANS_FONT, fontSize: titleSize, fontWeight: 600, color: COLORS.danger }}>
              Delete Lane
            </div>
            <div style={{ fontFamily: SANS_FONT, fontSize: textSize, color: COLORS.textMuted, marginTop: 2 }}>
              Open the lane manager for a pre-flight check, scope picker, and live progress.
            </div>
          </div>
          <button
            type="button"
            disabled={isDisabled}
            onClick={() => onNavigate(`/lanes?laneId=${encodeURIComponent(lane.id)}&focus=single&action=manage`)}
            style={{
              ...primaryButton({ height: compact ? 30 : 32, padding: "0 16px", opacity: isDisabled ? 0.45 : 1 }),
              background: COLORS.danger,
            }}
          >
            <Trash size={13} /> Manage lane…
          </button>
        </div>
      </div>
    </div>
  );
}
