import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CheckCircle,
  CircleDashed,
  CircleNotch,
  MinusCircle,
  XCircle,
} from "@phosphor-icons/react";

import type { PrActionRun, PrCheck, PrChecksStatus, PrRerunChecksTarget } from "../../../../shared/types/prs";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { PrSection, prSectionAction } from "./prSection";
import {
  buildUnifiedChecks,
  formatCheckDuration,
  isAttentionState,
  pipelineStateOf,
  summarizePipelineStates,
  type UnifiedCheckItem,
} from "./prUnifiedChecks";

/** Measured height of one check row, used to work out how many fit. */
const CHECKS_ROW_HEIGHT_PX = 26;
/** Never collapse below this, however short the pane gets. */
const CHECKS_MIN_VISIBLE_ROWS = 4;

export type PrChecksCardProps = {
  checks: PrCheck[];
  actionRuns: PrActionRun[];
  onSelectCheck?: (check: PrCheck) => void;
  onOpenChecksTab?: () => void;
  onRerunChecks?: (target?: PrRerunChecksTarget) => void;
  actionBusy?: boolean;
  /**
   * Growth-target mode for the right rail: the card takes the column's slack
   * (`flex-1 min-h-0`) and its list scrolls internally. Because a stretched card
   * with only the needs-attention rows would just be the old dead air with a
   * border, fill mode lists EVERY check (already ordered failure → running →
   * done by `buildUnifiedChecks`).
   */
  fill?: boolean;
  /**
   * Cap on how many rows (ghosts + checks, in that priority order) the list
   * renders. The remainder folds behind a "+N more" link to the CI tab, so a PR
   * with 37 jobs cannot turn a summary section into a second checks tab.
   * Omit for the uncapped list.
   */
  previewLimit?: number;
  /**
   * Grow the preview to fill the height the card is given, instead of holding a
   * fixed row count. The rail pins the merge box to the bottom and the checks
   * list is what absorbs the slack between them, so a fixed cap left a column of
   * dead air on a tall window while still claiming "+32 more".
   */
  autoFillPreview?: boolean;
  /**
   * ADE-135: required contexts that never reported on this commit, in the order
   * GitHub declared them. Rendered as dimmed placeholder rows in the same list
   * as the real checks so a job that is simply absent reads as an unfilled slot
   * rather than as nothing at all.
   */
  missingRequired?: readonly string[] | null;
  /**
   * The canonical rollup. The header used to derive its verdict from row counts
   * alone, which is producer-blind: on the ADE-135 payload it rendered a green
   * "3/3 passed" directly above the `required · not reported` ghost rows this
   * card had just been taught to show.
   */
  checksStatus?: PrChecksStatus | null;
};

type Bucket = "pass" | "fail" | "pending" | "skip";

/**
 * Display bucket for one row, derived from the single shared rollup
 * (`pipelineStateOf`) so this card can never disagree with the CI tab again.
 * `unknown` (completed, no conclusion) reads as needs-attention rather than
 * being silently hidden.
 */
function bucketOf(item: Pick<UnifiedCheckItem, "status" | "conclusion">): Bucket {
  switch (pipelineStateOf(item)) {
    case "passed":
      return "pass";
    case "failed":
    case "unknown":
      return "fail";
    case "running":
    case "queued":
      return "pending";
    default:
      return "skip";
  }
}

function toSyntheticCheck(item: UnifiedCheckItem): PrCheck {
  return {
    id: item.checkRunId,
    name: item.displayName,
    status: item.status,
    conclusion: item.conclusion,
    detailsUrl: item.detailsUrl,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
  };
}

function StatusGlyph({ bucket }: { bucket: Bucket }) {
  if (bucket === "fail") return <XCircle size={14} weight="fill" style={{ color: COLORS.danger, flexShrink: 0 }} />;
  if (bucket === "pending") {
    return <CircleNotch size={13} className="motion-safe:animate-spin" style={{ color: COLORS.info, flexShrink: 0 }} />;
  }
  if (bucket === "skip") return <MinusCircle size={14} weight="fill" style={{ color: COLORS.textDim, flexShrink: 0 }} />;
  return <CheckCircle size={14} weight="fill" style={{ color: COLORS.checkPass, flexShrink: 0 }} />;
}

