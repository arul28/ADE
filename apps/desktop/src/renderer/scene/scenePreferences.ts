/**
 * What fills the window behind the top bar, the welcome screen and the new
 * chat page.
 *  - `gradient`: the theme's animated mesh.
 *  - `image`: one picture, bundled (`ade:<id>`) or the user's own (`user:<id>`).
 *  - `shuffle`: a picture from the library, changed on `shuffleEvery`
 *    (the default: a new one each time the computer wakes).
 * With `showImage` off a picture only lends its colours to the mesh.
 */
export type SceneMode = "gradient" | "image" | "shuffle";
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
  defaultsRevision: SCENE_DEFAULTS_REVISION,
};

const MAX_EXCLUDED = 200;

export function normalizeScenePreferences(value: unknown): ScenePreferences {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  if (raw.defaultsRevision !== SCENE_DEFAULTS_REVISION) return { ...DEFAULT_SCENE_PREFERENCES, shuffleExclude: [] };
  const mode: SceneMode = raw.mode === "image" || raw.mode === "shuffle" || raw.mode === "gradient" ? raw.mode : "shuffle";
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
    defaultsRevision: SCENE_DEFAULTS_REVISION,
  };
}
