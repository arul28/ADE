import { memo } from "react";

import type { PrCheck } from "../../../../shared/types/prs";
import { COLORS } from "../../lanes/laneDesignTokens";
import { PrCommitRail, type PrCommitRailCommit } from "./PrCommitRail";
import { PrPushChecksRail } from "./PrPushChecksRail";

export type PrDetailLeftRailProps = {
  commits: PrCommitRailCommit[];
  activeSha: string | null;
  onSelectCommit: (sha: string) => void;
  checks: PrCheck[];
  onOpenLog: (check: PrCheck) => void;
  onSelectCheck?: (check: PrCheck) => void;
  onOpenChecksTab?: () => void;
};

export const PrDetailLeftRail = memo(function PrDetailLeftRail({
  commits,
  activeSha,
  onSelectCommit,
  checks,
  onOpenLog,
  onSelectCheck,
  onOpenChecksTab,
}: PrDetailLeftRailProps) {
  return (
    <div
      data-testid="pr-detail-left-rail"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
      style={{
        background: `linear-gradient(180deg, color-mix(in srgb, ${COLORS.accent} 5%, ${COLORS.cardBg}) 0%, ${COLORS.cardBg} 42%, color-mix(in srgb, ${COLORS.success} 4%, ${COLORS.cardBg}) 100%)`,
        borderRight: `1px solid ${COLORS.accentBorder}`,
        boxShadow: `inset -1px 0 0 color-mix(in srgb, ${COLORS.accent} 12%, transparent)`,
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PrCommitRail
          layout="pane"
          commits={commits}
          activeSha={activeSha}
          onSelectCommit={onSelectCommit}
        />
      </div>

      <div
        aria-hidden
        className="shrink-0"
        style={{
          height: 2,
          background: `linear-gradient(90deg, transparent 0%, ${COLORS.accent} 35%, ${COLORS.success} 65%, transparent 100%)`,
          opacity: 0.85,
        }}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PrPushChecksRail
          checks={checks}
          onOpenLog={onOpenLog}
          onSelectCheck={onSelectCheck}
          onOpenChecksTab={onOpenChecksTab}
        />
      </div>
    </div>
  );
});

export default PrDetailLeftRail;
