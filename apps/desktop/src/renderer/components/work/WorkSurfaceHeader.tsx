import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { ChatGitToolbar } from "../chat/ChatGitToolbar";
import { WorkToolPickerBackdrop } from "../terminals/WorkToolPickerBackdrop";
import { useAppStore } from "../../state/appStore";
import { WorkHeaderToolsToggle } from "./WorkHeaderPaneToggles";
import { LaneBranchDriftChip } from "../lanes/LaneBranchDrift";
import { LaneChip } from "../terminals/LaneChip";
import { SessionSnoozeChip } from "./SessionLifecycleChips";
import { ClaudeCacheTtlBadge } from "../shared/ClaudeCacheTtlBadge";
import { useFloatingPaneEmbeddedChrome } from "../ui/FloatingPane";
import { cn } from "../ui/cn";
import type { OpenProjectBinding } from "../../../shared/types";
import { useLaneNamePending, useSessionFieldGenerating } from "../../state/sessionMetadataGeneratingStore";
import { NamingPendingLabel } from "../terminals/LaneNamingLabel";

// Provider default chat titles — mirrors DEFAULT_SESSION_TITLES in
// agentChatService.ts. When a chat's title transitions FROM one of these TO a
// real (model-authored) title while mounted, the header title crossfades with a
// brief one-time shimmer.
const PROVIDER_DEFAULT_TITLES = new Set([
  "Codex Chat",
  "Claude Chat",
  "Cursor Chat",
  "Droid Chat",
  "AI Chat",
  "OpenCode Chat",
  "Open Code Chat",
]);

/**
 * Renders the surface title and plays a one-time shimmer when the title lands —
 * i.e. transitions from a provider default to a real title while the surface is
 * mounted. CSS keyframes only; respects `prefers-reduced-motion: reduce`.
 */
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function WorkSurfaceTitle({ title, generating = false }: { title: string; generating?: boolean }) {
  const prevTitleRef = useRef(title);
  const prevGeneratingRef = useRef(generating);
  const [landed, setLanded] = useState(false);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const prev = prevTitleRef.current;
    const wasGenerating = prevGeneratingRef.current;
    prevTitleRef.current = title;
    prevGeneratingRef.current = generating;
    if (generating) return;
    if (prev === title && !wasGenerating) return;
    const landedFromDefault = PROVIDER_DEFAULT_TITLES.has(prev) && !PROVIDER_DEFAULT_TITLES.has(title);
    const landedFromRegen = wasGenerating && prev !== title;
    if (
      (landedFromDefault || landedFromRegen)
      && title.trim().length > 0
      && !prefersReducedMotion()
    ) {
      setLanded(true);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(() => setLanded(false), 800);
    }
  }, [title, generating]);

  useEffect(() => () => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
  }, []);

  return (
    <span
      className={cn("min-w-0 shrink truncate font-sans text-[13px] font-bold tracking-tight text-white", landed && "ade-title-landed")}
      title={generating ? "Naming chat…" : title}
      data-title-landed={landed ? "true" : undefined}
      data-title-generating={generating ? "true" : undefined}
      onAnimationEnd={() => setLanded(false)}
    >
      {generating ? (
        <NamingPendingLabel text={title} naming pendingLabel="Naming chat" />
      ) : (
        title
      )}
    </span>
  );
}

export { WorkHeaderSidebarToggle, WorkHeaderToolsToggle } from "./WorkHeaderPaneToggles";

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

