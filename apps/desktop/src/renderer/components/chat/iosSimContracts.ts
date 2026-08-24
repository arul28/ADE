/**
 * Adapters between the iOS Simulator drawer UI and the preload/service
 * contracts it consumes, plus the small formatters the drawer's compact
 * chrome needs. Keeping them here means the panel and its sibling components
 * never reach into `window.ade` shapes directly.
 */
import type {
  IosSimulatorLaunchResult,
  IosSimulatorPrivacyPane,
  IosSimulatorSession,
  IosSimulatorWindowSourcesResult,
} from "../../../shared/types";

export type IosSimSettingsPane = IosSimulatorPrivacyPane;
export type IosSimWindowSourcesResult = IosSimulatorWindowSourcesResult;

/** Opens the macOS privacy pane the blocked capability lives in. */
export async function openIosSimSettingsPane(pane: IosSimSettingsPane): Promise<void> {
  await window.ade.iosSimulator.openSystemSettings({ pane });
}

export type IosSimRevealResult = { ok: boolean; message: string | null };

/**
 * Un-hides, un-minimizes and activates Simulator.app — the one place ADE
 * deliberately takes focus, because the user asked for it.
 *
 * Resolves `{ ok: false }` with a populated `message` for a denied Automation
 * grant, a Simulator that is not running, and non-macOS. Callers must honour
 * `ok`: reporting a refused reveal as a success is the exact silent failure the
 * blocker overlay exists to kill.
 */
export async function revealSimulator(): Promise<IosSimRevealResult> {
  return window.ade.iosSimulator.revealSimulator();
}

/**
 * Passes the runtime session down as a park/settle trigger: Electron main's own
 * service sees a null `activeSession` for brain-owned launches, so without this
 * hint the host never parks the window at all. Scoring the returned sources
 * against the booted device happens here in the renderer, in
 * `pickSimulatorWindowSource` — the host does not rank them.
 */
export async function listWindowSourcesForSession(
  session: { deviceUdid: string; deviceName: string | null } | null,
): Promise<IosSimWindowSourcesResult> {
  return window.ade.iosSimulator.listSimulatorWindowSources(session ? { session } : undefined);
}

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
  const buildRoot = (result as { buildRoot?: unknown }).buildRoot;
  return {
    buildRoot: typeof buildRoot === "string" ? buildRoot.trim() || null : null,
    usedInstalledBinary: (result as { usedInstalledBinary?: unknown }).usedInstalledBinary === true,
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
