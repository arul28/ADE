import type {
  StorageCategoryId,
  StorageCategorySnapshot,
  StorageCleanupTarget,
  StorageItem,
  StorageSafety,
} from "../../../../shared/types/storage";
import { COLORS } from "../../lanes/laneDesignTokens";
export { formatBytes } from "../../../lib/format";

/**
 * Presentation metadata for the storage dashboard. This module holds only pure
 * helpers so the mapping from the storage snapshot to cleanup targets — the part
 * that must stay correct as the backend evolves — is unit-testable without a DOM.
 */

export type CategoryMeta = {
  /** Human display name shown as the card title. */
  name: string;
  /** One-line plain-language description. No internal jargon. */
  description: string;
  /** Distinct hue used for this category's segment and swatch. */
  hue: string;
};

// Curated, muted category hues. Distinct enough to read as separate segments,
// desaturated enough to look intentional rather than a rainbow. These are data
// colors (legend-backed), not semantic status colors.
export const CATEGORY_META: Record<StorageCategoryId, CategoryMeta> = {
  chats_history: {
    name: "Chats & terminal history",
    description: "Transcripts of your chats and terminal sessions.",
    hue: "#8b7bf0",
  },
  lanes_worktrees: {
    name: "Lanes & worktrees",
    description: "Working copies ADE keeps for each lane.",
    hue: "#4aa8e0",
  },
  build_release: {
    name: "Build & release files",
    description: "Leftover staging from building and releasing your app.",
    hue: "#e0a44a",
  },
  caches: {
    name: "Caches",
    description: "Rebuildable data ADE recreates whenever it needs it.",
    hue: "#43b3a0",
  },
  proof_attachments: {
    name: "Proof & attachments",
    description: "Screenshots, recordings, and files you've attached.",
    hue: "#d071b8",
  },
  recovery_backups: {
    name: "Recovery backups",
    description: "Snapshots ADE saved before making risky changes.",
    hue: "#7b86e0",
  },
  database: {
    name: "Project database",
    description: "Your project's live data.",
    hue: "#8a8f9c",
  },
};

// Order the cards deliberately: the largest, most actionable categories first,
// protected data last. Lanes leads because it is the feature users came for.
export const CATEGORY_ORDER: StorageCategoryId[] = [
  "lanes_worktrees",
  "chats_history",
  "caches",
  "build_release",
  "proof_attachments",
  "recovery_backups",
  "database",
];

export type SafetyMeta = { label: string; color: string };

export const SAFETY_META: Record<StorageSafety, SafetyMeta> = {
  safe_to_remove: { label: "Safe to remove", color: COLORS.success },
  compressible: { label: "Can be compressed", color: COLORS.info },
  review_first: { label: "Review first", color: COLORS.warning },
  protected: { label: "Protected", color: COLORS.textMuted },
};

/** Basename of a path without pulling in node's path module in the renderer. */
export function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? trimmed;
}

const CACHE_SEGMENT = /[\\/]\.ade[\\/]cache[\\/]/;
const TMP_STAGING = /[\\/]ade-[^\\/]*[\\/]?$/;

/**
 * Resolve the cleanup target for a single item, or null when it cannot be safely
 * removed through the storage API. The kind is derived from the item's path (not
 * just its category) because a category can hold paths the backend validates
 * under different kinds — e.g. iOS build data lives under `.ade/cache`, so it is
 * a rebuildable cache even though it appears under "Build & release files".
 *
 * `laneIdByKey` maps a worktree directory name to its lane id; archived lanes
 * require the real lane id, which the snapshot item does not carry.
 */
export function buildCleanupTarget(
  categoryId: StorageCategoryId,
  item: StorageItem,
  laneIdByKey: Map<string, string>,
): StorageCleanupTarget | null {
  const p = item.path;
  switch (categoryId) {
    case "lanes_worktrees": {
      if (item.laneStatus === "orphaned") return { kind: "orphaned_worktree", path: p };
      if (item.laneStatus === "archived") {
        const laneId = laneIdByKey.get(baseName(p));
        return laneId ? { kind: "archived_lane_worktree", laneId, path: p } : null;
      }
      return null; // active worktrees are protected
    }
    case "recovery_backups":
      return { kind: "recovery_backup", path: p };
    case "build_release":
    case "caches":
      if (CACHE_SEGMENT.test(p)) return { kind: "rebuildable_cache", path: p };
      if (TMP_STAGING.test(p)) return { kind: "stale_tmp_staging", path: p };
      return null;
    default:
      return null; // chats_history, proof_attachments, database
  }
}

export type CleanableEntry = { item: StorageItem; target: StorageCleanupTarget };

/**
 * The items within a category that we can offer a working cleanup action for.
 * Excludes protected/compressible items and anything whose path we can't map to
 * a valid target, so we never present a Remove button that is doomed to block.
 */
export function cleanableEntries(
  categoryId: StorageCategoryId,
  category: StorageCategorySnapshot,
  laneIdByKey: Map<string, string>,
): CleanableEntry[] {
  const out: CleanableEntry[] = [];
  for (const item of category.items) {
    const target = buildCleanupTarget(categoryId, item, laneIdByKey);
    if (!target) continue;
    if (categoryId === "lanes_worktrees") {
      if (item.safety !== "review_first") continue;
    } else if (categoryId !== "recovery_backups") {
      if (item.safety !== "safe_to_remove") continue;
    }
    out.push({ item, target });
  }
  return out;
}

/** Split lane items into their three display groups, largest first within each. */
export function groupLaneItems(items: StorageItem[]): {
  active: StorageItem[];
  archived: StorageItem[];
  orphaned: StorageItem[];
} {
  const active: StorageItem[] = [];
  const archived: StorageItem[] = [];
  const orphaned: StorageItem[] = [];
  for (const item of items) {
    if (item.laneStatus === "archived") archived.push(item);
    else if (item.laneStatus === "orphaned") orphaned.push(item);
    else active.push(item);
  }
  return { active, archived, orphaned };
}
