import React, { useCallback, useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { Bug, FileCode2, GitPullRequest, History, LayoutGrid, Network, Play, Rocket, Settings, TerminalSquare, Wand2 } from "lucide-react";
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
        className="flex flex-col gap-px w-full"
        onContextMenu={handleContextMenu}
      >
        {items.map((it) => {
          const isActive = location.pathname === it.to;
          return (
            <NavLink
              key={it.to}
              to={it.to}
              className="relative flex items-center gap-2.5 w-full h-8 px-2.5 rounded text-muted-fg/70 transition-colors duration-100 hover:text-fg hover:bg-muted/20 group"
            >
              {isActive && (
                <motion.div
                  layoutId="tab-indicator"
                  className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-accent"
                  transition={layoutTransition}
                />
              )}
              <span className="relative inline-flex items-center shrink-0">
                <it.icon
                  className={cn(
                    "h-[15px] w-[15px] transition-colors duration-100",
                    isActive ? "text-accent" : "group-hover:text-fg/70"
                  )}
                />
                {it.to === "/terminals" && terminalAttention.indicator !== "none" ? (
                  <span
                    title={
                      terminalAttention.indicator === "running-needs-attention"
                        ? `${terminalAttention.needsAttentionCount} terminal${terminalAttention.needsAttentionCount === 1 ? " needs" : "s need"} input`
                        : "All active terminals running"
                    }
                    className={cn(
                      "absolute -right-1 -top-1 h-2 w-2 rounded-full",
                      terminalAttention.indicator === "running-needs-attention" ? "bg-amber-400" : "bg-emerald-500"
                    )}
                  />
                ) : null}
              </span>
              <span className={cn(
                "font-mono text-[11px] tracking-wide truncate",
                isActive && "text-fg font-medium"
              )}>{it.label}</span>
            </NavLink>
          );
        })}
      </nav>
      {contextMenu && project?.rootPath ? (
        <div
          className="fixed z-40 min-w-[170px] rounded bg-[--color-surface-overlay] border border-border/50 p-0.5 shadow-float"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button className="block w-full rounded-sm px-2 py-1 text-left text-[11px] font-mono hover:bg-muted/40" onClick={() => {
            setContextMenu(null);
            window.ade.app.revealPath(project.rootPath).catch(() => { });
          }}>{revealLabel}</button>
        </div>
      ) : null}
    </>
  );
}
