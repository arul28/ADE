import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  GitMerge,
  Trash,
  XCircle,
} from "@phosphor-icons/react";

import type {
  MergeMethod,
  PrCheck,
  PrCommit,
  PrReview,
  PrStatus,
  PrWithConflicts,
  UpdateBranchStrategy,
} from "../../../../shared/types/prs";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { canAttemptMerge } from "./prMergeRailUtils";
import { PrMergeChecklist } from "./PrMergeChecklist";
import { PrMergeDialog, type PrMergeDialogResult } from "./PrMergeDialog";

/** localStorage key for the remembered merge method (dialog default). */
const LAST_MERGE_METHOD_KEY = "ade:prs:lastMergeMethod";

function readLastMergeMethod(fallback: MergeMethod): MergeMethod {
  try {
    const raw = window.localStorage.getItem(LAST_MERGE_METHOD_KEY);
    if (raw === "squash" || raw === "merge" || raw === "rebase") return raw;
  } catch {
    // localStorage can be unavailable in private/test environments.
  }
  return fallback;
}

function writeLastMergeMethod(method: MergeMethod): void {
  try {
    window.localStorage.setItem(LAST_MERGE_METHOD_KEY, method);
  } catch {
    // ignore
  }
}

export type PrDetailMergeRailProps = {
  pr: PrWithConflicts;
  status: PrStatus | null;
  checks: PrCheck[];
  reviews: PrReview[];
  commits?: PrCommit[];
  mergeMethod: MergeMethod;
  actionBusy: boolean;
  onMerge: (method: MergeMethod, options?: {
    bypassRules?: boolean;
    commitTitle?: string;
    commitBody?: string;
    expectedHeadSha?: string;
  }) => void;
  onUpdateBranch?: (strategy: UpdateBranchStrategy) => void;
  updateBranchBusy?: boolean;
  updateBranchNotice?: { tone: "success" | "error"; text: string } | null;
  onDeleteBranch?: () => void;
  deleteBranchBusy?: boolean;
  onOpenManageLane?: () => void;
  onClose?: () => void;
  onReopen?: () => void;
};

