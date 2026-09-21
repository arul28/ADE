/**
 * Whether each harness can run on this computer right now, and why not.
 *
 * The wizard shows every harness and lets you pick an unavailable one on
 * purpose: a preset is a saved intention, and refusing to save "Droid on my
 * Anthropic key" because Droid is not installed yet would make the list
 * describe the machine instead of the work. The reason is shown on the card so
 * the choice is informed rather than silent.
 */

import type { AiSettingsStatus } from "../../../../shared/types";
import { HARNESS_PRESET_BODIES, type HarnessPresetBody } from "../../../../shared/harnessPresets";

export type HarnessAvailability = {
  available: boolean;
  /** One sentence naming what is missing. Empty when the harness is ready. */
  reason: string;
};

const UNKNOWN: HarnessAvailability = { available: true, reason: "" };

/**
 * Read one harness's readiness off the provider status probe.
 *
 * A `null` status means the probe has not landed; every harness reads as
 * available then, because flashing "not installed" at a list that is still
 * loading is a false claim, not a cautious one.
 */
export function harnessAvailability(
  harness: HarnessPresetBody,
  status: AiSettingsStatus | null,
): HarnessAvailability {
  if (!status) return UNKNOWN;
  const providers = status.availableProviders;

  if (harness === "claude") {
    const claude = providers?.claude;
    if (!claude) return UNKNOWN;
    if (!claude.binary?.present) return { available: false, reason: "Claude Code is not installed on this computer." };
    if (!claude.auth?.ready) return { available: false, reason: "Claude Code is installed but not signed in." };
    return { available: true, reason: "" };
  }
  if (harness === "codex") {
    return providers?.codex
      ? { available: true, reason: "" }
      : { available: false, reason: "Codex CLI is not installed or not signed in." };
  }
  if (harness === "cursor") {
    return providers?.cursor
      ? { available: true, reason: "" }
      : { available: false, reason: "Cursor is not installed or not signed in." };
  }
  if (harness === "droid") {
    return providers?.droid
      ? { available: true, reason: "" }
      : { available: false, reason: "Droid is not installed or not signed in." };
  }
  if (harness === "opencode") {
    if (status.opencodeBinaryInstalled === false) {
      return { available: false, reason: "OpenCode is not installed on this computer." };
    }
    return { available: true, reason: "" };
  }
  if (harness === "pi") {
    const pi = status.piInstallation;
    if (!pi) return UNKNOWN;
    if (!pi.installed) return { available: false, reason: "Pi is not installed on this computer." };
    if (pi.blocker) return { available: false, reason: pi.blocker };
    return { available: true, reason: "" };
  }
  // The ACP CLIs (qwen, kimi, grok, copilot) report a plain boolean, and an
  // absent key means the probe predates that provider rather than that the
  // provider is missing.
  const acp = providers?.[harness as "qwen" | "kimi" | "grok" | "copilot"];
  if (acp === undefined) return UNKNOWN;
  return acp
    ? { available: true, reason: "" }
    : { available: false, reason: "Not installed or not signed in." };
}

/** Readiness for every harness, for the wizard's card grid. */
export function harnessAvailabilityMap(
  status: AiSettingsStatus | null,
): Record<HarnessPresetBody, HarnessAvailability> {
  const out = {} as Record<HarnessPresetBody, HarnessAvailability>;
  for (const harness of HARNESS_PRESET_BODIES) out[harness] = harnessAvailability(harness, status);
  return out;
}
