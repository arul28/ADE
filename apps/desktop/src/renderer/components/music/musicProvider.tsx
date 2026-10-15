import React from "react";
import { AppleMusicAppIcon, AppleMusicBadge, SpotifyItemLink, SpotifyBrand } from "./musicParts";
import spotifyIconUrl from "./assets/spotify-icon-green.svg";
import { useMusicState } from "./musicStore";

export function useMusicProvider() {
  return useMusicState((state) => state?.provider ?? "apple");
}

export function useMusicProviderName(): string {
  return useMusicProvider() === "spotify" ? "Spotify" : "Apple Music";
}

/** Official provider artwork, without redrawing the Spotify mark. */
export function MusicProviderIcon({ size = 16, className }: { size?: number; className?: string }) {
  const provider = useMusicProvider();
  return provider === "spotify"
    ? <img src={spotifyIconUrl} width={size} height={size} className={className} alt="" aria-hidden />
    : <AppleMusicAppIcon size={size} className={className} />;
}

export function MusicProviderBadge({ height = 28, className, linked = true }: { height?: number; className?: string; linked?: boolean }) {
  const provider = useMusicProvider();
  const url = useMusicState((state) => state?.playback.nowPlaying?.externalUrl);
  return provider === "spotify"
    ? <span className={className} style={{ fontSize: Math.max(11, height / 2), lineHeight: `${height}px` }}>{linked ? <SpotifyItemLink url={url ?? "https://open.spotify.com/"} /> : <SpotifyBrand />}</span>
    : <AppleMusicBadge height={height} className={className} />;
}
