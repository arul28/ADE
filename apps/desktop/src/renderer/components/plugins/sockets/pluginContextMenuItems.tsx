import React from "react";

import type { ContextMenuItem } from "../../files/v2/ContextMenu";
import type { PluginMenuEntry } from "./contributionModel";
import { SocketIcon } from "./socketUi";

/** What the contributed rows sit under, wherever they are drawn. */
export const PLUGIN_MENU_SECTION_LABEL = "Plugins";

/**
 * Contributed entries as rows for a surface's context menu.
 *
 * One adapter for four menus. PRs and Files had transcribed the same eight
 * lines of `map`, Work had transcribed them again as JSX, and the four had
 * drifted apart on every detail that was left to the caller — whether the
 * section was announced, whether "Extend this tab…" appeared at all, and where
 * the separator went.
 *
 * The heading is not decoration. A contributed row can ask for the product's
 * destructive styling, and a red row that is not visibly a plugin's reads as
 * ADE's own. So the heading and `danger` are emitted together, by this
 * function, and a caller cannot take one without the other.
 */
export function pluginContextMenuItems(entries: readonly PluginMenuEntry[]): ContextMenuItem[] {
  if (entries.length === 0) return [];
  const items: ContextMenuItem[] = [
    { type: "separator" },
    { type: "header", label: PLUGIN_MENU_SECTION_LABEL },
  ];
  for (const entry of entries) {
    items.push({
      type: "item",
      label: entry.label,
      // The plugin's own glyph rows ride on the entry (see `PluginMenuEntry`),
      // so a `brand:*` token the package shipped draws its mark here instead of
      // the puzzle piece every row-menu used to show.
      icon: <SocketIcon
        name={entry.icon}
        size={14}
        {...(entry.brandIcons ? { brandIcons: entry.brandIcons } : {})}
      />,
      onClick: entry.onSelect,
      ...(entry.danger ? { danger: true } : {}),
    });
  }
  return items;
}
