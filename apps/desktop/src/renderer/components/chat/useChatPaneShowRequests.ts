import type { WorkToolShowSurface } from "../../../shared/types/workToolShow";
import { useWorkSurfaceMountRef, workSurfaceKey } from "../../lib/workToolOnScreen";
import { showOutcomeWhenOnScreen, useWorkToolShowHandler } from "../../lib/workToolShowRequests";

const CHAT_PANE_SHOW_SURFACES: readonly WorkToolShowSurface[] = ["proof", "apple"];
const CHAT_PANE_SHOW_SURFACES_IN_WORK: readonly WorkToolShowSurface[] = ["proof"];

/** Chat drawers are addressed by chat id, which is unique across machines. */
const CHAT_SCOPE = "chat";

function drawerKey(surface: "proof" | "apple", chatSessionId: string | null): string | null {
  return chatSessionId ? workSurfaceKey(surface, CHAT_SCOPE, chatSessionId) : null;
}

/**
 * `ade ui show proof` for the chat this pane shows, while it is on screen.
 * Outside Work this pane also owns the chat's Apple drawer, so it takes
 * `ade ui show apple` too; in Work the tools pane does.
 *
 * "shown" means the drawer's own element is laid out in a visible window, the
 * same test the Work tools pass. Attach the returned refs to each drawer's body.
 */
export function useChatPaneShowRequests({
  chatSessionId,
  visible,
  laneToolDrawersHidden,
  laneId,
  openProofDrawer,
  openAppleDrawer,
}: {
  chatSessionId: string | null;
  /** The pane is on screen; a hidden tile registers nothing. */
  visible: boolean;
  /** In Work, where the tools pane owns the Apple device. */
  laneToolDrawersHidden: boolean;
  laneId: string | null;
  openProofDrawer: () => void;
  openAppleDrawer: () => void;
}): {
  proofDrawerRef: (element: HTMLDivElement | null) => void;
  appleDrawerRef: (element: HTMLDivElement | null) => void;
} {
  const proofDrawerRef = useWorkSurfaceMountRef<HTMLDivElement>(drawerKey("proof", chatSessionId));
  const appleDrawerRef = useWorkSurfaceMountRef<HTMLDivElement>(drawerKey("apple", chatSessionId));
  useWorkToolShowHandler(
    visible ? chatSessionId : null,
    laneToolDrawersHidden ? CHAT_PANE_SHOW_SURFACES_IN_WORK : CHAT_PANE_SHOW_SURFACES,
    (request) => {
      if (request.chatSessionId !== chatSessionId) return "declined";
      let surface: "proof" | "apple";
      if (request.surface === "proof") {
        openProofDrawer();
        surface = "proof";
      } else if (request.surface === "apple" && !laneToolDrawersHidden && laneId) {
        openAppleDrawer();
        surface = "apple";
      } else {
        return "declined";
      }
      return showOutcomeWhenOnScreen(workSurfaceKey(surface, CHAT_SCOPE, request.chatSessionId));
    },
  );
  return { proofDrawerRef, appleDrawerRef };
}
