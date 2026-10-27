import { useEffect, useRef } from "react";
import { ADE_WELCOME_VIDEO_REPLAY_EVENT } from "../../../shared/welcomeVideo";
import { isWebClientMode } from "../../lib/webClientMode";
import { useAppStore } from "../../state/appStore";
import { ViewportOverlayPortal } from "../ui/ViewportOverlayHost";
import { DIALOG_SELECTOR, MODAL_DIALOG_SELECTOR } from "../ui/overlayState";
import { GateBackdrop } from "./GateBackdrop";
import { prefetchOnboardingDiscovery, showFirstRunProjects } from "./firstRunActions";
import { FirstRunStep, useFirstRunSteps } from "./FirstRunSteps";
import "./launchGateGlass.css";

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
 * Desktop only: the hosted web client controls other computers, and setup is
 * about the one it runs on. Over a project tab bound to another machine the
 * agents card is left out (`useFirstRunSteps`' `skipAgents`): its status and
 * sign-ins would go to that machine.
 */
export function OnboardingBootstrap() {
  const remoteTab = useAppStore((state) => state.projectBinding?.kind === "remote");
  const steps = useFirstRunSteps({
    enabled: !isWebClientMode(),
    skipAgents: remoteTab,
    onFinish: showFirstRunProjects,
  });
  const { phase, restart, skip } = steps;
  const gateRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (isWebClientMode()) return undefined;
    const replay = () => {
      // A replay finds projects again: some were added since the last run.
      void prefetchOnboardingDiscovery({ fresh: true }).catch(() => undefined);
      restart();
    };
    window.addEventListener(ADE_WELCOME_VIDEO_REPLAY_EVENT, replay);
    return () => window.removeEventListener(ADE_WELCOME_VIDEO_REPLAY_EVENT, replay);
  }, [restart]);

  const open = phase === "welcome" || phase === "agents" || phase === "projects";

  // Escape skips setup, as the welcome card's Skip does.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (escapeBelongsToInnerLayer(event, gateRef.current)) return;
      skip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, skip]);

  if (!open) return null;

  return (
    <ViewportOverlayPortal layer="dialog">
      <div
        ref={gateRef}
        className="ade-gate"
        role="dialog"
        aria-modal="true"
        aria-label="Set up ADE"
        style={{ pointerEvents: "auto" }}
      >
        <GateBackdrop />
        <FirstRunStep key={phase} step={phase} steps={steps} />
      </div>
    </ViewportOverlayPortal>
  );
}
