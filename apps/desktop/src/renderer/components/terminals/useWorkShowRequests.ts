import { useCallback, useEffect, useMemo } from "react";
import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";
import type { WorkToolShowRequest, WorkToolShowSurface } from "../../../shared/types/workToolShow";
import type { WorkSidebarTab } from "../../state/appStore";
import { workRuntimeScopeKey } from "../../lib/chatMachineRouting";
import {
  isDocumentVisible,
  isWorkSurfaceOnScreen,
  waitForWorkSurfaceOnScreen,
  workSurfaceKey,
} from "../../lib/workToolOnScreen";
import {
  useWorkToolShowHandler,
  useWorkToolShowRequestListener,
  type WorkToolShowOutcome,
} from "../../lib/workToolShowRequests";
import { floatAppleMiniPlayerForChat, type AppleMiniPlayerSurface } from "../apple/appleMiniPlayerStore";
import { appleEventAddresses } from "../apple/appleDeviceState";
import { setWorkLivePreviewEnabledForChat } from "../chat/chatCompanionUiState";

const WORK_PAGE_SHOW_SURFACES: readonly WorkToolShowSurface[] = ["apple", "floating-apple", "browser"];

const onScreenOutcome = (onScreen: boolean): WorkToolShowOutcome => (onScreen ? "shown" : "opened");

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
  /** The lane the tools pane is showing, which is what its tools mount under. */
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
  const showWorkSurface = useCallback((
    request: WorkToolShowRequest,
  ): WorkToolShowOutcome | Promise<WorkToolShowOutcome> => {
    if (!activeWorkSession || request.chatSessionId !== activeWorkSession.id) return "declined";
    const sessionLaneId = activeWorkSession.laneId || null;
    /*
     * Writing the tool into the store is a request, not a result: "shown" is
     * answered only once the tool is on screen, in the lane the pane mounts it
     * under (a lane-less chat's tools use the pane's fallback lane).
     */
    if (request.surface === "browser") {
      setWorkSidebarTool("browser");
      return waitForWorkSurfaceOnScreen(workSurfaceKey("browser", scopeKey, activeLaneId)).then(onScreenOutcome);
    }
    if (request.surface === "apple") {
      // An explicit ask undoes an earlier × for this chat's floating device.
      setWorkLivePreviewEnabledForChat(request.chatSessionId, "ios", true);
      // Mounting the Apple tool takes the device back from a floating player.
      setWorkSidebarTool("ios");
      return waitForWorkSurfaceOnScreen(workSurfaceKey("ios", scopeKey, activeLaneId)).then(onScreenOutcome);
    }
    if (request.surface !== "floating-apple") return "declined";
    // The chat's own device is already on screen in the pane.
    if (isWorkSurfaceOnScreen(workSurfaceKey("ios", scopeKey, sessionLaneId))) return "shown";
    // Opening, not yet visible: an automatic float would only be taken back
    // by the pane a moment later.
    if (request.auto && appleToolOpening) return "declined";
    return floatAppleMiniPlayerForChat({
      laneId: sessionLaneId,
      chatSessionId: request.chatSessionId,
      runtimePin,
      auto: request.auto,
    }).then((floated) => (floated ? onScreenOutcome(isDocumentVisible()) : "declined"));
  }, [activeLaneId, activeWorkSession, appleToolOpening, runtimePin, scopeKey, setWorkSidebarTool]);

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
    const api = window.ade?.iosSimulator;
    if (!active || !sessionId || !api?.onEvent) return undefined;
    return api.onEvent((event) => {
      if (event.type !== "drawer-open-requested") return;
      if (!appleEventAddresses(event, { chatSessionId: sessionId, laneId: sessionLaneId, acceptUnscoped: false })) return;
      setWorkSidebarTool("ios");
    }, runtimePin);
  }, [active, runtimePin, sessionId, sessionLaneId, setWorkSidebarTool]);

  return appleMiniPlayerSurface;
}
