import React from "react";
import { NavLink } from "react-router-dom";
import { Bug, FileCode2, GitPullRequest, History, LayoutGrid, Network, Play, Settings, TerminalSquare, Wand2 } from "lucide-react";
import { cn } from "../ui/cn";

const items = [
  { to: "/project", label: "Play", icon: Play },
  { to: "/lanes", label: "Lanes", icon: LayoutGrid },
  { to: "/files", label: "Files", icon: FileCode2 },
  { to: "/terminals", label: "Terminals", icon: TerminalSquare },
  { to: "/conflicts", label: "Conflicts", icon: Bug },
  { to: "/graph", label: "Graph", icon: Network },
  { to: "/prs", label: "PRs", icon: GitPullRequest },
  { to: "/history", label: "History", icon: History },
  { to: "/automations", label: "Automations", icon: Wand2 },
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
