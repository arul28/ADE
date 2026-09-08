import type { BuiltInBrowserStatus } from "../../../shared/types";

export const BUILT_IN_BROWSER_PARTITION: BuiltInBrowserStatus["partition"] = "persist:ade-browser";
export const BUILT_IN_BROWSER_WEBAUTHN_KEYCHAIN_ACCESS_GROUP = "VQ372F39G6.com.ade.desktop.webauthn";

/**
 * Two-line value helpers shared by `builtInBrowserService` and its extracted
 * tab-capability half. They live here rather than in either of those so the
 * capability module can import them without an import cycle back through the
 * service, and so there is one copy rather than a fork per module.
 */

/** Trimmed string, or `null` for a blank one. */
export function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/** Non-negative integer pixel value; `0` for anything non-finite. */
export function normalizeDimension(value: unknown): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value as number));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
