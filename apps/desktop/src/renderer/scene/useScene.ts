/**
 * The active scene: what fills the window behind the top bar, the welcome
 * screen and the new chat page, resolved from the `scene` interface
 * preference.
 *
 * Loading is shared: every backdrop on screen reads the same module cache, so
 * a picture is fetched, decoded and colour-sampled once, not once per surface.
 * Shuffle picks once per launch (never the same picture twice in a row) and
 * `reshuffleScene()` picks again on demand.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useAppStore } from "../state/appStore";
import { DEFAULT_SCENE_PREFERENCES, type ScenePreferences, type SceneTexture } from "./scenePreferences";
import { BUNDLED_SCENES, findBundledScene, isUserSceneId } from "./sceneLibrary";
import { extractScenePalette, type ScenePalette } from "./scenePalette";
import { listUserScenes, subscribeUserScenes, userSceneUrl, type UserSceneSummary } from "./userScenes";

export type ActiveScene =
  /** `still`: the flat theme background (mode `plain`); no mesh is drawn. */
  | { kind: "gradient"; still: boolean }
  | {
      kind: "image";
      id: string;
      name: string;
      /** Null while the picture loads or when it is gone. */
      url: string | null;
      position: string;
      showImage: boolean;
      texture: SceneTexture;
      dim: number;
      matchTheme: boolean;
      palette: ScenePalette | null;
    };

type Entry = { url: string | null; palette: ScenePalette | null; done: boolean };

const SHUFFLE_LAST_KEY = "ade.sceneShuffleLast";

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let snapshotVersion = 0;
let userScenes: UserSceneSummary[] = [];
let userScenesLoaded = false;
let shufflePick: string | null = null;

