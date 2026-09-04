/**
 * Per-user order of plugin `toolbar-action` buttons on the `app` surface.
 *
 * The key is scoped to the signed-in user so two accounts on one machine do
 * not share a layout, and the user id is sanitized so a Windows path-unsafe
 * character in an id cannot be a localStorage key (or, later, a file name).
 * Signed-out readers share the `local` bucket.
 */

export type PluginToolbarOrderItem = {
  pluginId: string;
  id: string;
};

const STORAGE_PREFIX = "ade.plugin.toolbarOrder.v1:";

export function sanitizeToolbarOrderUserId(userId: string | null | undefined): string {
  const raw = (userId ?? "").trim() || "local";
  return raw.replace(/[\\/:*?"<>|\s]+/g, "_").toLowerCase();
}

export function pluginToolbarOrderStorageKey(userId: string | null | undefined): string {
  return `${STORAGE_PREFIX}${sanitizeToolbarOrderUserId(userId)}`;
}

export function applyPluginToolbarOrder<T extends { pluginId: string; id: string }>(
  items: readonly T[],
  saved: readonly PluginToolbarOrderItem[] | null | undefined,
): T[] {
  if (!saved || saved.length === 0) return [...items];
  const remaining = [...items];
  const ordered: T[] = [];
  for (const ref of saved) {
    const index = remaining.findIndex((item) => item.pluginId === ref.pluginId && item.id === ref.id);
    if (index < 0) continue;
    ordered.push(remaining.splice(index, 1)[0]!);
  }
  return [...ordered, ...remaining];
}

export function parsePluginToolbarOrder(raw: string | null): PluginToolbarOrderItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PluginToolbarOrderItem[] = [];
    const seen = new Set<string>();
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const pluginId = (entry as { pluginId?: unknown }).pluginId;
      const id = (entry as { id?: unknown }).id;
      if (typeof pluginId !== "string" || typeof id !== "string" || !pluginId || !id) continue;
      const key = `${pluginId}\0${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ pluginId, id });
    }
    return out;
  } catch {
    return [];
  }
}

export function readPluginToolbarOrder(userId: string | null | undefined): PluginToolbarOrderItem[] {
  if (typeof localStorage === "undefined") return [];
  try {
    return parsePluginToolbarOrder(localStorage.getItem(pluginToolbarOrderStorageKey(userId)));
  } catch {
    return [];
  }
}

export function writePluginToolbarOrder(
  userId: string | null | undefined,
  order: readonly PluginToolbarOrderItem[],
): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(pluginToolbarOrderStorageKey(userId), JSON.stringify(order));
  } catch {
    // Quota or private mode: the session keeps the in-memory order.
  }
}

/**
 * How many leading items fit beside a chevron.
 *
 * A container width of 0 is jsdom (or a collapsed host): show everything so
 * tests without layout mocks do not hide the row they are asserting on.
 */
export function visiblePluginToolbarCount(
  itemWidths: readonly number[],
  containerWidth: number,
  chevronWidth: number,
  gap: number,
): number {
  if (containerWidth <= 0) return itemWidths.length;
  const total = itemWidths.reduce((sum, width, index) => sum + width + (index > 0 ? gap : 0), 0);
  if (total <= containerWidth) return itemWidths.length;
  const budget = Math.max(0, containerWidth - chevronWidth - (itemWidths.length > 0 ? gap : 0));
  let used = 0;
  let count = 0;
  for (const width of itemWidths) {
    const cost = count === 0 ? width : width + gap;
    if (used + cost > budget) break;
    used += cost;
    count += 1;
  }
  return count;
}

export function movePluginToolbarItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return [...items];
  }
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (!moved) return [...items];
  next.splice(to, 0, moved);
  return next;
}
