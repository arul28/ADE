/**
 * The helper's `ping.linux` reply: what a Linux host is missing for a lane
 * screen, and the command that installs it.
 *
 * Kept apart from the installer so the driver lifecycle can read one protocol
 * field without depending on package management.
 */

import type { LinuxDesktopHostFacts } from "../../../shared/types/macDesktop";
import { linuxDesktopInstallCommand } from "./linuxDesktopSetup";

/** Read loosely: an older helper sends no `linux` object, and this answers null. */
export function readLinuxHostFacts(value: unknown): LinuxDesktopHostFacts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const missing = Array.isArray(record.missing)
    ? record.missing.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    missing,
    encoder: typeof record.encoder === "string" ? record.encoder : null,
    installCommand: linuxDesktopInstallCommand(missing),
  };
}
