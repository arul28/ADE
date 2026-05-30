import type { MouseEvent as ReactMouseEvent } from "react";
import { DotsThreeVertical, Info, StopCircle } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type { LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import { openLaneInLanesTabPath } from "../../lib/laneNavigation";
import { shouldShowClaudeCacheTtl } from "../../lib/claudeCacheTtl";
import { formatToolTypeLabel, primarySessionLabel, truncateSessionLabel } from "../../lib/sessions";
import { sessionStatusDot } from "../../lib/terminalAttention";
import { ChatGitToolbar } from "../chat/ChatGitToolbar";
import { getLaneAccent } from "../lanes/laneColorPalette";
import { QuickRunMenu } from "../run/QuickRunMenu";
import { SmartTooltip } from "../ui/SmartTooltip";
import { cn } from "../ui/cn";
import {
  WORK_SURFACE_HEADER_ACTION_BASE,
  WORK_SURFACE_HEADER_ACTION_IDLE,
  WorkSurfaceHeader,
} from "../work/WorkSurfaceHeader";

type SessionMouseHandler = (
  session: TerminalSessionSummary,
  event: ReactMouseEvent<HTMLElement>,
) => void;

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

/** Small runtime-state dot (running / awaiting input / ended) shared across CLI session headers. */
function SessionStatusDot({ session }: { session: TerminalSessionSummary }) {
  const dot = sessionStatusDot(session);
  return (
    <span
      aria-hidden
      title={dot.label}
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        dot.cls,
        dot.spinning && "animate-spin",
      )}
    />
  );
}

/** Red stop button — only rendered while a PTY-backed session is actually running. */
function StopSessionButton({
  session,
  stopping = false,
  onStopRunningSession,
}: {
  session: TerminalSessionSummary;
  stopping?: boolean;
  onStopRunningSession?: (session: TerminalSessionSummary) => void;
}) {
  const canStop = session.status === "running" && Boolean(session.ptyId) && Boolean(onStopRunningSession);
  if (!canStop) return null;
  return (
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
  );
}

/** Lane-scoped Run dropdown — only rendered when the session belongs to a lane. */
function SessionRunMenu({ session }: { session: TerminalSessionSummary }) {
  if (!session.laneId) return null;
  return (
    <QuickRunMenu
      laneId={session.laneId}
      compact
      label="Run"
      align="end"
      triggerStyle={{ height: 24, padding: "0 8px" }}
    />
  );
}

function SessionInfoButton({
  session,
  onInfoClick,
}: {
  session: TerminalSessionSummary;
  onInfoClick?: SessionMouseHandler;
}) {
  return (
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
  );
}

function SessionActionsButton({
  session,
  onContextMenu,
}: {
  session: TerminalSessionSummary;
  onContextMenu?: SessionMouseHandler;
}) {
  return (
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
  );
}

/**
 * Trailing-action set rendered to the right of every CLI session header. Kept
 * intentionally light: Stop, a lane-scoped Run dropdown, an Info button, and the
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
  onInfoClick?: SessionMouseHandler;
  onContextMenu?: SessionMouseHandler;
  onStopRunningSession?: (session: TerminalSessionSummary) => void;
}) {
  return (
    <>
      <StopSessionButton session={session} stopping={stopping} onStopRunningSession={onStopRunningSession} />
      <SessionRunMenu session={session} />
      <SessionInfoButton session={session} onInfoClick={onInfoClick} />
      <SessionActionsButton session={session} onContextMenu={onContextMenu} />
    </>
  );
}

/**
 * Consolidated action cluster for a CLI session's grid tile. The grid tile's
 * lane-colored FloatingPane header now carries everything the old secondary
 * header did, so this folds those controls into a single row in order:
 * PR chip → Stop → status dot → Run → Info → kebab.
 */
export function GridTileSessionHeaderActions({
  session,
  stopping = false,
  onInfoClick,
  onContextMenu,
  onStopRunningSession,
}: {
  session: TerminalSessionSummary;
  stopping?: boolean;
  onInfoClick?: SessionMouseHandler;
  onContextMenu?: SessionMouseHandler;
  onStopRunningSession?: (session: TerminalSessionSummary) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {session.laneId ? <ChatGitToolbar laneId={session.laneId} /> : null}
      <StopSessionButton session={session} stopping={stopping} onStopRunningSession={onStopRunningSession} />
      <SessionStatusDot session={session} />
      <SessionRunMenu session={session} />
      <SessionInfoButton session={session} onInfoClick={onInfoClick} />
      <SessionActionsButton session={session} onContextMenu={onContextMenu} />
    </div>
  );
}

/**
 * Adapts a TerminalSessionSummary into the unified WorkSurfaceHeader. Replaces
 * the legacy WorkCliSessionHeader so CLI surfaces and ADE chats share the same
 * visual shell (title + lane chip + cache badge + git toolbar) and only diverge
 * in their trailing actions. In grid view this header is consolidated into the
 * tile's FloatingPane header (see GridTileSessionHeaderActions); the standard
 * (tabs) surface still renders it inline.
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
  onInfoClick?: SessionMouseHandler;
  onContextMenu?: SessionMouseHandler;
  onStopRunningSession?: (session: TerminalSessionSummary) => void;
}) {
  const navigate = useNavigate();
  const lane = lanes.find((entry) => entry.id === session.laneId) ?? null;
  const laneAccent = getLaneAccent(lane, 0);
  const toolLabel = formatToolTypeLabel(session.toolType);
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
          <SessionStatusDot session={session} />
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
