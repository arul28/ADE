// ---------------------------------------------------------------------------
// A machine runs two ADE versions: its brain (the background service other
// devices talk to) and its desktop app. They usually match. After
// `ade brain update`, or an app update while the brain kept running, they do
// not, and a surface that shows only the brain calls a machine whose app is
// behind "up to date". These helpers show one version when they agree and
// both when they drift, and give the version that decides "is it behind?".
// Shared by the desktop renderer, the brain and the CLI.
// ---------------------------------------------------------------------------

import { compareUpdateVersions } from "./updateVersions";

export type MachineVersions = {
  /** The brain's version: what answers other machines. */
  brainVersion: string | null | undefined;
  /** The installed desktop app's version. Null when there is none (a headless server) or a brain too old to say. */
  appVersion: string | null | undefined;
};

function clean(version: string | null | undefined): string | null {
  const trimmed = version?.trim();
  return trimmed ? trimmed : null;
}

function sameVersion(left: string, right: string): boolean {
  return left.replace(/^v/i, "") === right.replace(/^v/i, "")
    || compareUpdateVersions(left, right) === 0;
}

/** Both versions are known and they differ. */
export function machineVersionsDrift(versions: MachineVersions): boolean {
  const brain = clean(versions.brainVersion);
  const app = clean(versions.appVersion);
  return Boolean(brain && app && !sameVersion(brain, app));
}

/**
 * The version that decides whether the machine is behind: the older of the
 * two when they drift, so a machine whose app is behind never reads as up to
 * date. One version when only one is known.
 */
export function machineComparableVersion(versions: MachineVersions): string | null {
  const brain = clean(versions.brainVersion);
  const app = clean(versions.appVersion);
  if (!brain || !app) return brain ?? app;
  return compareUpdateVersions(app, brain) <= 0 ? app : brain;
}

/**
 * The version text without a product name: "1.2.125" when they agree (or the
 * app is unknown), "1.2.123 · brain 1.2.125" when they drift. The app comes
 * first because it is what the person sees on that machine.
 */
export function formatMachineVersions(versions: MachineVersions): string | null {
  const brain = clean(versions.brainVersion);
  const app = clean(versions.appVersion);
  if (brain && app && !sameVersion(brain, app)) return `${app} · brain ${brain}`;
  return brain ?? app;
}
