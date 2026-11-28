import React from "react";
import {
  Funnel,
  Stack,
  Timer,
  Tray,
  UserCircle,
  CheckCircle as ReadyIcon,
} from "@phosphor-icons/react";
import type {
  CtoLinearCustomView,
  CtoLinearProject,
  CtoLinearQuickViewProject,
  OpenProjectBinding,
} from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { LinearProjectIcon } from "../../lanes/linearProjectIcon";
import { LinearRailSections } from "./LinearRailSections";
import {
  LINEAR_SCOPE_ACTIVE_CYCLE,
  LINEAR_SCOPE_ALL,
  LINEAR_SCOPE_INBOX,
  LINEAR_SCOPE_MINE,
  LINEAR_SCOPE_PREFIX,
  LINEAR_SCOPE_READY,
} from "./linearScope";

type LinearRailProject = CtoLinearProject & { quick: CtoLinearQuickViewProject | null };

/**
 * The Linear window's left rail: the built-in views, the workspace sections
 * (favorites, cycles, initiatives, documents), custom views and projects.
 * Every entry speaks in scope strings (`linearScope.ts`); the browser parses
 * them in one place.
 */
export function LinearBrowserRail({
  narrow,
  activeScopeKey,
  onSelectScope,
  scopeCount,
  inbox,
  readyCount,
  cyclesAvailable,
  customViews,
  projects,
  projectCount,
  loadingProjects,
  filtersActive,
  onResetFilters,
  pin,
  railTeamKey,
  onOpenIssue,
}: {
  narrow: boolean;
  /** The selected entry's scope string (`project:<id>` and `document:<id>` included). */
  activeScopeKey: string;
  onSelectScope: (scopeKey: string) => void;
  scopeCount: (scopeKey: string) => string | null;
  /** Null when this machine's ADE has no inbox. */
  inbox: { count: string | null } | null;
  readyCount: string | null;
  cyclesAvailable: boolean;
  customViews: CtoLinearCustomView[];
  projects: LinearRailProject[];
  projectCount: (projectId: string) => string | null;
  loadingProjects: boolean;
  filtersActive: boolean;
  onResetFilters: () => void;
  pin: OpenProjectBinding | null;
  railTeamKey: string | null;
  onOpenIssue: (idOrIdentifier: string) => void;
}) {
  const scopeButton = (scopeKey: string, title: string, icon: React.ReactNode, count: string | null) => (
    <ScopeNavButton
      active={activeScopeKey === scopeKey}
      icon={icon}
      title={title}
      count={count}
      onClick={() => onSelectScope(scopeKey)}
    />
  );

  return (
    <aside className={cn("flex min-h-0 flex-col overflow-hidden border-r border-fg/[0.07]", narrow ? "h-full bg-[color:var(--ade-shell-surface,#121019)]" : "bg-fg/[0.015]")}>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2" data-linear-pane="projects">
        <div className="space-y-px" data-linear-rail="views">
          {scopeButton(LINEAR_SCOPE_ALL, "All issues", <Stack size={14} />, scopeCount(LINEAR_SCOPE_ALL))}
          {scopeButton(LINEAR_SCOPE_MINE, "My issues", <UserCircle size={14} />, scopeCount(LINEAR_SCOPE_MINE))}
          {inbox ? scopeButton(LINEAR_SCOPE_INBOX, "Inbox", <Tray size={14} />, inbox.count) : null}
          {scopeButton(LINEAR_SCOPE_READY, "Ready", <ReadyIcon size={14} />, readyCount)}
          {cyclesAvailable
            ? scopeButton(LINEAR_SCOPE_ACTIVE_CYCLE, "Current cycle", <Timer size={14} />, scopeCount(LINEAR_SCOPE_ACTIVE_CYCLE))
            : null}
        </div>

        <LinearRailSections
          pin={pin}
          teamKey={railTeamKey}
          activeScope={activeScopeKey}
          onSelectScope={onSelectScope}
          onOpenIssue={onOpenIssue}
        />

        {customViews.length > 0 ? (
          <>
            <div className="mb-1 mt-4 px-2 text-[12px] text-muted-fg/70">Views</div>
            <div className="space-y-px">
              {customViews.map((view) => {
                const key = `${LINEAR_SCOPE_PREFIX.view}${view.id}`;
                return (
                  <React.Fragment key={view.id}>
                    {scopeButton(key, view.name, <Funnel size={13} style={view.color ? { color: view.color } : undefined} />, scopeCount(key))}
                  </React.Fragment>
                );
              })}
            </div>
          </>
        ) : null}

        <div className="mb-1 mt-4 flex items-center justify-between gap-2 px-2">
          <span className="text-[12px] text-muted-fg/70">Projects</span>
          {filtersActive ? (
            <button
              type="button"
              className="text-[11.5px] text-muted-fg/70 transition-colors hover:text-fg"
              onClick={onResetFilters}
            >
              Reset filters
            </button>
          ) : null}
        </div>

        {loadingProjects && projects.length === 0 ? (
          <div className="px-2 py-3 text-[12px] text-muted-fg/60">Loading projects…</div>
        ) : projects.length > 0 ? (
          <div className="space-y-px">
            {projects.map((projectEntry) => {
              const key = `${LINEAR_SCOPE_PREFIX.project}${projectEntry.id}`;
              return (
                <ProjectFilterButton
                  key={projectEntry.id}
                  project={projectEntry}
                  active={activeScopeKey === key}
                  count={projectCount(projectEntry.id)}
                  onClick={() => onSelectScope(key)}
                />
              );
            })}
          </div>
        ) : (
          <div className="px-2 py-3 text-[12px] text-muted-fg/60">No projects yet.</div>
        )}
      </div>
    </aside>
  );
}

function ScopeNavButton({
  active,
  icon,
  title,
  count,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  count: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-fg/25",
        active ? "bg-fg/[0.07] text-fg" : "text-fg/70 hover:bg-fg/[0.04] hover:text-fg",
      )}
      onClick={onClick}
      title={title}
      aria-current={active ? "page" : undefined}
    >
      <span className="grid w-4 shrink-0 place-items-center text-muted-fg">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{title}</span>
      {count ? <span className="shrink-0 text-[11.5px] tabular-nums text-muted-fg/70">{count}</span> : null}
    </button>
  );
}

function ProjectFilterButton({
  project,
  active,
  count,
  onClick,
}: {
  project: LinearRailProject;
  active: boolean;
  count: string | null;
  onClick: () => void;
}) {
  const quick = project.quick;
  return (
    <button
      type="button"
      className={cn(
        "flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-fg/25",
        active ? "bg-fg/[0.07] text-fg" : "text-fg/70 hover:bg-fg/[0.04] hover:text-fg",
      )}
      onClick={onClick}
      title={project.name}
      aria-current={active ? "page" : undefined}
    >
      <LinearProjectIcon
        icon={project.icon ?? quick?.icon}
        color={project.color ?? quick?.color}
        name={project.name}
        size={16}
      />
      <span className="min-w-0 flex-1 truncate text-[13px]">{project.name}</span>
      {count ? <span className="shrink-0 text-[11.5px] tabular-nums text-muted-fg/70">{count}</span> : null}
    </button>
  );
}
