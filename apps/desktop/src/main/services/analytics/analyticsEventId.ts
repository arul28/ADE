import { createHash } from "node:crypto";

/**
 * A stable, v4-shaped insert id for an event derived from another record, so a
 * retried capture of the same fact is one event in PostHog.
 */
export function derivedEventId(baseId: string, suffix: string): string {
  const chars = createHash("sha256").update(`${baseId}:${suffix}`).digest("hex").slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = "8";
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