const ICON_BTN =
  "inline-flex h-5 w-5 items-center justify-center rounded transition-colors";

export const PrChecksCard = memo(function PrChecksCard({
  checks,
  actionRuns,
  onSelectCheck,
  onOpenChecksTab,
  onRerunChecks,
  actionBusy = false,
  fill = false,
  previewLimit,
  autoFillPreview = false,
  missingRequired,
  checksStatus,
}: PrChecksCardProps) {
  // Order is meaningful (GitHub's declaration order), so this is never sorted.
  const ghosts = useMemo(() => missingRequired ?? [], [missingRequired]);
  const items = useMemo(() => buildUnifiedChecks(checks, actionRuns), [checks, actionRuns]);

  const { passing, failing, pending, total } = useMemo(() => {
    const buckets = summarizePipelineStates(items);
    return {
      passing: buckets.passed,
      failing: buckets.failed + buckets.unknown,
      pending: buckets.running + buckets.queued,
      total: buckets.total,
    };
  }, [items]);

  const attention = useMemo(
    () => (fill ? items : items.filter((item) => isAttentionState(pipelineStateOf(item)))),
    [items, fill],
  );

  // How many rows the body can actually show. Measured rather than guessed: the
  // rail's height depends on the window, the pane split, and how much the
  // sections above it are using.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [fittingRows, setFittingRows] = useState<number | null>(null);
  useEffect(() => {
    if (!autoFillPreview) { setFittingRows(null); return undefined; }
    const node = listRef.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? 0;
      const rows = Math.max(CHECKS_MIN_VISIBLE_ROWS, Math.floor(height / CHECKS_ROW_HEIGHT_PX));
      setFittingRows((prev) => (prev === rows ? prev : rows));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [autoFillPreview]);

  const effectiveLimit = autoFillPreview
    ? (fittingRows ?? previewLimit ?? null)
    : (previewLimit ?? null);

  // Ghosts spend the budget first: a required slot that never reported outranks
  // any result that did arrive, so it can never be the row that gets truncated
  // away.
  const { visibleGhosts, visibleItems, hiddenCount } = useMemo(() => {
    const limit = effectiveLimit != null && effectiveLimit > 0 ? effectiveLimit : null;
    if (limit == null) return { visibleGhosts: ghosts, visibleItems: attention, hiddenCount: 0 };
    const shownGhosts = ghosts.slice(0, limit);
    const shownItems = attention.slice(0, Math.max(0, limit - shownGhosts.length));
    return {
      visibleGhosts: shownGhosts,
      visibleItems: shownItems,
      hiddenCount: ghosts.length - shownGhosts.length + (attention.length - shownItems.length),
    };
  }, [ghosts, attention, effectiveLimit]);

  // `not_run` outranks the row tally: rows can all be green and still have
  // verified nothing.
  const notRun = checksStatus === "not_run";
  const summaryColor =
    total === 0 || notRun
      ? COLORS.textMuted
      : failing > 0
        ? COLORS.danger
        : pending > 0
          ? COLORS.info
          : COLORS.checkPass;

  const summaryText = notRun
    ? total === 0
      ? "No CI has run"
      : `No CI has run · ${total} check${total === 1 ? "" : "s"}`
    : total === 0
      ? "No checks yet"
      : `${passing}/${total} passed`;
  const headerBucket: Bucket =
    total === 0 || notRun ? "skip" : failing > 0 ? "fail" : pending > 0 ? "pending" : "pass";

  return (
    <PrSection
      icon={CheckCircle}
      title="Checks"
      // The rollup is a fact about the section, so it rides in `meta`. The glyph
      // repeats the verdict in shape, which keeps colour from being the only
      // signal for a failing or pending run.
      meta={
        <span className="inline-flex items-center gap-1.5">
          <StatusGlyph bucket={headerBucket} />
          <span style={{ color: summaryColor }}>{summaryText}</span>
        </span>
      }
      action={
        (total > 0 || ghosts.length > 0) && onOpenChecksTab ? (
          <button
            type="button"
            onClick={onOpenChecksTab}
            className="inline-flex items-center gap-1"
            style={prSectionAction()}
          >
            View all
            <ArrowSquareOut size={11} />
          </button>
        ) : null
      }
      // Fill mode is the right rail, where this section follows the people group
      // — so it carries the hairline that separates the two.
      divided={fill}
      scroll={fill}
      className={fill ? "flex-1 overflow-hidden" : undefined}
      bodyRef={listRef}
      data-testid="pr-checks-card"
    >
      {visibleItems.length > 0 || visibleGhosts.length > 0 ? (
        <div data-testid="pr-checks-card-list">
          {/* Ghosts lead the list: a slot that was never filled outranks the
              results that did arrive. */}
          {visibleGhosts.map((context) => (
            <div
              key={`missing:${context}`}
              className="flex items-center gap-2 py-1.5"
              data-testid="pr-checks-card-ghost-row"
            >
              <CircleDashed size={14} weight="bold" style={{ color: COLORS.textDim, flexShrink: 0 }} />
              <span
                className="min-w-0 flex-1 truncate text-[11px]"
                style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}
                title={`${context} is required but has not reported on this commit`}
              >
                {context}
              </span>
              <span
                className="text-[10px]"
                style={{ color: COLORS.textDim, fontFamily: SANS_FONT }}
              >
                required · not reported
              </span>
            </div>
          ))}
          {visibleItems.map((item) => {
            const bucket = bucketOf(item);
            const rerunTarget: PrRerunChecksTarget | null = item.source === "actions_job" && item.jobId != null
              ? { actionJobIds: [item.jobId] }
              : item.checkRunId != null
                ? { checkRunIds: [item.checkRunId] }
                : null;
            return (
              <div
                key={item.id}
                className="group/row flex items-center gap-2 py-1.5"
                data-testid="pr-checks-card-row"
              >
                <StatusGlyph bucket={bucket} />
                <span
                  className="min-w-0 flex-1 truncate text-[11px]"
                  style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}
                  title={item.displayName}
                >
                  {item.displayName}
                </span>
                {item.duration != null ? (
                  <span
                    className="text-[10px] transition-opacity group-hover/row:opacity-0"
                    style={{ color: COLORS.textDim, fontFamily: SANS_FONT }}
                  >
                    {formatCheckDuration(item.duration)}
                  </span>
                ) : null}
                <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100">
                  {bucket === "fail" && onRerunChecks && rerunTarget ? (
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => onRerunChecks(rerunTarget)}
                      className={ICON_BTN}
                      style={{ color: COLORS.textSecondary }}
                      title="Re-run failed checks"
                      aria-label={`Re-run ${item.displayName}`}
                    >
                      <ArrowClockwise size={12} />
                    </button>
                  ) : null}
                  {onSelectCheck ? (
                    <button
                      type="button"
                      onClick={() => onSelectCheck(toSyntheticCheck(item))}
                      className={ICON_BTN}
                      style={{ color: COLORS.textSecondary }}
                      title="View check"
                      aria-label={`View ${item.displayName}`}
                    >
                      <ArrowSquareOut size={12} />
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
          {hiddenCount > 0 ? (
            onOpenChecksTab ? (
              <button
                type="button"
                onClick={onOpenChecksTab}
                className="mt-1 text-left text-[11px]"
                style={prSectionAction()}
                data-testid="pr-checks-card-more"
              >
                +{hiddenCount} more
              </button>
            ) : (
              <span
                className="mt-1 block text-[11px]"
                style={{ color: COLORS.textDim, fontFamily: SANS_FONT }}
                data-testid="pr-checks-card-more"
              >
                +{hiddenCount} more
              </span>
            )
          ) : null}
        </div>
      ) : null}
    </PrSection>
  );
});

export default PrChecksCard;