/** Canonical 32px title rail shared by chat and CLI work surfaces. */
export const WORK_SURFACE_HEADER_CLASS = "flex h-8 items-center px-2";

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
  /** Optional control rendered immediately after the title (e.g. Cursor Cloud link). */
  titleAccessory?: ReactNode;
  /** Optional click handler for the lane chip (e.g. navigate to Lanes tab). */
  onLaneChipClick?: () => void;
  /**
   * When true, renders the Claude cache TTL badge. Caller decides whether
   * the gate applies (e.g. via `shouldShowClaudeCacheTtl`). The badge is
   * surface-agnostic — it reads `idleSinceAt` and counts down.
   */
  showCacheBadge?: boolean;
  cacheIdleSinceAt?: string | null;
  /** Session id whose metadata-generation state controls the title shimmer. */
  lifecycleSessionId?: string | null;
  /** Session id whose snooze state should surface as an ambient header chip. */
  snoozeSessionId?: string | null;
  /** When true and laneId is set, renders the ChatGitToolbar. */
  showGitToolbar?: boolean;
  /** Chat session owning the header; lets PR badges stay chat-specific. */
  prSessionId?: string | null;
  /**
   * When set (ADE chat surfaces only), the PR pill toggles this callback
   * instead of opening its inline slide-out / navigating to the PRs tab. CLI
   * surfaces omit it and keep the original behaviour.
   */
  onTogglePrPane?: () => void;
  prPaneOpen?: boolean;
  /** See `ChatGitToolbar.runtimePin`: the machine this lane's PR is read from. */
  runtimePin?: OpenProjectBinding | null;
  /** Surface-specific trailing actions (right side of the row). */
  trailingActions?: ReactNode;
  /** Far-right Tools-pane toggle. When provided, renders after trailingActions. */
  onToggleToolsPane?: () => void;
  /** Icon immediately left of the Tools toggle. Chat progress uses this. */
  actionsToggle?: ReactNode;
  toolsPaneOpen?: boolean;
  /** Hide the "create a PR" button. The badge stays when a pull request exists. */
  prBadgeOnly?: boolean;
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

/** Props of the centered chat header. It has no lane chip. */
export type CenteredWorkSurfaceHeaderProps = Omit<
  WorkSurfaceHeaderProps,
  "laneChipName" | "laneChipColor" | "showLaneChip" | "onLaneChipClick"
>;

/**
 * The parts both header layouts share: the title drag props of a grid tile,
 * the title shimmer state, the git toolbar, and the tools toggle.
 */
function useWorkSurfaceHeaderParts({
  laneId,
  lifecycleSessionId = null,
  showGitToolbar = false,
  prSessionId = null,
  onTogglePrPane,
  prPaneOpen,
  runtimePin = null,
  prBadgeOnly = false,
  onToggleToolsPane,
  toolsPaneOpen = false,
}: CenteredWorkSurfaceHeaderProps) {
  // When this header is the title row of a grid tile (FloatingPane with hidden
  // header), the embedded chrome lets the title act as the tile's drag handle —
  // so the chat/CLI surface looks identical in or out of a grid.
  const embeddedChrome = useFloatingPaneEmbeddedChrome();
  const tileDragProps = embeddedChrome?.dragHandleProps ?? null;
  const generatingTitle = useSessionFieldGenerating(lifecycleSessionId, "title");
  const gitToolbar = showGitToolbar && laneId ? (
    <ChatGitToolbar
      laneId={laneId}
      sessionId={prSessionId}
      onTogglePrPane={onTogglePrPane}
      prPaneOpen={prPaneOpen}
      runtimePin={runtimePin}
      linkedPrOnly={prBadgeOnly}
    />
  ) : null;
  const toolsToggle = onToggleToolsPane ? (
    <WorkHeaderToolsToggle open={toolsPaneOpen} onToggle={onToggleToolsPane} />
  ) : null;
  const titleDragProps = {
    ...(tileDragProps ?? {}),
    title: tileDragProps ? "Drag to rearrange or out of the grid" : undefined,
  };
  return { tileDragging: Boolean(tileDragProps), titleDragProps, generatingTitle, gitToolbar, toolsToggle };
}

/**
 * Renders the canonical single-row work surface header: title and lane chips
 * on the left, actions on the right. The CLI session surfaces in WorkViewArea
 * use it and pass a light action set (Run / Terminal / Info / kebab).
 */
