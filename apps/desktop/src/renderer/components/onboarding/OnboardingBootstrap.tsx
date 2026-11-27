import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { ADE_WELCOME_VIDEO_REPLAY_EVENT } from "../../../shared/welcomeVideo";
import { isWebClientMode } from "../../lib/webClientMode";
import { markOnboardingStarted } from "../../onboarding/onboardingProgress";
import { useAppStore } from "../../state/appStore";
import { LANE_SHARE_GUEST_ROUTE } from "../laneShare/guest/laneShareGuestRoute";
import { ViewportOverlayPortal } from "../ui/ViewportOverlayHost";
import { DIALOG_SELECTOR, MODAL_DIALOG_SELECTOR } from "../ui/overlayState";
import { GateBackdrop } from "./GateBackdrop";
import { prefetchOnboardingDiscovery, showFirstRunProjects } from "./firstRunActions";
import { FirstRunStep, useFirstRunSteps } from "./FirstRunSteps";
import "./launchGateGlass.css";
import { BRAND } from "../../../shared/brand";

/**
 * Layers opened over setup: a sheet or dialog (an agent sign-in, the phone
 * QR), a menu or a popover (the chat picker). Escape in one of them closes
 * it, not setup.
 */
const INNER_LAYER_SELECTOR = [
  DIALOG_SELECTOR,
  '[role="menu"]',
  '[role="listbox"]',
  "[data-radix-popper-content-wrapper]",
].join(", ");

/** Whether Escape belongs to something open over the setup card rather than to setup itself. */
function escapeBelongsToInnerLayer(event: KeyboardEvent, gate: HTMLElement | null): boolean {
  const target = event.target instanceof Element ? event.target : null;
  const fromLayer = target?.closest(INNER_LAYER_SELECTOR);
  if (fromLayer && fromLayer !== gate) return true;
  // Focus may have stayed on the control that opened it (a pill under its picker).
  if (gate?.querySelector(INNER_LAYER_SELECTOR)) return true;
  // A modal portalled outside the gate (the account sheet).
  return document.querySelectorAll(MODAL_DIALOG_SELECTOR).length > 1;
}

/**
 * First-run setup inside the running app. The launch gate runs it on a fresh
 * computer; this shows it again when:
 *
 * - the user picks "Show me around again" in the help menu, or
 * - the gate was already open when the app loaded (a reload during setup), so
 *   setup never finished here.
 *
 * In ADE Web it is also the welcome a new account sees on its first visit:
 * the welcome card alone (`welcomeOnly`), since the agents and projects cards
 * set up the computer ADE runs on and the web has none of its own. Over a
 * project tab bound to another machine the agents card is left out
 * (`useFirstRunSteps`' `skipAgents`): its status and sign-ins would go to
 * that machine.
 */
export function OnboardingBootstrap() {
  const remoteTab = useAppStore((state) => state.projectBinding?.kind === "remote");
  const web = isWebClientMode();
  const steps = useFirstRunSteps({
    welcomeOnly: web,
    skipAgents: remoteTab,
    onFinish: web ? undefined : showFirstRunProjects,
  });
  const { phase, restart, dismiss } = steps;
  // Someone opening a lane shared with them came for that lane: the welcome waits until they leave its page.
  const onSharedLanePage = useLocation().pathname.startsWith(LANE_SHARE_GUEST_ROUTE);
  const gateRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const replay = () => {
      // A replay finds projects again: some were added since the last run.
      if (!web) void prefetchOnboardingDiscovery({ fresh: true }).catch(() => undefined);
      restart();
    };
    window.addEventListener(ADE_WELCOME_VIDEO_REPLAY_EVENT, replay);
    return () => window.removeEventListener(ADE_WELCOME_VIDEO_REPLAY_EVENT, replay);
  }, [restart, web]);

  const open = !onSharedLanePage && (phase === "welcome" || phase === "agents" || phase === "projects");

  // ADE Web: the welcome counts as given once it is on screen, not when it was found due.
  useEffect(() => {
    if (open && web) markOnboardingStarted();
  }, [open, web]);

  // Escape closes setup; unlike the Skip link it never skips the tour.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (escapeBelongsToInnerLayer(event, gateRef.current)) return;
      dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dismiss]);

  if (!open) return null;

  return (
    <ViewportOverlayPortal layer="dialog">
      <div
        ref={gateRef}
        className="ade-gate"
        role="dialog"
        aria-modal="true"
        aria-label={`Set up ${BRAND.NAME}`}
        style={{ pointerEvents: "auto" }}
      >
        <GateBackdrop />
        <FirstRunStep key={phase} step={phase} steps={steps} />
      </div>
    </ViewportOverlayPortal>
  );
}
