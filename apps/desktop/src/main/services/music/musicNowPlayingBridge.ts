import type { HomeNowPlayingState } from "../../../shared/types/homeWidgets";
import { musicArtworkUrl, type MusicCommand, type MusicState } from "../../../shared/types/music";
import type { NowPlayingService } from "../home/nowPlayingService";

/**
 * Puts the Music tab's player in the home page's Now Playing list.
 *
 * While ADE's own player has a track loaded it is a Now Playing source (the
 * first one while it plays) and the widget's buttons drive it; when it has
 * nothing loaded (signed out, unloaded with no track, never started) it leaves
 * the list to the browser tabs and other apps.
 */
export function createMusicNowPlayingBridge(args: {
  nowPlaying: () => NowPlayingService | null;
  command: (command: MusicCommand) => Promise<unknown>;
}): (state: MusicState) => void {
  let latest: HomeNowPlayingState = { available: true, session: null, source: "ade-music" };
  let push: ((state: HomeNowPlayingState) => void) | null = null;

  return (state) => {
    const service = args.nowPlaying();
    if (!service) return;
    const track = state.playback.nowPlaying;
    if (!track) {
      if (push) {
        push = null;
        service.setOverride(null);
      }
      return;
    }
    const playing = state.playback.isPlaying;
    latest = {
      available: true,
      source: "ade-music",
      session: {
        id: "ade-music",
        kind: "ade-music",
        app: "Apple Music",
        appIcon: null,
        title: track.title,
        artist: track.artist,
        album: track.album,
        status: playing ? "playing" : "paused",
        positionMs: Math.round(state.playback.position * 1000),
        durationMs: track.durationMs ?? Math.round(state.playback.duration * 1000),
        updatedAt: state.playback.positionAt,
        canPlay: true,
        canPause: true,
        canNext: true,
        canPrevious: true,
        artwork: musicArtworkUrl(track.artwork, 192),
      },
    };
    if (!push) {
      push = service.setOverride({
        getState: () => latest,
        command: async (command) => {
          await args.command({ type: command });
        },
      });
    }
    push(latest);
  };
}
