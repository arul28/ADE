import React from "react";
import { useAppStore } from "../../state/appStore";
import { EmptyState } from "../ui/EmptyState";

export function ProjectHomePage() {
  const project = useAppStore((s) => s.project);

  return (
    <div className="h-full overflow-auto rounded-lg border border-border bg-card/60 p-4 backdrop-blur">
      <div className="text-sm font-semibold">Projects (Home)</div>
      <div className="mt-1 text-sm text-muted-fg">Project-wide management, processes, and test buttons live here.</div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-border bg-card/70 p-3">
          <div className="text-xs text-muted-fg">Current project</div>
          <div className="mt-1 text-sm font-medium">{project?.displayName ?? "(none)"}</div>
          <div className="mt-1 truncate text-xs text-muted-fg">{project?.rootPath ?? "Select a repo in onboarding (Phase 1)"}</div>
        </div>
        <div className="rounded-lg border border-border bg-card/70 p-3">
          <div className="text-xs text-muted-fg">Base branch</div>
          <div className="mt-1 text-sm font-medium">{project?.baseRef ?? "main"}</div>
          <div className="mt-1 text-xs text-muted-fg">MVP: read-only</div>
        </div>
        <div className="md:col-span-2">
          <EmptyState
            title="Processes + tests (stub)"
            description="Phase 2 adds managed processes, logs viewer, and test suite buttons."
          />
        </div>
      </div>
    </div>
  );
}

