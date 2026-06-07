import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { SidebarSimple } from "@phosphor-icons/react";
import { ChatGitToolbar } from "../chat/ChatGitToolbar";
import { LaneChip } from "../terminals/LaneChip";
import { ClaudeCacheTtlBadge } from "../shared/ClaudeCacheTtlBadge";
import { useFloatingPaneEmbeddedChrome } from "../ui/FloatingPane";
import { cn } from "../ui/cn";

/** Small "docked tools panel" glyph for the per-surface Tools toggle (purple). */
function ToolsPaneGlyph({ open }: { open: boolean }) {
  return (
    <span className="relative block h-[15px] w-[17px]" aria-hidden="true">
      <span
        className={cn(
          "absolute inset-0 rounded-[3px] border transition-colors",
          open ? "border-violet-300/70 bg-violet-400/15" : "border-violet-300/45 bg-transparent",
        )}
      />
      <span
        className={cn(
          "absolute right-[1.5px] top-[1.5px] bottom-[1.5px] w-[4px] rounded-[2px] transition-colors",
          open ? "bg-violet-200/90 shadow-[0_0_8px_rgba(167,139,250,0.4)]" : "bg-violet-300/65",
        )}
      />
      <span className={cn("absolute left-[2.5px] top-[3px] h-[1.5px] w-[6px] rounded-full transition-colors", open ? "bg-violet-100/85" : "bg-violet-300/75")} />
      <span className={cn("absolute left-[2.5px] top-[7px] h-[1.5px] w-[4.5px] rounded-full transition-colors", open ? "bg-violet-100/60" : "bg-violet-300/50")} />
      <span className={cn("absolute left-[2.5px] top-[11px] h-[1.5px] w-[5.5px] rounded-full transition-colors", open ? "bg-violet-100/60" : "bg-violet-300/50")} />
    </span>
  );
}

/** Far-left sidebar (session list) expander — lives in every chat/CLI header. */
export function WorkHeaderSidebarToggle({
  collapsed,
  onToggle,
  count,
}: {
  collapsed: boolean;
  onToggle: () => void;
  count?: number;
}) {
  const label = collapsed ? "Show sessions" : "Hide sessions";
  return (
    <button
      type="button"
      className="ade-shell-control inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium text-muted-fg/55 transition-colors hover:text-fg/85"
      data-variant="ghost"
      title={label}
      aria-label={label}
      aria-pressed={!collapsed}
      onClick={onToggle}
    >
      <SidebarSimple size={13} weight="regular" />
      {typeof count === "number" && count > 0 ? (
        <span className="min-w-[1ch] text-[9px] leading-none tabular-nums text-muted-fg/45">{count}</span>
      ) : null}
    </button>
  );
}

/** Far-right Tools-pane toggle — lives in every chat/CLI header. */
export function WorkHeaderToolsToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-opacity hover:opacity-100"
      style={{ opacity: open ? 1 : 0.85 }}
      onClick={onToggle}
      title={open ? "Close Tools pane" : "Open Tools pane"}
      aria-label={open ? "Close Tools pane" : "Open Tools pane"}
      aria-pressed={open}
    >
      <ToolsPaneGlyph open={open} />
    </button>
  );
}

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
  /**
   * When set (ADE chat surfaces only), the PR pill toggles this callback
   * instead of opening its inline slide-out / navigating to the PRs tab. CLI
   * surfaces omit it and keep the original behaviour.
   */
  onTogglePrPane?: () => void;
  prPaneOpen?: boolean;
  /** Surface-specific trailing actions (right side of the row). */
  trailingActions?: ReactNode;
  /**
   * Far-left session-list expander. When provided, renders the sidebar toggle
   * before the title (every chat/CLI surface owns its own expander now that the
   * shared top bar is gone).
   */
  onToggleSessionsPane?: () => void;
  sessionsPaneCollapsed?: boolean;
  sessionsPaneCount?: number;
  /** Far-right Tools-pane toggle. When provided, renders after trailingActions. */
  onToggleToolsPane?: () => void;
  toolsPaneOpen?: boolean;
  className?: string;
  /**
   * Right-click handler for the whole header row. CLI session surfaces wire this
   * to open the session context menu (parity with right-clicking a sidebar card);
   * chat surfaces omit it.
   */
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
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
  onTogglePrPane,
  prPaneOpen,
  trailingActions,
  onToggleSessionsPane,
  sessionsPaneCollapsed = false,
  sessionsPaneCount,
  onToggleToolsPane,
  toolsPaneOpen = false,
  className,
  onContextMenu,
  testId,
}: WorkSurfaceHeaderProps) {
  // When this header is the title row of a grid tile (FloatingPane with hidden
  // header), the embedded chrome lets the title act as the tile's drag handle —
  // so the chat/CLI surface looks identical in or out of a grid.
  const embeddedChrome = useFloatingPaneEmbeddedChrome();
  const tileDragProps = embeddedChrome?.dragHandleProps ?? null;
  return (
    <div className={cn(WORK_SURFACE_HEADER_CLASS, className)} data-testid={testId} onContextMenu={onContextMenu}>
      <div className="flex items-center gap-2">
        {onToggleSessionsPane ? (
          <WorkHeaderSidebarToggle
            collapsed={sessionsPaneCollapsed}
            onToggle={onToggleSessionsPane}
            count={sessionsPaneCount}
          />
        ) : null}
        <div
          className={cn("flex min-w-0 shrink items-center gap-2", tileDragProps && "cursor-grab active:cursor-grabbing")}
          {...(tileDragProps ?? {})}
          title={tileDragProps ? "Drag to rearrange or out of the grid" : undefined}
        >
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

        {showGitToolbar && laneId ? (
          <ChatGitToolbar laneId={laneId} onTogglePrPane={onTogglePrPane} prPaneOpen={prPaneOpen} />
        ) : null}

        {trailingActions || onToggleToolsPane ? (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {trailingActions}
            {onToggleToolsPane ? (
              <WorkHeaderToolsToggle open={toolsPaneOpen} onToggle={onToggleToolsPane} />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
