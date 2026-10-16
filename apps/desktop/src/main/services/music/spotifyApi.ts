import type {
  MusicArtwork,
  MusicDevice,
  MusicItem,
  MusicLibraryKind,
  MusicPage,
  MusicRecent,
  MusicSearchResult,
} from "../../../shared/types/music";
import { MUSIC_MAX_COLLECTION_TRACKS } from "../../../shared/types/music";

/**
 * The Spotify Web API, called from the main process with the signed-in user's
 * access token.
 *
 * Written against Development Mode as it stands after Spotify's February 2026
 * changes: search returns at most 10 per type, playlists list their items only
 * for their owner or collaborators (`/playlists/{id}/items`), the library is
 * one URI-based `/me/library` endpoint, and there are no browse, chart or
 * batch-lookup endpoints. Extended Quota apps answer the same calls.
 *
 * Items keep Spotify URIs as their ids, the form the player and library
 * endpoints take. Browse reads are cached for 60 s; player reads never are.
 */

const API = "https://api.spotify.com/v1";
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;
/** Development Mode's search cap per type. */
const SEARCH_LIMIT = 10;
const PAGE_LIMIT = 50;

export type SpotifyErrorReason =
  | "NO_ACTIVE_DEVICE"
  | "PREMIUM_REQUIRED"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "NETWORK"
  | "HTTP";

export class SpotifyApiError extends Error {
  readonly status: number;
  readonly reason: SpotifyErrorReason;
  /** Seconds Spotify asked to wait (429). */
  readonly retryAfter: number | null;
  constructor(message: string, status: number, reason: SpotifyErrorReason, retryAfter: number | null = null) {
    super(message);
    this.name = "SpotifyApiError";
    this.status = status;
    this.reason = reason;
    this.retryAfter = retryAfter;
  }
}

export const SPOTIFY_NO_DEVICE_MESSAGE = "No Spotify device is active. Open Spotify on this computer or pick a device.";
export const SPOTIFY_PREMIUM_MESSAGE = "Spotify Premium is needed to control playback.";

type Image = { url?: string; width?: number | null; height?: number | null };
type Named = { name?: string };
type ExternalUrls = { spotify?: string };

export type SpotifyTrack = {
  uri?: string;
  type?: string;
  name?: string;
  duration_ms?: number;
  explicit?: boolean;
  is_local?: boolean;
  artists?: Named[];
  album?: SpotifyAlbum;
  /** Episodes carry their show here and their own images. */
  show?: Named & { images?: Image[] };
  images?: Image[];
  external_urls?: ExternalUrls;
};

type SpotifyAlbum = {
  uri?: string;
  name?: string;
  artists?: Named[];
  images?: Image[];
  release_date?: string;
  total_tracks?: number;
  external_urls?: ExternalUrls;
};

type SpotifyPlaylist = {
  uri?: string;
  name?: string;
  owner?: { display_name?: string | null; id?: string };
  images?: Image[] | null;
  /** Renamed `items` in February 2026; older answers say `tracks`. */
  items?: { total?: number };
  tracks?: { total?: number };
  external_urls?: ExternalUrls;
};

type SpotifyArtist = { uri?: string; name?: string; images?: Image[]; external_urls?: ExternalUrls };

type Paging<T> = { items?: Array<T | null>; next?: string | null; total?: number; offset?: number };

export type SpotifyDeviceRaw = {
  id?: string | null;
  name?: string;
  type?: string;
  is_active?: boolean;
  is_restricted?: boolean;
  volume_percent?: number | null;
  supports_volume?: boolean;
};

export type SpotifyPlayer = {
  device?: SpotifyDeviceRaw;
  shuffle_state?: boolean;
  repeat_state?: "off" | "track" | "context";
  progress_ms?: number | null;
  is_playing?: boolean;
  item?: SpotifyTrack | null;
  currently_playing_type?: string;
  context?: { uri?: string } | null;
  timestamp?: number;
};

