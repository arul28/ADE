import {
  BETA_FEED_MANIFEST_URL,
  LATEST_STABLE_MANIFEST_URL,
  parseReleaseManifest,
  updateTrackOfVersion,
  type UpdateTrack,
} from "../../../shared/updateTrack";
import type { AutoUpdateLatestByTrack } from "../../../shared/types";
import type { Logger } from "../logging/logger";

/**
 * The newest published build of BOTH tracks, whichever one this computer
 * follows. electron-updater only reads this computer's own feed, so a Beta
 * computer never learns the newest Stable build (and the reverse); another
 * machine on the other track would then have no build to be offered.
 *
 * Each track's `release-manifest.json` is one small JSON read from GitHub's
 * release downloads (no API rate limit). Read beside the ordinary update check
 * (startup, every 30 minutes, "Check for updates"), never on its own timer.
 * A failed or unreadable answer keeps the last version that track had, so an
 * offline check never takes a known build away and never invents one.
 */
export type LatestByTrackReader = {
  /** The last known value; null for a track never read successfully. */
  current(): AutoUpdateLatestByTrack;
  /**
   * Reads both tracks unless a read finished within `minIntervalMs`. Resolves
   * the (possibly unchanged) value; never rejects.
   */
  refresh(): Promise<AutoUpdateLatestByTrack>;
};

const TRACK_MANIFEST_URLS: Record<UpdateTrack, string> = {
  stable: LATEST_STABLE_MANIFEST_URL,
  beta: BETA_FEED_MANIFEST_URL,
};

export function createLatestByTrackReader(args: {
  /** Resolves the parsed JSON, `null` for a 404, and throws on other failures. */
  fetchJson: (url: string) => Promise<unknown | null>;
  /**
   * Stable's newest version from somewhere else, for a Stable release that
   * predates `release-manifest.json` (the manifest answers 404).
   */
  fetchStableFallback?: () => Promise<string | null>;
  logger?: Pick<Logger, "warn">;
  /** A "Check for updates" pressed again right away reuses the last read. */
  minIntervalMs?: number;
  nowMs?: () => number;
}): LatestByTrackReader {
  const minIntervalMs = args.minIntervalMs ?? 60_000;
  const nowMs = args.nowMs ?? (() => Date.now());
  let latest: AutoUpdateLatestByTrack = { stable: null, beta: null };
  let lastReadAtMs: number | null = null;
  let inFlight: Promise<AutoUpdateLatestByTrack> | null = null;

  async function readTrack(track: UpdateTrack): Promise<string | null> {
    try {
      const raw = await args.fetchJson(TRACK_MANIFEST_URLS[track]);
      if (raw === null) {
        return track === "stable" && args.fetchStableFallback
          ? validVersionOn(track, await args.fetchStableFallback())
          : null;
      }
      return validVersionOn(track, parseReleaseManifest(raw)?.version ?? null);
    } catch (error) {
      args.logger?.warn("autoUpdate.latest_by_track_read_failed", {
        track,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async function readBoth(): Promise<AutoUpdateLatestByTrack> {
    const [stable, beta] = await Promise.all([readTrack("stable"), readTrack("beta")]);
    // An answer replaces the old value; no answer keeps it.
    latest = { stable: stable ?? latest.stable, beta: beta ?? latest.beta };
    lastReadAtMs = nowMs();
    return latest;
  }

  return {
    current: () => latest,
    refresh() {
      if (inFlight) return inFlight;
      if (lastReadAtMs != null && nowMs() - lastReadAtMs < minIntervalMs) return Promise.resolve(latest);
      inFlight = readBoth().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

/** The version, only when it really is a build of `track`; a feed that disagrees is not trusted. */
function validVersionOn(track: UpdateTrack, version: string | null | undefined): string | null {
  const trimmed = version?.trim().replace(/^v/i, "") ?? "";
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(trimmed)) return null;
  return updateTrackOfVersion(trimmed) === track ? trimmed : null;
}
