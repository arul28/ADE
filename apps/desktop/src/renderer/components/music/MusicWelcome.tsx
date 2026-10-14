import React from "react";
import { motion } from "motion/react";
import {
  AppWindow,
  CircleNotch,
  LockSimple,
  MagnifyingGlass,
  MusicNotes,
  Playlist,
  Queue,
  X,
} from "@phosphor-icons/react";

import type { MusicCharts, MusicItem, MusicSearchResult } from "../../../shared/types/music";
import { MusicArt } from "./musicParts";
import { useMusicReducedMotion } from "./MusicPlayer";
import { MusicProviderBadge, useMusicProvider, useMusicProviderName } from "./musicProvider";
import { SpotifySetup } from "./MusicProviderControls";
import { musicActions, useMusicState } from "./musicStore";

/**
 * What the Music tab shows before Apple Music is connected: a hero over a
 * mosaic of real catalog artwork, Connect, what you get, and a privacy line.
 * Catalog browsing works without connecting, so the page below the hero is
 * live: top albums open, songs play (30-second previews until connected).
 */

type Showcase = MusicCharts;

const FALLBACK_TERMS = ["Today's Hits", "Hip-Hop", "Pop", "Chill", "Indie", "R&B"];

/** Popular catalog albums, playlists and songs; the developer token is enough. */
async function loadShowcase(): Promise<Showcase> {
  const bridge = window.ade?.music;
  if (!bridge) return { albums: [], songs: [], playlists: [] };
  try {
    const result = await bridge.charts();
    if (result.albums.length >= 12) return result;
  } catch {
    // Fall back to searches below.
  }
  const results = await Promise.all(
    FALLBACK_TERMS.map((term) =>
      bridge.search({ term, scope: "catalog", limit: 8 }).catch((): MusicSearchResult => ({ songs: [], albums: [], playlists: [], artists: [] })),
    ),
  );
  const seen = new Set<string>();
  const unique = (items: MusicItem[]) => items.filter((item) => item.artwork && !seen.has(item.id) && seen.add(item.id));
  return {
    albums: unique(results.flatMap((r) => r.albums)),
    playlists: unique(results.flatMap((r) => r.playlists)),
    songs: unique(results.flatMap((r) => r.songs)).slice(0, 10),
  };
}

let showcaseCache: Promise<Showcase> | null = null;
function useShowcase(): Showcase | null {
  const provider = useMusicProvider();
  const [value, setValue] = React.useState<Showcase | null>(null);
  React.useEffect(() => {
    if (provider === "spotify") return;
    let live = true;
    showcaseCache ??= loadShowcase().catch(() => {
      showcaseCache = null;
      return { albums: [], songs: [], playlists: [] };
    });
    void showcaseCache.then((v) => {
      if (live) setValue(v);
    });
    return () => {
      live = false;
    };
  }, [provider]);
  return value;
}

export function ConnectButton({ compact = false }: { compact?: boolean }) {
  const providerName = useMusicProviderName();
  const connecting = useMusicState((s) => Boolean(s?.connecting));
  const hostStarting = useMusicState((s) => s?.host.status === "starting");
  const busy = connecting || hostStarting;
  return (
    <button
      type="button"
      className={compact ? "ade-music-connect is-compact" : "ade-music-connect"}
      onClick={() => void musicActions.connect()}
      disabled={busy}
      data-testid="music-connect"
    >
      {busy ? <CircleNotch size={14} className="animate-spin" /> : <MusicNotes size={14} weight="fill" />}
      {connecting ? `Waiting for ${providerName}…` : hostStarting ? "Starting…" : `Connect ${providerName}`}
    </button>
  );
}

/** While Apple's window is open: where it is, and a way out. */
export function SignInControls({ compact = false }: { compact?: boolean }) {
  const provider = useMusicProvider();
  const connecting = useMusicState((s) => Boolean(s?.connecting));
  if (!connecting) return null;
  return (
    <div className="ade-music-signin-help" role="status">
      {compact ? null : <span>{provider === "spotify" ? "Finish signing in to Spotify in your browser." : "Finish signing in to Apple in its own window."}</span>}
      <span className="ade-music-signin-actions">
        <button type="button" className="ade-music-pill is-small" onClick={musicActions.showSignIn}>
          <AppWindow size={13} /> {provider === "spotify" ? "Open sign-in page" : "Show sign-in window"}
        </button>
        <button type="button" className="ade-music-pill is-small is-quiet" onClick={musicActions.cancelSignIn}>
          <X size={12} /> Cancel
        </button>
      </span>
    </div>
  );
}

