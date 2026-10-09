/**
 * What fills the window behind the top bar, the welcome screen and the new
 * chat page.
 *  - `gradient`: the theme's animated mesh.
 *  - `plain`: the theme's flat background, no picture and no motion.
 *  - `image`: one picture, bundled (`ade:<id>`) or the user's own (`user:<id>`).
 *  - `shuffle`: a picture from the library, changed on `shuffleEvery`
 *    (the default: a new one each time the computer wakes).
 * With `showImage` off a picture only lends its colours to the mesh.
 */
import { isWebClientMode } from "../lib/webClientMode";

export type SceneMode = "gradient" | "plain" | "image" | "shuffle";
export type SceneTexture = "none" | "dots" | "grain";
/** When shuffle picks a new picture. `wake` also covers launch. */
export type SceneShuffleEvery = "launch" | "wake" | "hour" | "day";
export type ScenePreferences = {
  mode: SceneMode;
  imageId: string | null;
  showImage: boolean;
  texture: SceneTexture;
  /** 0–60: how much the theme background veils the picture. */
  dim: number;
  /** The picture also sets the app's accent colours (and a hint of its hue in the surfaces). */
  matchTheme: boolean;
  shuffleEvery: SceneShuffleEvery;
  /** Pictures left out of the shuffle. Everything else, including new pictures, is in. */
  shuffleExclude: string[];
  /** The user picked a scene (`useSetScene`), so these are not the untouched shipped default. */
  choiceMade: boolean;
  /** Which shipped default these preferences descend from; see `SCENE_DEFAULTS_REVISION`. */
  defaultsRevision: number;
};

/**
 * Bump to put every user back on the shipped default once, whatever they had
 * chosen. Preferences carrying an older revision (or none) are replaced by
 * `DEFAULT_SCENE_PREFERENCES` on the next read; after that the user's choices
 * stand until the next bump.
 *
 * 1 — pictures ship: shuffle, a new picture on each wake, every picture in.
 */
export const SCENE_DEFAULTS_REVISION = 1;

export const DEFAULT_SCENE_PREFERENCES: ScenePreferences = {
  mode: "shuffle",
  imageId: null,
  showImage: true,
  texture: "dots",
  dim: 12,
  matchTheme: true,
  shuffleEvery: "wake",
  shuffleExclude: [],
  choiceMade: false,
  defaultsRevision: SCENE_DEFAULTS_REVISION,
};

/**
 * The hosted web client's default: the theme's flat background, no picture and
 * no motion. A browser tab that paints a picture on every load spends its
 * first paint on a fetch and a palette sample, and a visitor has not chosen a
 * wallpaper. Desktop never reads this.
 *
 * It is chosen at read time and never written under its own revision, so the
 * stored revision stays `SCENE_DEFAULTS_REVISION` on both clients.
 */
export const WEB_DEFAULT_SCENE_PREFERENCES: ScenePreferences = {
  ...DEFAULT_SCENE_PREFERENCES,
  mode: "plain",
  showImage: false,
};

const MAX_EXCLUDED = 200;

/**
 * The shipped shuffle default, untouched. The web client persisted it on its
 * first load, so it is not a choice and reads as the web default. Any pick the
 * user made (`choiceMade`) stands, even when it is Shuffle again.
 */
function isUntouchedShuffleDefault(raw: Record<string, unknown>): boolean {
  return raw.choiceMade !== true
    && raw.mode === "shuffle"
    && !(typeof raw.imageId === "string" && raw.imageId.trim())
    && raw.shuffleEvery !== "launch" && raw.shuffleEvery !== "hour" && raw.shuffleEvery !== "day"
    && !(Array.isArray(raw.shuffleExclude) && raw.shuffleExclude.length > 0);
}

export function normalizeScenePreferences(value: unknown): ScenePreferences {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const stale = raw.defaultsRevision !== SCENE_DEFAULTS_REVISION;
  if (isWebClientMode()) {
    if (stale || isUntouchedShuffleDefault(raw)) return { ...WEB_DEFAULT_SCENE_PREFERENCES, shuffleExclude: [] };
  } else if (stale) {
    return { ...DEFAULT_SCENE_PREFERENCES, shuffleExclude: [] };
  }
  const mode: SceneMode = raw.mode === "image" || raw.mode === "shuffle" || raw.mode === "gradient" || raw.mode === "plain"
    ? raw.mode
    : "shuffle";
  const imageId = typeof raw.imageId === "string" && raw.imageId.trim() ? raw.imageId.trim().slice(0, 120) : null;
  const texture: SceneTexture = raw.texture === "none" || raw.texture === "grain" ? raw.texture : "dots";
  const dimRaw = typeof raw.dim === "number" && Number.isFinite(raw.dim) ? raw.dim : DEFAULT_SCENE_PREFERENCES.dim;
  const shuffleEvery: SceneShuffleEvery =
    raw.shuffleEvery === "launch" || raw.shuffleEvery === "hour" || raw.shuffleEvery === "day" ? raw.shuffleEvery : "wake";
  const shuffleExclude = Array.isArray(raw.shuffleExclude)
    ? [...new Set(raw.shuffleExclude.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 120))].slice(0, MAX_EXCLUDED)
    : [];
  return {
    mode: mode === "image" && !imageId ? "shuffle" : mode,
    imageId,
    showImage: raw.showImage !== false,
    texture,
    dim: Math.round(Math.min(60, Math.max(0, dimRaw))),
    matchTheme: raw.matchTheme !== false,
    shuffleEvery,
    shuffleExclude,
    choiceMade: raw.choiceMade === true,
    defaultsRevision: SCENE_DEFAULTS_REVISION,
  };
}
