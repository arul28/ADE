import { randomUUID } from "node:crypto";

/**
 * A folder renamed aside so its files can be removed after the caller
 * returns: `.<name>.ade-deleting-<8 hex>`, next to where it lived. The name is
 * ADE's own, which is what makes sweeping a forgotten one safe. Lane delete,
 * Archive & Reclaim and the build output cleanup all use it.
 */
export const DELETING_TRASH_SUFFIX = ".ade-deleting-";
export const DELETING_TRASH_NAME = /^\..+\.ade-deleting-[0-9a-f]{8}$/;

/** A fresh trash name for a folder called `baseName`. */
export function deletingTrashName(baseName: string): string {
  return `.${baseName}${DELETING_TRASH_SUFFIX}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}
