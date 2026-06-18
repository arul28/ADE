import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  CaretDown,
  CheckCircle,
  Circle,
  CircleNotch,
  GitMerge,
  Prohibit,
  XCircle,
} from "@phosphor-icons/react";

import type {
  PrCheck,
  PrReview,
  PrStatus,
  PrWithConflicts,
  UpdateBranchStrategy,
} from "../../../../shared/types/prs";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { buildMergeChecklist, reviewStateForLogin, type MergeChecklistItem } from "./prMergeRailUtils";
import { PrUserAvatar } from "./PrUserAvatar";

export type PrMergeChecklistProps = {
  pr: PrWithConflicts;
  status: PrStatus | null;
  checks: PrCheck[];
  reviews: PrReview[];
  /** Inline update-branch action for the "behind base" row. */
  onUpdateBranch?: (strategy: UpdateBranchStrategy) => void;
  /** True while an update-branch call is in flight (disables the split button, shows progress). */
  updateBranchBusy?: boolean;
  /** Transient inline message rendered under the "behind" row (result toast / conflict notice). */
  updateBranchNotice?: { tone: "success" | "error"; text: string } | null;
};

const STATE_ICON = {
  pass: { Icon: CheckCircle, color: COLORS.success },
  fail: { Icon: XCircle, color: COLORS.danger },
  neutral: { Icon: Circle, color: COLORS.textMuted },
} as const;

/**
 * GitHub-style requirement checklist for the merge surface. Renders a header
 * pill (blocked / ready / actively-rechecking) plus a row per requirement.
 * The "behind base" row carries the inline Update-branch split button.
 */
export const PrMergeChecklist = memo(function PrMergeChecklist({
  pr,
  status,
  checks,
  reviews,
  onUpdateBranch,
  updateBranchBusy = false,
  updateBranchNotice = null,
}: PrMergeChecklistProps) {
  const items = buildMergeChecklist({ pr, status, checks, reviews });
  const computing = Boolean(status?.mergeabilityComputing);
  const mergeState = status?.mergeStateStatus ?? null;
  // Draft is read from the PR row itself so the header stays correct even when
  // the live GitHub merge box (mergeStateStatus) hasn't loaded yet.
  const isDraft = pr.state === "draft" || mergeState === "draft";
  const blocked = mergeState === "blocked" || mergeState === "behind" || mergeState === "dirty"
    || items.some((item) => item.state === "fail");
  // Without mergeStateStatus, fall back to the legacy boolean for the ready pill.
  const ready = !blocked && !isDraft && (mergeState
    ? mergeState === "clean" || mergeState === "has_hooks" || mergeState === "unstable"
    : Boolean(status?.isMergeable));

  // Approving-review avatars for the review row (parity with GitHub's merge box).
  const approvers = reviews
    .filter((review) => reviewStateForLogin(reviews, review.reviewer) === "approved")
    .filter((review, index, all) => all.findIndex((r) => r.reviewer === review.reviewer) === index)
    .slice(0, 5);

  return (
    <div data-testid="pr-merge-checklist" className="px-3 py-3">
      <ChecklistHeader computing={computing} isDraft={isDraft} blocked={blocked} ready={ready} />

      <div className="mt-2.5 flex flex-col gap-1.5">
        {items.map((item) => (
          <ChecklistRow
            key={item.id}
            item={item}
            approvers={item.id === "review" && item.state === "pass" ? approvers : []}
            behindRow={item.id === "behind" && item.state !== "pass" ? {
              onUpdateBranch,
              busy: updateBranchBusy,
              notice: updateBranchNotice,
            } : null}
          />
        ))}
      </div>
    </div>
  );
});

function ChecklistHeader({ computing, isDraft, blocked, ready }: { computing: boolean; isDraft: boolean; blocked: boolean; ready: boolean }) {
  if (computing) {
    // Actively-rechecking state — NOT a dead spinner. Pulsing pill + spinner so
    // the user can see ADE is still polling GitHub for the merge box.
    return (
      <div
        data-testid="pr-merge-checking"
        className="inline-flex animate-pulse items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
        style={{
          color: COLORS.info,
          background: "color-mix(in srgb, var(--color-info) 12%, transparent)",
          border: "1px solid color-mix(in srgb, var(--color-info) 26%, transparent)",
          fontFamily: SANS_FONT,
        }}
      >
        <CircleNotch size={13} weight="bold" className="animate-spin" />
        Checking mergeability…
      </div>
    );
  }
  if (isDraft) {
    // Draft isn't an error — it's a state. Muted pill, distinct from "blocked".
    return (
      <div
        data-testid="pr-merge-draft"
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
        style={{
          color: COLORS.textSecondary,
          background: COLORS.recessedBg,
          border: `1px solid ${COLORS.border}`,
          fontFamily: SANS_FONT,
        }}
      >
        <Circle size={13} weight="bold" />
        Draft — not ready to merge
      </div>
    );
  }
  if (blocked) {
    return (
      <div
        data-testid="pr-merge-blocked"
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
        style={{
          color: COLORS.danger,
          background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
          border: "1px solid color-mix(in srgb, var(--color-error) 28%, transparent)",
          fontFamily: SANS_FONT,
        }}
      >
        <Prohibit size={13} weight="fill" />
        Merging is blocked
      </div>
    );
  }
  if (ready) {
    return (
      <div
        data-testid="pr-merge-ready"
        className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
        style={{
          color: COLORS.success,
          background: "color-mix(in srgb, var(--color-success) 12%, transparent)",
          border: "1px solid color-mix(in srgb, var(--color-success) 28%, transparent)",
          fontFamily: SANS_FONT,
        }}
      >
        <CheckCircle size={13} weight="fill" />
        Ready to merge
      </div>
    );
  }
  return (
    <div
      className="inline-flex items-center gap-1.5 text-[11px]"
      style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}
    >
      Merge state unavailable
    </div>
  );
}

