// ---------------------------------------------------------------------------
// Update tracks: Stable and Beta. See docs/plans/beta-track.md.
//
// A track is not a separate install. Both tracks are the same app (same app
// id, same ~/.ade, same brain, same CLI); they differ only in which builds a
// machine takes. The track of a build is read from its version alone, so main,
// renderer, the brain, the CLI and the phone always agree on it.
// ---------------------------------------------------------------------------

import { compareUpdateVersions } from "./updateVersions";

export type UpdateTrack = "stable" | "beta";

export const UPDATE_TRACKS: readonly UpdateTrack[] = ["stable", "beta"];

/**
 * The fixed Beta feed: a GitHub prerelease whose `latest-mac.yml`,
 * `latest.yml` and `beta.json` always describe the current beta, with file
 * URLs that point at the versioned beta release. CI replaces them only after
 * that release is fully published.
 *
 * electron-updater's GitHub provider is not used for Beta on purpose: for a
 * `-beta.` build it takes the newest release of any kind, stable included.
 */
export const BETA_FEED_TAG = "beta-feed";
export const BETA_FEED_BASE_URL = `https://github.com/arul28/ADE/releases/download/${BETA_FEED_TAG}/`;
export const BETA_FEED_MANIFEST_URL = `${BETA_FEED_BASE_URL}beta.json`;

/** Every release carries one: `release-manifest.json`. */
export const RELEASE_MANIFEST_ASSET = "release-manifest.json";

/**
 * The version in `apps/desktop/package.json` that every unreleased build (dev
 * apps, dev brains, tests) reports. Release builds stamp the tag over it, so a
 * shipped build never carries it. It looks like a beta, so it is named here:
 * a dev build is never on the Beta track.
 */
export const DEV_PLACEHOLDER_VERSION = "1.0.0-beta.1";

/**
 * Beta when the version's prerelease starts with `beta` (`1.2.128-beta.3`,
 * and the one-off test builds `1.2.128-beta.0.preview.7`); Stable otherwise.
 * A `v` prefix and build metadata are ignored.
 */
export function updateTrackOfVersion(version: string | null | undefined): UpdateTrack {
  const trimmed = (version ?? "").trim().replace(/^v/i, "").split("+")[0] ?? "";
  if (trimmed === DEV_PLACEHOLDER_VERSION) return "stable";
  const dash = trimmed.indexOf("-");
  if (dash < 0) return "stable";
  const firstIdentifier = trimmed.slice(dash + 1).split(".")[0]?.toLowerCase() ?? "";
  return firstIdentifier === "beta" ? "beta" : "stable";
}

/** Hands the running build's track to the preload, like the package channel. */
export const UPDATE_TRACK_ARGV_PREFIX = "--ade-update-track=";

/** The running build's track in the renderer/preload. Missing means Stable. */
export function resolveUpdateTrackFromArgv(argv: readonly string[] | undefined): UpdateTrack {
  for (const arg of argv ?? []) {
    if (typeof arg === "string" && arg.startsWith(UPDATE_TRACK_ARGV_PREFIX)) {
      return normalizeUpdateTrack(arg.slice(UPDATE_TRACK_ARGV_PREFIX.length)) ?? "stable";
    }
  }
  return "stable";
}

export function normalizeUpdateTrack(value: unknown): UpdateTrack | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "stable" || normalized === "beta" ? normalized : null;
}

/** "Stable" or "Beta": the only two words the UI uses for tracks. */
export function updateTrackLabel(track: UpdateTrack): string {
  return track === "beta" ? "Beta" : "Stable";
}

/**
 * Whether a machine on `selectedTrack`, running `currentVersion`, may be
 * offered `offeredVersion` by an ordinary update check.
 *
 * An ordinary check only ever moves forward inside the selected track. A
 * build from the other track, or an older one, is reached only through the
 * guarded track switch, which checks the databases first (T3 #2049, #26288).
 */
export function isOrdinaryUpdateOffer(args: {
  selectedTrack: UpdateTrack;
  currentVersion: string;
  offeredVersion: string;
}): boolean {
  if (updateTrackOfVersion(args.offeredVersion) !== args.selectedTrack) return false;
  if (updateTrackOfVersion(args.currentVersion) !== args.selectedTrack) return false;
  return compareUpdateVersions(args.offeredVersion, args.currentVersion) > 0;
}

/**
 * The parts of `release-manifest.json` a client reads. Unknown fields are
 * ignored, so the manifest can grow.
 */
export type ReleaseManifest = {
  version: string;
  tag: string;
  track: UpdateTrack;
  commit: string | null;
  publishedAt: string | null;
  /** `DB_COMPAT_LEVEL` of that build; null when the manifest does not say. */
  dbCompat: number | null;
  syncProtocol: { version: number; minSupported: number } | null;
};

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Null when the value is not a usable manifest. */
export function parseReleaseManifest(value: unknown): ReleaseManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const version = typeof record.version === "string" ? record.version.trim().replace(/^v/i, "") : "";
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return null;
  const tag = typeof record.tag === "string" && record.tag.trim() ? record.tag.trim() : `v${version}`;
  const sync = record.syncProtocol && typeof record.syncProtocol === "object"
    ? record.syncProtocol as Record<string, unknown>
    : null;
  const syncVersion = finiteInteger(sync?.version);
  const syncMin = finiteInteger(sync?.minSupported);
  return {
    version,
    tag,
    // The version decides; a manifest that disagrees with its own version is
    // not trusted on this point.
    track: updateTrackOfVersion(version),
    commit: typeof record.commit === "string" && /^[0-9a-f]{40}$/i.test(record.commit) ? record.commit.toLowerCase() : null,
    publishedAt: typeof record.publishedAt === "string" ? record.publishedAt : null,
    dbCompat: finiteInteger(record.dbCompat),
    syncProtocol: syncVersion != null && syncMin != null ? { version: syncVersion, minSupported: syncMin } : null,
  };
}

/** Where a stable release's manifest lives. */
export function stableReleaseManifestUrl(tag: string): string {
  return `https://github.com/arul28/ADE/releases/download/${tag}/${RELEASE_MANIFEST_ASSET}`;
}

export const LATEST_STABLE_MANIFEST_URL =
  `https://github.com/arul28/ADE/releases/latest/download/${RELEASE_MANIFEST_ASSET}`;
