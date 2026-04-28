import { memo, useCallback, useMemo, useState, type CSSProperties } from "react";
import { ArrowClockwise, Sparkle, X } from "@phosphor-icons/react";

import type { PrAiSummary } from "../../../../shared/types";
import {
  COLORS,
  SANS_FONT,
  cardStyle,
  inlineBadge,
  outlineButton,
} from "../../lanes/laneDesignTokens";
import { formatTimeAgo } from "./prFormatters";

type PrAiSummaryCardProps = {
  prId: string;
  summary: PrAiSummary | null;
  loading?: boolean;
  onGenerated?: (next: PrAiSummary) => void;
  onDismiss?: (prId: string) => void;
  dismissed?: boolean;
};

const DISMISS_PREFIX = "ade:pr-ai-summary-dismissed:";

export function isAiSummaryDismissed(prId: string): boolean {
  try {
    return sessionStorage.getItem(DISMISS_PREFIX + prId) === "1";
  } catch {
    return false;
  }
}

function persistDismissed(prId: string, value: boolean) {
  try {
    if (value) sessionStorage.setItem(DISMISS_PREFIX + prId, "1");
    else sessionStorage.removeItem(DISMISS_PREFIX + prId);
  } catch {
    /* ignore */
  }
}

function Section({
  heading,
  items,
  kind,
}: {
  heading: string;
  items: string[];
  kind: "risk" | "hotspot" | "concern";
}) {
  if (!items.length) return null;
  const chipColor =
    kind === "risk" ? COLORS.danger : kind === "hotspot" ? COLORS.warning : COLORS.info;
  return (
    <div className="flex flex-col gap-1.5">
      <span
        className="text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}
      >
        {heading}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item, idx) => (
          <span
            key={`${kind}-${idx}`}
            style={inlineBadge(chipColor, { padding: "2px 8px", fontSize: 11 })}
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function Skeleton() {
  const shimmerLine: CSSProperties = {
    background:
      "linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 100%)",
    backgroundSize: "200% 100%",
    animation: "pr-ai-summary-shimmer 1.4s ease-in-out infinite",
    borderRadius: 4,
  };

  return (
    <div data-pr-ai-summary-skeleton className="flex flex-col gap-3">
      <style>{`@keyframes pr-ai-summary-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
      <div style={{ ...shimmerLine, height: 10, width: "90%" }} />
      <div style={{ ...shimmerLine, height: 10, width: "70%" }} />
      <div style={{ ...shimmerLine, height: 10, width: "80%" }} />
    </div>
  );
}

export const PrAiSummaryCard = memo(function PrAiSummaryCard({
  prId,
  summary,
  loading,
  onGenerated,
  onDismiss,
  dismissed,
}: PrAiSummaryCardProps) {
  const [busy, setBusy] = useState<"regenerate" | "generate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localDismissed, setLocalDismissed] = useState(() => dismissed ?? isAiSummaryDismissed(prId));

  const containerStyle = useMemo<CSSProperties>(
    () =>
      cardStyle({
        padding: 16,
        borderRadius: 12,
        borderColor: COLORS.accentBorder,
        background: `linear-gradient(180deg, ${COLORS.accentSubtle} 0%, rgba(255,255,255,0.03) 100%)`,
      }),
    [],
  );

  const handleGenerate = useCallback(async () => {
    const bridge = window.ade?.prs?.regenerateAiSummary;
    if (!bridge) return;
    setBusy(summary ? "regenerate" : "generate");
    setError(null);
    try {
      const next = await bridge(prId);
      onGenerated?.(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [summary, prId, onGenerated]);

  const handleDismiss = useCallback(() => {
    persistDismissed(prId, true);
    setLocalDismissed(true);
    onDismiss?.(prId);
  }, [prId, onDismiss]);

  if (localDismissed) return null;

  const headerLabel = "AI summary";
  const timestamp = summary ? formatTimeAgo(summary.generatedAt) : null;

  return (
    <div data-pr-ai-summary-card style={containerStyle}>
      <div className="mb-3 flex items-center gap-2">
        <span
          aria-hidden
          className="inline-flex h-6 w-6 items-center justify-center rounded-[6px]"
          style={{ background: COLORS.accentSubtle, color: COLORS.accent }}
        >
          <Sparkle size={12} weight="fill" />
        </span>
        <span
          className="flex-1 text-[12px] font-semibold"
          style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}
        >
          {headerLabel}
        </span>
        {timestamp ? (
          <span className="text-[11px]" style={{ color: COLORS.textMuted }}>
            {timestamp}
          </span>
        ) : null}
        {summary ? (
          <button
            type="button"
            onClick={handleGenerate}
            disabled={busy === "regenerate"}
            aria-label="Regenerate summary"
            style={outlineButton({ height: 24, fontSize: 11, padding: "0 8px" })}
          >
            <ArrowClockwise size={11} weight="regular" />
            {busy === "regenerate" ? "…" : "Regenerate"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss summary"
          className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] transition-colors hover:bg-white/[0.06]"
          style={{ color: COLORS.textMuted }}
        >
          <X size={12} weight="bold" />
        </button>
      </div>

      {loading ? (
        <Skeleton />
      ) : summary ? (
        <div className="flex flex-col gap-3">
          <p
            className="text-[12px] leading-relaxed"
            style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}
          >
            {summary.summary}
          </p>
          <Section heading="Risk areas" items={summary.riskAreas} kind="risk" />
          <Section
            heading="Reviewer hotspots"
            items={summary.reviewerHotspots}
            kind="hotspot"
          />
          <Section
            heading="Unresolved concerns"
            items={summary.unresolvedConcerns}
            kind="concern"
          />
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <span
            className="flex-1 text-[12px]"
            style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}
          >
            No summary yet.
          </span>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={busy === "generate"}
            style={outlineButton({
              height: 28,
              fontSize: 12,
              color: COLORS.accent,
              borderColor: COLORS.accentBorder,
              background: COLORS.accentSubtle,
            })}
          >
            <Sparkle size={12} weight="fill" />
            {busy === "generate" ? "Generating…" : "Generate summary"}
          </button>
        </div>
      )}

      {error ? (
        <div
          role="alert"
          className="mt-3 rounded-[6px] border px-3 py-2 text-[11px]"
          style={{
            borderColor: `${COLORS.danger}40`,
            background: `${COLORS.danger}10`,
            color: COLORS.danger,
            fontFamily: SANS_FONT,
          }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
});

export default PrAiSummaryCard;
