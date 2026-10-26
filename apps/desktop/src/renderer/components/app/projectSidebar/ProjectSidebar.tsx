import React, { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GearSix } from "@phosphor-icons/react";
import { cn } from "../../ui/cn";
import { useAppStore } from "../../../state/appStore";
import { isWebClientMode, WEB_CLIENT_TAB_PATHS } from "../../../lib/webClientMode";
import { pressActivation } from "../../../lib/pressActivation";
import { readStoredProjectSettingsRoute } from "../projectRouteStorage";
import { HelpMenu } from "../../onboarding/HelpMenu";
import {
  commitProjectSidebarWidth,
  getProjectSidebarPrefs,
  setProjectSidebarWidth,
  useProjectSidebarPrefs,
} from "./projectSidebarPrefs";
import { useProjectSidebarSlotTarget } from "./ProjectSidebarSlot";
import { StarRepoPill } from "./StarRepoPill";
import { lastSettingsRoute, rememberProjectRoute, settingsReturnRoute } from "./settingsReturnRoute";
import {
  PROJECT_SIDEBAR_FOOTER_TABS,
  PROJECT_SIDEBAR_TABS,
  projectSidebarShortcutLabel,
  projectSidebarTabForPath,
  projectSidebarTabTarget,
  visibleProjectSidebarTabs,
} from "./projectSidebarTabs";
import { cssZoomOf } from "../../../lib/webZoom";

export { projectSidebarTabForPath };

/**
 * `heldRoute` is set while CTO or History is open: the page you came from,
 * which still owns the sidebar list. Its tab stays selected beside the active
 * footer item, and the held tab or opening a chat from the held Work list
 * returns to it.
 */
