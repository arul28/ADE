import type { AutoUpdatePhase, AutoUpdateTrackState } from "../../../shared/types";
import {
  BETA_FEED_BASE_URL,
  isOrdinaryUpdateOffer,
  updateTrackOfVersion,
  type UpdateTrack,
} from "../../../shared/updateTrack";
import type { Logger } from "../logging/logger";

/**
 * Which builds this launch takes, and from which feed (docs/plans/beta-track.md).
 *
 * An ordinary check only moves forward inside the selected track. Crossing to
 * the other track happens only through `beginSwitch`, which the service calls
 * after the database guard allowed it; during that switch the target track's
 * builds, older ones included, are accepted.
 */
export type TrackFeedUpdater = {
  allowPrerelease?: boolean;
  allowDowngrade?: boolean;
  setFeedURL?: (
    options:
      | { provider: "github"; owner: string; repo: string }
      | { provider: "generic"; url: string },
  ) => void;
};

export type TrackFeedPolicy = ReturnType<typeof createTrackFeedPolicy>;

// Local on purpose: the service's formatter lives in autoUpdateService.ts,
// which imports this module.
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTrackFeedPolicy(args: {
  updater: TrackFeedUpdater;
  currentVersion: string;
  /** The dev feed override. It wins over tracks: it tests the install flow itself. */
  overrideFeedUrl: string | undefined;
  /** `owner/repo` of the stable feed. */
  releaseRepository: string;
  readSelectedTrack: (() => UpdateTrack | null) | undefined;
  logger: Logger;
}) {
  const { updater, currentVersion, overrideFeedUrl, logger } = args;
  const runningTrack = updateTrackOfVersion(currentVersion);
  // The service always passes a validated `owner/repo`.
  const [releaseOwner, releaseRepo] = args.releaseRepository.split("/") as [string, string];

  const readSaved = (): UpdateTrack => {
    try {
      return args.readSelectedTrack?.() ?? runningTrack;
    } catch (error) {
      logger.warn("autoUpdate.track_read_failed", { message: errorText(error) });
      return runningTrack;
    }
  };

  let selected: UpdateTrack = readSaved();
  // Set only while this launch moves the machine to the other track. Kept in
  // memory: the build the switch installs saves the choice once it has
  // landed, so quitting before the restart leaves the machine on its old track.
  let switching: UpdateTrack | null = null;
  // The track the updater's feed is set up for; null until the first setup.
  let feedTrack: UpdateTrack | null = null;
  // Whether this launch pointed the updater at the Beta feed. Kept apart from
  // `feedTrack`, which a switch clears to force a new setup.
  let pointedAtBetaFeed = false;

  /** The track whose builds this launch takes: a switch's target, else the choice. */
  const targetTrack = (): UpdateTrack => switching ?? selected;

  function configure(): void {
    const track = targetTrack();
    if (overrideFeedUrl || feedTrack === track) return;
    try {
      if (track === "beta") {
        updater.setFeedURL?.({ provider: "generic", url: BETA_FEED_BASE_URL });
        pointedAtBetaFeed = true;
      } else if (pointedAtBetaFeed || runningTrack === "beta") {
        // A Stable build never got here before tracks existed, so its packaged
        // feed is left exactly as it was; only a build that was pointed at the
        // Beta feed, or a Beta build moving to Stable, is pointed back.
        updater.setFeedURL?.({ provider: "github", owner: releaseOwner, repo: releaseRepo });
        pointedAtBetaFeed = false;
      }
      // On the GitHub feed a `-beta.` build would otherwise take the newest
      // release of any kind. Stable reads only `releases/latest`.
      updater.allowPrerelease = false;
      // Older builds are accepted only while a switch moves this machine to
      // the other track (`switching` is never the running track); the switch
      // already checked the databases.
      updater.allowDowngrade = switching !== null;
      feedTrack = track;
      logger.info("autoUpdate.track_feed_configured", { track, runningTrack, switching });
    } catch (error) {
      logger.warn("autoUpdate.track_feed_config_failed", { track, message: errorText(error) });
    }
  }

  return {
    runningTrack,

    /**
     * Rereads the saved choice (the CLI can change it). True when it changed.
     * A switch in progress keeps its own target until it installs or is
     * cancelled.
     */
    refreshSelected(): boolean {
      if (switching) return false;
      const saved = readSaved();
      if (saved === selected) return false;
      selected = saved;
      return true;
    },

    configure,

    /** Whether a build the feed answered with may be offered in this launch. */
    acceptsOffer(version: string): boolean {
      if (overrideFeedUrl) return true;
      if (switching && updateTrackOfVersion(version) === switching) {
        // The switch target itself, or a newer build on that track.
        return version !== currentVersion;
      }
      return isOrdinaryUpdateOffer({ selectedTrack: selected, currentVersion, offeredVersion: version });
    },

    /**
     * The Beta feed answers 404 between betas, or before the first one exists.
     * That means "no Beta build right now", not a failure to show. A bare 404
     * counts only while checking: during a download it means a beta's own file
     * is gone, which is a real failure.
     */
    isMissingFeed(error: unknown, phase: AutoUpdatePhase): boolean {
      if (targetTrack() !== "beta" || overrideFeedUrl) return false;
      if ((error as { code?: unknown } | null)?.code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND") return true;
      return phase === "check" && /\b404\b/.test(errorText(error));
    },

    state(): AutoUpdateTrackState {
      return { selected, running: runningTrack, switching };
    },

    /** The feed a network probe should ask: the Beta feed while it is in use. */
    genericFeedUrl(): string | undefined {
      return overrideFeedUrl ?? (targetTrack() === "beta" ? BETA_FEED_BASE_URL : undefined);
    },

    /** Points the feed at `target` for this launch. Back to the running track cancels a switch. */
    beginSwitch(target: UpdateTrack): void {
      selected = target;
      switching = target === runningTrack ? null : target;
      feedTrack = null;
      configure();
    },
  };
}
