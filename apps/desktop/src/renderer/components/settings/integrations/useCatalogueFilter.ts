/**
 * Which MCP quick setups the Integrations grid shows: the popular few, all of
 * them, or one category. The grid keeps every tile mounted and only marks the
 * rest folded, so Settings search (which filters what is on the page) still
 * finds a folded server.
 */
import { useMemo, useState } from "react";
import type { McpCatalogueCategory, McpCatalogueEntry } from "../../../../shared/mcpCatalogue";

/** Tiles shown before "Show all": the start of the catalogue, which is ordered by use. */
export const POPULAR_COUNT = 12;

const CATEGORY_LABELS: Record<McpCatalogueCategory, string> = {
  dev: "Dev tools",
  data: "Data",
  productivity: "Productivity",
  docs: "Docs",
  search: "Search",
  observability: "Monitoring",
  payments: "Payments",
  design: "Design",
  browser: "Browser",
  reference: "Reference",
};

export type CatalogueFilter = "popular" | "all" | McpCatalogueCategory;

export type CatalogueChip = { id: CatalogueFilter; label: string; count?: number };

export type CatalogueFilterView = {
  /** The chips to offer; empty when there is nothing to fold (a search, or a short list). */
  chips: CatalogueChip[];
  activeFilter: CatalogueFilter;
  setFilter: (filter: CatalogueFilter) => void;
  /** The ids shown; null shows every tile. */
  shownIds: ReadonlySet<string> | null;
  /** Tiles the current filter folds away. */
  foldedCount: number;
};

/**
 * `catalogue` is what the grid can offer (not yet added, matching the search);
 * `searching` is true while the Add search has text, which shows every match.
 */
export function useCatalogueFilter(catalogue: readonly McpCatalogueEntry[], searching: boolean): CatalogueFilterView {
  const [filter, setFilter] = useState<CatalogueFilter>("popular");

  const categories = useMemo(() => {
    const counts = new Map<McpCatalogueCategory, number>();
    for (const entry of catalogue) counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [catalogue]);

  // Chips only while there is something to fold. Without them nothing could
  // undo a filter, so the grid then shows everything.
  const offerChips = !searching && catalogue.length > POPULAR_COUNT;
  const chips = useMemo<CatalogueChip[]>(() => (offerChips
    ? [
      { id: "popular", label: "Popular" },
      { id: "all", label: "All", count: catalogue.length },
      ...categories.map(([id, count]) => ({ id, label: CATEGORY_LABELS[id], count })),
    ]
    : []), [offerChips, catalogue.length, categories]);

  // A category whose every server is now added has no chip: back to the popular few.
  const activeFilter: CatalogueFilter = !offerChips
    ? "all"
    : chips.some((chip) => chip.id === filter) ? filter : "popular";

  const shownIds = useMemo(() => {
    if (activeFilter === "all") return null;
    if (activeFilter === "popular") return new Set(catalogue.slice(0, POPULAR_COUNT).map((entry) => entry.id));
    return new Set(catalogue.filter((entry) => entry.category === activeFilter).map((entry) => entry.id));
  }, [activeFilter, catalogue]);

  return {
    chips,
    activeFilter,
    setFilter,
    shownIds,
    foldedCount: shownIds ? catalogue.length - shownIds.size : 0,
  };
}
