/**
 * The active scene: what fills the window behind the top bar, the welcome
 * screen and the new chat page, resolved from the `scene` interface
 * preference.
 *
 * Loading is shared: every backdrop on screen reads the same module cache, so
 * a picture is fetched, decoded and colour-sampled once, not once per surface.
 * Each draws the file sized for the screen: a bundled picture's copy
 * (`sceneSrcForScreen`), or a user picture's screen-sized copy (`userSceneUrl`).
 * Shuffle picks once per launch (never the same picture twice in a row) and
 * `reshuffleScene()` picks again on demand.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getAppearanceState, useAppearanceStore } from "../state/appearanceStore";
import { DEFAULT_SCENE_PREFERENCES, type ScenePreferences, type SceneTexture } from "./scenePreferences";
import { BUNDLED_SCENES, findBundledScene, isUserSceneId, readScreenPixels, sceneFitsScreen, sceneSrcForScreen, type ScreenPixels } from "./sceneLibrary";
import { extractScenePalette, type ScenePalette } from "./scenePalette";
import { listUserScenes, subscribeUserScenes, userSceneUrl, type UserSceneSummary } from "./userScenes";

export type ActiveScene =
  /** The flat theme background (mode `plain`): no mesh is drawn and nothing moves. */
  | { kind: "plain" }
  /**
   * The theme's animated mesh (mode `gradient`, or a picture that is gone).
   * `pending`: shuffle has not drawn its picture yet (it waits for the user
   * library), so a picture may still replace the mesh in a moment.
   */
  | { kind: "gradient"; pending?: true }
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

/**
 * The cache key of a scene on this screen. A user picture has one entry per
 * screen size, because each size draws its own copy; a bundled picture picks
 * its file at render time, so one entry serves every screen.
 */
function entryKey(id: string, screen: ScreenPixels): string {
  return isUserSceneId(id) ? `${id}@${screen.width}x${screen.height}` : id;
}

function sceneIdOfEntry(key: string): string {
  const at = key.indexOf("@");
  return at < 0 ? key : key.slice(0, at);
}

