import type { MouseEvent as ReactMouseEvent } from "react";
import { DotsThreeVertical, Info, StopCircle } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import { openLaneInLanesTabPath } from "../../lib/laneNavigation";
import { shouldShowClaudeCacheTtl } from "../../lib/claudeCacheTtl";
import { formatToolTypeLabel, primarySessionLabel, truncateSessionLabel } from "../../lib/sessions";
import { sessionStatusDot } from "../../lib/terminalAttention";
import { getLaneAccent } from "../lanes/laneColorPalette";
import { QuickRunMenu } from "../run/QuickRunMenu";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";
import {
  WORK_SURFACE_HEADER_ACTION_BASE,
  WORK_SURFACE_HEADER_ACTION_IDLE,
  WorkSurfaceHeader,
} from "../work/WorkSurfaceHeader";

/**
 * Maps a TerminalSessionSummary's toolType onto the "provider" enum
 * `shouldShowClaudeCacheTtl` understands. Used so Claude Code CLI and
 * orchestrated Claude variants get the cache TTL badge alongside Claude SDK
 * chats.
 */
function providerForCacheBadgeGate(toolType: TerminalSessionSummary["toolType"]): "claude" | null {
  if (toolType === "claude" || toolType === "claude-orchestrated" || toolType === "claude-chat") {
    return "claude";
  }
  return null;
}

function statusForCacheBadgeGate(
  session: TerminalSessionSummary,
): { status: "idle" | "active"; awaitingInput: boolean } {
  return {
    status: session.runtimeState === "idle" ? "idle" : "active",
    awaitingInput: session.runtimeState === "waiting-input",
  };
}

/**
 * Trailing-action set rendered to the right of every CLI session header. Kept
 * intentionally light: lane-scoped Run dropdown, an Info button, and the
 * session kebab. The chat surface owns its much larger action set (Simulator,
 * App Control, Browser, Chat actions, terminal, delete, etc.) inline in
 * AgentChatPane.
 */
export function CliSurfaceTrailingActions({
  session,
  stopping = false,
  onInfoClick,
  onContextMenu,
  onStopRunningSession,
}: {
  session: TerminalSessionSummary;
  stopping?: boolean;
  onInfoClick?: (session: TerminalSessionSummary, event: ReactMouseEvent<HTMLElement>) => void;
  onContextMenu?: (session: TerminalSessionSummary, event: ReactMouseEvent<HTMLElement>) => void;
  onStopRunningSession?: (session: TerminalSessionSummary) => void;
}) {
  const canStop = session.status === "running" && Boolean(session.ptyId) && Boolean(onStopRunningSession);
  return (
    <>
      {canStop ? (
        <SmartTooltip content={{ label: stopping ? "Stopping…" : "Stop session", description: "Terminate the running session." }}>
          <button
            type="button"
            className={cn(WORK_SURFACE_HEADER_ACTION_BASE, "px-1.5 text-red-300/70 hover:text-red-200")}
            onClick={() => onStopRunningSession?.(session)}
            aria-label="Stop session"
            disabled={stopping}
          >
            <StopCircle size={14} weight="regular" />
          </button>
        </SmartTooltip>
      ) : null}
      {session.laneId ? (
        <QuickRunMenu
          laneId={session.laneId}
          compact
          label="Run"
          align="end"
          triggerStyle={{ height: 24, padding: "0 8px" }}
        />
      ) : null}
      <SmartTooltip
        content={{ label: "Session info", description: "Open metadata and session actions." }}
      >
        <button
          type="button"
          className={cn(WORK_SURFACE_HEADER_ACTION_BASE, WORK_SURFACE_HEADER_ACTION_IDLE, "px-1.5")}
          onClick={(event) => onInfoClick?.(session, event)}
          aria-label="Session info"
          disabled={!onInfoClick}
        >
          <Info size={13} />
        </button>
      </SmartTooltip>
      <SmartTooltip
        content={{
          label: "Session actions",
          description: "Rename, pin, copy links, archive, or delete this session.",
        }}
      >
        <button
          type="button"
          className={cn(WORK_SURFACE_HEADER_ACTION_BASE, WORK_SURFACE_HEADER_ACTION_IDLE, "px-1.5")}
          onClick={(event) => onContextMenu?.(session, event)}
          aria-label="Session actions"
          disabled={!onContextMenu}
        >
          <DotsThreeVertical size={14} weight="bold" />
        </button>
      </SmartTooltip>
    </>
  );
}

/**
 * Adapts a TerminalSessionSummary into the unified WorkSurfaceHeader. Replaces
 * the legacy WorkCliSessionHeader so CLI surfaces and ADE chats share the same
 * visual shell (title + lane chip + cache badge + git toolbar) and only diverge
 * in their trailing actions.
 */
export function CliSessionWorkSurfaceHeader({
  session,
  lanes,
  compact = false,
  stopping = false,
  onInfoClick,
  onContextMenu,
  onStopRunningSession,
}: {
  session: TerminalSessionSummary;
  lanes: LaneSummary[];
  compact?: boolean;
  stopping?: boolean;
  onInfoClick?: (session: TerminalSessionSummary, event: ReactMouseEvent<HTMLElement>) => void;
  onContextMenu?: (session: TerminalSessionSummary, event: ReactMouseEvent<HTMLElement>) => void;
  onStopRunningSession?: (session: TerminalSessionSummary) => void;
}) {
  const navigate = useNavigate();
  const lane = lanes.find((entry) => entry.id === session.laneId) ?? null;
  const laneAccent = getLaneAccent(lane, 0);
  const toolLabel = formatToolTypeLabel(session.toolType);
  const dot = sessionStatusDot(session);
  const title = truncateSessionLabel(primarySessionLabel(session), compact ? 24 : 44);
  const cacheGate = statusForCacheBadgeGate(session);
  const cacheProvider = providerForCacheBadgeGate(session.toolType);
  const showCache = cacheProvider
    ? shouldShowClaudeCacheTtl({
        provider: cacheProvider,
        status: cacheGate.status,
        idleSinceAt: session.chatIdleSinceAt,
        awaitingInput: cacheGate.awaitingInput,
      })
    : false;

  return (
    <WorkSurfaceHeader
      title={`${title} · ${toolLabel}`}
      laneId={session.laneId}
      laneChipName={session.laneName}
      laneChipColor={laneAccent}
      showLaneChip
      onLaneChipClick={
        session.laneId
          ? () => navigate(openLaneInLanesTabPath(session.laneId!))
          : undefined
      }
      showCacheBadge={showCache}
      cacheIdleSinceAt={session.chatIdleSinceAt}
      showGitToolbar
      trailingActions={
        <>
          <span
            aria-hidden
            title={dot.label}
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              dot.cls,
              dot.spinning && "animate-spin",
            )}
          />
          <CliSurfaceTrailingActions
            session={session}
            stopping={stopping}
            onInfoClick={onInfoClick}
            onContextMenu={onContextMenu}
            onStopRunningSession={onStopRunningSession}
          />
        </>
      }
      testId="work-cli-session-header"
    />
  );
}
