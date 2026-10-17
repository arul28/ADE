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
import { APP_CONTROL_CARD_ON_SCREEN_KEY, grantAppControlCardForChat } from "../work/appControlCardGrants";
import { useMacDesktopSupport } from "./useMacDesktopSupport";
import { hostDesktopTool, type DesktopWorkTool } from "./workTools";
import { isAddressedToThisDesktop } from "../../lib/desktopClient";

const WORK_PAGE_SHOW_SURFACES: readonly WorkToolShowSurface[] = [
  "apple",
  "floating-apple",
  "browser",
  "mac-desktop",
  "floating-mac-desktop",
  "app-control",
  "floating-app-control",
];

/** How a surface that lives in the tools pane is shown there. */
type PaneSurfaceRoute = {
  /** The tools-pane tab that shows this surface on this host. */
  tool: "ios" | DesktopWorkTool | "app-control";
  /** The floating surface the brain names when this one floats instead. */
  floating: WorkToolShowSurface;
  showFloating: (
    request: WorkToolShowRequest,
  ) => WorkToolShowOutcome | Promise<WorkToolShowOutcome>;
};

function showPaneTool({
  chatSessionId,
  tool,
  scopeKey,
  activeLaneId,
  setTool,
}: {
  chatSessionId: string;
  tool: "ios" | DesktopWorkTool | "app-control";
  scopeKey: string;
  activeLaneId: string | null;
  /**
   * Which setter to select the tool with. `showWorkSurface` passes the
   * non-revealing one whenever the person's pane is already open (or the
   * surface has a floating player to fall back to), so an agent's ask cannot
   * re-open a pane they closed; it passes the revealing one only when opening
   * the pane is the only way left to answer.
   */
  setTool: (tool: WorkSidebarTab) => void;
}): Promise<WorkToolShowOutcome> {
  // The preview marker is keyed `mac-desktop` on both hosts (see `MacDesktopMiniPlayer`).
  setWorkLivePreviewEnabledForChat(chatSessionId, tool === "windows-desktop" ? "mac-desktop" : tool, true);
  setTool(tool);
  return showOutcomeWhenOnScreen(workSurfaceKey(tool, scopeKey, activeLaneId));
}

/**
 * A floating handler's outcome, named as the surface it floats.
 *
 * `ade ui show mac-desktop` with the tools pane closed is answered by the lane's
 * floating card, and the agent is told that (see `WorkToolShowAck.shownAs`)
 * rather than being left to look for a pane that is still closed.
 */
