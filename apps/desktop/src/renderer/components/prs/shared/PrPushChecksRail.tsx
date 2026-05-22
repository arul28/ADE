import { memo, useMemo } from "react";
import { CheckCircle, Clock, WarningCircle } from "@phosphor-icons/react";

import type { PrCheck } from "../../../../shared/types/prs";
import { COLORS, MONO_FONT, inlineBadge } from "../../lanes/laneDesignTokens";
import { PrCheckList, summarizeChecks } from "./prCheckList";

export type PrPushChecksRailProps = {
  checks: PrCheck[];
  onOpenLog: (check: PrCheck) => void;
  onSelectCheck?: (check: PrCheck) => void;
  onOpenChecksTab?: () => void;
};

export const PrPushChecksRail = memo(function PrPushChecksRail({
  checks,
  onOpenLog,
  onSelectCheck,
  onOpenChecksTab,
}: PrPushChecksRailProps) {
  const summary = useMemo(() => summarizeChecks(checks), [checks]);

  return (
    <div
      data-testid="pr-push-checks-rail"
      className="flex min-h-0 flex-1 flex-col"
      style={{
        background: `color-mix(in srgb, ${COLORS.success} 4%, ${COLORS.cardBg})`,
      }}
    >
      <div
        className="flex shrink-0 flex-col gap-1 px-2.5 py-2"
        style={{
          borderBottom: `1px solid color-mix(in srgb, ${COLORS.success} 18%, ${COLORS.border})`,
          background: `linear-gradient(135deg, color-mix(in srgb, ${COLORS.success} 10%, transparent) 0%, color-mix(in srgb, ${COLORS.accent} 6%, transparent) 100%)`,
        }}
      >
        <div className="flex items-center gap-1.5">
          <CheckCircle size={12} weight="fill" style={{ color: COLORS.success }} />
          <span
            className="text-[9px] font-bold uppercase leading-tight tracking-[0.6px]"
            style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}
          >
            Checks after most recent push
          </span>
          <span
            className="ml-auto text-[10px]"
            style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}
          >
            {summary.total}
          </span>
        </div>
        {summary.total > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {summary.passing > 0 ? (
              <span style={inlineBadge(COLORS.success, { fontSize: 9, padding: "2px 6px" })}>
                {summary.passing} passed
              </span>
            ) : null}
            {summary.pending > 0 ? (
              <span
                style={{
                  ...inlineBadge(COLORS.warning, { fontSize: 9, padding: "2px 6px" }),
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                }}
              >
                <Clock size={9} weight="fill" />
                {summary.pending} pending
              </span>
            ) : null}
            {summary.failing > 0 ? (
              <span
                style={{
                  ...inlineBadge(COLORS.danger, { fontSize: 9, padding: "2px 6px" }),
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                }}
              >
                <WarningCircle size={9} weight="fill" />
                {summary.failing} failed
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <PrCheckList
          checks={checks}
          onOpenLog={onOpenLog}
          onSelectCheck={onSelectCheck}
          onOpenChecksTab={onOpenChecksTab}
          emptyMessage="No checks after the latest push yet."
        />
      </div>
    </div>
  );
});

export default PrPushChecksRail;
