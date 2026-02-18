import React, { useCallback, useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { BookOpenText, Bug, FileCode2, GitPullRequest, History, LayoutGrid, Network, Play, Settings, TerminalSquare, Wand2 } from "lucide-react";
import { cn } from "../ui/cn";
import { useAppStore } from "../../state/appStore";
import { revealLabel } from "../../lib/platform";

const items = [
  { to: "/project", label: "Play", icon: Play },
  { to: "/lanes", label: "Lanes", icon: LayoutGrid },
  { to: "/files", label: "Files", icon: FileCode2 },
  { to: "/terminals", label: "Terminals", icon: TerminalSquare },
  { to: "/conflicts", label: "Conflicts", icon: Bug },
  { to: "/context", label: "Context", icon: BookOpenText },
  { to: "/graph", label: "Graph", icon: Network },
  { to: "/prs", label: "PRs", icon: GitPullRequest },
  { to: "/history", label: "History", icon: History },
  { to: "/automations", label: "Automations", icon: Wand2 },
  { to: "/settings", label: "Settings", icon: Settings }
] as const;

export function TabNav() {
  const project = useAppStore((s) => s.project);
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
        className="flex flex-col gap-1.5 w-full items-center"
        onContextMenu={handleContextMenu}
      >
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            title={it.label}
            className={({ isActive }) =>
              cn(
                "flex items-center justify-center w-10 h-10 rounded-xl text-muted-fg/60 transition-all duration-150 hover:text-fg hover:bg-muted/40",
                isActive && "text-accent bg-accent/15 ring-1 ring-inset ring-accent/10"
              )
            }
          >
            <it.icon className="h-[18px] w-[18px]" />
          </NavLink>
        ))}
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
