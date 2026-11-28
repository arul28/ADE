import { useCallback, useEffect } from "react";
import type {
  CtoGetLinearIssuePickerDataResult,
  CtoLinearCustomView,
  CtoLinearRailData,
  NormalizedLinearIssue,
} from "../../../../shared/types";
import {
  LINEAR_SCOPE_ALL,
  LINEAR_SCOPE_PREFIX,
  linearScopeKey,
  linearScopeTitle,
  parseLinearScope,
  type LinearScope,
} from "./linearScope";
import type { LinearIssueBrowserFilters } from "./linearIssueBrowserData";

/**
 * The Linear rail's scope: what a rail click does, which entry is active, the
 * breadcrumb title, and the fallback for a saved scope this workspace no
 * longer lists.
 */
export function useLinearRailScope({
  activeScope,
  openDocumentId,
  setOpenDocumentId,
  setNarrowRailOpen,
  setNarrowDetailOpen,
  updateFilters,
  railData,
  catalog,
  catalogLoaded,
  customViews,
  issues,
}: {
  activeScope: LinearScope;
  openDocumentId: string | null;
  setOpenDocumentId: (id: string | null) => void;
  setNarrowRailOpen: (open: boolean) => void;
  setNarrowDetailOpen: (open: boolean) => void;
  updateFilters: (patch: Partial<LinearIssueBrowserFilters>) => void;
  railData: CtoLinearRailData | null;
  catalog: CtoGetLinearIssuePickerDataResult;
  catalogLoaded: boolean;
  customViews: CtoLinearCustomView[];
  issues: NormalizedLinearIssue[];
}) {
  // Every rail entry (views, sections, favorites, projects, documents) is a scope string.
  const handleRailScope = useCallback((scopeKey: string) => {
    const scope = parseLinearScope(scopeKey);
    setNarrowRailOpen(false);
    if (scope.kind === "document") {
      setOpenDocumentId(scope.id);
      setNarrowDetailOpen(true);
      return;
    }
    setOpenDocumentId(null);
    if (scope.kind === "project") {
      updateFilters({ projectId: scope.id, scope: LINEAR_SCOPE_ALL });
      return;
    }
    updateFilters({ scope: linearScopeKey(scope), projectId: "" });
  }, [setNarrowDetailOpen, setNarrowRailOpen, setOpenDocumentId, updateFilters]);
  const activeRailScope = openDocumentId
    ? `${LINEAR_SCOPE_PREFIX.document}${openDocumentId}`
    : linearScopeKey(activeScope);

  // A cycle, initiative or label scope saved earlier (or on a machine whose
  // ADE reads them) that this workspace no longer lists falls back to All
  // issues once the rail has loaded, instead of an empty list. An empty list
  // for that kind means the rail was not really read (disconnected, rate
  // limited, a failed read), so the saved scope stays.
  useEffect(() => {
    if (!railData) return;
    if (activeScope.kind !== "cycle" && activeScope.kind !== "initiative" && activeScope.kind !== "label") return;
    if (activeScope.kind === "label" && !catalogLoaded) return;
    const entities: ReadonlyArray<{ id: string }> = activeScope.kind === "cycle"
      ? railData.cycles
      : activeScope.kind === "initiative"
        ? railData.initiatives
        : catalog.labels ?? [];
    if (entities.length === 0) return;
    const id = activeScope.id;
    const known = entities.some((entity) => entity.id === id)
      || railData.favorites.some((favorite) => favorite.targetId === id);
    if (!known) updateFilters({ scope: LINEAR_SCOPE_ALL });
  }, [activeScope, catalog.labels, catalogLoaded, railData, updateFilters]);

  const currentCrumb = linearScopeTitle(activeScope, (kind, id) => {
    if (kind === "project") return catalog.projects.find((entry) => entry.id === id)?.name;
    if (kind === "view") return customViews.find((view) => view.id === id)?.name;
    if (kind === "label") return catalog.labels?.find((label) => label.id === id)?.name;
    if (kind === "initiative") return railData?.initiatives.find((entry) => entry.id === id)?.name;
    if (kind !== "cycle") return null;
    const cycle = railData?.cycles.find((entry) => entry.id === id);
    return cycle ? cycle.name?.trim() || `Cycle ${cycle.number}` : issues.find((issue) => issue.cycleId === id)?.cycleName;
  });

  return { handleRailScope, activeRailScope, currentCrumb };
}
