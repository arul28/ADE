import { createContext, useContext } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  DEFAULT_THEME_ID,
  baseModeForThemeId,
  canonicalThemeId,
  normalizeAdeThemeList,
  resolveTheme,
  resolveThemeById,
  themeIdForMode,
  type AdeTheme,
} from "../../shared/theme";
import { isWebClientMode } from "../lib/webClientMode";
import { DEFAULT_SCENE_PREFERENCES, normalizeScenePreferences, type ScenePreferences } from "../scene/scenePreferences";
import { applyInterfacePreferences } from "../theme/applyInterface";
import { applyAdeTheme } from "../theme/applyTheme";

/**
 * The part of the app's state that decides how ADE looks: theme, scene, fonts,
 * motion and tooltips. It is a module of its own so the components that paint
 * the look (`AppearanceRoot`, `ThemeDocumentSync`, the mesh backdrop, tooltips,
 * scenes) do not import `appStore`. The hosted client's sign-in screen draws
 * with those components before anyone is signed in, and `appStore` alone was a
 * third of the JavaScript a signed-out visitor downloaded.
 *
 * Inside the app these values still live in `appStore`: it registers itself
 * here when it loads, and {@link useAppearanceStore} reads from it (or from the
 * project store in context) exactly as `useAppStore` does. Only when no app
 * store exists does a small stand-in take over, filled from the same saved
 * preferences with the same parsing, which `appStore` imports from this file.
 */

export type ThemeId = "dark" | "light";

/** The interface and code faces ADE ships, plus the platform's own. */
export type InterfaceSansFont = "geist" | "system" | "geist-mono";
export type InterfaceMonoFont = "jetbrains" | "geist-mono" | "system";

export type InterfacePreferences = {
  sansFont: InterfaceSansFont;
  monoFont: InterfaceMonoFont;
  /** Stops transitions and animations across the app, whatever the OS says. */
  reduceMotion: boolean;
  scene: ScenePreferences;
};

export const DEFAULT_INTERFACE_PREFERENCES: InterfacePreferences = {
  sansFont: "geist",
  monoFont: "jetbrains",
  reduceMotion: false,
  scene: DEFAULT_SCENE_PREFERENCES,
};

export function normalizeInterfacePreferences(value: unknown): InterfacePreferences {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const sansFont: InterfaceSansFont =
    raw.sansFont === "system" || raw.sansFont === "geist-mono" ? raw.sansFont : "geist";
  const monoFont: InterfaceMonoFont =
    raw.monoFont === "geist-mono" || raw.monoFont === "system" ? raw.monoFont : "jetbrains";
  return { sansFont, monoFont, reduceMotion: raw.reduceMotion === true, scene: normalizeScenePreferences(raw.scene) };
}

export const USER_PREFERENCES_STORAGE_KEY = "ade.userPreferences.v1";

/**
 * The theme id to paint. `themeId` is the user's choice and the synced value;
 * when the theme follows the system, the same family's variant for the OS mode
 * is painted instead. A custom theme has one mode and paints as it is.
 */
export function effectiveThemeId(themeId: string, followsSystem: boolean, systemColorScheme: ThemeId): string {
  return followsSystem ? themeIdForMode(themeId, systemColorScheme) : themeId;
}

/** The OS colour scheme now. Local to this machine; never persisted or synced. */
export function readSystemColorScheme(): ThemeId {
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
  } catch {
    // Fall through to the default.
  }
  return "dark";
}

export function coerceTheme(value: unknown): ThemeId | null {
  if (value === "dark" || value === "light") return value;
  if (value === "github" || value === "bloomberg" || value === "rainbow" || value === "pats") return "dark";
  if (value === "e-paper" || value === "sky") return "light";
  return null;
}

/**
 * Keep the active theme id verbatim rather than resolving it here.
 *
 * A custom theme's id can arrive from the account store before the theme list
 * itself does, and resolving now would pin the machine to the fallback and lose
 * the user's choice. The renderer resolves the id against the full list at paint
 * time (`resolveThemeById`), so an id that names nothing today paints as the
 * default until its definition lands.
 */
export function coerceThemeId(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    // A retired shipped id maps to the variant that replaced it.
    if (trimmed) return canonicalThemeId(trimmed);
  }
  return DEFAULT_THEME_ID;
}

/** What the appearance components read, and the two things they write. */
export type AppearanceState = {
  theme: ThemeId;
  themeId: string;
  customThemes: AdeTheme[];
  themeFollowsSystem: boolean;
  systemColorScheme: ThemeId;
  interfacePreferences: InterfacePreferences;
  smartTooltipsEnabled: boolean;
  setInterfacePreferences: (next: Partial<InterfacePreferences>) => void;
  setSystemColorScheme: (scheme: ThemeId) => void;
};

/** The theme id to paint, after the follow-the-system rule. */
export function selectEffectiveThemeId(
  state: Pick<AppearanceState, "themeId" | "themeFollowsSystem" | "systemColorScheme">,
): string {
  return effectiveThemeId(state.themeId, state.themeFollowsSystem, state.systemColorScheme);
}

/** The store as the appearance hooks use it: read and subscribe. The app store fits this as it is. */
type AppearanceStoreApi = Pick<StoreApi<AppearanceState>, "getState" | "getInitialState" | "subscribe">;

/**
 * The OS colour scheme changed. Returns the new scheme with the base mode it
 * paints, or null when the scheme is the one already held.
 */
