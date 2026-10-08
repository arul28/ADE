/** A plain object's fields, or null for anything else (arrays included). Dependency-free, so any module can use it without an import cycle. */
export function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
