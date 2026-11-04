/** The four groups, in the order the drawer stacks them (§B1). */
export const APPLE_DRAWER_GROUPS = ["device", "app", "capture", "preview-lab"] as const;

export type AppleDrawerGroupId = (typeof APPLE_DRAWER_GROUPS)[number];

export function isAppleDrawerGroupId(value: unknown): value is AppleDrawerGroupId {
  return typeof value === "string" && (APPLE_DRAWER_GROUPS as readonly string[]).includes(value);
}
