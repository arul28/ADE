import React, { createContext, useContext, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The project sidebar owns an empty body element. Each tab page renders its
 * list into that element through `ProjectSidebarSlot`, a portal. The list
 * stays in the page's React tree, so it keeps the page's state, context and
 * callbacks; only its DOM moves into the sidebar.
 */

type ProjectSidebarSlotContextValue = {
  slotElement: HTMLElement | null;
  setSlotElement: (element: HTMLElement | null) => void;
  /** Slots that passed `active`. A held list yields while this is non-zero. */
  activeClaimCount: number;
  claimSidebar: () => () => void;
};

const ProjectSidebarSlotContext = createContext<ProjectSidebarSlotContextValue | null>(null);

export function ProjectSidebarSlotProvider({ children }: { children: React.ReactNode }) {
  const [slotElement, setSlotElement] = useState<HTMLElement | null>(null);
  const [activeClaimCount, setActiveClaimCount] = useState(0);
  const claimSidebar = useMemo(() => {
    return () => {
      setActiveClaimCount((count) => count + 1);
      return () => setActiveClaimCount((count) => count - 1);
    };
  }, []);
  const value = useMemo(
    () => ({ slotElement, setSlotElement, activeClaimCount, claimSidebar }),
    [slotElement, activeClaimCount, claimSidebar],
  );
  return <ProjectSidebarSlotContext.Provider value={value}>{children}</ProjectSidebarSlotContext.Provider>;
}

/** Ref callback for the sidebar body that receives the portals. */
export function useProjectSidebarSlotTarget(): (element: HTMLElement | null) => void {
  return useContext(ProjectSidebarSlotContext)?.setSlotElement ?? noopSetSlot;
}

/** True when a project sidebar exists above this component. */
export function useHasProjectSidebar(): boolean {
  return useContext(ProjectSidebarSlotContext) != null;
}

function noopSetSlot(): void {}

/**
 * CTO and History open over the page you were on. That page stays mounted
 * behind them, inactive, and this keeps its sidebar list on screen so the
 * sidebar looks exactly as you left it.
 */
const ProjectSidebarHoldContext = createContext(false);

export function ProjectSidebarHold({ held, children }: { held: boolean; children: React.ReactNode }) {
  return <ProjectSidebarHoldContext.Provider value={held}>{children}</ProjectSidebarHoldContext.Provider>;
}

/**
 * Renders `children` in the project sidebar body.
 *
 * Each slot gets its own container in the body. The container shows only
 * while `active` is true, so a page that stays mounted while hidden (Work)
 * keeps its list mounted too, and a return to that tab does not remount it.
 * Only the page that is on screen may pass `active`. A page held under CTO
 * or History (`ProjectSidebarHold`) shows its list while inactive, and hides
 * it again while another slot is active (CTO settings takes the sidebar).
 *
 * Outside a project sidebar (tests, the Work tools pane) nothing renders, so a
 * page must keep its own fallback column when `useHasProjectSidebar()` is false.
 */
export function ProjectSidebarSlot({ active, children }: { active: boolean; children: React.ReactNode }) {
  const slotContext = useContext(ProjectSidebarSlotContext);
  const slotElement = slotContext?.slotElement ?? null;
  const claimSidebar = slotContext?.claimSidebar;
  const held = useContext(ProjectSidebarHoldContext);
  const claimed = (slotContext?.activeClaimCount ?? 0) > 0;
  const shown = active || (held && !claimed);

  useLayoutEffect(() => {
    if (!active || !claimSidebar) return;
    return claimSidebar();
  }, [active, claimSidebar]);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!slotElement) return;
    const element = document.createElement("div");
    element.className = "ade-project-sidebar-slot";
    slotElement.appendChild(element);
    setContainer(element);
    return () => {
      element.remove();
      setContainer(null);
    };
  }, [slotElement]);

  useLayoutEffect(() => {
    if (!container) return;
    container.hidden = !shown;
    if (shown) container.removeAttribute("inert");
    else container.setAttribute("inert", "");
  }, [shown, container]);

  if (!container) return null;
  return createPortal(children, container);
}
