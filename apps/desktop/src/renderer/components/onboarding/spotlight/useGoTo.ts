import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAppStore } from "../../../state/appStore";
import { findVisibleAnchor } from "../tour/anchorGeometry";
import { onDraftPage } from "../tour/onboardingTourSteps";

/**
 * Takes the user somewhere in the front window, on their click: the tour's
 * "Show me" and ADE Tips' "Try it". Pure navigation, no IPC: the places are
 * pages of the project tab in front (and its machine), or Home.
 *
 * - `"home"`: Home. With a project in front, a new tab's Home, as the top
 *   bar's + does.
 * - `"draft"`: a fresh new chat on Work, opened with Work's own New chat
 *   button so it gets the lane and machine Work would pick.
 * - a route (`"/work"`, `"/prs"`, `"/settings?tab=…#…"`): that page of the open
 *   project.
 *
 * Anything but Home needs an open project; with none, it goes Home, where the
 * projects are.
 */
export type GoToDestination = "home" | "draft" | `/${string}`;

/** Chats, Browser and Music are tabs of their own; Home lives behind the project route. */
const MACHINE_ROUTE = /^\/(chats|browser|music|account|hub)(\/|$)/;
const WORK_ROUTE = /^\/work(\/|$)/;

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Opens a fresh draft on Work with Work's own New chat button. Work restores
 * the last open chat a beat after it mounts, which can replace a draft that
 * showed first, so a draft only counts once it has stayed; until then New
 * chat is pressed again.
 */
async function openDraft(alive: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  let draftSince: number | null = null;
  let pressedAt = -Infinity;
  while (alive() && performance.now() < deadline) {
    const now = performance.now();
    if (onDraftPage()) {
      draftSince ??= now;
      if (now - draftSince >= 700) return;
    } else {
      draftSince = null;
      const newChat = findVisibleAnchor("new-chat");
      if (newChat && now - pressedAt > 900) {
        newChat.click();
        pressedAt = now;
      }
    }
    await wait(120);
  }
}

export function useGoTo(): (destination: GoToDestination) => void {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const runRef = useRef(0);
  useEffect(() => () => {
    runRef.current += 1;
  }, []);
  return useCallback((destination: GoToDestination) => {
    runRef.current += 1;
    const run = runRef.current;
    const store = useAppStore.getState();
    // Home, or nowhere else to go yet: every other place needs a project.
    if (destination === "home" || store.project == null) {
      store.openNewTab();
      if (MACHINE_ROUTE.test(pathRef.current)) navigate("/work");
      return;
    }
    if (store.isNewTabOpen) store.cancelNewTab();
    else if (store.showWelcome) store.setShowWelcome(false);
    if (store.standaloneSettingsOpen) store.setStandaloneSettingsOpen(false);
    const route = destination === "draft" ? "/work" : destination;
    if (route === "/work") {
      if (!WORK_ROUTE.test(pathRef.current)) navigate("/work");
    } else {
      navigate(route);
    }
    if (destination !== "draft") return;
    void openDraft(() => runRef.current === run);
  }, [navigate]);
}