export function spotifyArtwork(images: Image[] | null | undefined): MusicArtwork | null {
  const usable = (images ?? []).filter((image): image is Image & { url: string } => typeof image?.url === "string" && image.url.length > 0);
  if (!usable.length) return null;
  const largest = usable.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a));
  return {
    url: largest.url,
    width: largest.width ?? null,
    height: largest.height ?? null,
    bgColor: null,
    sizes: usable.map((image) => ({ url: image.url, width: image.width ?? null })),
  };
}

const artistNames = (artists: Named[] | undefined): string =>
  (artists ?? []).map((artist) => artist.name).filter(Boolean).join(", ");

const yearOf = (date: string | undefined): number | null => {
  const year = typeof date === "string" ? Number.parseInt(date.slice(0, 4), 10) : NaN;
  return Number.isFinite(year) ? year : null;
};

/** A track or episode as a song row. `album` fills in what an album's own track list leaves out. */
export function spotifyTrackItem(track: SpotifyTrack | null | undefined, options: { library?: boolean; album?: SpotifyAlbum } = {}): MusicItem | null {
  if (!track?.uri || track.is_local) return null;
  const album = track.album ?? options.album;
  const episode = track.type === "episode";
  return {
    id: track.uri,
    kind: "song",
    title: track.name ?? "",
    subtitle: episode ? track.show?.name ?? "" : artistNames(track.artists),
    album: episode ? track.show?.name ?? null : album?.name ?? null,
    artwork: spotifyArtwork(episode ? track.images ?? track.show?.images : album?.images),
    durationMs: typeof track.duration_ms === "number" ? track.duration_ms : null,
    library: Boolean(options.library),
    catalogId: track.uri,
    trackCount: null,
    releaseYear: yearOf(album?.release_date),
    explicit: Boolean(track.explicit),
    externalUrl: track.external_urls?.spotify ?? null,
  };
}

export function spotifyAlbumItem(album: SpotifyAlbum | null | undefined, library = false): MusicItem | null {
  if (!album?.uri) return null;
  return {
    id: album.uri,
    kind: "album",
    title: album.name ?? "",
    subtitle: artistNames(album.artists),
    album: null,
    artwork: spotifyArtwork(album.images),
    durationMs: null,
    library,
    catalogId: album.uri,
    trackCount: typeof album.total_tracks === "number" ? album.total_tracks : null,
    releaseYear: yearOf(album.release_date),
    explicit: false,
    externalUrl: album.external_urls?.spotify ?? null,
  };
}

export function spotifyPlaylistItem(playlist: SpotifyPlaylist | null | undefined, library = false): MusicItem | null {
  if (!playlist?.uri) return null;
  const total = playlist.items?.total ?? playlist.tracks?.total;
  return {
    id: playlist.uri,
    kind: "playlist",
    title: playlist.name ?? "",
    subtitle: playlist.owner?.display_name || "Spotify",
    album: null,
    artwork: spotifyArtwork(playlist.images),
    durationMs: null,
    library,
    catalogId: playlist.uri,
    trackCount: typeof total === "number" ? total : null,
    releaseYear: null,
    explicit: false,
    externalUrl: playlist.external_urls?.spotify ?? null,
  };
}

function spotifyArtistItem(artist: SpotifyArtist | null | undefined): MusicItem | null {
  if (!artist?.uri) return null;
  return {
    id: artist.uri,
    kind: "artist",
    title: artist.name ?? "",
    subtitle: "Artist",
    album: null,
    artwork: spotifyArtwork(artist.images),
    durationMs: null,
    library: false,
    catalogId: artist.uri,
    trackCount: null,
    releaseYear: null,
    explicit: false,
    externalUrl: artist.external_urls?.spotify ?? null,
  };
}

export function spotifyDevice(raw: SpotifyDeviceRaw | null | undefined): MusicDevice | null {
  if (!raw?.id) return null;
  return {
    id: raw.id,
    name: raw.name ?? "Spotify device",
    type: raw.type ?? "Unknown",
    isActive: Boolean(raw.is_active),
    isRestricted: Boolean(raw.is_restricted),
    volume: typeof raw.volume_percent === "number" ? raw.volume_percent / 100 : null,
    supportsVolume: raw.supports_volume !== false && typeof raw.volume_percent === "number",
  };
}

const compact = <T>(values: Array<T | null>): T[] => values.filter((value): value is T => value !== null);

