import type {
  MusicItem,
  MusicItemKind,
  MusicLibraryKind,
  MusicPage,
  MusicRecent,
  MusicSearchResult,
  MusicSearchScope,
  MusicCharts,
  MusicAccount,
} from "../../../shared/types/music";

/**
 * The Apple Music API, called from the main process.
 *
 * Browsing (search, library, recently played, track lists, ratings) goes
 * straight to api.music.apple.com with the developer token and, for anything
 * under `/v1/me`, the user's Music-User-Token. The player host is only needed to
 * PLAY, so the Music tab can browse without the 300+ MB WebView2 tree loaded.
 *
 * Responses are cached briefly in memory: Apple rate-limits per developer token,
 * and the Music tab re-reads the same lists as you move between views.
 */

const API = "https://api.music.apple.com";
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;

export class AppleMusicApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AppleMusicApiError";
    this.status = status;
  }
}

type Resource = {
  id: string;
  type: string;
  attributes?: Record<string, unknown> & {
    name?: string;
    artistName?: string;
    curatorName?: string;
    albumName?: string;
    durationInMillis?: number;
    trackCount?: number;
    releaseDate?: string;
    contentRating?: string;
    artwork?: { url?: string; width?: number; height?: number; bgColor?: string };
    playParams?: { id?: string; kind?: string; isLibrary?: boolean; catalogId?: string; reportingId?: string };
    description?: { short?: string; standard?: string };
  };
  relationships?: Record<string, { data?: Resource[] }>;
};

const KIND_BY_TYPE: Record<string, MusicItemKind> = {
  songs: "song",
  "library-songs": "song",
  "music-videos": "song",
  albums: "album",
  "library-albums": "album",
  playlists: "playlist",
  "library-playlists": "playlist",
  artists: "artist",
  "library-artists": "artist",
  stations: "station",
};

export function normalizeResource(resource: Resource): MusicItem | null {
  const kind = KIND_BY_TYPE[resource.type];
  if (!kind) return null;
  const a = resource.attributes ?? {};
  const library = resource.type.startsWith("library-");
  const art = a.artwork;
  const year = typeof a.releaseDate === "string" ? Number.parseInt(a.releaseDate.slice(0, 4), 10) : NaN;
  const subtitle =
    kind === "playlist"
      ? (a.curatorName as string | undefined) ?? (library ? "Your playlist" : "Apple Music")
      : kind === "station"
        ? "Station"
        : kind === "artist"
          ? "Artist"
          : a.artistName ?? "";
  return {
    id: resource.id,
    kind,
    title: a.name ?? "",
    subtitle,
    album: a.albumName ?? null,
    artwork: art?.url
      ? { url: art.url, width: art.width ?? null, height: art.height ?? null, bgColor: art.bgColor ?? null }
      : null,
    durationMs: typeof a.durationInMillis === "number" ? a.durationInMillis : null,
    library,
    catalogId: a.playParams?.catalogId ?? (library ? null : resource.id),
    trackCount: typeof a.trackCount === "number" ? a.trackCount : null,
    releaseYear: Number.isFinite(year) ? year : null,
    explicit: a.contentRating === "explicit",
  };
}

const normalizeAll = (data: Resource[] | undefined): MusicItem[] =>
  (data ?? []).map(normalizeResource).filter((item): item is MusicItem => item !== null);

export type AppleMusicApi = ReturnType<typeof createAppleMusicApi>;