export const PrDetailMergeRail = memo(function PrDetailMergeRail({
  pr,
  status,
  checks,
  reviews,
  commits = [],
  mergeMethod,
  actionBusy,
  onMerge,
  onUpdateBranch,
  updateBranchBusy = false,
  updateBranchNotice = null,
  onDeleteBranch,
  deleteBranchBusy = false,
  onOpenManageLane,
  onClose,
  onReopen,
}: PrDetailMergeRailProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [defaultMethod, setDefaultMethod] = useState<MergeMethod>(() => readLastMergeMethod(mergeMethod));
  const [deleteBranchArmed, setDeleteBranchArmed] = useState(false);
  const [closePrArmed, setClosePrArmed] = useState(false);
  const deleteBranchArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closePrArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleDeleteBranchClick = useCallback(() => {
    if (!onDeleteBranch) return;
    if (deleteBranchArmed) {
      if (deleteBranchArmTimer.current) clearTimeout(deleteBranchArmTimer.current);
      setDeleteBranchArmed(false);
      onDeleteBranch();
      return;
    }
    setDeleteBranchArmed(true);
    if (deleteBranchArmTimer.current) clearTimeout(deleteBranchArmTimer.current);
    deleteBranchArmTimer.current = setTimeout(() => setDeleteBranchArmed(false), 4000);
  }, [deleteBranchArmed, onDeleteBranch]);

  const handleClosePrClick = useCallback(() => {
    if (!onClose) return;
    if (closePrArmed) {
      if (closePrArmTimer.current) clearTimeout(closePrArmTimer.current);
      setClosePrArmed(false);
      onClose();
      return;
    }
    setClosePrArmed(true);
    if (closePrArmTimer.current) clearTimeout(closePrArmTimer.current);
    closePrArmTimer.current = setTimeout(() => setClosePrArmed(false), 4000);
  }, [closePrArmed, onClose]);

  useEffect(() => () => {
    if (deleteBranchArmTimer.current) clearTimeout(deleteBranchArmTimer.current);
    if (closePrArmTimer.current) clearTimeout(closePrArmTimer.current);
  }, []);

  useEffect(() => {
    setClosePrArmed(false);
  }, [pr.id]);

  const mergeEnabled = canAttemptMerge({ pr, status, bypassRules: false })
    || (Boolean(status?.canBypass) && status?.mergeStateStatus === "blocked");
  const isMerged = pr.state === "merged";
  const isClosed = pr.state === "closed";
  const isTerminal = isMerged || isClosed;

  const handleRailClick = useCallback(() => {
    if (!onOpenManageLane || !pr.laneId) return;
    onOpenManageLane();
  }, [onOpenManageLane, pr.laneId]);

  const handleMethodChange = useCallback((method: MergeMethod) => {
    setDefaultMethod(method);
    writeLastMergeMethod(method);
  }, []);

  const handleDialogMerge = useCallback(
    (result: PrMergeDialogResult) => {
      writeLastMergeMethod(result.method);
      setDefaultMethod(result.method);
      onMerge(result.method, {
        bypassRules: result.bypassRules,
        commitTitle: result.commitTitle,
        commitBody: result.commitBody,
        expectedHeadSha: result.expectedHeadSha,
      });
      setDialogOpen(false);
    },
    [onMerge],
  );

  if (isTerminal) {
    return (
      <div
        data-testid="pr-detail-merge-rail"
        className="w-full"
        style={{ background: "transparent" }}
      >
        <div className="shrink-0">
          {isMerged ? (
            <div
              className="px-3 py-2.5"
              style={{
                background: `color-mix(in srgb, ${COLORS.accent} 14%, var(--color-card))`,
                borderBottom: `1px solid color-mix(in srgb, ${COLORS.accent} 26%, transparent)`,
              }}
              data-testid="pr-merge-merged-banner"
            >
              <div className="flex items-start gap-2">
                <GitMerge size={15} weight="fill" style={{ color: COLORS.accent, marginTop: 1, flexShrink: 0 }} />
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold leading-snug" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
                    Merged and closed
                  </div>
                  <div className="mt-1 text-[10px] leading-snug" style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}>
                    <span className="font-mono">{pr.headBranch}</span> into <span className="font-mono">{pr.baseBranch}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div
              className="px-3 py-2.5"
              style={{ borderBottom: `1px solid ${COLORS.border}` }}
            >
              <div
                className="flex items-center gap-2 text-[11px]"
                style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}
              >
                <XCircle size={14} style={{ flexShrink: 0 }} />
                <span>This pull request is closed.</span>
              </div>
              {onReopen ? (
                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={onReopen}
                  className="mt-2 inline-flex h-7 w-full items-center justify-center gap-1.5 rounded-md text-[11px] font-medium"
                  style={{
                    color: COLORS.success,
                    background: "color-mix(in srgb, var(--color-success) 10%, transparent)",
                    border: "1px solid color-mix(in srgb, var(--color-success) 35%, transparent)",
                    opacity: actionBusy ? 0.6 : 1,
                    fontFamily: SANS_FONT,
                  }}
                >
                  Reopen pull request
                </button>
              ) : null}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 px-3 py-2">
            {onOpenManageLane && pr.laneId ? (
              <button
                type="button"
                onClick={handleRailClick}
                className="inline-flex h-7 items-center rounded-md px-2 text-[11px] font-medium"
                style={{
                  color: COLORS.accent,
                  background: "transparent",
                  border: "none",
                  fontFamily: SANS_FONT,
                  cursor: "pointer",
                }}
              >
                Manage lane
              </button>
            ) : (
              <span />
            )}
            {isMerged && onDeleteBranch ? (
              <button
                type="button"
                disabled={deleteBranchBusy}
                onClick={handleDeleteBranchClick}
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium"
                style={{
                  color: deleteBranchArmed ? COLORS.danger : COLORS.textPrimary,
                  background: COLORS.recessedBg,
                  border: `1px solid ${deleteBranchArmed ? COLORS.danger : COLORS.border}`,
                  opacity: deleteBranchBusy ? 0.6 : 1,
                  fontFamily: SANS_FONT,
                }}
              >
                <Trash size={12} />
                {deleteBranchBusy
                  ? "Deleting…"
                  : deleteBranchArmed
                    ? "Click again to confirm"
                    : "Delete branch"}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="pr-detail-merge-rail"
      className="flex w-full flex-col overflow-hidden"
      style={{ background: "transparent" }}
    >
      <div className="overflow-y-auto">
        <PrMergeChecklist
          pr={pr}
          status={status}
          checks={checks}
          reviews={reviews}
          onUpdateBranch={onUpdateBranch}
          updateBranchBusy={updateBranchBusy}
          updateBranchNotice={updateBranchNotice}
        />

        <div className="px-3 pb-3">
          <button
            type="button"
            disabled={!mergeEnabled || actionBusy}
            onClick={() => setDialogOpen(true)}
            className="inline-flex min-h-8 w-full items-center justify-center gap-1.5 rounded-md px-3 text-[11px] font-semibold"
            style={{
              color: mergeEnabled ? "#fff" : COLORS.textMuted,
              background: mergeEnabled
                ? `linear-gradient(135deg, ${COLORS.success} 0%, #16a34a 100%)`
                : COLORS.recessedBg,
              border: `1px solid ${mergeEnabled ? COLORS.success : COLORS.border}`,
              opacity: actionBusy ? 0.6 : 1,
              fontFamily: SANS_FONT,
            }}
            data-testid="pr-merge-open-dialog-button"
          >
            <GitMerge size={12} weight="bold" />
            {actionBusy ? "Merging…" : "Merge…"}
          </button>

          {onClose && pr.state === "open" ? (
            <button
              type="button"
              disabled={actionBusy}
              onClick={handleClosePrClick}
              className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md text-[11px] font-medium"
              style={{
                color: COLORS.danger,
                background: "color-mix(in srgb, var(--color-error) 8%, transparent)",
                border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
                opacity: actionBusy ? 0.6 : 1,
                fontFamily: SANS_FONT,
              }}
            >
              <XCircle size={12} />
              {closePrArmed ? "Click again to close PR" : "Close pull request"}
            </button>
          ) : null}
        </div>
      </div>

      <PrMergeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        pr={pr}
        status={status}
        commits={commits}
        defaultMethod={defaultMethod}
        actionBusy={actionBusy}
        onMerge={handleDialogMerge}
        onMethodChange={handleMethodChange}
      />
    </div>
  );
});

export default PrDetailMergeRail;