export function ProjectSidebar({ route, heldRoute = null }: { route: string; heldRoute?: string | null }) {
  const navigate = useNavigate();
  const { width, hidden: hiddenByPreference } = useProjectSidebarPrefs();
  const setSlotTarget = useProjectSidebarSlotTarget();
  // Select scalars only: the sidebar sits beside every tab page, and a wide
  // selector here would re-render it on every unrelated store write.
  const projectRoot = useAppStore((s) => (s.projectBinding?.kind === "remote" ? s.projectBinding.rootPath : s.project?.rootPath ?? null));
  const bindingKey = useAppStore((s) => s.projectBinding?.key ?? null);
  const workIndicator = useAppStore((s) => s.terminalAttention.indicator);
  const needsYouCount = useAppStore((s) => s.terminalAttention.needsAttentionCount);
  const ctoAwaitingInput = useAppStore((s) => s.ctoAttention.awaitingInput);
  const keybindings = useAppStore((s) => s.keybindings);
  const pathname = route.split(/[?#]/, 1)[0] || "/work";
  const activeTab = projectSidebarTabForPath(pathname);
  const heldTab = heldRoute ? projectSidebarTabForPath(heldRoute.split(/[?#]/, 1)[0] || "/work") : null;
  const settingsActive = pathname === "/settings" || pathname.startsWith("/settings/");
  // Settings keeps the sidebar open. The saved preference is left alone, so
  // leaving Settings restores the sidebar the way the user had it.
  const hidden = hiddenByPreference && !settingsActive;
  const settingsVisible = !isWebClientMode() || WEB_CLIENT_TAB_PATHS.has("/settings");
  const routeKey = bindingKey ?? (projectRoot ? `local:${projectRoot}` : null);
  // The star pill is a desktop-only nudge, shown under the Work session list.
  const starPillSlotActive = !isWebClientMode() && !heldRoute && activeTab === "/work";

  // The tab a click asked for, shown before the route commits. The tab strip
  // starts its animation on the click, and the new page mounts after it.
  const [pendingTab, setPendingTab] = useState<string | null>(null);
  // Under CTO or History the tab whose list fills the sidebar (Work, Lanes)
  // stays selected, so the list below it keeps its label.
  const shownTab = pendingTab ?? heldTab ?? activeTab;
  useEffect(() => {
    setPendingTab(null);
  }, [route]);

  useEffect(() => {
    rememberProjectRoute(routeKey, route);
  }, [route, routeKey]);

  const goTo = useCallback(
    (target: string) => {
      // Let the tab strip paint its first frame, then mount the page as a
      // transition so React yields to the animation while it renders.
      window.requestAnimationFrame(() => {
        startTransition(() => {
          void navigate(target);
        });
      });
    },
    [navigate],
  );

  const openTab = useCallback(
    (to: string) => {
      setPendingTab(to);
      // The held tab returns to exactly where you were on it.
      goTo(heldRoute && heldTab === to ? heldRoute : projectSidebarTabTarget(to, projectRoot));
    },
    [goTo, heldRoute, heldTab, projectRoot],
  );

  // The held Work list stays live under CTO: opening a chat from it (the row
  // selects it in the held page) also brings that page back on screen, so the
  // click is never swallowed by the overlay. Native listener, because the list
  // is portalled in and React bubbles portal events to its owner, not here.
  const [bodyElement, setBodyElement] = useState<HTMLDivElement | null>(null);
  const setBodyRef = useCallback((node: HTMLDivElement | null) => {
    setBodyElement(node);
    setSlotTarget(node);
  }, [setSlotTarget]);
  useEffect(() => {
    if (!bodyElement || !heldRoute || heldTab !== "/work") return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest("[data-session-row], [data-session-row-action]");
      if (!row || target?.closest("[aria-haspopup], [role='menu'], [role='menuitem'], input, textarea")) return;
      void navigate(heldRoute.split(/[?#]/, 1)[0] || "/work");
    };
    bodyElement.addEventListener("click", onClick);
    return () => bodyElement.removeEventListener("click", onClick);
  }, [bodyElement, heldRoute, heldTab, navigate]);

  const openSettings = useCallback(() => {
    // The cog is a toggle: from Settings it returns to where you were.
    if (settingsActive) {
      navigate(settingsReturnRoute(routeKey));
      return;
    }
    // Otherwise it reopens the last Settings section of this project.
    const stored = lastSettingsRoute(routeKey)
      ?? (routeKey ? readStoredProjectSettingsRoute(routeKey) : null)
      ?? (projectRoot && projectRoot !== routeKey ? readStoredProjectSettingsRoute(projectRoot) : null);
    navigate(stored ?? "/settings");
  }, [navigate, projectRoot, routeKey, settingsActive]);

  return (
    <aside
      className="ade-project-sidebar relative flex h-full min-h-0 shrink-0 flex-col"
      hidden={hidden}
      style={{ width, display: hidden ? "none" : undefined }}
      data-tour="app.sidebar"
      data-testid="project-sidebar"
    >
      <nav className="ade-project-sidebar-tabs shrink-0" aria-label="Project tabs">
        {visibleProjectSidebarTabs(PROJECT_SIDEBAR_TABS).map((tab) => {
          const active = shownTab === tab.to;
          const attention =
            tab.to === "/work" && workIndicator !== "none"
              ? workIndicator === "running-needs-attention"
                ? "warning"
                : "active"
              : null;
          const shortcut = projectSidebarShortcutLabel(keybindings, tab.keybinding);
          const attentionLabel =
            attention === "warning" && needsYouCount > 0
              ? ` · ${needsYouCount} need${needsYouCount === 1 ? "s" : ""} you`
              : "";
          return (
            <button
              key={tab.to}
              type="button"
              className="ade-project-sidebar-tab"
              data-active={active ? "true" : undefined}
              aria-current={active ? "page" : undefined}
              aria-label={tab.label}
              title={`${tab.label}${attentionLabel}${shortcut ? `  ${shortcut}` : ""}`}
              // A tab opens on the press. The click it replaces fires on mouse-up.
              {...pressActivation(() => openTab(tab.to))}
            >
              <span className="relative inline-flex shrink-0">
                <tab.icon size={16} weight={active ? "fill" : "regular"} />
                {attention ? (
                  <span
                    className={cn(
                      "absolute -right-1 -top-1 ade-status-dot",
                      attention === "warning" ? "ade-status-dot-warning" : "ade-status-dot-active",
                    )}
                  />
                ) : null}
              </span>
              <span className="ade-project-sidebar-tab-label">{tab.label}</span>
            </button>
          );
        })}
      </nav>

      <div ref={setBodyRef} className="ade-project-sidebar-body relative flex min-h-0 flex-1 flex-col" />

      {starPillSlotActive ? <StarRepoPill /> : null}

      <div className="ade-project-sidebar-footer shrink-0">
        {visibleProjectSidebarTabs(PROJECT_SIDEBAR_FOOTER_TABS).map((item) => {
          const active = activeTab === item.to;
          const waiting = item.to === "/cto" && ctoAwaitingInput;

          return (
            <button
              key={item.to}
              type="button"
              className="ade-project-sidebar-footer-item"
              data-active={active ? "true" : undefined}
              aria-current={active ? "page" : undefined}
              title={waiting ? "The CTO is waiting on you" : undefined}
              // Pressing the open item keeps it open (CTO stays on its thread);
              // the held tab above, or a chat in its list, leads back.
              {...pressActivation(() => {
                if (active) return;
                openTab(item.to);
              })}
            >
              <span className="relative inline-flex shrink-0">
                <item.icon size={15} weight={active ? "fill" : "regular"} />
                {waiting ? (
                  <span className="absolute -right-1 -top-1 ade-status-dot ade-status-dot-warning" />
                ) : null}
              </span>
              <span>{item.label}</span>
            </button>
          );
        })}
        {/* Help: ADE Tips, "Show me around again", docs. */}
        <HelpMenu
          align="start"
          side="above"
          className="ade-project-sidebar-footer-item ade-project-sidebar-footer-help"
          iconSize={15}
        />
        {settingsVisible ? (
          <button
            type="button"
            className="ade-project-sidebar-footer-item ade-project-sidebar-footer-settings"
            data-active={settingsActive ? "true" : undefined}
            aria-current={settingsActive ? "page" : undefined}
            aria-label="Settings"
            title={settingsActive ? "Back" : "Settings"}
            {...pressActivation(openSettings)}
          >
            <GearSix size={15} weight={settingsActive ? "fill" : "regular"} />
          </button>
        ) : null}
      </div>

      <ProjectSidebarResizeHandle />
    </aside>
  );
}

function ProjectSidebarResizeHandle() {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: getProjectSidebarPrefs().width };
    document.body.classList.add("ade-project-sidebar-resizing");
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    // The pointer delta is screen px; the sidebar width is layout px.
    setProjectSidebarWidth(drag.startWidth + (event.clientX - drag.startX) / cssZoomOf());
  }, []);

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("ade-project-sidebar-resizing");
    commitProjectSidebarWidth();
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      className="ade-project-sidebar-resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}
