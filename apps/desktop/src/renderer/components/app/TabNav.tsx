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
    <nav className="flex flex-col gap-2 w-full items-center">
      {items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          title={it.label}
          className={({ isActive }) =>
            cn(
              "flex items-center justify-center w-10 h-10 rounded-md text-muted-fg transition-colors hover:text-fg hover:bg-muted",
              isActive && "text-accent bg-transparent ring-1 ring-border shadow-sm"
            )
          }
        >
          <it.icon className="h-5 w-5" />
        </NavLink>
      ))}
    </nav>
  );
}
