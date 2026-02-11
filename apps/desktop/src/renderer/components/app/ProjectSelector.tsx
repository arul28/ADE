import React from "react";
import { Folder } from "lucide-react";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";

export function ProjectSelector() {
  const project = useAppStore((s) => s.project);

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Folder className="h-4 w-4 text-muted-fg" />
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{project?.displayName ?? "No project"}</div>
        <div className="truncate text-xs text-muted-fg">{project?.rootPath ?? "Select a repo in Phase 1 onboarding"}</div>
      </div>
      <Button variant="ghost" size="sm" disabled title="Project switching comes with onboarding (Phase 1)">
        Change
      </Button>
    </div>
  );
}

