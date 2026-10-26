/**
 * The helper's `ping.linux` reply: what a Linux host is missing for a lane
 * screen.
 *
 * Pure on purpose: it reads the reply and nothing else. The install command
 * is derived from this report where the status is built
 * (`macDesktopService`), so the driver lifecycle can read one protocol field
 * without depending on package management.
 */

import type { LinuxDesktopHostReport } from "../../../shared/types/macDesktop";

/** Read loosely: an older helper sends no `linux` object, and this answers null. */
export function readLinuxHostFacts(value: unknown): LinuxDesktopHostReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const missing = Array.isArray(record.missing)
    ? record.missing.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    missing,
    encoder: typeof record.encoder === "string" ? record.encoder : null,
  };
}