export function WorkSurfaceHeader(props: WorkSurfaceHeaderProps) {
  const {
    title,
    laneId,
    laneChipName,
    laneChipColor,
    showLaneChip = false,
    titleAccessory,
    onLaneChipClick,
    showCacheBadge = false,
    cacheIdleSinceAt,
    snoozeSessionId = null,
    runtimePin = null,
    trailingActions,
    actionsToggle,
    className,
    onContextMenu,
    testId,
  } = props;
  const { tileDragging, titleDragProps, generatingTitle, gitToolbar, toolsToggle } = useWorkSurfaceHeaderParts(props);
  const namingLane = useLaneNamePending(laneId);
  return (
    <div className={cn(WORK_SURFACE_HEADER_CLASS, className)} data-testid={testId} onContextMenu={onContextMenu}>
      <div className="flex w-full items-center gap-2">
        <div
          className={cn("flex min-w-0 shrink items-center gap-2", tileDragging && "cursor-grab active:cursor-grabbing")}
          {...titleDragProps}
        >
          <WorkSurfaceTitle title={title} generating={generatingTitle} />
          {titleAccessory}
          {showLaneChip && laneId && laneChipName ? (
            <LaneChip
              laneName={laneChipName}
              laneColor={laneChipColor}
              naming={namingLane}
              onClick={onLaneChipClick}
              aria-label={onLaneChipClick ? `Open ${laneChipName} in Lanes tab` : undefined}
            />
          ) : null}
          {laneId ? <LaneBranchDriftChip laneId={laneId} /> : null}
          {snoozeSessionId ? <SessionSnoozeChip sessionId={snoozeSessionId} runtimePin={runtimePin} /> : null}
          {showCacheBadge ? (
            <ClaudeCacheTtlBadge idleSinceAt={cacheIdleSinceAt ?? null} />
          ) : null}
        </div>
        <div className="relative z-10 ml-auto flex shrink-0 items-center gap-2">
          {gitToolbar}
          {trailingActions}
          {actionsToggle || toolsToggle ? (
            <div className="flex items-center gap-3">
              {actionsToggle}
              {toolsToggle}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The ADE chat header: the thread title sits centered over the header
 * backdrop, and the git toolbar, snooze and cache chips move to the right
 * cluster. It has no lane chip.
 */
export function CenteredWorkSurfaceHeader(props: CenteredWorkSurfaceHeaderProps) {
  const {
    title,
    titleAccessory,
    showCacheBadge = false,
    cacheIdleSinceAt,
    snoozeSessionId = null,
    runtimePin = null,
    trailingActions,
    actionsToggle,
    className,
    onContextMenu,
    testId,
  } = props;
  const theme = useAppStore((state) => state.theme);
  const { tileDragging, titleDragProps, generatingTitle, gitToolbar, toolsToggle } = useWorkSurfaceHeaderParts(props);
  return (
    <div className={cn(WORK_SURFACE_HEADER_CLASS, "relative", className)} data-testid={testId} onContextMenu={onContextMenu}>
      <div className="pointer-events-none absolute -inset-x-2 inset-y-0 overflow-hidden" aria-hidden>
        <div className="relative h-full w-full">
          <WorkToolPickerBackdrop theme={theme} variant="header" />
        </div>
      </div>
      <div className="relative z-10 flex w-full items-center">
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-16">
          <div
            className={cn("pointer-events-auto flex min-w-0 max-w-full items-center gap-2", tileDragging && "cursor-grab active:cursor-grabbing")}
            {...titleDragProps}
          >
            <WorkSurfaceTitle title={title} generating={generatingTitle} />
            {titleAccessory}
          </div>
        </div>
        <div className="relative z-10 ml-auto flex shrink-0 items-center gap-2">
          {snoozeSessionId ? <SessionSnoozeChip sessionId={snoozeSessionId} runtimePin={runtimePin} /> : null}
          {showCacheBadge ? (
            <ClaudeCacheTtlBadge idleSinceAt={cacheIdleSinceAt ?? null} />
          ) : null}
          {trailingActions}
          {gitToolbar || actionsToggle || toolsToggle ? (
            <div className="flex items-center gap-3">
              {gitToolbar}
              {actionsToggle}
              {toolsToggle}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