function ChecklistRow({
  item,
  approvers,
  behindRow,
}: {
  item: MergeChecklistItem;
  approvers: PrReview[];
  behindRow: {
    onUpdateBranch?: (strategy: UpdateBranchStrategy) => void;
    busy: boolean;
    notice: { tone: "success" | "error"; text: string } | null;
  } | null;
}) {
  const { Icon, color } = STATE_ICON[item.state];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Icon size={14} weight={item.state === "neutral" ? "regular" : "fill"} style={{ color, flexShrink: 0 }} />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium leading-tight" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}>
            {item.label}
          </div>
          {item.detail ? (
            <div className="text-[10px] leading-tight" style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}>
              {item.detail}
            </div>
          ) : null}
        </div>
        {approvers.length > 0 ? (
          <div className="flex shrink-0 items-center" style={{ marginRight: 2 }}>
            {approvers.map((review, index) => (
              <span
                key={review.reviewer}
                style={{ marginLeft: index === 0 ? 0 : -6, zIndex: approvers.length - index }}
                title={`${review.reviewer} approved`}
              >
                <PrUserAvatar user={{ login: review.reviewer, avatarUrl: review.reviewerAvatarUrl }} size={16} />
              </span>
            ))}
          </div>
        ) : null}
        {behindRow ? (
          <UpdateBranchSplitButton onUpdateBranch={behindRow.onUpdateBranch} busy={behindRow.busy} />
        ) : null}
      </div>
      {behindRow?.notice ? (
        <div
          data-testid="pr-merge-update-notice"
          className="ml-6 text-[10px] leading-snug"
          style={{
            color: behindRow.notice.tone === "error" ? COLORS.danger : COLORS.success,
            fontFamily: SANS_FONT,
          }}
        >
          {behindRow.notice.text}
        </div>
      ) : null}
    </div>
  );
}

function UpdateBranchSplitButton({
  onUpdateBranch,
  busy,
}: {
  onUpdateBranch?: (strategy: UpdateBranchStrategy) => void;
  busy: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [menuOpen]);

  const handlePick = useCallback(
    (strategy: UpdateBranchStrategy) => {
      setMenuOpen(false);
      onUpdateBranch?.(strategy);
    },
    [onUpdateBranch],
  );

  if (!onUpdateBranch) return null;

  return (
    <div className="relative flex shrink-0 items-stretch" ref={ref}>
      <button
        type="button"
        disabled={busy}
        onClick={() => handlePick("merge")}
        data-testid="pr-merge-update-branch"
        className="inline-flex h-6 items-center gap-1 rounded-l-md px-2 text-[10px] font-semibold"
        style={{
          color: COLORS.accent,
          background: "color-mix(in srgb, var(--color-accent) 10%, transparent)",
          border: `1px solid ${COLORS.accentBorder}`,
          opacity: busy ? 0.6 : 1,
          fontFamily: SANS_FONT,
        }}
      >
        {busy ? <CircleNotch size={11} weight="bold" className="animate-spin" /> : <GitMerge size={11} weight="bold" />}
        {busy ? "Updating…" : "Update branch"}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setMenuOpen((open) => !open)}
        aria-label="Choose update strategy"
        className="inline-flex w-5 items-center justify-center rounded-r-md"
        style={{
          color: COLORS.accent,
          background: "color-mix(in srgb, var(--color-accent) 10%, transparent)",
          borderTop: `1px solid ${COLORS.accentBorder}`,
          borderRight: `1px solid ${COLORS.accentBorder}`,
          borderBottom: `1px solid ${COLORS.accentBorder}`,
          borderLeft: "none",
          opacity: busy ? 0.6 : 1,
        }}
      >
        <CaretDown size={10} weight="bold" />
      </button>
      {menuOpen ? (
        <div
          className="absolute right-0 top-full z-30 mt-1 min-w-[200px] rounded-md py-1 shadow-lg"
          style={{ background: COLORS.cardBgSolid, border: `1px solid ${COLORS.outlineBorder}` }}
        >
          <button
            type="button"
            onClick={() => handlePick("merge")}
            className="block w-full px-3 py-2 text-left text-[11px]"
            style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, background: "transparent", border: "none", cursor: "pointer" }}
          >
            Update with merge commit
          </button>
          <button
            type="button"
            onClick={() => handlePick("rebase")}
            className="block w-full px-3 py-2 text-left text-[11px]"
            style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT, background: "transparent", border: "none", cursor: "pointer" }}
          >
            Update with rebase
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default PrMergeChecklist;
