/**
 * Socket taxonomy — where a plugin is allowed to appear on a core surface.
 *
 * Pure types and pure helpers, shared by the daemon, the desktop renderer, the
 * `ade code` TUI and (transcribed) iOS. No React, no Electron, no Node.
 *
 * The taxonomy is deliberately CLOSED and small. Six kinds × six surfaces is
 * the whole vocabulary, and every core surface implements the same six, so a
 * plugin author learns the shape once and iOS can implement it exhaustively at
 * compile time. Adding a seventh kind is a platform change with a parity cost
 * on four clients — not something a plugin can invent at runtime.
 *
 * Two invariants the host enforces and clients rely on:
 *
 * 1. **Placement is host-controlled and always AFTER core content.** A
 *    contribution never reorders, replaces, or interleaves with the product's
 *    own rows. `order` sorts plugins against each other, nothing more.
 * 2. **Payload shape is per kind, and a mismatched payload renders nothing.**
 *    {@link parsePluginContributionPayload} is the single gate; surfaces call
 *    it and skip anything that fails rather than rendering a half-built row.
 *
 * Static contributions come from the manifest. DYNAMIC per-entity values (this
 * PR's badge, this lane's menu item) come from `plugin_contributions` rows
 * written by the machine that owns the data.
 */

import { bounded, finite, isRecord, oneOf } from "./parse";
import { normalizeVocabTone, type VocabTone } from "./vocabulary";

export const PLUGIN_SOCKET_KINDS = [
  "toolbar-action",
  "row-badge",
  "row-menu-item",
  "detail-section",
  "empty-state",
  "filter-chip",
  "file-viewer",
] as const;

export type PluginSocketKind = (typeof PLUGIN_SOCKET_KINDS)[number];

/** The core surfaces. Everything else in ADE is extractable into a plugin. */
export const PLUGIN_SURFACE_IDS = ["work", "lanes", "files", "prs", "automations", "cto"] as const;

export type PluginSurfaceId = (typeof PLUGIN_SURFACE_IDS)[number];

/** The entity a dynamic contribution is attached to. */
export const PLUGIN_ENTITY_KINDS = ["lane", "pr", "session", "file", "automation", "surface"] as const;

export type PluginEntityKind = (typeof PLUGIN_ENTITY_KINDS)[number];

/** Narrow an untrusted string to a socket kind. Lives here, beside the list. */
export function isPluginSocketKind(value: unknown): value is PluginSocketKind {
  return oneOf(value, PLUGIN_SOCKET_KINDS) !== null;
}

/** Narrow an untrusted string to a core surface. Lives here, beside the list. */
export function isPluginSurfaceId(value: unknown): value is PluginSurfaceId {
  return oneOf(value, PLUGIN_SURFACE_IDS) !== null;
}

/**
 * What each socket kind needs before it can render anything.
 *
 * Three layers used to encode this separately and disagree about it: the
 * manifest parser required `panelId`/`actionId` but not `label`, the
 * manifest→payload mapping assumed whatever the manifest happened to carry, and
 * the payload validator dropped the result. A manifest declaring a badge with no
 * label therefore parsed clean, installed clean, and contributed nothing — with
 * nothing anywhere telling the author why.
 *
 * `manifest` names fields on a `sockets[]` entry; `payload` names fields on the
 * per-kind payload. They differ (a badge's manifest `label` becomes the
 * payload's `text`), which is exactly why one table has to state both.
 */
export type PluginSocketRequirementField = "label" | "actionId" | "panelId" | "extensions";

export type PluginSocketRequirement = {
  manifest: readonly PluginSocketRequirementField[];
  payload: readonly string[];
};

export const PLUGIN_SOCKET_REQUIREMENTS: Record<PluginSocketKind, PluginSocketRequirement> = {
  "toolbar-action": { manifest: ["label", "actionId"], payload: ["label", "actionId"] },
  "row-badge": { manifest: ["label"], payload: ["text"] },
  "row-menu-item": { manifest: ["label", "actionId"], payload: ["label", "actionId"] },
  "detail-section": { manifest: ["panelId"], payload: ["panelId"] },
  "empty-state": { manifest: ["label"], payload: ["title"] },
  // `filterKey` falls back to the socket id, so the manifest need not carry it.
  "filter-chip": { manifest: ["label"], payload: ["label", "filterKey"] },
  "file-viewer": { manifest: ["panelId", "extensions"], payload: ["panelId", "extensions"] },
};