function asFloating(
  result: WorkToolShowOutcome | Promise<WorkToolShowOutcome>,
  surface: WorkToolShowSurface,
): WorkToolShowOutcome | Promise<WorkToolShowOutcome> {
  const name = (outcome: WorkToolShowOutcome): WorkToolShowOutcome =>
    (outcome === "shown" ? { shownAs: surface } : outcome);
  return result instanceof Promise ? result.then(name) : name(result);
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
 *
 * App Control follows it too, with its own floating player and grants
 * (`appControlCardGrants`): the lane's app floats over the chat whose agent
 * drives it, unless the chat turned its preview off.
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
  showWorkSidebarTool,
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
  /** A person's pick: activates the tool and reveals the pane. */
  setWorkSidebarTool: (tool: WorkSidebarTab) => void;
  /**
   * A surface request's tool: activates it in an already-open pane and leaves a
   * closed one closed (`useWorkSidebarTool.showTool`).
   */
  showWorkSidebarTool: (tool: WorkSidebarTab) => void;
}): AppleMiniPlayerSurface | null {
  /*
   * Built from the SESSION in front, never from `activeLaneId`: on the
   * new-chat screen that falls back to the composer's draft lane, so a lane's
   * simulator would read as "belonging" to a new chat that has not started
   * anywhere. No session, no surface: the player hides
   * without closing.
   */
  const appleMiniPlayerSurface = useMemo<AppleMiniPlayerSurface | null>(() => (
    activeWorkSession
      ? { laneId: activeWorkSession.laneId || null, runtimePin, boundBinding: projectBinding }
      : null
  ), [activeWorkSession, projectBinding, runtimePin]);

  const scopeKey = workRuntimeScopeKey(runtimePin, projectBinding);
  const appleToolOpening = workSidebarVisible && workSidebarTool === "ios";
  /*
   * `mac-desktop` is the surface name on every host; the pane tool that shows
   * it is the host's own (`hostDesktopTool`, the rule the tools pane uses).
   * This hook runs above `NativeToolFeedsProvider`, so it takes the platform
   * from the same cached capability read rather than from the provider's
   * context; it costs no extra round trip.
   */
  const desktopSupport = useMacDesktopSupport({ runtimePin, enabled: active });
  const desktopTool = hostDesktopTool({ hostPlatform: desktopSupport?.platform ?? null });
  const macDesktopToolOpening = workSidebarVisible && workSidebarTool === desktopTool;
  const appControlToolOpening = workSidebarVisible && workSidebarTool === "app-control";
  /*
   * A floating card shows one lane's screen or app, so it floats only when the
   * chat's own lane is the lane the pane grants it on, and the request (when it
   * names a lane) names that same lane. A lane-less chat, whose tools borrow
   * the pane's fallback lane, gets none.
   */
  const floatsOnChatLane = useCallback((request: WorkToolShowRequest): boolean => {
    const chatLaneId = activeWorkSession?.laneId || null;
    return Boolean(
      chatLaneId
        && chatLaneId === activeLaneId
        && (!request.laneId || request.laneId === chatLaneId),
    );
  }, [activeLaneId, activeWorkSession]);

  /**
   * A lane surface as its floating player, for an ask the pane cannot take.
   *
   * The Mac Desktop player and the App Control player answer the same three
   * questions — is this card's own lane the chat's, is the pane already showing
   * it, and may an automatic offer float — and differ only in the names they
   * are registered under. One rule, one place to change it.
   *
   * Named by `floating-mac-desktop` / `floating-app-control`, and reached from
   * the pane surface of the same name while the person has the pane closed:
   * their layout is theirs, so the surface an agent drives continuously floats
   * over the chat instead of re-opening the pane every time they close it.
   */
  const showFloatingCard = useCallback((
    request: WorkToolShowRequest,
    card: {
      /** The pane tool whose on-screen state outranks the card. */
      tool: DesktopWorkTool | "app-control";
      /**
       * The key both the preview toggle and the × marker are written under.
       * `mac-desktop` on both hosts: see `MacDesktopMiniPlayer`.
       */
      previewKey: "mac-desktop" | "app-control";
      /** The key this card registers under while it is shown. */
      onScreenKey: string;
      /** The pane is opening this tool right now, so an offer would be undone. */
      paneOpening: boolean;
      grant: (laneId: string | null, chatSessionId: string) => boolean;
    },
  ): WorkToolShowOutcome | Promise<WorkToolShowOutcome> => {
    // Only over a chat of the card's own lane.
    if (!floatsOnChatLane(request)) return "declined";
    // The pane outranks the card for the lane's one decoder
    // (`macDesktopLiveViewLease`), so it is showing the surface already.
    if (isWorkSurfaceOnScreen(workSurfaceKey(card.tool, scopeKey, activeLaneId))) return "shown";
    if (request.auto) {
      if (card.paneOpening) return "declined";
      if (!isWorkLivePreviewEnabled(readChatCompanionUiState(request.chatSessionId), card.previewKey)) {
        return "declined";
      }
      return card.grant(activeLaneId, request.chatSessionId) ? "shown" : "declined";
    }
    // Asked for by name: undo an earlier × and float the card now, with the
    // Off state and its Start when there is no display.
    floatWorkLiveCardForChat(request.chatSessionId, card.previewKey);
    card.grant(activeLaneId, request.chatSessionId);
    return showOutcomeWhenOnScreen(workSurfaceKey(card.onScreenKey, scopeKey, activeLaneId));
  }, [activeLaneId, floatsOnChatLane, scopeKey]);

  const showFloatingMacDesktop = useCallback(
    (request: WorkToolShowRequest): WorkToolShowOutcome | Promise<WorkToolShowOutcome> => showFloatingCard(request, {
      tool: desktopTool,
      previewKey: "mac-desktop",
      onScreenKey: MAC_DESKTOP_CARD_ON_SCREEN_KEY,
      paneOpening: macDesktopToolOpening,
      grant: grantMacDesktopCardForChat,
    }),
    [desktopTool, macDesktopToolOpening, showFloatingCard],
  );

  const showFloatingAppControl = useCallback(
    (request: WorkToolShowRequest): WorkToolShowOutcome | Promise<WorkToolShowOutcome> => showFloatingCard(request, {
      tool: "app-control",
      previewKey: "app-control",
      onScreenKey: APP_CONTROL_CARD_ON_SCREEN_KEY,
      paneOpening: appControlToolOpening,
      grant: grantAppControlCardForChat,
    }),
    [appControlToolOpening, showFloatingCard],
  );

  /** The lane's Apple device as the floating player. */
  const showFloatingApple = useCallback((
    request: WorkToolShowRequest,
  ): WorkToolShowOutcome | Promise<WorkToolShowOutcome> => {
    // The Apple tool is already on screen in the pane.
    if (isWorkSurfaceOnScreen(workSurfaceKey("ios", scopeKey, activeLaneId))) return "shown";
    // The player only floats over a chat of its own lane, so a lane-less chat
    // (whose tools borrow the pane's fallback lane) gets none.
    if (!activeWorkSession?.laneId) return "declined";
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
  }, [activeLaneId, activeWorkSession, appleToolOpening, runtimePin, scopeKey]);

  /**
   * The three surfaces that live in the tools pane, and the floating surface
   * each one becomes when the person has the pane closed.
   *
   * One row per surface rather than three copies of the same branch. The tool
   * is the host's own for `mac-desktop` (`hostDesktopTool`), and each floating
   * surface is the one the brain names in an ack (`WorkToolShowAck.shownAs`).
   */
  const paneSurfaces = useMemo<Partial<Record<WorkToolShowSurface, PaneSurfaceRoute>>>(() => ({
    apple: { tool: "ios", floating: "floating-apple", showFloating: showFloatingApple },
    "mac-desktop": {
      tool: desktopTool,
      floating: "floating-mac-desktop",
      showFloating: showFloatingMacDesktop,
    },
    "app-control": {
      tool: "app-control",
      floating: "floating-app-control",
      showFloating: showFloatingAppControl,
    },
  }), [desktopTool, showFloatingAppControl, showFloatingApple, showFloatingMacDesktop]);

  const showWorkSurface = useCallback((
    request: WorkToolShowRequest,
  ): WorkToolShowOutcome | Promise<WorkToolShowOutcome> => {
    if (!activeWorkSession || request.chatSessionId !== activeWorkSession.id) return "declined";
    /*
     * One lane for every surface: `activeLaneId`, the one the pane mounts its
     * tools under. Writing the tool into the store is a request, not a result:
     * "shown" is answered only once the tool is on screen there.
     *
     * A screen or app tool the agent drives continuously never opens a closed
     * pane. Openness is the person's workspace preference — the pane is where
     * they put it, and a request that arrived while they were elsewhere is not
     * a reason to take their layout back. With the pane open the tool activates
     * in it as before; with the pane closed the floating player shows the same
     * surface over the chat, which is what the ask was for anyway.
     *
     * The pane is still where an ask goes when nothing can float it: a
     * lane-less chat, whose screen is the pane's fallback lane, and a request
     * naming another lane (`floatsOnChatLane`). Declining those would leave the
     * agent with a `held` that never lands, so the pane opens as it always did.
     * The browser is the same kind of case by choice — `ade browser handoff` is
     * an agent saying it cannot get past a page and the person has to act there.
     */
    if (request.surface === "browser") {
      setWorkSidebarTool("browser");
      return showOutcomeWhenOnScreen(workSurfaceKey("browser", scopeKey, activeLaneId));
    }
    const pane = paneSurfaces[request.surface];
    if (pane) {
      const openPane = (reveal: boolean) => showPaneTool({
        chatSessionId: request.chatSessionId,
        tool: pane.tool,
        scopeKey,
        activeLaneId,
        // Revealing only when opening the pane is the only way left to answer:
        // an agent's ask must not re-open a pane the person closed. The
        // revealing setter is the person's own (it also counts the tool as
        // opened), which is right here — the pane opening IS this installation
        // opening that tool, whoever asked.
        setTool: reveal ? setWorkSidebarTool : showWorkSidebarTool,
      });
      if (workSidebarVisible) return openPane(false);
      if (floatsOnChatLane(request)) {
        const floated = asFloating(pane.showFloating(request), pane.floating);
        // An automatic offer is not a person's request and never rearranges
        // their layout to show itself.
        if (request.auto) return floated;
        // A float can still decline — a lane with no device to float, say. The
        // chat's handler is registered right here, so a `declined` would be
        // held for a chat that can never drain it: the pane takes the ask after
        // all rather than leaving the agent a promise nobody keeps.
        // The caller awaits either way, so the value-or-promise duality is
        // settled once here rather than at each read.
        return Promise.resolve(floated)
          .then((outcome) => (outcome === "declined" ? openPane(true) : outcome));
      }
      // Nothing can float this surface for this chat: a lane-less chat, or a
      // request naming another lane.
      if (request.auto) return "declined";
      return openPane(true);
    }
    if (request.surface === "floating-mac-desktop") return showFloatingMacDesktop(request);
    if (request.surface === "floating-app-control") return showFloatingAppControl(request);
    if (request.surface !== "floating-apple") return "declined";
    return showFloatingApple(request);
  }, [
    activeLaneId,
    activeWorkSession,
    floatsOnChatLane,
    paneSurfaces,
    scopeKey,
    setWorkSidebarTool,
    showFloatingAppControl,
    showFloatingApple,
    showFloatingMacDesktop,
    showWorkSidebarTool,
    workSidebarVisible,
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
      if (!isAddressedToThisDesktop(event.targetClientId)) return;
      if (!appleEventAddresses(event, { chatSessionId: sessionId, laneId: sessionLaneId, acceptUnscoped: false })) return;
      setWorkSidebarTool("ios");
    }, runtimePin);
  }, [active, runtimePin, sessionId, sessionLaneId, setWorkSidebarTool]);

  return appleMiniPlayerSurface;
}
