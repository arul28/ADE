import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
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
import { PrSection, prFlatButton } from "./prSection";
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

/**
 * Readable floor for a checklist label that shares its row with an inline
 * action. Below this the row wraps and the button drops to its own line — the
 * label truncates, it never re-wraps into a four-line stack.
 */
const LABEL_MIN_PX = 120;

/**
 * Per-state glyph. The *shape* is the signal — a ring, a tick, a cross — so a
 * row still reads correctly with the colour stripped out (monochrome print,
 * colour-blind vision, a washed-out screen). Colour only reinforces it.
 */
const STATE_ICON = {
  pass: { Icon: CheckCircle, color: COLORS.success, label: "Passing" },
  fail: { Icon: XCircle, color: COLORS.danger, label: "Failing" },
  neutral: { Icon: Circle, color: COLORS.textMuted, label: "Pending" },
} as const;

/**
 * GitHub-style requirement checklist for the merge surface. A flat titled
 * section: a status line (blocked / ready / actively-rechecking) plus a row per
 * requirement. The "behind base" row carries the inline Update-branch split
 * button.
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
    <PrSection
      data-testid="pr-merge-checklist"
      icon={GitMerge}
      title="Merge requirements"
      className="px-3 py-3"
    >
      <ChecklistHeader computing={computing} isDraft={isDraft} blocked={blocked} ready={ready} />

      <div className="mt-2 flex flex-col gap-1.5">
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
    </PrSection>
  );
});

/**
 * The one-line verdict above the rows. Flat: a glyph and coloured text, no pill
 * fill and no border — the four states stay distinguishable by glyph alone
 * (spinner, ring, prohibit, tick).
 */
function ChecklistHeader({ computing, isDraft, blocked, ready }: { computing: boolean; isDraft: boolean; blocked: boolean; ready: boolean }) {
  if (computing) {
    // Actively-rechecking state — NOT a dead spinner. The glyph keeps spinning
    // so the user can see ADE is still polling GitHub for the merge box.
    return (
      <div
        data-testid="pr-merge-checking"
        className="inline-flex items-center gap-1.5 text-[11px] font-medium"
        style={{ color: COLORS.info, fontFamily: SANS_FONT }}
      >
        <CircleNotch size={13} weight="bold" className="animate-spin" />
        Checking mergeability…
      </div>
    );
  }
  if (isDraft) {
    // Draft isn't an error — it's a state. Muted tone, distinct from "blocked".
    return (
      <div
        data-testid="pr-merge-draft"
        className="inline-flex items-center gap-1.5 text-[11px] font-medium"
        style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT }}
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
        className="inline-flex items-center gap-1.5 text-[11px] font-medium"
        style={{ color: COLORS.danger, fontFamily: SANS_FONT }}
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
        className="inline-flex items-center gap-1.5 text-[11px] font-medium"
        style={{ color: COLORS.success, fontFamily: SANS_FONT }}
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
  const { Icon, color, label: stateLabel } = STATE_ICON[item.state];
  return (
    <div className="flex flex-col gap-1">
      {/* A row carrying an inline action wraps: the label keeps a readable floor
          (LABEL_MIN_PX) and the button drops to a second line indented under it,
          instead of squeezing the label into a four-line stack. */}
      <div className={`flex items-center gap-2${behindRow ? " flex-wrap" : ""}`}>
        <Icon
          size={14}
          weight={item.state === "neutral" ? "regular" : "fill"}
          style={{ color, flexShrink: 0 }}
          role="img"
          aria-label={stateLabel}
        />
        <div className="min-w-0 flex-1" style={behindRow ? { flex: "1 1 auto", minWidth: LABEL_MIN_PX } : undefined}>
          <div className="truncate text-[11px] font-medium leading-tight" style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }} title={item.label}>
            {item.label}
          </div>
          {item.detail ? (
            <div className="truncate text-[10px] leading-tight" style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }} title={item.detail}>
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
          <UpdateBranchSplitButton
            onUpdateBranch={behindRow.onUpdateBranch}
            busy={behindRow.busy}
            // Indent to the label's text column once the button has wrapped
            // (14px icon + 8px gap); harmless while it still sits inline.
            style={{ marginLeft: 22, marginTop: 5 }}
          />
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

/** Height the update-branch menu needs below its trigger before it flips up. */
const MENU_MIN_SPACE_PX = 96;

function UpdateBranchSplitButton({
  onUpdateBranch,
  busy,
  style,
}: {
  onUpdateBranch?: (strategy: UpdateBranchStrategy) => void;
  busy: boolean;
  style?: CSSProperties;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  /**
   * Which way the menu opens. The rail is pinned to the bottom of the pane, so a
   * menu that always dropped downward ran straight off the bottom of the window
   * — and the two items it hides are the only way to pick a strategy.
   *
   * Measured at open time rather than assumed: the rail moves as the pane
   * resizes, so a fixed direction is wrong half the time.
   */
  const [openUp, setOpenUp] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) { setOpenUp(false); return; }
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    // Room the menu needs below the trigger, including its own margin. If the
    // viewport cannot give it, flip up — and if neither side fits, prefer the
    // side with more room so it is clipped as little as possible.
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    setOpenUp(spaceBelow < MENU_MIN_SPACE_PX && spaceAbove > spaceBelow);
  }, [menuOpen]);

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
    <div className="relative flex shrink-0 items-stretch" style={style} ref={ref}>
      {/* Flat split control: one hairline outline shared across both halves, no
          tinted fill — the merge button is the only filled control on the pane. */}
      <button
        type="button"
        disabled={busy}
        onClick={() => handlePick("merge")}
        data-testid="pr-merge-update-branch"
        style={prFlatButton({
          tone: COLORS.accent,
          height: 24,
          gap: 4,
          padding: "0 8px",
          fontSize: 10,
          fontWeight: 600,
          borderTopRightRadius: 0,
          borderBottomRightRadius: 0,
          borderRight: "none",
          opacity: busy ? 0.6 : 1,
        })}
      >
        {busy ? <CircleNotch size={11} weight="bold" className="animate-spin" /> : <GitMerge size={11} weight="bold" />}
        {busy ? "Updating…" : "Update branch"}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setMenuOpen((open) => !open)}
        aria-label="Choose update strategy"
        style={prFlatButton({
          tone: COLORS.accent,
          height: 24,
          width: 20,
          padding: 0,
          borderTopLeftRadius: 0,
          borderBottomLeftRadius: 0,
          opacity: busy ? 0.6 : 1,
        })}
      >
        <CaretDown size={10} weight="bold" />
      </button>
      {menuOpen ? (
        <div
          className={`absolute right-0 z-30 min-w-[200px] rounded-md py-1 shadow-lg ${
            openUp ? "bottom-full mb-1" : "top-full mt-1"
          }`}
          style={{
            background: COLORS.cardBgSolid,
            border: `1px solid ${COLORS.outlineBorder}`,
            // Never taller than the room it has, whichever way it opened, so a
            // long menu scrolls inside the viewport instead of past its edge.
            maxHeight: `calc(100vh - ${MENU_MIN_SPACE_PX}px)`,
            overflowY: "auto",
          }}
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