function emit(): void {
  snapshotVersion += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function refreshUserScenes(): void {
  void listUserScenes().then((rows) => {
    userScenes = rows;
    userScenesLoaded = true;
    // A deleted picture must not linger in the cache.
    for (const id of [...entries.keys()]) {
      if (isUserSceneId(id) && !rows.some((row) => row.id === id)) entries.delete(id);
    }
    emit();
  });
}

let userSceneSubscription: (() => void) | null = null;
function ensureUserScenes(): void {
  if (userSceneSubscription) return;
  userSceneSubscription = subscribeUserScenes(refreshUserScenes);
  refreshUserScenes();
}

function load(id: string): void {
  if (entries.has(id)) return;
  entries.set(id, { url: null, palette: null, done: false });
  const bundled = findBundledScene(id);
  const urlPromise = bundled ? Promise.resolve(bundled.src) : isUserSceneId(id) ? userSceneUrl(id) : Promise.resolve(null);
  // A user picture deleted while this load was in flight must not come back.
  const stillWanted = () => entries.has(id);
  void urlPromise.then(async (url) => {
    if (!stillWanted()) return;
    entries.set(id, { url, palette: null, done: !url });
    emit();
    if (!url) return;
    const palette = await extractScenePalette(id, url);
    if (!stillWanted()) return;
    entries.set(id, { url, palette, done: true });
    emit();
  });
}

export function sceneLibraryIds(): string[] {
  return [...BUNDLED_SCENES.map((scene) => scene.id), ...userScenes.map((scene) => scene.id)];
}

const SHUFFLE_AT_KEY = "ade.sceneShuffleAt";
const PERIOD_MS: Record<"hour" | "day", number> = { hour: 3_600_000, day: 86_400_000 };

/** The shuffle pool: every picture not left out. Falls back to everything when the user left out all of them. */
export function shufflePool(exclude: readonly string[]): string[] {
  const all = sceneLibraryIds();
  const pool = all.filter((id) => !exclude.includes(id));
  return pool.length > 0 ? pool : all;
}

function pickShuffle(avoid: string | null, exclude: readonly string[]): string {
  const pool = shufflePool(exclude);
  const candidates = pool.length > 1 ? pool.filter((id) => id !== avoid) : pool;
  return candidates[Math.floor(Math.random() * candidates.length)] ?? BUNDLED_SCENES[0]!.id;
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(pick: string): void {
  try {
    window.localStorage.setItem(SHUFFLE_LAST_KEY, pick);
    window.localStorage.setItem(SHUFFLE_AT_KEY, String(Date.now()));
  } catch {
    // Not remembering the last pick only risks a repeat.
  }
}

/**
 * The picture shuffle shows now. Launch and wake modes pick fresh on the
 * first read of a run; hour and day modes keep the remembered pick while its
 * period lasts, so a relaunch inside the hour does not change the picture.
 */
function currentShufflePick(prefs: ScenePreferences): string {
  const pool = shufflePool(prefs.shuffleExclude);
  if (shufflePick && pool.includes(shufflePick)) return shufflePick;
  const last = readStored(SHUFFLE_LAST_KEY);
  if ((prefs.shuffleEvery === "hour" || prefs.shuffleEvery === "day") && last && pool.includes(last)) {
    const at = Number(readStored(SHUFFLE_AT_KEY));
    if (Number.isFinite(at) && Date.now() - at < PERIOD_MS[prefs.shuffleEvery]) {
      shufflePick = last;
      return last;
    }
  }
  shufflePick = pickShuffle(last, prefs.shuffleExclude);
  remember(shufflePick);
  return shufflePick;
}

/** Picks another picture for shuffle mode right now. */
export function reshuffleScene(): void {
  const prefs = useAppStore.getState().interfacePreferences.scene ?? DEFAULT_SCENE_PREFERENCES;
  shufflePick = pickShuffle(shufflePick, prefs.shuffleExclude);
  remember(shufflePick);
  emit();
}

/**
 * One light timer while shuffle is on: every 30s it checks the wall clock.
 * A jump far past the interval means the computer slept, so wake mode picks
 * again; hour and day modes pick when their period has run out. No other
 * work runs on it.
 */
const SHUFFLE_TICK_MS = 30_000;
const WAKE_GAP_MS = 90_000;
let shuffleTimer: number | null = null;
let lastTick = 0;

function shuffleTick(): void {
  const now = Date.now();
  const slept = now - lastTick > WAKE_GAP_MS;
  lastTick = now;
  const prefs = useAppStore.getState().interfacePreferences.scene ?? DEFAULT_SCENE_PREFERENCES;
  if (prefs.mode !== "shuffle") return;
  if (prefs.shuffleEvery === "wake" && slept) {
    reshuffleScene();
    return;
  }
  if (prefs.shuffleEvery === "hour" || prefs.shuffleEvery === "day") {
    const at = Number(readStored(SHUFFLE_AT_KEY));
    if (!Number.isFinite(at) || now - at >= PERIOD_MS[prefs.shuffleEvery]) reshuffleScene();
  }
}

function setShuffleTimer(on: boolean): void {
  if (on && shuffleTimer == null) {
    lastTick = Date.now();
    shuffleTimer = window.setInterval(shuffleTick, SHUFFLE_TICK_MS);
  } else if (!on && shuffleTimer != null) {
    window.clearInterval(shuffleTimer);
    shuffleTimer = null;
  }
}

function sceneName(id: string): string {
  return findBundledScene(id)?.name ?? userScenes.find((scene) => scene.id === id)?.name ?? "Picture";
}

/** Resolves preferences to a scene id, or null for the gradient. */
export function sceneIdFor(prefs: ScenePreferences): string | null {
  if (prefs.mode === "image") return prefs.imageId;
  if (prefs.mode === "shuffle") return currentShufflePick(prefs);
  return null;
}

export function useActiveScene(): ActiveScene {
  const prefs = useAppStore((s) => s.interfacePreferences.scene ?? DEFAULT_SCENE_PREFERENCES);
  useSyncExternalStore(subscribe, () => snapshotVersion);
  const usesUserLibrary = prefs.mode === "shuffle" || isUserSceneId(prefs.imageId);

  useEffect(() => {
    if (usesUserLibrary) ensureUserScenes();
  }, [usesUserLibrary]);

  // Shuffle waits for the user library so a user picture can win the draw.
  const waitingForLibrary = prefs.mode === "shuffle" && !userScenesLoaded && !shufflePick;
  const id = waitingForLibrary ? null : sceneIdFor(prefs);

  useEffect(() => {
    if (id) load(id);
  }, [id]);

  if (!id) return { kind: "gradient", still: prefs.mode === "plain" };
  const entry = entries.get(id);
  // A user picture that no longer exists falls back to the gradient.
  if (entry?.done && !entry.url) return { kind: "gradient", still: false };
  return {
    kind: "image",
    id,
    name: sceneName(id),
    url: entry?.url ?? null,
    position: findBundledScene(id)?.position ?? "50% 50%",
    showImage: prefs.showImage,
    texture: prefs.texture,
    dim: prefs.dim,
    matchTheme: prefs.matchTheme,
    palette: entry?.palette ?? null,
  };
}

/** The user library, live. */
export function useUserScenes(): UserSceneSummary[] {
  useSyncExternalStore(subscribe, () => snapshotVersion);
  useEffect(() => {
    ensureUserScenes();
  }, []);
  return userScenes;
}

/** Merges a partial scene change into the interface preferences. */
export function useSetScene(): (next: Partial<ScenePreferences>) => void {
  const setInterfacePreferences = useAppStore((s) => s.setInterfacePreferences);
  return useCallback(
    (next) => {
      const current = useAppStore.getState().interfacePreferences.scene ?? DEFAULT_SCENE_PREFERENCES;
      setInterfacePreferences({ scene: { ...current, ...next, choiceMade: true } });
    },
    [setInterfacePreferences],
  );
}

/**
 * Mirrors the scene onto <html>: `data-scene="image"` while a picture is on
 * screen (cards turn frosted, wordmarks step aside) and `"gradient"` otherwise.
 * Mount once, near the root.
 */
export function useSceneDocumentSync(): ActiveScene {
  const scene = useActiveScene();
  const showingImage = scene.kind === "image" && scene.showImage;
  const shuffleOn = useAppStore((s) => (s.interfacePreferences.scene ?? DEFAULT_SCENE_PREFERENCES).mode === "shuffle");
  // Mounted once at the root, so the shuffle timer has exactly one owner.
  useEffect(() => {
    setShuffleTimer(shuffleOn);
    return () => setShuffleTimer(false);
  }, [shuffleOn]);
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-scene", showingImage ? "image" : "gradient");
    return () => root.removeAttribute("data-scene");
  }, [showingImage]);
  return scene;
}
