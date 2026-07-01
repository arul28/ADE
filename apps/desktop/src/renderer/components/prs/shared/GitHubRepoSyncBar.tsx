import { memo } from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";

import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { formatTimeAgoCompact } from "./prFormatters";

export type GitHubRepoSyncBarProps = {
  repoLabel: string;
  syncing: boolean;
  onSync: () => void;
  syncedAt?: string | null;
  compact?: boolean;
};

export const GitHubRepoSyncBar = memo(function GitHubRepoSyncBar({
  repoLabel,
  syncing,
  onSync,
  syncedAt = null,
  compact = false,
}: GitHubRepoSyncBarProps) {
  if (!repoLabel) return null;
  const statusText = syncing
    ? "Syncing"
    : syncedAt
      ? `Updated ${formatTimeAgoCompact(syncedAt)}`
      : "Watching GitHub";

  return (
    <div
      data-testid="github-repo-sync-bar"
      className="flex items-center gap-2"
      style={
        compact
          ? {
              padding: "0 10px",
              height: 30,
              borderRadius: 8,
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.06)",
            }
          : undefined
      }
    >
      <span
        style={{
          fontFamily: SANS_FONT,
          fontSize: 11,
          color: COLORS.textDim,
          whiteSpace: "nowrap",
        }}
      >
        {repoLabel}
      </span>
      <span
        style={{
          fontFamily: SANS_FONT,
          fontSize: 11,
          color: syncing ? COLORS.accent : COLORS.textMuted,
          whiteSpace: "nowrap",
        }}
      >
        {statusText}
      </span>
      <button
        type="button"
        aria-label="Sync now"
        title="Sync now"
        onClick={() => void onSync()}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: compact ? 0 : 5,
          height: compact ? 24 : 28,
          width: compact ? 24 : undefined,
          padding: compact ? 0 : "0 10px",
          fontSize: 11,
          fontWeight: 500,
          fontFamily: SANS_FONT,
          color: syncing ? COLORS.accent : COLORS.textSecondary,
          background: syncing ? "rgba(167,139,250,0.08)" : "rgba(255,255,255,0.03)",
          border: syncing ? "1px solid rgba(167,139,250,0.15)" : "1px solid rgba(255,255,255,0.06)",
          borderRadius: compact ? 6 : 7,
          cursor: "pointer",
          transition: "all 150ms ease",
        }}
      >
        <ArrowsClockwise size={12} className={syncing ? "animate-spin" : ""} />
        {compact ? null : "Sync now"}
      </button>
    </div>
  );
});

export default GitHubRepoSyncBar;
