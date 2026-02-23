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
  { to: "/automations", label: "Automations", icon: Robot },
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
        className={cn(
          "relative flex items-center w-full h-9 rounded-md transition-colors duration-100 group",
          "text-muted-fg/70 hover:text-fg hover:bg-muted/30",
        )}
      >
        {/* Active indicator bar */}
        {isActive && (
          <motion.div
            layoutId="tab-indicator"
            className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-accent"
            transition={layoutTransition}
          />
        )}

        {/* Fixed-width icon container - never moves during collapse */}
        <span className="flex items-center justify-center w-[52px] shrink-0">
          <span className="relative inline-flex items-center">
            <it.icon
              size={18}
              weight="regular"
              className={cn(
                "transition-colors duration-150 shrink-0",
                isActive ? "text-accent" : "group-hover:text-fg/70",
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
            "ade-tab-label text-xs font-medium whitespace-nowrap",
            isActive && "text-fg font-medium",
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
        <div className="mx-3 my-1 border-t border-border/20" />

        {/* Tool navigation items */}
        <div className="flex flex-col gap-px">
          {mainItems.slice(4).map((it) => renderItem(it))}
        </div>

        {/* Spacer pushes settings to bottom */}
        <div className="mt-auto" />

        {/* Divider line before settings */}
        <div className="mx-2 mb-1 border-t border-border/20" />

        {/* Settings pinned to bottom */}
        {renderItem(settingsItem)}
      </nav>

      {/* Context menu */}
      {contextMenu && project?.rootPath ? (
        <div
          className="fixed z-40 min-w-[170px] rounded bg-[--color-surface-overlay] border border-border/50 p-0.5 shadow-float"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            className="block w-full rounded-sm px-2 py-1 text-left text-[11px] font-mono hover:bg-muted/40"
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
