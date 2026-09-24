import React from "react";
import { Archive, Trash, Warning } from "@phosphor-icons/react";
import { LaneIcon } from "../../ui/vcsIcons";
import { Banner, NoticeBadge } from "../../ui/notice";
import type { LaneSummary, PrSummary } from "../../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton, primaryButton, dangerButton } from "../../lanes/laneDesignTokens";
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
      <Banner
        layout="inline"
        style={{ flexShrink: 0 }}
        model={{ id: `pr-lane-cleanup-done:${lane.id}`, tone: "success", title: done }}
      />
    );
  }

  if (isPrimaryBranchMismatch) {
    return (
      <Banner
        layout="inline"
        style={{ flexShrink: 0 }}
        model={{
          id: `pr-primary-branch-mismatch:${lane.id}`,
          tone: "warning",
          icon: <Warning size={14} weight="fill" />,
          title: "PR is linked to Primary, but its branch is separate",
          detail: "ADE will not delete the Primary lane. You can clean up the PR branch instead.",
          busy,
          error: error ?? undefined,
          extra: (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div><NoticeBadge tone="neutral">{pr.state}</NoticeBadge></div>
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
              <button type="button" disabled={isDisabled || !branchConfirmMatch || !pr.id} onClick={() => void handleBranchCleanup()} style={dangerButton({ height: compact ? 30 : 32, padding: "0 16px", opacity: isDisabled || !branchConfirmMatch || !pr.id ? 0.45 : 1 })}>
                <Trash size={13} /> Delete PR branch
              </button>
            </div>
          ),
        }}
      />
    );
  }

  if (lane.laneType === "primary") return null;

  return (
    <Banner
      layout="inline"
      style={{ flexShrink: 0 }}
      model={{
        id: `pr-lane-cleanup:${lane.id}`,
        tone: pr.state === "merged" ? "success" : "neutral",
        icon: <LaneIcon size={14} />,
        title: `Manage Lane: ${lane.name}`,
        detail: (
          <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <span>Branch: <span style={{ color: COLORS.textPrimary }}>{lane.branchRef}</span></span>
            <span>Type: <span style={{ color: COLORS.textPrimary }}>{lane.laneType}</span></span>
            <NoticeBadge tone={pr.state === "merged" ? "success" : "neutral"}>
              {pr.state === "merged" ? "PR merged" : "PR closed"}
            </NoticeBadge>
            {lane.status?.dirty ? <NoticeBadge tone="warning">dirty</NoticeBadge> : null}
          </span>
        ),
        actions: [{
          label: "View in Lanes",
          variant: "secondary",
          onClick: () => onNavigate(`/lanes?laneId=${encodeURIComponent(lane.id)}`),
        }],
        busy,
        extra: (
          <div style={{ display: "flex", flexDirection: "column", gap: compact ? 12 : 14 }}>
            <div style={{ display: "flex", alignItems: compact ? "flex-start" : "center", justifyContent: "space-between", gap: 12, flexDirection: compact ? "column" : "row" }}>
              <div>
                <div style={{ fontFamily: SANS_FONT, fontSize: compact ? 12 : 13, fontWeight: 600, color: COLORS.textPrimary }}>Archive</div>
                <div style={{ fontFamily: SANS_FONT, fontSize: textSize, color: COLORS.textMuted, marginTop: 2 }}>
                  Hide from ADE without deleting worktree or branches
                </div>
              </div>
              <button type="button" disabled={isDisabled} onClick={() => void handleArchive()} style={outlineButton({ height: compact ? 30 : 32, padding: "0 16px", color: COLORS.accent, borderColor: "color-mix(in srgb, var(--color-accent) 40%, transparent)" })}>
                <Archive size={13} /> Archive
              </button>
            </div>

            <div style={{ display: "flex", alignItems: compact ? "flex-start" : "center", justifyContent: "space-between", gap: 12, flexDirection: compact ? "column" : "row" }}>
              <div>
                <div style={{ fontFamily: SANS_FONT, fontSize: compact ? 12 : 13, fontWeight: 600, color: COLORS.danger }}>
                  Delete lane
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
        ),
      }}
    />
  );
}
