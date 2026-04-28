import { memo, useCallback, useEffect } from "react";
import { ArrowSquareOut, X } from "@phosphor-icons/react";

import type { PrCheck } from "../../../../shared/types/prs";
import { COLORS, MONO_FONT } from "../../lanes/laneDesignTokens";
import { healthColor } from "../../lanes/laneDesignTokens";

function openExternalUrl(url: string | undefined | null) {
  if (!url) return;
  const bridge = typeof window !== "undefined" ? window.ade?.app?.openExternal : undefined;
  if (bridge) void bridge(url).catch(() => {});
}

function checkDotColor(check: PrCheck): string {
  if (check.status !== "completed") return COLORS.warning;
  switch (check.conclusion) {
    case "success":
      return healthColor("healthy");
    case "failure":
    case "cancelled":
      return healthColor("unhealthy");
    case "neutral":
    case "skipped":
      return COLORS.textDim;
    default:
      return COLORS.textMuted;
  }
}

export type PrCheckLogDrawerProps = {
  check: PrCheck | null;
  onClose: () => void;
};

export const PrCheckLogDrawer = memo(function PrCheckLogDrawer({
  check,
  onClose,
}: PrCheckLogDrawerProps) {
  useEffect(() => {
    if (!check) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [check, onClose]);

  const handleOpenExternal = useCallback(() => {
    if (!check?.detailsUrl) return;
    openExternalUrl(check.detailsUrl);
  }, [check]);

  if (!check) return null;

  return (
    <div
      role="dialog"
      aria-label={`Logs for ${check.name}`}
      data-testid="pr-check-log-drawer"
      className="absolute inset-y-0 right-0 z-20 flex w-[380px] max-w-full flex-col"
      style={{
        background: COLORS.cardBgSolid,
        borderLeft: `1px solid ${COLORS.border}`,
        boxShadow: "-12px 0 32px rgba(0,0,0,0.35)",
      }}
    >
      <div
        className="flex items-center gap-2 px-3"
        style={{ borderBottom: `1px solid ${COLORS.border}`, height: 40 }}
      >
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: checkDotColor(check) }}
        />
        <div className="min-w-0 flex-1 truncate text-[12px]" style={{ color: COLORS.textPrimary }}>
          {check.name}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close log drawer"
          className="p-1 transition-colors"
          style={{ color: COLORS.textMuted }}
        >
          <X size={14} weight="regular" />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-3">
        <div
          className="text-[10px] uppercase tracking-[0.8px]"
          style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}
        >
          Logs
        </div>
        <pre
          className="mt-1.5 whitespace-pre-wrap break-words rounded-[4px] p-2 text-[11px] leading-[1.5]"
          style={{
            fontFamily: MONO_FONT,
            color: COLORS.textSecondary,
            background: "rgba(0,0,0,0.35)",
            border: `1px solid ${COLORS.border}`,
          }}
        >
          Inline log preview isn’t wired up yet. Use “Open full logs” to view the
          complete run on GitHub.
        </pre>
      </div>

      <div className="p-3" style={{ borderTop: `1px solid ${COLORS.border}` }}>
        <button
          type="button"
          onClick={handleOpenExternal}
          disabled={!check.detailsUrl}
          className="inline-flex h-8 w-full items-center justify-center gap-2 text-[12px] font-medium transition-colors"
          style={{
            color: check.detailsUrl ? COLORS.accent : COLORS.textDim,
            background: check.detailsUrl ? COLORS.accentSubtle : "transparent",
            border: `1px solid ${check.detailsUrl ? COLORS.accentBorder : COLORS.border}`,
            cursor: check.detailsUrl ? "pointer" : "not-allowed",
          }}
        >
          Open full logs
          <ArrowSquareOut size={12} weight="regular" />
        </button>
      </div>
    </div>
  );
});

export default PrCheckLogDrawer;
