import React from "react";
import { NavLink } from "react-router-dom";
import { BookOpenText, Bug, FileCode2, GitPullRequest, History, LayoutGrid, Network, Play, Settings, TerminalSquare, Wand2 } from "lucide-react";
import { cn } from "../ui/cn";

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
  return (
    <nav className="flex flex-col gap-1.5 w-full items-center">
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
  );
}
