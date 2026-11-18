import type { ClientMinimumResponse } from "../../../account-directory/src/clientMinimumContract";
import { shippedVersionOrNull, updateTrackOfVersion, type UpdateTrack } from "./updateTrack";
import { compareUpdateVersions } from "./updateVersions";

/**
 * Whether a desktop build (this app, its brain, or another machine's ADE seen
 * from here) has to update before it keeps working.
 *
 * The one rule every surface shares, so a machine never reads "update
 * required" in one window and "fine" in another. It never blocks unless all
 * of these hold:
 * - the build is a released Stable or Beta build (not Alpha, a dev build or
 *   a one-off preview);
 * - the owner set a minimum for its track and the build is below it;
 * - an update that meets the minimum is published on that track, so pressing
 *   Update can actually finish. A minimum set ahead of the release, or a
 *   track whose newest build is unknown, blocks nobody.
 */

export type DesktopUpdateRequirement =
  | { required: false }
  | {
    required: true;
    track: UpdateTrack;
    currentVersion: string;
    minimumVersion: string;
    /** The newest published build on the track, which meets the minimum. */
    targetVersion: string;
  };

/** Alpha builds, previews and dev builds never have a minimum. */
export function isGateExemptVersion(version: string | null | undefined): boolean {
  const shipped = shippedVersionOrNull(version);
  if (!shipped) return true;
  const prerelease = shipped.replace(/^v/i, "").split("+")[0]?.split("-").slice(1).join("-").toLowerCase() ?? "";
  return /(^|\.)(alpha|preview|dev|rc)(\.|$)/.test(prerelease) || prerelease.includes("alpha");
}

export function desktopUpdateRequirement(args: {
  currentVersion: string | null | undefined;
  minimum: Pick<ClientMinimumResponse, "desktop"> | null | undefined;
  /** Newest published build per track; null when that track's feed was not read. */
  latest: { stable: string | null; beta: string | null } | null | undefined;
}): DesktopUpdateRequirement {
  const current = args.currentVersion?.trim() ?? "";
  if (!current || isGateExemptVersion(current)) return { required: false };
  const track = updateTrackOfVersion(current);
  const minimumVersion = args.minimum?.desktop?.[track]?.trim() || null;
  if (!minimumVersion) return { required: false };
  if (compareUpdateVersions(current, minimumVersion) >= 0) return { required: false };
  const targetVersion = args.latest?.[track]?.trim() || null;
  // No published build meets the minimum yet: Update could not finish.
  if (!targetVersion || updateTrackOfVersion(targetVersion) !== track) return { required: false };
  if (compareUpdateVersions(targetVersion, minimumVersion) < 0) return { required: false };
  return { required: true, track, currentVersion: current, minimumVersion, targetVersion };
}

/**
 * How long a read of `/client/minimum` decides. Past this the gate opens: a
 * machine that cannot reach the account server cannot download an update
 * either, and its work goes on.
 */
export const CLIENT_MINIMUM_FRESH_MS = 12 * 60 * 60_000;