/** `spotify:album:abc` → `abc`, for the path of a per-item endpoint. */
export function spotifyIdOf(uri: string, type: "track" | "album" | "playlist" | "artist"): string {
  const match = new RegExp(`^spotify:${type}:([A-Za-z0-9]+)$`).exec(uri.trim());
  if (!match) throw new SpotifyApiError("Spotify couldn't find that.", 404, "NOT_FOUND");
  return match[1]!;
}

const pageOf = (paging: Paging<unknown> | undefined, offset: number, items: MusicItem[]): MusicPage => {
  const read = paging?.items?.length ?? 0;
  const next = offset + read;
  return {
    items,
    nextOffset: paging?.next && read > 0 && next < MUSIC_MAX_COLLECTION_TRACKS ? next : null,
    total: typeof paging?.total === "number" ? paging.total : null,
  };
};

export type SpotifyApi = ReturnType<typeof createSpotifyApi>;

export function createSpotifyApi(args: {
  /** A valid access token (refreshed by the caller), or null when signed out. */
  accessToken: (options?: { forceRefresh?: boolean }) => Promise<string | null>;
  fetchImpl?: typeof fetch;
}) {
  const cache = new Map<string, { at: number; value: unknown }>();
  /** Spotify said to wait until then (429). Every call fails fast until it passes. */
  let blockedUntil = 0;

  const request = async <T>(
    path: string,
    options: { method?: string; body?: unknown; cache?: boolean } = {},
  ): Promise<T> => {
    const method = options.method ?? "GET";
    const cacheable = method === "GET" && options.cache !== false;
    if (cacheable) {
      const hit = cache.get(path);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
    }
    if (Date.now() < blockedUntil) {
      throw new SpotifyApiError("Spotify is rate limiting ADE. Try again in a minute.", 429, "RATE_LIMITED", Math.ceil((blockedUntil - Date.now()) / 1000));
    }
    const send = async (forceRefresh: boolean): Promise<Response> => {
      const token = await args.accessToken({ forceRefresh });
      if (!token) throw new SpotifyApiError("Connect Spotify to use it in ADE.", 401, "UNAUTHORIZED");
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
      if (options.body !== undefined) headers["content-type"] = "application/json";
      try {
        return await (args.fetchImpl ?? fetch)(`${API}${path}`, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new SpotifyApiError("Couldn't reach Spotify. Check your connection and try again.", 0, "NETWORK");
      }
    };
    let response = await send(false);
    // An access token can die before its hour (revoked, rotated): refresh once.
    if (response.status === 401) response = await send(true);
    const text = response.status === 204 ? "" : await response.text();
    if (!response.ok) {
      let reason = "";
      try {
        reason = String((JSON.parse(text) as { error?: { reason?: string } }).error?.reason ?? "");
      } catch {
        // Not JSON.
      }
      if (response.status === 401) throw new SpotifyApiError("Spotify needs you to connect again.", 401, "UNAUTHORIZED");
      if (response.status === 429) {
        const retryAfter = Math.max(1, Number(response.headers.get("retry-after")) || 30);
        blockedUntil = Date.now() + retryAfter * 1000;
        throw new SpotifyApiError("Spotify is rate limiting ADE. Try again in a minute.", 429, "RATE_LIMITED", retryAfter);
      }
      if (reason === "NO_ACTIVE_DEVICE" || (response.status === 404 && path.startsWith("/me/player"))) {
        throw new SpotifyApiError(SPOTIFY_NO_DEVICE_MESSAGE, response.status, "NO_ACTIVE_DEVICE");
      }
      if (reason === "PREMIUM_REQUIRED") throw new SpotifyApiError(SPOTIFY_PREMIUM_MESSAGE, 403, "PREMIUM_REQUIRED");
      if (response.status === 403) {
        // A Development Mode app answers 403 to a user missing from its allow list.
        throw new SpotifyApiError(
          path.startsWith("/me/player")
            ? "Spotify refused that command on this device."
            : "Spotify refused ADE's request. If your Spotify app is in Development Mode, add your account under User Management.",
          403,
          "FORBIDDEN",
        );
      }
      if (response.status === 404) throw new SpotifyApiError("Spotify couldn't find that.", 404, "NOT_FOUND");
      throw new SpotifyApiError(`Spotify answered HTTP ${response.status}.`, response.status, "HTTP");
    }
    const value = (text ? JSON.parse(text) : undefined) as T;
    if (cacheable) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(path, { at: Date.now(), value });
    } else if (method !== "GET" && !path.startsWith("/me/player")) {
      cache.clear();
    }
    return value;
  };

  const qs = (params: Record<string, string | number | boolean | undefined>): string => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") search.set(key, String(value));
    return search.toString();
  };

  const clampPage = (input: { offset?: number; limit?: number }) => ({
    offset: Math.min(Math.max(Math.floor(input.offset ?? 0), 0), MUSIC_MAX_COLLECTION_TRACKS),
    limit: Math.min(Math.max(Math.floor(input.limit ?? PAGE_LIMIT), 1), PAGE_LIMIT),
  });

  const player = (path: string, params: Record<string, string | number | boolean | undefined> = {}, method = "PUT", body?: unknown) => {
    const query = qs(params);
    return request<void>(`/me/player${path}${query ? `?${query}` : ""}`, { method, body, cache: false });
  };

  return {
    clearCache: () => {
      cache.clear();
      blockedUntil = 0;
    },

    me: () => request<{ id?: string; display_name?: string | null }>("/me"),

    async search(input: { term: string; limit?: number }): Promise<MusicSearchResult> {
      const term = input.term.trim();
      if (!term) return { songs: [], albums: [], playlists: [], artists: [] };
      const limit = Math.min(Math.max(input.limit ?? SEARCH_LIMIT, 1), SEARCH_LIMIT);
      const body = await request<{
        tracks?: Paging<SpotifyTrack>;
        albums?: Paging<SpotifyAlbum>;
        playlists?: Paging<SpotifyPlaylist>;
        artists?: Paging<SpotifyArtist>;
      }>(`/search?${qs({ q: term, type: "track,album,playlist,artist", limit })}`);
      return {
        songs: compact((body.tracks?.items ?? []).map((track) => spotifyTrackItem(track))),
        albums: compact((body.albums?.items ?? []).map((album) => spotifyAlbumItem(album))),
        // Spotify's search answers can hold null playlists.
        playlists: compact((body.playlists?.items ?? []).map((playlist) => spotifyPlaylistItem(playlist))),
        artists: compact((body.artists?.items ?? []).map(spotifyArtistItem)),
      };
    },

    async library(input: { kind: MusicLibraryKind; offset?: number; limit?: number }): Promise<MusicPage> {
      const { offset, limit } = clampPage(input);
      if (input.kind === "playlists") {
        const body = await request<Paging<SpotifyPlaylist>>(`/me/playlists?${qs({ limit, offset })}`);
        return pageOf(body, offset, compact((body.items ?? []).map((playlist) => spotifyPlaylistItem(playlist, true))));
      }
      if (input.kind === "albums") {
        const body = await request<Paging<{ album?: SpotifyAlbum }>>(`/me/albums?${qs({ limit, offset })}`);
        return pageOf(body, offset, compact((body.items ?? []).map((saved) => spotifyAlbumItem(saved?.album, true))));
      }
      const body = await request<Paging<{ track?: SpotifyTrack }>>(`/me/tracks?${qs({ limit, offset })}`);
      return pageOf(body, offset, compact((body.items ?? []).map((saved) => spotifyTrackItem(saved?.track, { library: true }))));
    },

    async recent(): Promise<MusicRecent> {
      const body = await request<{ items?: Array<{ track?: SpotifyTrack }> }>(
        `/me/player/recently-played?${qs({ limit: 30 })}`,
        { cache: false },
      );
      const tracks: MusicItem[] = [];
      const containers: MusicItem[] = [];
      const seenTracks = new Set<string>();
      const seenAlbums = new Set<string>();
      for (const entry of body.items ?? []) {
        const track = spotifyTrackItem(entry?.track);
        if (track && !seenTracks.has(track.id)) {
          seenTracks.add(track.id);
          tracks.push(track);
        }
        const album = spotifyAlbumItem(entry?.track?.album);
        if (album && !seenAlbums.has(album.id) && containers.length < 10) {
          seenAlbums.add(album.id);
          containers.push(album);
        }
      }
      return { containers, tracks };
    },

    /**
     * One page of an album's or playlist's tracks (up to 50). In Development
     * Mode a playlist the user neither owns nor collaborates on lists no
     * items; it still plays as a whole (`playCollection`), so that is an empty
     * page, not an error.
     */
    async tracks(input: { kind: "album" | "playlist"; id: string; offset?: number; limit?: number }): Promise<MusicPage> {
      const { offset, limit } = clampPage(input);
      if (input.kind === "album") {
        const id = spotifyIdOf(input.id, "album");
        // An album's track list leaves out the album; its artwork and name come from here.
        const album = await request<SpotifyAlbum>(`/albums/${id}`);
        const body = await request<Paging<SpotifyTrack>>(`/albums/${id}/tracks?${qs({ limit, offset })}`);
        return pageOf(body, offset, compact((body.items ?? []).map((track) => spotifyTrackItem(track, { album }))));
      }
      const id = spotifyIdOf(input.id, "playlist");
      try {
        const body = await request<Paging<{ item?: SpotifyTrack | null; track?: SpotifyTrack | null }>>(
          `/playlists/${id}/items?${qs({ limit, offset, additional_types: "track,episode" })}`,
        );
        return pageOf(body, offset, compact((body.items ?? []).map((entry) => spotifyTrackItem(entry?.item ?? entry?.track))));
      } catch (error) {
        if (error instanceof SpotifyApiError && (error.status === 403 || error.status === 404)) {
          return { items: [], nextOffset: null, total: null };
        }
        throw error;
      }
    },

    async saved(uri: string): Promise<boolean> {
      const body = await request<boolean[]>(`/me/library/contains?${qs({ uris: uri })}`, { cache: false });
      return Boolean(body?.[0]);
    },

    async setSaved(uri: string, saved: boolean): Promise<void> {
      await request<void>(`/me/library?${qs({ uris: uri })}`, { method: saved ? "PUT" : "DELETE", cache: false });
    },

    // Player. Never cached; a 204 with no body means "nothing playing".
    playbackState: () => request<SpotifyPlayer | undefined>(`/me/player?${qs({ additional_types: "track,episode" })}`, { cache: false }),
    devices: async (): Promise<MusicDevice[]> => {
      const body = await request<{ devices?: SpotifyDeviceRaw[] }>("/me/player/devices", { cache: false });
      return compact((body.devices ?? []).map(spotifyDevice));
    },
    queue: () => request<{ currently_playing?: SpotifyTrack | null; queue?: SpotifyTrack[] }>("/me/player/queue", { cache: false }),
    play: (input: { deviceId?: string; contextUri?: string; uris?: string[]; offset?: number; positionMs?: number } = {}) => {
      const body: Record<string, unknown> = {};
      if (input.contextUri) body.context_uri = input.contextUri;
      if (input.uris) body.uris = input.uris;
      if (typeof input.offset === "number" && (input.contextUri || input.uris)) body.offset = { position: input.offset };
      if (typeof input.positionMs === "number") body.position_ms = Math.max(0, Math.round(input.positionMs));
      return player("/play", { device_id: input.deviceId }, "PUT", Object.keys(body).length ? body : undefined);
    },
    pause: () => player("/pause"),
    next: () => player("/next", {}, "POST"),
    previous: () => player("/previous", {}, "POST"),
    seek: (positionMs: number) => player("/seek", { position_ms: Math.max(0, Math.round(positionMs)) }),
    volume: (fraction: number) => player("/volume", { volume_percent: Math.round(Math.max(0, Math.min(1, fraction)) * 100) }),
    shuffle: (on: boolean) => player("/shuffle", { state: on }),
    repeat: (mode: "off" | "track" | "context") => player("/repeat", { state: mode }),
    addToQueue: (uri: string) => player("/queue", { uri }, "POST"),
    transfer: (deviceId: string, play: boolean) => player("", {}, "PUT", { device_ids: [deviceId], play }),
  };
}
