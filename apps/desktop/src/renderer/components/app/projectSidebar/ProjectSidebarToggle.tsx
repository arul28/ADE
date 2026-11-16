import React from "react";
import { SidebarSimple } from "@phosphor-icons/react";
import { SmartTooltip } from "../../ui/SmartTooltip";
import { toggleProjectSidebarHidden, useProjectSidebarDrawerState, useProjectSidebarHidden } from "./projectSidebarPrefs";

/**
 * The top bar's sidebar toggle. It lives in its own component so only this
 * button, not the whole top bar, re-renders while the sidebar is resized.
 *
 * `locked` is set on Settings, which holds the docked sidebar open, so the
 * toggle is disabled there. A collapsed sidebar shows the toggle in the accent
 * colour with a dot, so it is easy to find. At phone width on ADE Web the
 * toggle opens and closes the drawer on every page, Settings too, and a closed
 * drawer is the normal state, so it shows no dot.
 */
export function ProjectSidebarToggle({ shortcut, locked = false }: { shortcut: string | null; locked?: boolean }) {
  const hidden = useProjectSidebarHidden();
  const drawerState = useProjectSidebarDrawerState();
  const isLocked = locked && drawerState === "off";
  const collapsed = hidden && !isLocked;
  const description = isLocked
    ? "Settings keeps the sidebar open."
    : collapsed
      ? "Show the project sidebar."
      : "Hide the project sidebar.";
  return (
    <SmartTooltip
      content={{
        label: "Toggle sidebar",
        description,
        // The shortcut does nothing on Settings, so the hint is not offered there.
        shortcut: isLocked ? undefined : shortcut ?? undefined,
      }}
      wrapperStyle={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <button
        type="button"
        className="ade-shell-control relative inline-flex h-[24px] w-[24px] shrink-0 items-center justify-center aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
        data-variant="ghost"
        data-collapsed={collapsed && drawerState === "off" ? "true" : undefined}
        aria-label="Toggle sidebar"
        aria-pressed={!collapsed}
        aria-disabled={isLocked || undefined}
        onClick={isLocked ? undefined : toggleProjectSidebarHidden}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <SidebarSimple size={16} weight="regular" />
        {collapsed && drawerState === "off" ? (
          <span aria-hidden className="absolute right-[3px] top-[3px] h-1.5 w-1.5 rounded-full bg-accent" />
        ) : null}
      </button>
    </SmartTooltip>
  );
}