/** A grid of real album covers behind the hero, softened so the text reads. */
function ArtMosaic({ items }: { items: MusicItem[] }) {
  const reduced = useMusicReducedMotion();
  const tiles = items.slice(0, 24);
  return (
    <div className="ade-music-mosaic" aria-hidden>
      <div className="ade-music-mosaic-grid">
        {tiles.map((item, i) => (
          <motion.span
            key={item.id}
            className="ade-music-mosaic-tile"
            initial={reduced ? false : { opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, delay: reduced ? 0 : (i % 8) * 0.04 + Math.floor(i / 8) * 0.06 }}
          >
            <MusicArt artwork={item.artwork} size={128} />
          </motion.span>
        ))}
      </div>
    </div>
  );
}

/** The signed-out hero: mosaic, Connect, what you get, privacy. */
export function ConnectHero({ showcase, compact = false }: { showcase?: Showcase | null; compact?: boolean }) {
  const provider = useMusicProvider();
  const own = useShowcase();
  const data = showcase ?? own;
  return (
    <section className={`ade-music-welcome${compact ? " is-compact" : ""}`} data-testid="music-connect-hero">
      <ArtMosaic items={data?.albums ?? []} />
      <div className="ade-music-welcome-body">
        <span className="ade-music-connect-glyph"><MusicNotes size={32} weight="fill" /></span>
        <h1>Your music, inside ADE</h1>
        <p>{provider === "spotify" ? "Connect Spotify to search, browse your library and control playback on your computer, phone or speakers. Spotify Premium and an active Spotify device are required." : "Connect Apple Music to play full songs, your library and playlists while you work. Until then, browse the catalog and play 30-second previews."}</p>
        <div className="ade-music-welcome-cta">
          <ConnectButton />
        </div>
        <SignInControls />
        {provider === "spotify" ? <details className="w-full max-w-lg text-left text-xs"><summary className="cursor-pointer">Spotify app settings</summary><SpotifySetup /></details> : null}
        {provider === "apple" ? <ul className="ade-music-welcome-points">
          <li>
            <span><Playlist size={15} /></span>
            <b>Your library</b>
            <i>Playlists, albums and songs</i>
          </li>
          <li>
            <span><Queue size={15} /></span>
            <b>Plays everywhere</b>
            <i>Keeps going on every tab</i>
          </li>
          <li>
            <span><MagnifyingGlass size={15} /></span>
            <b>Whole catalog</b>
            <i>Search 100 million songs</i>
          </li>
        </ul> : null}
        <p className="ade-music-welcome-privacy">
          <LockSimple size={12} weight="fill" />
          {provider === "spotify" ? "You sign in on Spotify’s own page. ADE never sees your password; access tokens stay encrypted on this computer." : "You sign in on Apple’s own page. ADE never sees your password; the access it gets stays encrypted on this computer. Needs an Apple Music subscription."}
        </p>
        <MusicProviderBadge height={30} className="ade-music-welcome-badge" />
      </div>
    </section>
  );
}

/** The whole signed-out search page: hero, then live catalog rows. */
export function MusicSignedOutHome({
  renderAlbums,
  renderSongs,
}: {
  renderAlbums: (items: MusicItem[]) => React.ReactNode;
  renderSongs: (items: MusicItem[]) => React.ReactNode;
}) {
  const provider = useMusicProvider();
  const showcase = useShowcase();
  if (provider === "spotify") return <ConnectHero />;
  return (
    <div className="ade-music-signedout">
      <ConnectHero showcase={showcase} />
      {showcase === null ? (
        <div className="ade-music-more"><CircleNotch size={16} className="animate-spin" /></div>
      ) : (
        <>
          {showcase.songs.length ? renderSongs(showcase.songs) : null}
          {showcase.albums.length ? renderAlbums(showcase.albums.slice(0, 12)) : null}
        </>
      )}
    </div>
  );
}
