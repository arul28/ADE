import { memo, useMemo } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CheckCircle,
  CircleDashed,
  CircleNotch,
  MinusCircle,
  XCircle,
} from "@phosphor-icons/react";

import type { PrActionRun, PrCheck, PrRerunChecksTarget } from "../../../../shared/types/prs";
import { COLORS, SANS_FONT, floatingPane } from "../../lanes/laneDesignTokens";
import {
  buildUnifiedChecks,
  formatCheckDuration,
  isAttentionState,
  pipelineStateOf,
  summarizePipelineStates,
  type UnifiedCheckItem,
} from "./prUnifiedChecks";

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
   * ADE-135: required contexts that never reported on this commit, in the order
   * GitHub declared them. Rendered as dimmed placeholder rows in the same list
   * as the real checks so a job that is simply absent reads as an unfilled slot
   * rather than as nothing at all.
   */
  missingRequired?: readonly string[] | null;
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
  missingRequired,
}: PrChecksCardProps) {
  // Order is meaningful (GitHub's declaration order), so this is never sorted.
  const ghosts = missingRequired ?? [];
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

  const summaryColor =
    total === 0
      ? COLORS.textMuted
      : failing > 0
        ? COLORS.danger
        : pending > 0
          ? COLORS.info
          : COLORS.checkPass;

  const summaryText = total === 0 ? "No checks yet" : `${passing}/${total} passed`;
  const headerBucket: Bucket = total === 0 ? "skip" : failing > 0 ? "fail" : pending > 0 ? "pending" : "pass";

  return (
    <section
      style={floatingPane({ padding: 0, overflow: "hidden" })}
      className={fill ? "flex min-h-0 flex-1 flex-col overflow-hidden" : undefined}
      data-testid="pr-checks-card"
    >
      <div className={`group flex items-center gap-2 px-3 py-2.5${fill ? " shrink-0" : ""}`}>
        <StatusGlyph bucket={headerBucket} />
        <span className="text-[12px] font-medium" style={{ color: summaryColor, fontFamily: SANS_FONT }}>
          {summaryText}
        </span>
        {total > 0 && onOpenChecksTab ? (
          <button
            type="button"
            onClick={onOpenChecksTab}
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] opacity-0 transition-opacity group-hover:opacity-100"
            style={{ color: COLORS.textSecondary, fontFamily: SANS_FONT, background: COLORS.hoverBg }}
          >
            View
            <ArrowSquareOut size={11} />
          </button>
        ) : null}
      </div>

      {attention.length > 0 || ghosts.length > 0 ? (
        <div
          className={fill ? "min-h-0 flex-1 overflow-y-auto" : undefined}
          style={{ borderTop: `1px solid ${COLORS.border}` }}
          data-testid="pr-checks-card-list"
        >
          {/* Ghosts lead the list: a slot that was never filled outranks the
              results that did arrive. */}
          {ghosts.map((context) => (
            <div
              key={`missing:${context}`}
              className="flex items-center gap-2 px-3 py-1.5"
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
          {attention.map((item) => {
            const bucket = bucketOf(item);
            const rerunTarget: PrRerunChecksTarget | null = item.source === "actions_job" && item.jobId != null
              ? { actionJobIds: [item.jobId] }
              : item.checkRunId != null
                ? { checkRunIds: [item.checkRunId] }
                : null;
            return (
              <div
                key={item.id}
                className="group/row flex items-center gap-2 px-3 py-1.5"
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
        </div>
      ) : null}
    </section>
  );
});

export default PrChecksCard;
