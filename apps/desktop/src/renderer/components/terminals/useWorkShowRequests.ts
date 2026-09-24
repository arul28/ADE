import { useCallback, useEffect, useMemo } from "react";
import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";
import type { WorkToolShowRequest, WorkToolShowSurface } from "../../../shared/types/workToolShow";
import type { WorkSidebarTab } from "../../state/appStore";
import { workRuntimeScopeKey } from "../../lib/chatMachineRouting";
import { isDocumentVisible, isWorkSurfaceOnScreen, workSurfaceKey } from "../../lib/workToolOnScreen";
import {
  showOutcomeWhenOnScreen,
  useWorkToolShowHandler,
  useWorkToolShowRequestListener,
  type WorkToolShowOutcome,
} from "../../lib/workToolShowRequests";
import { floatAppleMiniPlayerForChat, type AppleMiniPlayerSurface } from "../apple/appleMiniPlayerStore";
import { appleEventAddresses } from "../apple/appleDeviceState";
import {
  floatWorkLiveCardForChat,
  isWorkLivePreviewEnabled,
  readChatCompanionUiState,
  setWorkLivePreviewEnabledForChat,
} from "../chat/chatCompanionUiState";
import { MAC_DESKTOP_CARD_ON_SCREEN_KEY, grantMacDesktopCardForChat } from "../work/macDesktopCardGrants";

const WORK_PAGE_SHOW_SURFACES: readonly WorkToolShowSurface[] = [
  "apple",
  "floating-apple",
  "browser",
  "mac-desktop",
  "floating-mac-desktop",
];

function showPaneTool({
  chatSessionId,
  tool,
  scopeKey,
  activeLaneId,
  setWorkSidebarTool,
}: {
  chatSessionId: string;
  tool: "ios" | "mac-desktop";
  scopeKey: string;
  activeLaneId: string | null;
  setWorkSidebarTool: (tool: WorkSidebarTab) => void;
}): Promise<WorkToolShowOutcome> {
  setWorkLivePreviewEnabledForChat(chatSessionId, tool, true);
  setWorkSidebarTool(tool);
  return showOutcomeWhenOnScreen(workSurfaceKey(tool, scopeKey, activeLaneId));
}

/**
 * The Work page's side of `ade ui show`, and what the floating device checks
 * before it shows itself.
 *
 * Registered only while Work is on screen and only for the session in front,
 * which is the whole surface rule: another lane's chat and the new-chat screen
 * register nothing, so an agent elsewhere cannot put anything here. A request
 * for a chat that is not in front is held and lands when the user opens it.
 *
 * The floating rule (`auto` requests, sent when an agent drives the device):
 * float only when the Apple tool is not already on screen and the chat's "Show
 * preview when minimized" is on. × on the player turns that off for the chat
 * until the user turns it back on or the agent asks with `ade apple show`.
 *
 * The Mac Desktop follows the same rule with its floating card: an agent
 * driving the lane's display grants this chat the card on that lane (see
 * `macDesktopCardGrants`), and the card floats once a frame arrives.
 */
