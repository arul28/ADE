import type { ReactNode } from "react";
import { ChatGitToolbar } from "../chat/ChatGitToolbar";
import { LaneChip } from "../terminals/LaneChip";
import { ClaudeCacheTtlBadge } from "../shared/ClaudeCacheTtlBadge";
import { cn } from "../ui/cn";

/**
 * Shared visual + behaviour primitives for any "work surface" header — the
 * top bar that sits above either an ADE chat or a CLI session terminal. Both
 * surfaces share the same outer chrome (title + lane chip + cache badge +
 * git toolbar) and only diverge in what trailing actions they expose. Chat
 * surfaces pack the big tool-toggle row + Chat actions + delete/clear; CLI
 * surfaces show Run + Terminal + Info + kebab.
 */

/** Shared button shape for trailing-action buttons in any surface header. */
export const WORK_SURFACE_HEADER_ACTION_BASE =
  "relative inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 font-sans text-[10px] font-medium transition-colors";

export const WORK_SURFACE_HEADER_ACTION_IDLE =
  "border-white/[0.06] bg-white/[0.02] text-muted-fg/40 hover:border-white/[0.10] hover:text-fg/65";

export const WORK_SURFACE_HEADER_CLASS = "space-y-1 px-2 py-1";

export type WorkSurfaceHeaderProps = {
  /** Primary surface title (chat name, CLI session label, etc.). */
  title: string;
  /** Lane id for lane chip + git toolbar lookups. */
  laneId?: string | null;
  /** Lane chip text — usually lane.name. */
  laneChipName?: string;
  laneChipColor?: string;
  /** When true, the lane chip is rendered (requires laneId + laneChipName). */
  showLaneChip?: boolean;
  /** Optional click handler for the lane chip (e.g. navigate to Lanes tab). */
  onLaneChipClick?: () => void;
  /**
   * When true, renders the Claude cache TTL badge. Caller decides whether
   * the gate applies (e.g. via `shouldShowClaudeCacheTtl`). The badge is
   * surface-agnostic — it reads `idleSinceAt` and counts down.
   */
  showCacheBadge?: boolean;
  cacheIdleSinceAt?: string | null;
  /** When true and laneId is set, renders the ChatGitToolbar. */
  showGitToolbar?: boolean;
  /** Surface-specific trailing actions (right side of the row). */
  trailingActions?: ReactNode;
  className?: string;
  /** data-testid for integration tests. */
  testId?: string;
};

/**
 * Renders the canonical single-row work surface header. Both AgentChatPane
 * and the CLI session surfaces in WorkViewArea consume this — chat surfaces
 * pass their chat-tool buttons via `trailingActions`, CLI surfaces pass a
 * lighter set (Run / Terminal / Info / kebab).
 */
export function WorkSurfaceHeader({
  title,
  laneId,
  laneChipName,
  laneChipColor,
  showLaneChip = false,
  onLaneChipClick,
  showCacheBadge = false,
  cacheIdleSinceAt,
  showGitToolbar = false,
  trailingActions,
  className,
  testId,
}: WorkSurfaceHeaderProps) {
  return (
    <div className={cn(WORK_SURFACE_HEADER_CLASS, className)} data-testid={testId}>
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 shrink items-center gap-2">
          <span
            className="min-w-0 shrink truncate font-sans text-[13px] font-bold tracking-tight text-white"
            title={title}
          >
            {title}
          </span>
          {showLaneChip && laneId && laneChipName ? (
            <LaneChip
              laneName={laneChipName}
              laneColor={laneChipColor}
              onClick={onLaneChipClick}
              aria-label={onLaneChipClick ? `Open ${laneChipName} in Lanes tab` : undefined}
            />
          ) : null}
          {showCacheBadge ? (
            <ClaudeCacheTtlBadge idleSinceAt={cacheIdleSinceAt ?? null} />
          ) : null}
        </div>

        {showGitToolbar && laneId ? <ChatGitToolbar laneId={laneId} /> : null}

        {trailingActions ? (
          <div className="ml-auto flex shrink-0 items-center gap-2">{trailingActions}</div>
        ) : null}
      </div>
    </div>
  );
}
