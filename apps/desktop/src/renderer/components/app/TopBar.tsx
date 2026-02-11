import React from "react";
import { Play, Plus, Search } from "lucide-react";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { ProjectSelector } from "./ProjectSelector";
import { useAppStore } from "../../state/appStore";

export function TopBar({
  onOpenCommandPalette,
  commandHint
}: {
  onOpenCommandPalette: () => void;
  commandHint: React.ReactNode;
}) {
  const baseRef = useAppStore((s) => s.project?.baseRef);

  return (
    <header className="flex h-[52px] items-center justify-between border-b border-border bg-card/60 px-3 backdrop-blur">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex items-baseline gap-2">
          <div className="text-sm font-semibold tracking-tight">ADE</div>
          <div className="text-xs text-muted-fg">MVP scaffold</div>
        </div>

        <div className="h-5 w-px bg-border" />

        <ProjectSelector />

        <Chip className="hidden sm:inline-flex">base: {baseRef ?? "?"}</Chip>
        <Chip className="hidden md:inline-flex">sync: idle</Chip>
        <Chip className="hidden md:inline-flex">jobs: 0</Chip>
        <Chip className="hidden md:inline-flex">procs: 0</Chip>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={onOpenCommandPalette} title="Command palette">
          <Search className="h-4 w-4" />
          <span className="hidden sm:inline">Commands</span>
          <span className="hidden md:inline text-xs text-muted-fg">{commandHint}</span>
        </Button>
        <Button variant="outline" disabled title="Create lane (stub)">
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">Lane</span>
        </Button>
        <Button variant="primary" disabled title="Start terminal (Phase 0)">
          <Play className="h-4 w-4" />
          <span className="hidden sm:inline">Terminal</span>
        </Button>
      </div>
    </header>
  );
}