/**
 * Matches `AdeCardTone`: no red. Failure is amber. See `../adeCard.ts`.
 *
 * The SAME type the panel vocabulary uses, and folded by the same function.
 * They were separate, with separate normalizers, and they disagreed: a payload
 * saying `"info"` or `"Warning"` rendered correctly inside a panel and fell
 * through to neutral as a badge, so one plugin's amber warning was a grey label
 * two pixels away from itself.
 */
export type PluginBadgeTone = VocabTone;

/**
 * Visible badges per row before the rest collapse into a "+N" popover. Two is
 * what a dense Lanes/PRs row can carry without pushing core metadata off.
 */
export const PLUGIN_ROW_BADGE_VISIBLE_LIMIT = 2;

/** Hard ceiling on contributions a single plugin may place in one socket slot. */
export const PLUGIN_CONTRIBUTIONS_PER_SLOT_LIMIT = 8;

export type PluginToolbarActionPayload = {
  label: string;
  icon?: string;
  actionId: string;
  disabled?: boolean;
};

export type PluginRowBadgePayload = {
  text: string;
  tone: PluginBadgeTone;
  icon?: string;
  tooltip?: string;
};

export type PluginRowMenuItemPayload = {
  label: string;
  icon?: string;
  danger?: boolean;
  actionId: string;
};

export type PluginDetailSectionPayload = {
  panelId: string;
  title?: string;
};

export type PluginEmptyStatePayload = {
  title: string;
  body?: string;
  actionId?: string;
  actionLabel?: string;
};

export type PluginFilterChipPayload = {
  label: string;
  filterKey: string;
  count?: number;
};

export type PluginFileViewerPayload = {
  panelId: string;
  extensions: string[];
};

export type PluginContributionPayloadByKind = {
  "toolbar-action": PluginToolbarActionPayload;
  "row-badge": PluginRowBadgePayload;
  "row-menu-item": PluginRowMenuItemPayload;
  "detail-section": PluginDetailSectionPayload;
  "empty-state": PluginEmptyStatePayload;
  "filter-chip": PluginFilterChipPayload;
  "file-viewer": PluginFileViewerPayload;
};

export type PluginContribution<K extends PluginSocketKind = PluginSocketKind> = {
  pluginId: string;
  socket: K;
  surface: PluginSurfaceId;
  /** Stable per-plugin id: identity for dedupe and ordering, not content. */
  id: string;
  order?: number;
  payload: PluginContributionPayloadByKind[K];
};

/** A dynamic contribution row as stored in `plugin_contributions`. */
export type PluginEntityContribution = PluginContribution & {
  entityKind: PluginEntityKind;
  entityId: string;
  updatedAt: string;
};

/**
 * Validate a payload against its socket kind.
 *
 * Returns `null` for anything malformed. Surfaces skip nulls — a contribution
 * with a missing label or action is a bug in the plugin, and rendering a blank
 * button would hide it.
 */
