/**
 * Adapters between the iOS Simulator drawer UI and the preload/service
 * contracts it consumes, plus the small formatters the drawer's compact
 * chrome needs. Keeping them here means the panel and its sibling components
 * never reach into `window.ade` shapes directly.
 */
import type {
  IosSimulatorLaunchResult,
  IosSimulatorSession,
} from "../../../shared/types";

/*
 * `openIosSimSettingsPane` and `revealSimulator` used to live here. Both
 * belonged to the window-capture era: one opened the Screen Recording pane the
 * capture needed, the other un-minimized Simulator.app so there was a window to
 * capture. The helper reads the framebuffer directly, so neither has a caller
 * and neither has anything to do.
 */

/**
 * What the drawer shows about *which* binary is running: the checkout it was
 * built from, and whether it was built at all. Deliberately not the capability
 * matrix — the renderer derives tap/type availability from the tool chips.
 */
export type IosSimLaunchExtras = {
  buildRoot: string | null;
  usedInstalledBinary: boolean;
};

export const EMPTY_LAUNCH_EXTRAS: IosSimLaunchExtras = {
  buildRoot: null,
  usedInstalledBinary: false,
};

/**
 * Reads the extras off a launch return *or* off the active session.
 *
 * The drawer is not always the thing that launched: an agent can launch and the
 * user opens the drawer afterwards, in which case the session is the only place
 * these fields exist. Both shapes carry them optionally over the wire, so every
 * read is defensive — a session from an older host simply reports nothing.
 */
export function readLaunchExtras(
  result: IosSimulatorLaunchResult | IosSimulatorSession | null | undefined,
): IosSimLaunchExtras {
  if (!result) return EMPTY_LAUNCH_EXTRAS;
  // Both shapes declare these, so no cast is needed — only the runtime guards,
  // because a session from an older host carries neither.
  const { buildRoot, usedInstalledBinary } = result;
  return {
    buildRoot: typeof buildRoot === "string" ? buildRoot.trim() || null : null,
    usedInstalledBinary: usedInstalledBinary === true,
  };
}

/** `73_000` -> `1m 13s`. Compact, no prose. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Session age for the ownership card. */
export function formatAge(startedAt: string | null | undefined, now: number): string | null {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return null;
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
