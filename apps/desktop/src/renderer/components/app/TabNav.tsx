import React from "react";
import { NavLink } from "react-router-dom";
import { Bug, GitPullRequest, History, Home, LayoutGrid, Settings, TerminalSquare } from "lucide-react";
import { cn } from "../ui/cn";

const items = [
  { to: "/project", label: "Projects", icon: Home },
  { to: "/lanes", label: "Lanes", icon: LayoutGrid },
  { to: "/terminals", label: "Terminals", icon: TerminalSquare },
  { to: "/conflicts", label: "Conflicts", icon: Bug },
  { to: "/prs", label: "PRs", icon: GitPullRequest },
  { to: "/history", label: "History", icon: History },
  { to: "/settings", label: "Settings", icon: Settings }
] as const;

export function TabNav() {
  return (
    <nav className="flex h-full flex-col gap-1 rounded-lg border border-border bg-card/60 p-2 backdrop-blur">
      {items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-fg hover:bg-muted/60 hover:text-fg",
              isActive && "bg-muted/70 text-fg"
            )
          }
        >
          <it.icon className="h-4 w-4" />
          <span>{it.label}</span>
        </NavLink>
      ))}
      <div className="mt-auto px-2 py-1 text-xs text-muted-fg">Phase -1: shell only</div>
    </nav>
  );
}
