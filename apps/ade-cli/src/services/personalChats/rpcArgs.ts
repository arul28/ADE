/** Argument readers shared by the personal-chat and host-settings RPC doors. */

export type ObjectArgs = Record<string, unknown>;

export function asObject(value: unknown): ObjectArgs {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectArgs
    : {};
}

export function requiredString(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}