export function useWorkShowRequests({
  active,
  activeWorkSession,
  runtimePin,
  projectBinding,
  activeLaneId,
  workSidebarVisible,
  workSidebarTool,
  setWorkSidebarTool,
}: {
  active: boolean;
  activeWorkSession: TerminalSessionSummary | null;
  /** The session's resolved pin; null is the window's own machine. */
  runtimePin: OpenProjectBinding | null;
  projectBinding: OpenProjectBinding | null;
  /**
   * The lane the tools pane mounts its tools under: the session's own lane, or
   * for a lane-less chat the pane's fallback lane.
   */
  activeLaneId: string | null;
  workSidebarVisible: boolean;
  workSidebarTool: WorkSidebarTab | null;
  setWorkSidebarTool: (tool: WorkSidebarTab) => void;
}): AppleMiniPlayerSurface | null {
  /*
   * Built from the SESSION in front, never from `activeLaneId`: on the
   * new-chat screen that falls back to the composer's draft lane, so a lane's
   * simulator read as "belonging" to a new chat that had not started anywhere
   * (the owner's 2026-09-23 report). No session, no surface: the player hides
   * without closing.
   */
  const appleMiniPlayerSurface = useMemo<AppleMiniPlayerSurface | null>(() => (
    activeWorkSession
      ? { laneId: activeWorkSession.laneId || null, runtimePin, boundBinding: projectBinding }
      : null
  ), [activeWorkSession, projectBinding, runtimePin]);

  const scopeKey = workRuntimeScopeKey(runtimePin, projectBinding);
  const appleToolOpening = workSidebarVisible && workSidebarTool === "ios";
  const macDesktopToolOpening = workSidebarVisible && workSidebarTool === "mac-desktop";
  const showWorkSurface = useCallback((
    request: WorkToolShowRequest,
  ): WorkToolShowOutcome | Promise<WorkToolShowOutcome> => {
    if (!activeWorkSession || request.chatSessionId !== activeWorkSession.id) return "declined";
    /*
     * One lane for every surface: `activeLaneId`, the one the pane mounts its
     * tools under. Writing the tool into the store is a request, not a result:
     * "shown" is answered only once the tool is on screen there.
     */
    if (request.surface === "browser") {
      setWorkSidebarTool("browser");
      return showOutcomeWhenOnScreen(workSurfaceKey("browser", scopeKey, activeLaneId));
    }
    if (request.surface === "apple") {
      // An explicit ask undoes an earlier × for this chat's floating device.
      // Mounting the Apple tool takes the device back from a floating player.
      return showPaneTool({
        chatSessionId: request.chatSessionId,
        tool: "ios",
        scopeKey,
        activeLaneId,
        setWorkSidebarTool,
      });
    }
    if (request.surface === "mac-desktop") {
      // The pane outranks the card for the lane's one decoder
      // (`macDesktopLiveViewLease`), so mounting it takes the picture back.
      return showPaneTool({
        chatSessionId: request.chatSessionId,
        tool: "mac-desktop",
        scopeKey,
        activeLaneId,
        setWorkSidebarTool,
      });
    }
    if (request.surface === "floating-mac-desktop") {
      // Like the floating device: only over a chat of the card's own lane.
      if (!activeWorkSession.laneId) return "declined";
      if (isWorkSurfaceOnScreen(workSurfaceKey("mac-desktop", scopeKey, activeLaneId))) return "shown";
      if (request.auto) {
        if (macDesktopToolOpening) return "declined";
        if (!isWorkLivePreviewEnabled(readChatCompanionUiState(request.chatSessionId), "mac-desktop")) {
          return "declined";
        }
        return grantMacDesktopCardForChat(activeLaneId, request.chatSessionId) ? "shown" : "declined";
      }
      // Asked for by name: undo an earlier × and float the card now, with the
      // Off state and its Start when there is no display.
      floatWorkLiveCardForChat(request.chatSessionId, "mac-desktop");
      grantMacDesktopCardForChat(activeLaneId, request.chatSessionId);
      return showOutcomeWhenOnScreen(workSurfaceKey(MAC_DESKTOP_CARD_ON_SCREEN_KEY, scopeKey, activeLaneId));
    }
    if (request.surface !== "floating-apple") return "declined";
    // The Apple tool is already on screen in the pane.
    if (isWorkSurfaceOnScreen(workSurfaceKey("ios", scopeKey, activeLaneId))) return "shown";
    // The player only floats over a chat of its own lane, so a lane-less chat
    // (whose tools borrow the pane's fallback lane) gets none.
    if (!activeWorkSession.laneId) return "declined";
    // Opening, not yet visible: an automatic float would only be taken back
    // by the pane a moment later.
    if (request.auto && appleToolOpening) return "declined";
    return floatAppleMiniPlayerForChat({
      laneId: activeLaneId,
      chatSessionId: request.chatSessionId,
      runtimePin,
      auto: request.auto,
    }).then((floated): WorkToolShowOutcome => {
      if (!floated) return "declined";
      return isDocumentVisible() ? "shown" : "opened";
    });
  }, [
    activeLaneId,
    activeWorkSession,
    appleToolOpening,
    macDesktopToolOpening,
    runtimePin,
    scopeKey,
    setWorkSidebarTool,
  ]);

  useWorkToolShowHandler(
    active && activeWorkSession ? activeWorkSession.id : null,
    WORK_PAGE_SHOW_SURFACES,
    showWorkSurface,
  );
  // The window's own runtime is heard app-wide; a chat on another machine is
  // heard on its own pin.
  useWorkToolShowRequestListener(Boolean(active && runtimePin), runtimePin);

  /*
   * `ade apple launch --open-drawer` and an agent's inspect/select reveal. The
   * chat pane ignores these in Work (its lane drawers are hidden here), so
   * without this the request reached nothing on the surface agents use most.
   */
  const sessionId = activeWorkSession?.id ?? null;
  const sessionLaneId = activeWorkSession?.laneId || null;
  useEffect(() => {
    if (!active || !sessionId) return undefined;
    return window.ade.iosSimulator.onEvent((event) => {
      if (event.type !== "drawer-open-requested") return;
      if (!appleEventAddresses(event, { chatSessionId: sessionId, laneId: sessionLaneId, acceptUnscoped: false })) return;
      setWorkSidebarTool("ios");
    }, runtimePin);
  }, [active, runtimePin, sessionId, sessionLaneId, setWorkSidebarTool]);

  return appleMiniPlayerSurface;
}
