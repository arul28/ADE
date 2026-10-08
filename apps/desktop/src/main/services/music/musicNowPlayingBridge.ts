import type { HomeNowPlayingState } from "../../../shared/types/homeWidgets";
import { musicArtworkUrl, type MusicCommand, type MusicState } from "../../../shared/types/music";
import type { NowPlayingService } from "../home/nowPlayingService";

/**
 * Lets the Music tab take over the home page's Now Playing widget.
 *
 * While ADE's own player has a track loaded, the widget shows it and its
 * buttons drive it; when the player has nothing loaded (signed out, unloaded
 * with no track, never started) the widget goes back to the OS media source.
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
        app: "Apple Music",
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
