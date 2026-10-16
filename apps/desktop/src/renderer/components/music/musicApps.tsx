import type { HomeApp } from "../home/homeLayout";
import { AppleMusicAppIcon } from "./musicParts";
import { musicActions, useMusicState } from "./musicStore";
import spotifyIconUrl from "./assets/spotify-icon-green.svg";

/**
 * Apple Music and Spotify as two apps on the home page. Both open the one
 * Music tab, each on its own service.
 */

export const HOME_APP_LABELS: Record<HomeApp, string> = { appleMusic: "Apple Music", spotify: "Spotify" };

const PROVIDER: Record<HomeApp, "apple" | "spotify"> = { appleMusic: "apple", spotify: "spotify" };

export function HomeAppIcon({ app, size }: { app: HomeApp; size: number }) {
  if (app === "appleMusic") return <AppleMusicAppIcon size={size} />;
  // The official mark, unmodified, on Spotify's black, as an app tile the size of Apple's.
  return (
    <span className="ade-spotify-app-tile" style={{ width: size, height: size }}>
      <img src={spotifyIconUrl} width={Math.round(size * 0.72)} height={Math.round(size * 0.72)} alt="" aria-hidden draggable={false} />
    </span>
  );
}

export function openMusicApp(app: HomeApp): void {
  musicActions.open();
  void musicActions.selectProvider(PROVIDER[app]);
}

export function HomeAppButton({ app }: { app: HomeApp }) {
  const selected = useMusicState((state) => state?.provider ?? "apple") === PROVIDER[app];
  return (
    <button
      type="button"
      className="ade-home-app-button"
      data-app={app}
      data-selected={selected ? "true" : undefined}
      aria-label={HOME_APP_LABELS[app]}
      title={HOME_APP_LABELS[app]}
      onClick={() => openMusicApp(app)}
    >
      <HomeAppIcon app={app} size={34} />
    </button>
  );
}
