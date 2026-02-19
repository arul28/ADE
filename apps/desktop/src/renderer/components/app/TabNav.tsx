import React, { useCallback, useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { BookOpenText, Bug, FileCode2, GitPullRequest, History, LayoutGrid, Network, Play, Rocket, Settings, TerminalSquare, Wand2 } from "lucide-react";
import { cn } from "../ui/cn";
import { useAppStore } from "../../state/appStore";
import { revealLabel } from "../../lib/platform";
import { layoutTransition } from "../../lib/motion";

const items = [
  { to: "/project", label: "Run", icon: Play },
  { to: "/lanes", label: "Lanes", icon: LayoutGrid },
  { to: "/files", label: "Files", icon: FileCode2 },
  { to: "/terminals", label: "Terminals", icon: TerminalSquare },
  { to: "/conflicts", label: "Conflicts", icon: Bug },
  { to: "/context", label: "Context", icon: BookOpenText },
  { to: "/graph", label: "Graph", icon: Network },
  { to: "/prs", label: "PRs", icon: GitPullRequest },
  { to: "/history", label: "History", icon: History },
  { to: "/automations", label: "Automations", icon: Wand2 },
  { to: "/missions", label: "Missions", icon: Rocket },
  { to: "/settings", label: "Settings", icon: Settings }
] as const;

export function TabNav() {
  const project = useAppStore((s) => s.project);
  const terminalAttention = useAppStore((s) => s.terminalAttention);
  const location = useLocation();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [hoveredTab, setHoveredTab] = useState<string | null>(null);

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

  return (
    <>
      <nav
        className="flex flex-col gap-1.5 w-full items-center"
        onContextMenu={handleContextMenu}
      >
        {items.map((it) => {
          const isActive = location.pathname === it.to;
          return (
            <NavLink
              key={it.to}
              to={it.to}
              className="relative flex items-center justify-center w-10 h-10 rounded-xl text-muted-fg/60 transition-colors duration-150 hover:text-fg hover:bg-muted/40"
              onMouseEnter={() => setHoveredTab(it.to)}
              onMouseLeave={() => setHoveredTab(null)}
            >
              {isActive && (
                <motion.div
                  layoutId="tab-indicator"
                  className="absolute inset-0 rounded-xl bg-accent/15 ring-1 ring-inset ring-accent/10"
                  transition={layoutTransition}
                />
              )}
              <motion.span
                className="relative inline-flex items-center justify-center"
                animate={{ scale: isActive ? 1.1 : 1 }}
                whileHover={{ scale: 1.05 }}
                transition={{ type: "spring", stiffness: 300, damping: 20 }}
              >
                <it.icon
                  className={cn(
                    "h-[18px] w-[18px] transition-colors duration-150",
                    isActive && "text-accent"
                  )}
                  style={isActive ? { filter: "drop-shadow(0 0 4px var(--color-accent))" } : undefined}
                />
                {it.to === "/terminals" && terminalAttention.indicator !== "none" ? (
                  <span
                    title={
                      terminalAttention.indicator === "running-needs-attention"
                        ? `${terminalAttention.needsAttentionCount} terminal${terminalAttention.needsAttentionCount === 1 ? " needs" : "s need"} input`
                        : "All active terminals running"
                    }
                    className={cn(
                      "absolute -right-1.5 -top-1.5 h-2.5 w-2.5 rounded-full border-2 border-t-transparent animate-spin",
                      terminalAttention.indicator === "running-needs-attention" ? "border-amber-400" : "border-emerald-500"
                    )}
                  />
                ) : null}
              </motion.span>
              {/* Tooltip */}
              {hoveredTab === it.to && (
                <div className="pointer-events-none absolute left-full ml-2 z-50 whitespace-nowrap rounded-lg bg-[--color-surface-overlay] px-2.5 py-1 text-[11px] font-medium text-fg shadow-float backdrop-blur-xl">
                  {it.label}
                </div>
              )}
            </NavLink>
          );
        })}
      </nav>
      {contextMenu && project?.rootPath ? (
        <div
          className="fixed z-40 min-w-[190px] rounded-xl bg-[--color-surface-overlay] p-1 shadow-float backdrop-blur-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted/60" onClick={() => {
            setContextMenu(null);
            window.ade.app.revealPath(project.rootPath).catch(() => {});
          }}>{revealLabel}</button>
        </div>
      ) : null}
    </>
  );
}
