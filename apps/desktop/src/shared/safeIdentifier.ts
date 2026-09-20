/** Identifiers that are safe to use as ADE-owned path or storage-key segments. */
export const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isSafeIdentifier(value: string): boolean {
  // WHY: `path.resolve(root, "..")` is a valid path operation, but it would
  // turn an ADE-owned child home into its parent and cross the intended
  // credential/preset boundary.
  return value !== "." && value !== ".." && SAFE_IDENTIFIER_PATTERN.test(value);
}
