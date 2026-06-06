import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaretDown,
  CheckCircle,
  GitMerge,
  Terminal,
  Trash,
  Warning,
  XCircle,
} from "@phosphor-icons/react";

import type { MergeMethod, PrCheck, PrReview, PrStatus, PrWithConflicts } from "../../../../shared/types/prs";
import { COLORS, MONO_FONT, SANS_FONT } from "../../lanes/laneDesignTokens";
import {
  buildMergeCommandLineInstructions,
  canAttemptMerge,
  deriveMergeBlockers,
  mergeMethodLabel,
  mergeMethodShortLabel,
} from "./prMergeRailUtils";

export type PrDetailMergeRailProps = {
  pr: PrWithConflicts;
  status: PrStatus | null;
  checks: PrCheck[];
  reviews: PrReview[];
  mergeMethod: MergeMethod;
  actionBusy: boolean;
  onMerge: (method: MergeMethod, options?: { bypassRules?: boolean }) => void;
  onDeleteBranch?: () => void;
  deleteBranchBusy?: boolean;
  onOpenManageLane?: () => void;
  onClose?: () => void;
  onReopen?: () => void;
};

const MERGE_METHODS: MergeMethod[] = ["squash", "merge", "rebase"];

export const PrDetailMergeRail = memo(function PrDetailMergeRail({
  pr,
  status,
  checks,
  reviews,
  mergeMethod,
  actionBusy,
  onMerge,
  onDeleteBranch,
  deleteBranchBusy = false,
  onOpenManageLane,
  onClose,
  onReopen,
}: PrDetailMergeRailProps) {
  const [localMergeMethod, setLocalMergeMethod] = useState<MergeMethod>(mergeMethod);
  const [bypassRules, setBypassRules] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showCliInstructions, setShowCliInstructions] = useState(false);
  const [deleteBranchArmed, setDeleteBranchArmed] = useState(false);
  const [closePrArmed, setClosePrArmed] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
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

  useEffect(() => {
    setLocalMergeMethod(mergeMethod);
  }, [mergeMethod]);

  const blockers = useMemo(
    () => deriveMergeBlockers({ pr, status, checks, reviews }),
    [pr, status, checks, reviews],
  );
  const mergeEnabled = canAttemptMerge({ pr, status, bypassRules });
  const isMerged = pr.state === "merged";
  const isClosed = pr.state === "closed";
  const isTerminal = isMerged || isClosed;
  const showBypass = !isMerged && !isClosed && pr.state !== "draft" && Boolean(status) && !status?.isMergeable && !status?.mergeConflicts;

  const handleRailClick = useCallback(() => {
    if (!onOpenManageLane || !pr.laneId) return;
    onOpenManageLane();
  }, [onOpenManageLane, pr.laneId]);

  useEffect(() => {
    if (!showBypass) setBypassRules(false);
  }, [showBypass]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [menuOpen]);

  const cliInstructions = buildMergeCommandLineInstructions({
    repoOwner: pr.repoOwner,
    repoName: pr.repoName,
    prNumber: pr.githubPrNumber,
    method: localMergeMethod,
    bypassRules,
  });

  const handleMerge = useCallback(() => {
    if (!mergeEnabled || actionBusy) return;
    onMerge(localMergeMethod, { bypassRules });
  }, [actionBusy, bypassRules, localMergeMethod, mergeEnabled, onMerge]);

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

        <div className="px-3 py-3">
          {blockers.length > 0 ? (
              <div data-testid="pr-merge-blocked">
                <div className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: COLORS.danger, fontFamily: SANS_FONT }}>
                  <Warning size={14} weight="fill" />
                  Merging is blocked
                </div>
                <ul className="flex list-disc flex-col gap-1 pl-4">
                  {blockers.map((blocker) => (
                    <li key={blocker.id} className="text-[11px]" style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT }}>
                      {blocker.label}
                    </li>
                  ))}
                </ul>
              </div>
            ) : status?.isMergeable ? (
              <div className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: COLORS.success, fontFamily: SANS_FONT }}>
                <CheckCircle size={14} weight="fill" />
                Ready to merge
              </div>
            ) : (
              <div className="text-[12px]" style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}>
                Checking mergeability…
              </div>
            )}

            {showBypass ? (
              <label className="mt-3 flex items-start gap-2 text-[11px]" style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, lineHeight: 1.45 }}>
                <input
                  type="checkbox"
                  checked={bypassRules}
                  disabled={actionBusy}
                  onChange={(event) => setBypassRules(event.target.checked)}
                  className="mt-0.5"
                  style={{ accentColor: COLORS.warning }}
                />
                Merge without waiting for requirements to be met (bypass rules)
              </label>
            ) : null}

            <div className="relative mt-3 flex items-stretch gap-1" ref={menuRef}>
              <button
                type="button"
                disabled={!mergeEnabled || actionBusy}
                onClick={handleMerge}
                className="inline-flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-l-md px-3 text-[11px] font-semibold"
                style={{
                  color: mergeEnabled ? "#fff" : COLORS.textMuted,
                  background: mergeEnabled
                    ? `linear-gradient(135deg, ${COLORS.success} 0%, #16a34a 100%)`
                    : COLORS.recessedBg,
                  border: `1px solid ${mergeEnabled ? COLORS.success : COLORS.border}`,
                  opacity: actionBusy ? 0.6 : 1,
                }}
                data-testid="pr-merge-primary-button"
              >
                <GitMerge size={12} weight="bold" />
                {actionBusy ? "Merging..." : mergeMethodLabel(localMergeMethod)}
              </button>
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => setMenuOpen((open) => !open)}
                aria-label="Choose merge method"
                className="inline-flex w-8 items-center justify-center rounded-r-md"
                style={{
                  color: mergeEnabled ? "#fff" : COLORS.textMuted,
                  background: mergeEnabled ? COLORS.success : COLORS.recessedBg,
                  borderTop: `1px solid ${mergeEnabled ? COLORS.success : COLORS.border}`,
                  borderRight: `1px solid ${mergeEnabled ? COLORS.success : COLORS.border}`,
                  borderBottom: `1px solid ${mergeEnabled ? COLORS.success : COLORS.border}`,
                  borderLeft: "none",
                }}
              >
                <CaretDown size={12} weight="bold" />
              </button>
              {menuOpen ? (
                <div
                  className="absolute right-0 bottom-full z-20 mb-1 min-w-[180px] rounded-md py-1 shadow-lg"
                  style={{
                    background: COLORS.cardBgSolid,
                    border: `1px solid ${COLORS.outlineBorder}`,
                  }}
                >
                  {MERGE_METHODS.map((method) => (
                    <button
                      key={method}
                      type="button"
                      onClick={() => {
                        setLocalMergeMethod(method);
                        setMenuOpen(false);
                      }}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-[11px]"
                      style={{
                        color: localMergeMethod === method ? COLORS.accent : COLORS.textPrimary,
                        fontFamily: SANS_FONT,
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      {mergeMethodLabel(method)}
                      <span style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>{mergeMethodShortLabel(method)}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

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

            <button
              type="button"
              onClick={() => setShowCliInstructions((open) => !open)}
              className="mt-2 inline-flex items-center gap-1 text-[11px]"
              style={{ color: COLORS.accent, fontFamily: SANS_FONT, background: "none", border: "none", cursor: "pointer" }}
            >
              <Terminal size={12} />
              View command line instructions
            </button>
            {showCliInstructions ? (
              <pre
                className="mt-2 overflow-x-auto rounded-md px-2.5 py-2 text-[10px]"
                style={{
                  fontFamily: MONO_FONT,
                  color: COLORS.textSecondary,
                  background: COLORS.recessedBg,
                  border: `1px solid ${COLORS.border}`,
                }}
              >
                {cliInstructions}
              </pre>
            ) : null}
        </div>
      </div>
    </div>
  );
});

export default PrDetailMergeRail;