export function systemColorSchemeChange(
  prev: Pick<AppearanceState, "themeId" | "themeFollowsSystem" | "systemColorScheme" | "customThemes">,
  scheme: ThemeId,
): Pick<AppearanceState, "theme" | "systemColorScheme"> | null {
  const systemColorScheme: ThemeId = scheme === "light" ? "light" : "dark";
  if (systemColorScheme === prev.systemColorScheme) return null;
  const theme = baseModeForThemeId(
    effectiveThemeId(prev.themeId, prev.themeFollowsSystem, systemColorScheme),
    prev.customThemes,
  );
  return { theme, systemColorScheme };
}

/**
 * The project store in scope, as `AppStoreProvider` sets it. One context
 * object for both hooks: `appStore` uses this same object under its own type.
 */
export const AppearanceStoreContext = createContext<AppearanceStoreApi | null>(null);

let rootStore: AppearanceStoreApi | null = null;
let standInStore: AppearanceStoreApi | null = null;

/** Called once by `appStore` with the root app store. */
export function registerRootAppearanceStore(store: AppearanceStoreApi): void {
  rootStore = store;
}

type StoredAppearance = Pick<
  AppearanceState,
  "theme" | "themeId" | "customThemes" | "themeFollowsSystem" | "interfacePreferences" | "smartTooltipsEnabled"
>;

/** The appearance values of a saved unified preferences record. `appStore` reads them with this too. */
export function parseStoredAppearance(parsed: Record<string, unknown>): StoredAppearance {
  return {
    theme: coerceTheme(parsed.theme) ?? "dark",
    themeId: coerceThemeId(parsed.themeId ?? parsed.theme),
    customThemes: normalizeAdeThemeList(parsed.customThemes),
    themeFollowsSystem: parsed.themeFollowsSystem === true,
    interfacePreferences: normalizeInterfacePreferences(parsed.interfacePreferences),
    // Detailed tooltips are an onboarding aid that defaults OFF in the browser
    // web client (clutter for an already oriented user), and ON on desktop. An
    // explicit toggle is still honored.
    smartTooltipsEnabled: (parsed.smartTooltipsEnabled as boolean | null | undefined) ?? !isWebClientMode(),
  };
}

/** The saved appearance: the unified key, then the legacy keys, as `appStore` reads them. */
function readStoredAppearance(): StoredAppearance {
  try {
    const raw = window.localStorage.getItem(USER_PREFERENCES_STORAGE_KEY);
    if (raw) return parseStoredAppearance(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    // Unreadable storage reads as "nothing saved".
  }
  let theme: ThemeId = "dark";
  let smartTooltipsEnabled = !isWebClientMode();
  try {
    theme = coerceTheme(window.localStorage.getItem("ade.theme")) ?? "dark";
    if (window.localStorage.getItem("ade.smartTooltips") === "false") smartTooltipsEnabled = false;
  } catch {
    // ignore
  }
  return {
    theme,
    themeId: theme,
    customThemes: [],
    themeFollowsSystem: false,
    interfacePreferences: normalizeInterfacePreferences({}),
    smartTooltipsEnabled,
  };
}

/**
 * Save one appearance value into the unified preferences, leaving every other
 * key as it is. Only when that record already exists: writing a partial one
 * would make `appStore` skip its migration of the legacy keys on first load.
 */
function patchStoredPreferences(patch: Partial<StoredAppearance>): void {
  try {
    const raw = window.localStorage.getItem(USER_PREFERENCES_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    window.localStorage.setItem(USER_PREFERENCES_STORAGE_KEY, JSON.stringify({ ...parsed, ...patch }));
  } catch {
    // The value still holds for this page.
  }
}

function createStandInStore(): AppearanceStoreApi {
  const stored = readStoredAppearance();
  const systemColorScheme = readSystemColorScheme();
  const paintedThemeId = effectiveThemeId(stored.themeId, stored.themeFollowsSystem, systemColorScheme);
  // Paint the stored look before the first frame, as `appStore` does on load.
  if (typeof document !== "undefined" && document.documentElement) {
    try {
      applyAdeTheme(resolveTheme(resolveThemeById(paintedThemeId, stored.customThemes)));
      applyInterfacePreferences(stored.interfacePreferences);
    } catch {
      // A failed early paint must never block the page; the components retry.
    }
  }
  return createStore<AppearanceState>()((set) => ({
    ...stored,
    theme: baseModeForThemeId(paintedThemeId, stored.customThemes),
    systemColorScheme,
    setInterfacePreferences: (next) =>
      set((prev) => {
        const interfacePreferences = normalizeInterfacePreferences({ ...prev.interfacePreferences, ...next });
        patchStoredPreferences({ interfacePreferences });
        return { interfacePreferences };
      }),
    setSystemColorScheme: (scheme) =>
      set((prev) => {
        const change = systemColorSchemeChange(prev, scheme);
        if (!change) return {};
        if (change.theme !== prev.theme) patchStoredPreferences({ theme: change.theme });
        return change;
      }),
  }));
}

function rootAppearanceStore(): AppearanceStoreApi {
  return rootStore ?? (standInStore ??= createStandInStore());
}

/** `useAppStore` for the appearance values: the project store in context, else the root store. */
export function useAppearanceStore<T>(selector: (state: AppearanceState) => T): T {
  return useStore(useContext(AppearanceStoreContext) ?? rootAppearanceStore(), selector);
}

/** The root store's appearance values now (`useAppStore.getState()` for these fields). */
export function getAppearanceState(): AppearanceState {
  return rootAppearanceStore().getState();
}
