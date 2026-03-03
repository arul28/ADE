import React, { useCallback, useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import {
  PlayCircle,
  GitBranch,
  FileCode,
  Terminal,
  GitMerge,
  Graph,
  GitPullRequest,
  ClockCounterClockwise,
  Robot,
  Strategy,
  GearSix,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { useAppStore } from "../../state/appStore";
import { revealLabel } from "../../lib/platform";
import { layoutTransition } from "../../lib/motion";

const mainItems = [
  { to: "/project", label: "Run", icon: PlayCircle },
  { to: "/lanes", label: "Lanes", icon: GitBranch },
  { to: "/files", label: "Files", icon: FileCode },
  { to: "/work", label: "Work", icon: Terminal },
  { to: "/conflicts", label: "Conflicts", icon: GitMerge },
  { to: "/graph", label: "Graph", icon: Graph },
  { to: "/prs", label: "PRs", icon: GitPullRequest },
  { to: "/history", label: "History", icon: ClockCounterClockwise },
  { to: "/automations", label: "Agents", icon: Robot },
  { to: "/missions", label: "Missions", icon: Strategy },
] as const;

const settingsItem = { to: "/settings", label: "Settings", icon: GearSix } as const;

export function TabNav() {
  const project = useAppStore((s) => s.project);
  const terminalAttention = useAppStore((s) => s.terminalAttention);
  const location = useLocation();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const onPointerDown = () => setContextMenu(null);
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [contextMenu]);

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY });
  }, []);

  const renderItem = (
    it: { to: string; label: string; icon: React.ElementType },
  ) => {
    const isActive = location.pathname === it.to;

    return (
      <NavLink
        key={it.to}
        to={it.to}
        data-active={isActive ? "true" : undefined}
        className={cn(
          "ade-shell-sidebar-item group relative flex w-full items-center transition-colors duration-100",
        )}
      >
        {/* Active indicator bar */}
        {isActive && (
          <motion.div
            layoutId="tab-indicator"
            className="ade-shell-sidebar-active-rail absolute bottom-1 left-0 top-1 w-[2px]"
            transition={layoutTransition}
          />
        )}

        {/* Fixed-width icon container - never moves during collapse */}
        <span className="ade-shell-sidebar-icon-slot flex items-center justify-center shrink-0">
          <span className="relative inline-flex items-center">
            <it.icon
              size={18}
              weight="regular"
              className={cn(
                "ade-shell-sidebar-icon shrink-0 transition-colors duration-150",
              )}
            />
            {/* Terminal attention dot */}
            {it.to === "/work" && terminalAttention.indicator !== "none" ? (
              <span
                title={
                  terminalAttention.indicator === "running-needs-attention"
                    ? `${terminalAttention.needsAttentionCount} terminal${terminalAttention.needsAttentionCount === 1 ? " needs" : "s need"} input`
                    : "All active terminals running"
                }
                className={cn(
                  "absolute -right-1 -top-1 ade-status-dot",
                  terminalAttention.indicator === "running-needs-attention"
                    ? "ade-status-dot-warning"
                    : "ade-status-dot-active",
                )}
              />
            ) : null}
          </span>
        </span>

        {/* Label - opacity-animated separately from width transition */}
        <span
          className={cn(
            "ade-tab-label whitespace-nowrap",
          )}
        >
          {it.label}
        </span>
      </NavLink>
    );
  };

  return (
    <>
      <nav
        className="flex flex-col gap-px w-full h-full"
        onContextMenu={handleContextMenu}
      >
        {/* Core navigation items */}
        <div className="flex flex-col gap-px">
          {mainItems.slice(0, 4).map((it) => renderItem(it))}
        </div>

        {/* Group separator */}
        <div className="ade-shell-sidebar-separator mx-3 my-1 border-t" />

        {/* Tool navigation items */}
        <div className="flex flex-col gap-px">
          {mainItems.slice(4).map((it) => renderItem(it))}
        </div>

        {/* Spacer pushes settings to bottom */}
        <div className="mt-auto" />

        {/* Divider line before settings */}
        <div className="ade-shell-sidebar-separator mx-2 mb-1 border-t" />

        {/* Settings pinned to bottom */}
        {renderItem(settingsItem)}
      </nav>

      {/* Context menu */}
      {contextMenu && project?.rootPath ? (
        <div
          className="ade-shell-sidebar-menu fixed z-40 min-w-[170px] rounded-none p-0.5 shadow-float"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            className="ade-shell-sidebar-menu-item block w-full rounded-none px-2 py-1 text-left"
            onClick={() => {
              setContextMenu(null);
              window.ade.app.revealPath(project.rootPath).catch(() => {});
            }}
          >
            {revealLabel}
          </button>
        </div>
      ) : null}
    </>
  );
}
