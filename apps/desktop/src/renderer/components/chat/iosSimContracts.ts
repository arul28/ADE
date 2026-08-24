/**
 * Adapters between the iOS Simulator drawer UI and the preload/service
 * contracts it consumes, plus the small formatters the drawer's compact
 * chrome needs. Keeping them here means the panel and its sibling components
 * never reach into `window.ade` shapes directly.
 */
import type {
  IosSimulatorCapabilities,
  IosSimulatorLaunchResult,
  IosSimulatorWindowState,
} from "../../../shared/types";
import type {
  IosSimulatorPrivacyPane,
  IosSimulatorWindowIssueEx,
  IosSimulatorWindowSourcesResult,
  IosSimulatorWindowStateEx,
} from "../../../shared/types/iosSimulatorWindowCapture";

export type IosSimSettingsPane = IosSimulatorPrivacyPane;
export type IosSimWindowIssue = IosSimulatorWindowIssueEx;
export type IosSimWindowStateEx = IosSimulatorWindowStateEx;
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
 * The window-state poll and the window-sources call both return the widened
 * state; `simulatorWindowState` is held as the base type so the two sources
 * agree. Narrow at the point of use.
 */
export function readWindowState(state: IosSimulatorWindowState | null | undefined): IosSimWindowStateEx | null {
  return (state as IosSimWindowStateEx | null | undefined) ?? null;
}

export function readWindowIssue(state: IosSimulatorWindowState | null | undefined): IosSimWindowIssue | null {
  return readWindowState(state)?.issue ?? null;
}

/**
 * Passes the runtime session down so the host scores window sources against the
 * device that is actually booted — Electron main's own service sees a null
 * `activeSession` for brain-owned launches, which is what used to park capture
 * on a stale simulator window after a device switch.
 */
export async function listWindowSourcesForSession(
  session: { deviceUdid: string; deviceName: string | null } | null,
): Promise<IosSimWindowSourcesResult> {
  return window.ade.iosSimulator.listSimulatorWindowSources(session ? { session } : undefined);
}

export type IosSimLaunchExtras = {
  buildRoot: string | null;
  capabilities: IosSimulatorCapabilities | null;
  usedInstalledBinary: boolean;
};

export const EMPTY_LAUNCH_EXTRAS: IosSimLaunchExtras = {
  buildRoot: null,
  capabilities: null,
  usedInstalledBinary: false,
};

export function readLaunchExtras(result: IosSimulatorLaunchResult | null | undefined): IosSimLaunchExtras {
  if (!result) return EMPTY_LAUNCH_EXTRAS;
  return {
    buildRoot: result.buildRoot.trim() || null,
    capabilities: result.capabilities,
    usedInstalledBinary: result.usedInstalledBinary,
  };
}

/** `/Users/me/.ade/worktrees/my-lane` -> `…/worktrees/my-lane` */
export function pathTail(value: string, segments = 2): string {
  const parts = value.replace(/[\\/]+$/u, "").split(/[\\/]/u).filter(Boolean);
  if (parts.length <= segments) return parts.join("/");
  return `…/${parts.slice(-segments).join("/")}`;
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
