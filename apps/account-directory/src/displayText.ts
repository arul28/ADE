/**
 * Client-supplied text that a page or a list shows to a person: a computer
 * name, an ADE home.
 *
 * Control characters and format characters go. Format characters include the
 * bidi overrides and zero-width marks that can make a name read as something
 * else. Runs of whitespace fold to one space, and the result is cut to `max`
 * code points. The value is cleaned rather than refused, so an odd name never
 * blocks the request that carried it.
 */
export function boundedDisplayText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, max).join("").trim() || null;
}
