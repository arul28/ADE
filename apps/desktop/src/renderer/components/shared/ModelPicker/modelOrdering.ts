export interface ModelOrderingItem {
  /** ADE models key by `modelId`. `id` is accepted as a fallback for `ModelDescriptor` shape. */
  readonly modelId?: string;
  readonly id?: string;
}

type ReadonlyIdCollection = ReadonlySet<string> | ReadonlyArray<string>;

function toSet(values: ReadonlyIdCollection | undefined): ReadonlySet<string> {
  return values instanceof Set ? values : new Set(values ?? []);
}

function rankByValue(values: ReadonlyArray<string>): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (typeof value === "string" && !map.has(value)) map.set(value, i);
  }
  return map;
}

function itemKey(item: ModelOrderingItem): string {
  return item.modelId ?? item.id ?? "";
}

export type SortModelItemsOptions = {
  /** Canonical name from the foundation contract. */
  readonly favoriteModelIds?: ReadonlyIdCollection;
  /** Alias accepted from component callsites that pass `favorites` directly. */
  readonly favorites?: ReadonlyIdCollection;
  /** When true (or `favoriteModelIds`/`favorites` supplied), favorites sort first. */
  readonly groupFavorites?: boolean;
  readonly modelIdOrder?: ReadonlyArray<string>;
  /** Active model id — pins it to the very top regardless of favorites. */
  readonly activeId?: string | null;
};

export function sortModelItems<T extends ModelOrderingItem>(
  items: ReadonlyArray<T>,
  options?: SortModelItemsOptions,
): T[] {
  const favoritesSource = options?.favoriteModelIds ?? options?.favorites;
  const favorites = toSet(favoritesSource);
  const groupFavorites =
    options?.groupFavorites === true ||
    (options?.groupFavorites === undefined && favoritesSource !== undefined);
  const idOrder = rankByValue(options?.modelIdOrder ?? []);
  const activeId =
    typeof options?.activeId === "string" && options.activeId.length > 0 ? options.activeId : null;
  const originalOrder = new Map<T, number>();
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item !== undefined) originalOrder.set(item, i);
  }

  const rankActive = (item: T): number => {
    if (activeId === null) return 0;
    return itemKey(item) === activeId ? 0 : 1;
  };
  const rankFavorite = (item: T): number => {
    if (!groupFavorites) return 0;
    return favorites.has(itemKey(item)) ? 0 : 1;
  };
  const rankIdOrder = (item: T): number => {
    const value = idOrder.get(itemKey(item));
    return value === undefined ? Number.POSITIVE_INFINITY : value;
  };
  const rankOriginal = (item: T): number => {
    const value = originalOrder.get(item);
    return value === undefined ? Number.POSITIVE_INFINITY : value;
  };

  return items
    .slice()
    .sort((left, right) => {
      const activeDelta = rankActive(left) - rankActive(right);
      if (activeDelta !== 0) return activeDelta;
      const favoriteDelta = rankFavorite(left) - rankFavorite(right);
      if (favoriteDelta !== 0) return favoriteDelta;
      const idOrderDelta = rankIdOrder(left) - rankIdOrder(right);
      if (idOrderDelta !== 0) return idOrderDelta;
      return rankOriginal(left) - rankOriginal(right);
    });
}
