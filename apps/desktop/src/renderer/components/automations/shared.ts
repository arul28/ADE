/** Shared utilities for the automations UI. */

/**
 * The input chrome moved to `@ade-dev/ui`, because a plugin page's settings
 * section needs the same box. `INPUT_STYLE` and `CARD_STYLE` stay empty
 * objects, as they were: call sites spread them, and removing them would touch
 * every one.
 *
 * `extractError` and `parseList` are not UI and stay here.
 */
export { CARD_STYLE, INPUT_CLS, INPUT_STYLE } from "@ade-dev/ui";

/** Extract a human-readable error message from an unknown thrown value. */
export function extractError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parse a comma-separated input into a trimmed, non-empty string list. */
export function parseList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}
