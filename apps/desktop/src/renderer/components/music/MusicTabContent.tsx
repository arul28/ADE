import React from "react";
import { CircleNotch, Pause, Play } from "@phosphor-icons/react";
import { AppleMusicAppIcon } from "./musicParts";

import { musicArtworkUrl } from "../../../shared/types/music";
import { musicActions, useMusicNowPlaying, useMusicPosition, useMusicState } from "./musicStore";
import "./music.css";

/**
 * What the Music top tab shows. The tab is the mini player: the current song's
 * cover (whole, never cropped to a circle), its title, a play/pause button, and
 * a hairline of progress along the tab's bottom edge. With nothing loaded it is
 * the plain "Music" tab.
 *
 * The tab being open is music being "on": closing it pauses and unloads the
 * player (`closeMusicTab`), and reopening shows the last song paused, ready to
 * resume where it stopped.
 */
export function MusicTabContent({ active }: { active: boolean }) {
  const { nowPlaying, isPlaying, busy } = useMusicNowPlaying();
  if (!nowPlaying) {
    return (
      <>
        <AppleMusicAppIcon size={15} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-center text-[12px]">Apple Music</span>
      </>
    );
  }
  const art = musicArtworkUrl(nowPlaying.artwork, 40);
  return (
    <>
      <span className="ade-music-tab-art" aria-hidden>
        {art ? <img src={art} alt="" draggable={false} /> : <AppleMusicAppIcon size={18} />}
      </span>
      <span className="ade-music-tab-text" title={`${nowPlaying.title} — ${nowPlaying.artist}`}>
        {nowPlaying.title}
      </span>
      <button
        type="button"
        className="ade-music-tab-toggle"
        data-active={active || undefined}
        aria-label={isPlaying ? "Pause" : "Play"}
        title={isPlaying ? "Pause" : "Play"}
        onClick={(event) => {
          event.stopPropagation();
          void musicActions.toggle();
        }}
        onKeyDown={(event) => event.stopPropagation()}
        data-testid="music-tab-toggle"
      >
        {busy ? <CircleNotch size={10} className="animate-spin" /> : isPlaying ? <Pause size={10} weight="fill" /> : <Play size={10} weight="fill" />}
      </button>
      <MusicTabProgress />
    </>
  );
}

/** One render a second; the line moves by transform. */
function MusicTabProgress() {
  const position = useMusicPosition(1000);
  const duration = useMusicState((s) => s?.playback.duration ?? 0);
  const fraction = duration > 0 ? Math.min(1, position / duration) : 0;
  return (
    <span className="ade-music-tab-progress" aria-hidden>
      <span style={{ transform: `scaleX(${fraction})` }} />
    </span>
  );
}

/**
 * Closing the Music tab turns music off: pause now, then unload the player
 * (it keeps the queue and second, so reopening resumes there, paused). No
 * confirm: closing the tab is the explicit "stop" gesture, and nothing is lost.
 */
export function closeMusicTab(): void {
  musicActions.unload();
}