export function parsePluginContributionPayload<K extends PluginSocketKind>(
  socket: K,
  raw: unknown,
): PluginContributionPayloadByKind[K] | null {
  if (!isRecord(raw)) return null;
  const result = ((): PluginContributionPayloadByKind[PluginSocketKind] | null => {
    switch (socket) {
      case "toolbar-action": {
        const label = bounded(raw.label, 40);
        const actionId = bounded(raw.actionId, 64);
        if (!label || !actionId) return null;
        return {
          label,
          actionId,
          ...(bounded(raw.icon, 40) ? { icon: bounded(raw.icon, 40)! } : {}),
          ...(raw.disabled === true ? { disabled: true } : {}),
        };
      }
      case "row-badge": {
        const badgeText = bounded(raw.text, 32);
        if (!badgeText) return null;
        return {
          text: badgeText,
          tone: normalizeVocabTone(raw.tone),
          ...(bounded(raw.icon, 40) ? { icon: bounded(raw.icon, 40)! } : {}),
          ...(bounded(raw.tooltip, 200) ? { tooltip: bounded(raw.tooltip, 200)! } : {}),
        };
      }
      case "row-menu-item": {
        const label = bounded(raw.label, 60);
        const actionId = bounded(raw.actionId, 64);
        if (!label || !actionId) return null;
        return {
          label,
          actionId,
          ...(bounded(raw.icon, 40) ? { icon: bounded(raw.icon, 40)! } : {}),
          ...(raw.danger === true ? { danger: true } : {}),
        };
      }
      case "detail-section": {
        const panelId = bounded(raw.panelId, 64);
        if (!panelId) return null;
        return {
          panelId,
          ...(bounded(raw.title, 60) ? { title: bounded(raw.title, 60)! } : {}),
        };
      }
      case "empty-state": {
        const title = bounded(raw.title, 80);
        if (!title) return null;
        return {
          title,
          ...(bounded(raw.body, 240) ? { body: bounded(raw.body, 240)! } : {}),
          ...(bounded(raw.actionId, 64) ? { actionId: bounded(raw.actionId, 64)! } : {}),
          ...(bounded(raw.actionLabel, 40) ? { actionLabel: bounded(raw.actionLabel, 40)! } : {}),
        };
      }
      case "filter-chip": {
        const label = bounded(raw.label, 40);
        const filterKey = bounded(raw.filterKey, 64);
        if (!label || !filterKey) return null;
        return {
          label,
          filterKey,
          ...((finite(raw.count) ?? -1) >= 0 ? { count: Math.trunc(finite(raw.count)!) } : {}),
        };
      }
      case "file-viewer": {
        const panelId = bounded(raw.panelId, 64);
        const extensions = Array.isArray(raw.extensions)
          ? raw.extensions
            .map((value) => bounded(value, 16)?.toLowerCase() ?? null)
            .filter((value): value is string => Boolean(value) && value!.startsWith("."))
          : [];
        if (!panelId || extensions.length === 0) return null;
        return { panelId, extensions };
      }
      default:
        return null;
    }
  })();
  if (!result) return null;
  // The switch above and PLUGIN_SOCKET_REQUIREMENTS say the same thing, and the
  // whole point of the table is that the other two layers can trust it. This
  // is where the two are held to each other: a payload that satisfied the
  // switch but is missing a field the table advertises means the table has
  // drifted, and rendering it would make the manifest parser's warnings lie.
  const required = PLUGIN_SOCKET_REQUIREMENTS[socket as PluginSocketKind].payload;
  const record = result as Record<string, unknown>;
  for (const field of required) {
    const value = record[field];
    const present = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "";
    if (!present) return null;
  }
  return result as PluginContributionPayloadByKind[K] | null;
}

/**
 * Host-controlled placement: plugin order, then plugin id, then contribution
 * id. Deterministic across machines so two devices show the same row order for
 * the same data, and stable when a plugin omits `order` entirely.
 */
export function comparePluginContributions(left: PluginContribution, right: PluginContribution): number {
  const leftOrder = typeof left.order === "number" ? left.order : Number.MAX_SAFE_INTEGER;
  const rightOrder = typeof right.order === "number" ? right.order : Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  const byPlugin = left.pluginId.localeCompare(right.pluginId);
  return byPlugin !== 0 ? byPlugin : left.id.localeCompare(right.id);
}

/**
 * Sort, cap, and split row badges into the visible set plus an overflow count.
 * Every row-badge surface uses this so desktop, TUI and iOS agree on which two
 * badges are the visible ones.
 */
export function splitPluginRowBadges(
  contributions: readonly PluginContribution<"row-badge">[],
  visibleLimit = PLUGIN_ROW_BADGE_VISIBLE_LIMIT,
): { visible: PluginContribution<"row-badge">[]; overflowCount: number } {
  const sorted = [...contributions].sort(comparePluginContributions);
  const visible = sorted.slice(0, Math.max(0, visibleLimit));
  return { visible, overflowCount: Math.max(0, sorted.length - visible.length) };
}