/** The last URL and colours each scene showed, kept while the copy for a new screen loads. */
const lastUrlById = new Map<string, string>();
const lastPaletteById = new Map<string, ScenePalette>();

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
    for (const key of [...entries.keys()]) {
      const id = sceneIdOfEntry(key);
      if (isUserSceneId(id) && !rows.some((row) => row.id === id)) {
        entries.delete(key);
        lastUrlById.delete(id);
        lastPaletteById.delete(id);
      }
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

function load(id: string, screen: ScreenPixels): void {
  const key = entryKey(id, screen);
  if (entries.has(key)) return;
  entries.set(key, { url: null, palette: null, done: false });
  const bundled = findBundledScene(id);
  // A user picture shows its stored copy, or the picture itself at once; a
  // copy that has to be made first replaces it when ready (`upgradeToCopy`).
  const urlPromise = bundled
    ? Promise.resolve(bundled.src)
    : isUserSceneId(id)
      ? userSceneUrl(id, screen, { makeCopy: false })
      : Promise.resolve(null);
  // A user picture deleted while this load was in flight must not come back.
  const stillWanted = () => entries.has(key);
  void urlPromise.then(async (url) => {
    if (!stillWanted()) return;
    entries.set(key, { url, palette: null, done: !url });
    if (url) lastUrlById.set(id, url);
    emit();
    if (!url) return;
    // The colours come from a 48px sample, so a bundled picture samples its
    // thumbnail and a user picture its copy, instead of decoding the full
    // file a second time. Colours are kept per picture, not per file.
    const palette = await extractScenePalette(id, bundled?.thumb ?? url);
    if (!stillWanted()) return;
    if (palette) lastPaletteById.set(id, palette);
    entries.set(key, { url, palette, done: true });
    emit();
    if (isUserSceneId(id)) upgradeToCopy(key, id, screen, url);
  });
}

/**
 * Makes a user picture's copy for this screen when it was not stored yet, and
 * swaps it in. The layer keeps the picture on screen until the copy is
 * decoded (`SceneImageLayer`), so the swap shows nothing; it only frees the
 * larger decode.
 */
function upgradeToCopy(key: string, id: string, screen: ScreenPixels, shownUrl: string): void {
  void userSceneUrl(id, screen).then((url) => {
    const entry = entries.get(key);
    if (!url || url === shownUrl || !entry || entry.url !== shownUrl) return;
    entries.set(key, { ...entry, url });
    lastUrlById.set(id, url);
    emit();
  });
}

export function sceneLibraryIds(): string[] {
  return [...BUNDLED_SCENES.map((scene) => scene.id), ...userScenes.map((scene) => scene.id)];
}

const SHUFFLE_AT_KEY = "ade.sceneShuffleAt";
const PERIOD_MS: Record<"hour" | "day", number> = { hour: 3_600_000, day: 86_400_000 };

export type ShufflePrefs = Pick<ScenePreferences, "shuffleExclude" | "shuffleInclude">;

/**
 * Whether a picture is in the shuffle on this screen. Left out wins, then put
 * in by hand; otherwise the user's own pictures are in, and a bundled one is
 * in when it is sized for the screen.
 */
export function inShuffle(id: string, prefs: ShufflePrefs, screen: ScreenPixels): boolean {
  if (prefs.shuffleExclude.includes(id)) return false;
  if (prefs.shuffleInclude.includes(id) || isUserSceneId(id)) return true;
  const bundled = findBundledScene(id);
  return bundled ? sceneFitsScreen(bundled, screen) : false;
}

/**
 * The pool after the user clicks a picture in Settings. On → off leaves it
 * out. Off → on drops the leave-out and, when the picture would still not be
 * in on its own (not sized for this screen), puts it in by hand. Null when the
 * click would leave nothing to shuffle.
 */
export function toggledShufflePool(id: string, prefs: ShufflePrefs, screen: ScreenPixels, libraryIds: readonly string[]): ShufflePrefs | null {
  const next: ShufflePrefs = {
    shuffleExclude: prefs.shuffleExclude.filter((value) => value !== id),
    shuffleInclude: prefs.shuffleInclude.filter((value) => value !== id),
  };
  if (inShuffle(id, prefs, screen)) next.shuffleExclude.push(id);
  else if (!inShuffle(id, next, screen)) next.shuffleInclude.push(id);
  return libraryIds.some((libraryId) => inShuffle(libraryId, next, screen)) ? next : null;
}

/** The shuffle pool on the current screen. Empty when nothing fits, and the gradient shows instead. */
export function shufflePool(prefs: ShufflePrefs): string[] {
  const screen = readScreenPixels();
  return sceneLibraryIds().filter((id) => inShuffle(id, prefs, screen));
}

function pickShuffle(avoid: string | null, prefs: ShufflePrefs): string | null {
  const pool = shufflePool(prefs);
  const candidates = pool.length > 1 ? pool.filter((id) => id !== avoid) : pool;
  return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(pick: string | null): void {
  if (!pick) return;
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
function currentShufflePick(prefs: ScenePreferences): string | null {
  const pool = shufflePool(prefs);
  if (shufflePick && pool.includes(shufflePick)) return shufflePick;
  const last = readStored(SHUFFLE_LAST_KEY);
  if ((prefs.shuffleEvery === "hour" || prefs.shuffleEvery === "day") && last && pool.includes(last)) {
    const at = Number(readStored(SHUFFLE_AT_KEY));
    if (Number.isFinite(at) && Date.now() - at < PERIOD_MS[prefs.shuffleEvery]) {
      shufflePick = last;
      return last;
    }
  }
  shufflePick = pickShuffle(last, prefs);
  remember(shufflePick);
  return shufflePick;
}

/** Picks another picture for shuffle mode right now. */
export function reshuffleScene(): void {
  const prefs = getAppearanceState().interfacePreferences.scene ?? DEFAULT_SCENE_PREFERENCES;
  shufflePick = pickShuffle(shufflePick, prefs);
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
  const prefs = getAppearanceState().interfacePreferences.scene ?? DEFAULT_SCENE_PREFERENCES;
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

/**
 * Whether the scene will show a picture once it settles, read from the
 * preferences alone, before the user library loads: the boot code that must
 * know the window's final look early (the early prompt box) asks this. Null
 * when only the user library can tell (shuffle with no bundled picture that
 * fits this screen). A user picture chosen by hand counts as shown; if it was
 * deleted, the gradient shows instead.
 */
export function sceneWillShowPicture(prefs: ScenePreferences): boolean | null {
  if (!prefs.showImage) return false;
  if (prefs.mode === "image") {
    const id = prefs.imageId;
    return id !== null && (findBundledScene(id) !== null || isUserSceneId(id));
  }
  if (prefs.mode !== "shuffle") return false;
  if (shufflePick !== null || shufflePool(prefs).length > 0) return true;
  return userScenesLoaded ? false : null;
}

/**
 * `untouched` replaces the shipped default for a person who never picked a
 * scene (ADE Web's signed-out page opens on a picture, not the flat
 * background). A scene they chose always wins.
 */
export function useActiveScene(options: { untouched?: ScenePreferences } = {}): ActiveScene {
  const stored = useAppearanceStore((s) => s.interfacePreferences.scene ?? DEFAULT_SCENE_PREFERENCES);
  const untouchedDefault = !stored.choiceMade && Boolean(options.untouched);
  const prefs = untouchedDefault && options.untouched ? options.untouched : stored;
  useSyncExternalStore(subscribe, () => snapshotVersion);
  // Moving to a display of another size re-renders, so shuffle re-checks its
  // pick against the pictures that fit there and a bundled picture loads the
  // file sized for it.
  const screen = useScreenPixels();
  const usesUserLibrary = prefs.mode === "shuffle" || isUserSceneId(prefs.imageId);

  useEffect(() => {
    if (usesUserLibrary) ensureUserScenes();
  }, [usesUserLibrary]);

  // Shuffle waits for the user library so a user picture can win the draw.
  const waitingForLibrary = prefs.mode === "shuffle" && !userScenesLoaded && !shufflePick;
  const id = waitingForLibrary ? null : sceneIdFor(prefs);

  const key = id ? entryKey(id, screen) : null;
  useEffect(() => {
    if (id) load(id, screen);
    // `key` covers the screen for the scenes whose file depends on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!id) {
    if (prefs.mode === "plain") return { kind: "plain" };
    return waitingForLibrary ? { kind: "gradient", pending: true } : { kind: "gradient" };
  }
  const entry = key ? entries.get(key) : undefined;
  // A user picture that no longer exists falls back to the gradient.
  if (entry?.done && !entry.url) return { kind: "gradient" };
  const bundled = findBundledScene(id);
  return {
    kind: "image",
    id,
    name: sceneName(id),
    // On a move to another screen, a user picture keeps its last file until
    // the copy for the new screen is ready, so it does not blink out.
    url: bundled
      ? untouchedDefault && bundled.signIn ? bundled.signIn.src : sceneSrcForScreen(bundled, screen)
      : entry?.url ?? lastUrlById.get(id) ?? null,
    position: bundled?.position ?? "50% 50%",
    showImage: prefs.showImage,
    texture: prefs.texture,
    dim: prefs.dim,
    matchTheme: prefs.matchTheme,
    palette: entry?.palette ?? lastPaletteById.get(id) ?? null,
  };
}

// The screen's device pixels, live: moving the window to another display
// changes which pictures fit. `getSnapshot` also runs on every render, so a
// display change shows at the next render even without a resize.
function subscribeScreen(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

let screenSnapshot: ScreenPixels = { width: 0, height: 0 };
function readScreenSnapshot(): ScreenPixels {
  const next = readScreenPixels();
  if (next.width !== screenSnapshot.width || next.height !== screenSnapshot.height) screenSnapshot = next;
  return screenSnapshot;
}

export function useScreenPixels(): ScreenPixels {
  return useSyncExternalStore(subscribeScreen, readScreenSnapshot);
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
  const setInterfacePreferences = useAppearanceStore((s) => s.setInterfacePreferences);
  return useCallback(
    (next) => {
      const current = getAppearanceState().interfacePreferences.scene ?? DEFAULT_SCENE_PREFERENCES;
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
  const shuffleOn = useAppearanceStore((s) => (s.interfacePreferences.scene ?? DEFAULT_SCENE_PREFERENCES).mode === "shuffle");
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