export function createAppleMusicApi(args: {
  developerToken: () => Promise<string>;
  /** The stored Music-User-Token, or null before Connect. */
  userToken: () => string | null;
  /** Called when Apple rejects the user token, so the service can drop it. */
  onUserTokenRejected?: () => void;
  fetchImpl?: typeof fetch;
}) {
  const cache = new Map<string, { at: number; value: unknown }>();
  let storefront: { userToken: string; id: string } | null = null;

  const request = async <T>(
    pathAndQuery: string,
    options: { user?: boolean; method?: string; body?: unknown; cache?: boolean } = {},
  ): Promise<T> => {
    const user = options.user ?? pathAndQuery.startsWith("/v1/me");
    const userToken = user ? args.userToken() : null;
    if (user && !userToken) throw new AppleMusicApiError("Connect Apple Music to see your library.", 401);
    const cacheKey = `${userToken ? userToken.slice(-12) : "-"} ${pathAndQuery}`;
    const method = options.method ?? "GET";
    if (method === "GET" && options.cache !== false) {
      const hit = cache.get(cacheKey);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${await args.developerToken()}`,
      accept: "application/json",
    };
    if (userToken) headers["music-user-token"] = userToken;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await (args.fetchImpl ?? fetch)(`${API}${pathAndQuery}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AppleMusicApiError("Couldn't reach Apple Music. Check your connection.", 0);
    }
    if (response.status === 401 || response.status === 403) {
      // 401 = the token is dead. 403 can mean no subscription; keep the token then.
      if (user && response.status === 401) args.onUserTokenRejected?.();
      throw new AppleMusicApiError(
        user ? "Apple Music needs you to connect again." : "Apple Music refused ADE's developer token.",
        response.status,
      );
    }
    if (response.status === 429) throw new AppleMusicApiError("Apple Music is rate limiting ADE. Try again in a minute.", 429);
    if (response.status === 204 || (method !== "GET" && response.status < 300 && response.headers.get("content-length") === "0")) {
      cache.clear();
      return undefined as T;
    }
    if (response.status === 404) {
      if (method !== "GET") throw new AppleMusicApiError("Apple Music couldn't find that item.", 404);
      return { data: [] } as T;
    }
    if (!response.ok) throw new AppleMusicApiError(`Apple Music answered HTTP ${response.status}.`, response.status);
    const text = await response.text();
    const value = (text ? JSON.parse(text) : undefined) as T;
    if (method === "GET") {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(cacheKey, { at: Date.now(), value });
    } else {
      cache.clear();
    }
    return value;
  };

  const storefrontId = async (): Promise<string> => {
    const userToken = args.userToken();
    if (!userToken) return "us";
    if (storefront?.userToken === userToken) return storefront.id;
    try {
      const body = await request<{ data?: Array<{ id: string }> }>("/v1/me/storefront");
      const id = body.data?.[0]?.id ?? "us";
      storefront = { userToken, id };
      return id;
    } catch {
      return "us";
    }
  };

  const qs = (params: Record<string, string | number | undefined>): string => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") search.set(key, String(value));
    return search.toString();
  };

  return {
    storefrontId,
    clearCache: () => {
      cache.clear();
      storefront = null;
    },

    async search(input: { term: string; scope: MusicSearchScope; limit?: number }): Promise<MusicSearchResult> {
      const term = input.term.trim();
      const empty: MusicSearchResult = { songs: [], albums: [], playlists: [], artists: [] };
      if (!term) return empty;
      const limit = Math.min(Math.max(input.limit ?? 25, 1), 25);
      if (input.scope === "library") {
        const body = await request<{ results?: Record<string, { data?: Resource[] }> }>(
          `/v1/me/library/search?${qs({ term, types: "library-songs,library-albums,library-playlists", limit })}`,
        );
        const r = body.results ?? {};
        return {
          songs: normalizeAll(r["library-songs"]?.data),
          albums: normalizeAll(r["library-albums"]?.data),
          playlists: normalizeAll(r["library-playlists"]?.data),
          artists: [],
        };
      }
      const sf = await storefrontId();
      const body = await request<{ results?: Record<string, { data?: Resource[] }> }>(
        `/v1/catalog/${sf}/search?${qs({ term, types: "songs,albums,playlists,artists", limit })}`,
        { user: false },
      );
      const r = body.results ?? {};
      return {
        songs: normalizeAll(r.songs?.data),
        albums: normalizeAll(r.albums?.data),
        playlists: normalizeAll(r.playlists?.data),
        artists: normalizeAll(r.artists?.data),
      };
    },

    async charts(): Promise<MusicCharts> {
      const sf = await storefrontId();
      const body = await request<{ results?: Record<string, Array<{ data?: Resource[] }>> }>(
        `/v1/catalog/${sf}/charts?${qs({ types: "songs,albums,playlists", limit: 24 })}`,
        { user: false },
      );
      const r = body.results ?? {};
      return {
        songs: normalizeAll(r.songs?.[0]?.data),
        albums: normalizeAll(r.albums?.[0]?.data),
        playlists: normalizeAll(r.playlists?.[0]?.data),
      };
    },

    async account(): Promise<MusicAccount> {
      if (!args.userToken()) return { storefront: null };
      const body = await request<{ data?: Array<{ id: string; attributes?: { name?: string } }> }>("/v1/me/storefront");
      const entry = body.data?.[0];
      return { storefront: entry ? { id: entry.id, name: entry.attributes?.name ?? null } : null };
    },

    async library(input: { kind: MusicLibraryKind; offset?: number; limit?: number }): Promise<MusicPage> {
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
      const offset = Math.max(input.offset ?? 0, 0);
      const body = await request<{ data?: Resource[]; next?: string; meta?: { total?: number } }>(
        `/v1/me/library/${input.kind}?${qs({ limit, offset })}`,
      );
      const items = normalizeAll(body.data);
      return {
        items,
        nextOffset: body.next ? offset + (body.data?.length ?? limit) : null,
        total: typeof body.meta?.total === "number" ? body.meta.total : null,
      };
    },

    async recent(): Promise<MusicRecent> {
      const [containers, tracks] = await Promise.all([
        request<{ data?: Resource[] }>(`/v1/me/recent/played?${qs({ limit: 10 })}`, { cache: false }).catch(() => ({ data: [] })),
        request<{ data?: Resource[] }>(`/v1/me/recent/played/tracks?${qs({ limit: 30, types: "songs,library-songs" })}`, { cache: false }),
      ]);
      return { containers: normalizeAll(containers.data), tracks: normalizeAll(tracks.data) };
    },

    /**
     * The catalog song ids that are still available in this storefront, in
     * the order given. MusicKit refuses a whole queue when one id is gone (a
     * pulled or region-locked song), so a queue is filtered through this first.
     * Library ids (`i.…`) are not catalog ids and are passed through as is.
     */
    async availableSongIds(ids: readonly string[]): Promise<string[]> {
      const catalog = ids.filter((id) => /^\d+$/.test(id));
      if (!catalog.length) return [...ids];
      const sf = await storefrontId();
      const found = new Set<string>();
      for (let at = 0; at < catalog.length; at += 300) {
        const chunk = catalog.slice(at, at + 300);
        const body = await request<{ data?: Resource[] }>(`/v1/catalog/${sf}/songs?${qs({ ids: chunk.join(",") })}`);
        for (const song of body.data ?? []) if (song?.id) found.add(String(song.id));
      }
      return ids.filter((id) => !/^\d+$/.test(id) || found.has(id));
    },

    async tracks(input: { kind: "album" | "playlist"; id: string; library: boolean }): Promise<MusicItem[]> {
      const id = encodeURIComponent(input.id);
      const collection = input.kind === "album" ? "albums" : "playlists";
      const base = input.library
        ? `/v1/me/library/${collection}/${id}/tracks`
        : `/v1/catalog/${await storefrontId()}/${collection}/${id}/tracks`;
      const items: MusicItem[] = [];
      // Playlists can run to thousands of songs; read pages of 100 up to a bound.
      for (let offset = 0; offset < 2_000; offset += 100) {
        const body = await request<{ data?: Resource[]; next?: string }>(`${base}?${qs({ limit: 100, offset })}`, {
          user: input.library ? true : false,
        });
        items.push(...normalizeAll(body.data));
        if (!body.next) break;
      }
      return items;
    },

    async rating(input: { id: string; library: boolean }): Promise<boolean | null> {
      const type = input.library ? "library-songs" : "songs";
      const body = await request<{ data?: Array<{ attributes?: { value?: number } }> }>(
        `/v1/me/ratings/${type}/${encodeURIComponent(input.id)}`,
        { cache: false },
      );
      const value = body.data?.[0]?.attributes?.value;
      return value === 1 ? true : value === -1 ? false : null;
    },

    async setRating(input: { id: string; library: boolean; liked: boolean | null }): Promise<void> {
      const type = input.library ? "library-songs" : "songs";
      const target = `/v1/me/ratings/${type}/${encodeURIComponent(input.id)}`;
      if (input.liked === null) {
        await request<void>(target, { method: "DELETE" });
        return;
      }
      await request<void>(target, {
        method: "PUT",
        body: { type: "rating", attributes: { value: input.liked ? 1 : -1 } },
      });
    },
  };
}
