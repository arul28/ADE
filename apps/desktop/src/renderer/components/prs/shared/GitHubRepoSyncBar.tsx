import { memo } from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";

import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { formatTimeAgoCompact } from "./prFormatters";

export type GitHubRepoSyncBarProps = {
  repoLabel: string;
  syncing: boolean;
  onSync: () => void;
  syncedAt?: string | null;
};

/**
 * One quiet line under the PR list: which repo the list comes from, when it
 * last synced, and a button to sync now.
 */
export const GitHubRepoSyncBar = memo(function GitHubRepoSyncBar({
  repoLabel,
  syncing,
  onSync,
  syncedAt = null,
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
      className="flex min-w-0 items-center gap-2"
      style={{ fontFamily: SANS_FONT, fontSize: 11 }}
    >
      <span className="min-w-0 truncate" style={{ color: COLORS.textDim }} title={repoLabel}>
        {repoLabel}
      </span>
      <span className="shrink-0" style={{ color: syncing ? COLORS.accent : COLORS.textMuted, whiteSpace: "nowrap" }}>
        {statusText}
      </span>
      <button
        type="button"
        aria-label="Sync now"
        title="Sync now"
        onClick={() => void onSync()}
        className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors duration-150 hover:bg-white/[0.06]"
        style={{ color: syncing ? COLORS.accent : COLORS.textMuted, background: "transparent", border: "none", cursor: "pointer" }}
      >
        <ArrowsClockwise size={12} className={syncing ? "animate-spin" : ""} />
      </button>
    </div>
  );
});

export default GitHubRepoSyncBar;
