import { isWebClientMode } from "../lib/webClientMode";
import { findBundledScene } from "./sceneLibrary";

/**
 * What fills the window behind the top bar, the welcome screen and the new
 * chat page.
 *  - `gradient`: the theme's animated mesh.
 *  - `plain`: the theme's flat background, no picture and no motion (the web default).
 *  - `image`: one picture, bundled (`ade:<id>`) or the user's own (`user:<id>`).
 *  - `shuffle`: a picture from the library, changed on `shuffleEvery`
 *    (by default a new one each time the computer wakes). The desktop default.
 * With `showImage` off a picture only lends its colours to the mesh.
 */
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
  /**
   * Pictures left out of the shuffle. By default the shuffle holds every
   * picture that fits the screen (`sceneFitsScreen`) and the user's own;
   * this takes some out.
   */
  shuffleExclude: string[];
  /** Pictures the user put in the shuffle although they are not sized for this screen. */
  shuffleInclude: string[];
  /** The user picked a scene (`useSetScene`), so these are not the untouched shipped default. */
  choiceMade: boolean;
  /** Which shipped default these preferences descend from; see `SCENE_DEFAULTS_REVISION`. */
  defaultsRevision: number;
};

/**
 * Bump to put every user back on the shipped default once, whatever they had
 * chosen. Preferences carrying an older revision (or none) are replaced by
 * this client's default on the next read; after that the user's choices
 * stand until the next bump.
 *
 * 1 — pictures ship: shuffle, a new picture on each wake, every picture in.
 * 2 — sharp pictures sized per screen: everyone starts again on the shuffle
 *     of the pictures that fit their screen (plain on the web client).
 */
export const SCENE_DEFAULTS_REVISION = 2;

/**
 * The desktop default: a picture that fits the screen, a new one on each wake.
 * Only pictures sharp at the screen's size are in the draw, so a first launch
 * opens on a wallpaper that looks right on that display (`sceneFitsScreen`).
 */
export const DEFAULT_SCENE_PREFERENCES: ScenePreferences = {
  mode: "shuffle",
  imageId: null,
  showImage: true,
  texture: "none",
  dim: 30,
  matchTheme: true,
  shuffleEvery: "wake",
  shuffleExclude: [],
  shuffleInclude: [],
  choiceMade: false,
  defaultsRevision: SCENE_DEFAULTS_REVISION,
};

/**
 * The hosted web client's default: the theme's flat background. A browser tab
 * that paints a picture on every load spends its first paint on a fetch and a
 * palette sample. Chosen at read time and never written under its own
 * revision, so the stored revision stays `SCENE_DEFAULTS_REVISION` on both
 * clients.
 */
export const WEB_DEFAULT_SCENE_PREFERENCES: ScenePreferences = {
  ...DEFAULT_SCENE_PREFERENCES,
  mode: "plain",
};

/** This client's default: shuffle on desktop, plain on the hosted web client. */
export function defaultScenePreferences(): ScenePreferences {
  const defaults = isWebClientMode() ? WEB_DEFAULT_SCENE_PREFERENCES : DEFAULT_SCENE_PREFERENCES;
  return { ...defaults, shuffleExclude: [], shuffleInclude: [] };
}

const MAX_LISTED = 200;

function idList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 120))].slice(0, MAX_LISTED)
    : [];
}

export function normalizeScenePreferences(value: unknown): ScenePreferences {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const stale = raw.defaultsRevision !== SCENE_DEFAULTS_REVISION;
  if (stale) return defaultScenePreferences();
  const mode: SceneMode = raw.mode === "image" || raw.mode === "shuffle" || raw.mode === "gradient" || raw.mode === "plain"
    ? raw.mode
    : DEFAULT_SCENE_PREFERENCES.mode;
  const storedId = typeof raw.imageId === "string" && raw.imageId.trim() ? raw.imageId.trim().slice(0, 120) : null;
  // A bundled picture ADE no longer ships reads as no pick, so its user
  // shuffles instead of landing on the gradient.
  const imageId = storedId && storedId.startsWith("ade:") && !findBundledScene(storedId) ? null : storedId;
  const texture: SceneTexture = raw.texture === "none" || raw.texture === "grain" || raw.texture === "dots"
    ? raw.texture
    : DEFAULT_SCENE_PREFERENCES.texture;
  const dimRaw = typeof raw.dim === "number" && Number.isFinite(raw.dim) ? raw.dim : DEFAULT_SCENE_PREFERENCES.dim;
  const shuffleEvery: SceneShuffleEvery =
    raw.shuffleEvery === "launch" || raw.shuffleEvery === "hour" || raw.shuffleEvery === "day" ? raw.shuffleEvery : "wake";
  const shuffleExclude = idList(raw.shuffleExclude);
  const shuffleInclude = idList(raw.shuffleInclude);
  return {
    mode: mode === "image" && !imageId ? "shuffle" : mode,
    imageId,
    showImage: raw.showImage !== false,
    texture,
    dim: Math.round(Math.min(60, Math.max(0, dimRaw))),
    matchTheme: raw.matchTheme !== false,
    shuffleEvery,
    shuffleExclude,
    shuffleInclude,
    choiceMade: raw.choiceMade === true,
    defaultsRevision: SCENE_DEFAULTS_REVISION,
  };
}
