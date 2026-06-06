import { memo, useMemo } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CheckCircle,
  CircleNotch,
  MinusCircle,
  XCircle,
} from "@phosphor-icons/react";

import type { PrActionRun, PrCheck } from "../../../../shared/types/prs";
import { COLORS, SANS_FONT, floatingPane } from "../../lanes/laneDesignTokens";
import { buildUnifiedChecks, formatCheckDuration, type UnifiedCheckItem } from "./prUnifiedChecks";

export type PrChecksCardProps = {
  checks: PrCheck[];
  actionRuns: PrActionRun[];
  onSelectCheck?: (check: PrCheck) => void;
  onOpenChecksTab?: () => void;
  onRerunChecks?: () => void;
  actionBusy?: boolean;
};

type Bucket = "pass" | "fail" | "pending" | "skip";

function bucketOf(item: UnifiedCheckItem): Bucket {
  if (item.status !== "completed") return "pending";
  if (item.conclusion === "success") return "pass";
  if (item.conclusion === "neutral" || item.conclusion === "skipped") return "skip";
  // failure / cancelled / action_required / timed_out / null → needs attention
  // (counted against "passed" and surfaced in the list, never silently hidden).
  return "fail";
}

function toSyntheticCheck(item: UnifiedCheckItem): PrCheck {
  return {
    name: item.displayName,
    status: item.status,
    conclusion: item.conclusion,
    detailsUrl: item.detailsUrl,
    startedAt: null,
    completedAt: null,
  };
}

function StatusGlyph({ bucket }: { bucket: Bucket }) {
  if (bucket === "fail") return <XCircle size={14} weight="fill" style={{ color: COLORS.danger, flexShrink: 0 }} />;
  if (bucket === "pending") {
    return <CircleNotch size={13} className="animate-spin" style={{ color: COLORS.info, flexShrink: 0 }} />;
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
}: PrChecksCardProps) {
  const items = useMemo(() => buildUnifiedChecks(checks, actionRuns), [checks, actionRuns]);

  const { passing, failing, pending, total } = useMemo(() => {
    let pass = 0;
    let fail = 0;
    let pend = 0;
    for (const item of items) {
      const b = bucketOf(item);
      if (b === "pass") pass += 1;
      else if (b === "fail") fail += 1;
      else if (b === "pending") pend += 1;
    }
    return { passing: pass, failing: fail, pending: pend, total: items.length };
  }, [items]);

  const attention = useMemo(
    () => items.filter((item) => {
      const b = bucketOf(item);
      return b === "fail" || b === "pending";
    }),
    [items],
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
    <section style={floatingPane({ padding: 0, overflow: "hidden" })} data-testid="pr-checks-card">
      <div className="group flex items-center gap-2 px-3 py-2.5">
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

      {attention.length > 0 ? (
        <div style={{ borderTop: `1px solid ${COLORS.border}` }}>
          {attention.map((item) => {
            const bucket = bucketOf(item);
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
                  {bucket === "fail" && onRerunChecks ? (
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={onRerunChecks}
                      className={ICON_BTN}
                      style={{ color: COLORS.textSecondary }}
                      title="Re-run failed checks"
                      aria-label={`Re-run ${item.displayName}`}
                    >
                      <ArrowClockwise size={12} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onSelectCheck?.(toSyntheticCheck(item))}
                    className={ICON_BTN}
                    style={{ color: COLORS.textSecondary }}
                    title="View check"
                    aria-label={`View ${item.displayName}`}
                  >
                    <ArrowSquareOut size={12} />
                  </button>
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
