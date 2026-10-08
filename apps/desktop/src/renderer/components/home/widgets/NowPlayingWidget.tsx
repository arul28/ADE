import { useEffect, useState } from "react";
import { MusicNotes, Pause, Play, SkipBack, SkipForward } from "@phosphor-icons/react";
import type { HomeNowPlayingCommand, HomeNowPlayingState } from "../../../../shared/types/homeWidgets";
import { WelcomeCardHead } from "../../projects/ProjectWelcomeSidePanels";
import { useWidgetPreview, useWidgetSpan, useWidgetVisible } from "../HomeWidgetGrid";
import type { HomeWidgetProps } from "../homeWidgetRegistry";
import "../homeWidgets.css";

/**
 * Whatever the computer is playing, from any app: title, artist, album art,
 * progress, and play/pause/next/previous. Main reads the OS media session
 * (Windows: a helper on the System Media Transport Controls; macOS: the
 * MediaRemote adapter, or Music.app) only while this card is on screen; it
 * subscribes when visible and lets go when hidden, which stops the helper.
 */

function useNowPlaying(active: boolean): HomeNowPlayingState | null {
  const [state, setState] = useState<HomeNowPlayingState | null>(null);
  useEffect(() => {
    const bridge = window.ade?.home?.nowPlaying;
    if (!active || !bridge) return undefined;
    let cancelled = false;
    const off = bridge.onChanged((next) => {
      if (!cancelled) setState(next);
    });
    void bridge.subscribe().then((next) => {
      if (!cancelled) setState(next);
    }).catch(() => {
      if (!cancelled) setState({ available: false, session: null, source: null, error: "Now Playing is unavailable." });
    });
    return () => {
      cancelled = true;
      off();
      void bridge.unsubscribe().catch(() => {});
    };
  }, [active]);
  return state;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export default function NowPlayingWidget({ item }: HomeWidgetProps) {
  const visible = useWidgetVisible();
  const preview = useWidgetPreview();
  const span = useWidgetSpan(item);
  // A gallery preview shows the live state but must not hold the source open
  // after the gallery closes; it unsubscribes on unmount like the card does.
  const state = useNowPlaying(visible);
  const session = state?.session ?? null;
  const playing = session?.status === "playing";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!playing || !visible) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [playing, visible]);
  const position = session
    ? Math.min(session.durationMs || Number.POSITIVE_INFINITY, session.positionMs + (playing ? Math.max(0, now - session.updatedAt) : 0))
    : 0;
  const progress = session && session.durationMs > 0 ? Math.min(1, position / session.durationMs) : 0;
  const send = (command: HomeNowPlayingCommand) => void window.ade?.home?.nowPlaying?.command(command);
  const wide = span.w >= 2;

  return (
    <section
      className="kit-card ade-home-card ade-np"
      aria-label="Now playing"
      data-size={item.size}
      data-wide={wide || undefined}
      data-playing={playing || undefined}
      data-still={!visible || preview ? "true" : undefined}
    >
      {session?.artwork ? <img className="ade-np-backdrop" src={session.artwork} alt="" aria-hidden /> : null}
      <WelcomeCardHead icon={MusicNotes} title="Now playing">
        {session?.app ? <span className="ade-home-card-scope">{session.app}</span> : null}
        {playing ? (
          <span className="ade-np-eq" aria-hidden>
            <i /><i /><i /><i />
          </span>
        ) : null}
      </WelcomeCardHead>
      <div className="kit-card-body ade-np-body">
        {!window.ade?.home?.nowPlaying ? (
          <div className="ade-home-empty"><span>Available in the ADE desktop app.</span></div>
        ) : !state ? (
          <div className="ade-home-empty"><span>Listening…</span></div>
        ) : !state.available ? (
          <div className="ade-home-empty"><MusicNotes size={18} aria-hidden /><span>{state.error ?? "Now Playing is not available here."}</span></div>
        ) : !session ? (
          <div className="ade-np-empty">
            <span className="ade-np-art ade-np-art-empty"><MusicNotes size={22} /></span>
            <div className="ade-np-text">
              <span className="ade-np-title">Nothing playing</span>
              <span className="ade-np-artist">Play music or a video in any app and it shows here.</span>
            </div>
          </div>
        ) : (
          <>
            <div className="ade-np-main">
              {session.artwork ? (
                <img className="ade-np-art" src={session.artwork} alt={session.album ? `${session.album} cover` : "Cover art"} />
              ) : (
                <span className="ade-np-art ade-np-art-empty"><MusicNotes size={22} /></span>
              )}
              <div className="ade-np-text">
                <span className="ade-np-title" title={session.title}>{session.title || "Untitled"}</span>
                <span className="ade-np-artist" title={session.artist}>{session.artist || session.app || ""}</span>
                {wide && session.album ? <span className="ade-np-album" title={session.album}>{session.album}</span> : null}
              </div>
            </div>
            <div className="ade-np-foot">
              {session.durationMs > 0 ? (
                <div className="ade-np-progress">
                  <div className="ade-np-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
                    <span style={{ transform: `scaleX(${progress})` }} />
                  </div>
                  <div className="ade-np-times kit-num">
                    <span>{clock(position)}</span>
                    <span>−{clock(Math.max(0, session.durationMs - position))}</span>
                  </div>
                </div>
              ) : null}
              <div className="ade-np-controls">
                <button type="button" className="ade-np-btn" aria-label="Previous" title="Previous" disabled={!session.canPrevious} onClick={() => send("previous")}>
                  <SkipBack size={16} weight="fill" />
                </button>
                <button
                  type="button"
                  className="ade-np-btn ade-np-play"
                  aria-label={playing ? "Pause" : "Play"}
                  title={playing ? "Pause" : "Play"}
                  disabled={playing ? !session.canPause : !session.canPlay}
                  onClick={() => send(playing ? "pause" : "play")}
                >
                  {playing ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}
                </button>
                <button type="button" className="ade-np-btn" aria-label="Next" title="Next" disabled={!session.canNext} onClick={() => send("next")}>
                  <SkipForward size={16} weight="fill" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
