import { memo, useCallback } from "react";
import { ArrowSquareOut, MagnifyingGlass } from "@phosphor-icons/react";

import type { PrDeployment, PrDeploymentState } from "../../../../shared/types/prs";
import { COLORS, MONO_FONT } from "../../lanes/laneDesignTokens";
import { relativeWhen } from "../../../lib/format";

function openExternalUrl(url: string | undefined | null) {
  if (!url) return;
  const bridge = typeof window !== "undefined" ? window.ade?.app?.openExternal : undefined;
  if (bridge) void bridge(url).catch(() => {});
}

export function deploymentStateColor(state: PrDeploymentState): string {
  switch (state) {
    case "success":
      return COLORS.success;
    case "failure":
    case "error":
      return COLORS.danger;
    case "in_progress":
    case "pending":
    case "queued":
      return COLORS.warning;
    case "inactive":
      return COLORS.textDim;
    default:
      return COLORS.textMuted;
  }
}

function stateLabel(state: PrDeploymentState): string {
  switch (state) {
    case "in_progress":
      return "Deploying";
    case "success":
      return "Live";
    case "failure":
      return "Failed";
    case "error":
      return "Error";
    case "queued":
      return "Queued";
    case "pending":
      return "Pending";
    case "inactive":
      return "Inactive";
    default:
      return "Unknown";
  }
}

export type PrDeploymentCardProps = {
  deployment: PrDeployment;
};

export const PrDeploymentCard = memo(function PrDeploymentCard({
  deployment,
}: PrDeploymentCardProps) {
  const color = deploymentStateColor(deployment.state);
  const ts = deployment.updatedAt ?? deployment.createdAt;
  const handlePreview = useCallback(() => {
    openExternalUrl(deployment.environmentUrl);
  }, [deployment.environmentUrl]);
  const handleInspector = useCallback(() => {
    openExternalUrl(deployment.logUrl);
  }, [deployment.logUrl]);

  return (
    <div
      data-testid="pr-deployment-card"
      className="flex flex-col gap-1.5 px-3 py-2"
      style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}
    >
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: color, boxShadow: `0 0 6px ${color}60` }}
        />
        <span
          className="truncate text-[12px] font-medium"
          style={{ color: COLORS.textPrimary }}
        >
          {deployment.environment}
        </span>
        <span
          className="ml-auto text-[10px] uppercase tracking-[0.8px]"
          style={{ color, fontFamily: MONO_FONT }}
        >
          {stateLabel(deployment.state)}
        </span>
      </div>

      {deployment.description ? (
        <div className="text-[11px] leading-[1.4]" style={{ color: COLORS.textMuted }}>
          {deployment.description}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        {deployment.environmentUrl ? (
          <button
            type="button"
            onClick={handlePreview}
            className="inline-flex items-center gap-1 text-[11px] underline-offset-2 hover:underline"
            style={{ color: COLORS.accent }}
          >
            Preview
            <ArrowSquareOut size={11} weight="regular" />
          </button>
        ) : null}
        {deployment.logUrl ? (
          <button
            type="button"
            onClick={handleInspector}
            className="inline-flex items-center gap-1 text-[11px]"
            style={{ color: COLORS.textSecondary }}
          >
            <MagnifyingGlass size={11} weight="regular" />
            Inspector
          </button>
        ) : null}
        {ts ? (
          <span
            className="ml-auto text-[10px]"
            style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}
          >
            {relativeWhen(ts)}
          </span>
        ) : null}
      </div>
    </div>
  );
});

export default PrDeploymentCard;
