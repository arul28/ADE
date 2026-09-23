const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical 8-4-4-4-12 hex UUID (any version, any case). */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Trim and lowercase a caller-reserved UUID (lane id, launch id), or throw
 * `message`. Every reserved id goes through here so the same id always maps to
 * the same row and file name.
 */
export function requireNormalizedUuid(value: unknown, message: string): string {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!isUuid(id)) throw new Error(message);
  return id;
}
