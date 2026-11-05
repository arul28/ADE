/**
 * The Android brand catalog (plan §7.1): the named phones the picker's
 * "New device" grid offers. The brain (which profile to make an AVD from),
 * the CLI (`ade android device-create --catalog`) and the renderer (the tile,
 * the 3D body and its colour) all read this one list.
 *
 * The software inside is always stock Android. A catalog entry only chooses
 * the hardware profile (screen size, pixels, density) and the look.
 *
 * - Pixel entries use the SDK's own profiles. The newest Pixel ids differ
 *   between SDK versions, so each entry lists ids newest first and the brain
 *   takes the first one this SDK has (`resolveAndroidCatalogProfile`).
 * - Other brands use a profile ADE writes (`ade_<model>`) into the user's own
 *   `devices.xml`, with the screen size, resolution and density from the
 *   spec sheet. ADE never edits SDK files.
 *
 * Plain data and pure functions only: no Node and no DOM, so every process
 * can import it.
 */

export type AndroidCatalogBrand = "google" | "samsung" | "oneplus" | "nothing";

export type AndroidCatalogFormFactor = "phone" | "foldable" | "tablet" | "wear";

/** One body colour, with the maker's own marketing name. */
export type AndroidCatalogColor = {
  /** Stable id, recorded on the AVD (`ade.color`). */
  id: string;
  /** The marketing name ("Obsidian", "Icyblue"). */
  name: string;
  /** The body material colour, `#rrggbb`. */
  body: string;
  /** The frame and button colour, `#rrggbb`. */
  frame: string;
};

/**
 * The shape of the procedural body, for an entry with no model file (and for
 * the tile still while a model loads). Sizes are in millimetres, from the
 * spec sheet; the body is drawn to scale.
 */
export type AndroidCatalogBodyShape = {
  widthMm: number;
  heightMm: number;
  depthMm: number;
  /** Corner radius of the body outline. */
  cornerMm: number;
  /** The black border around the screen. */
  bezelMm: number;
  /** The rear camera: Pixel's full-width bar, a corner island, or none. */
  rearCamera: "bar" | "island" | "triple-vertical" | "none";
  /** The front camera: a centred punch hole, or none (a watch). */
  frontCamera: "punch" | "none";
  /** A round body (a watch). */
  round?: boolean;
};

/** A hardware profile ADE writes for a non-Pixel entry (`<d:device>` in `devices.xml`). */
export type AndroidAdeProfileSpec = {
  /** `ade_<model>`. The profile reader marks `ade_*` ids as origin `ade`. */
  id: string;
  name: string;
  manufacturer: string;
  diagonalInches: number;
  widthPx: number;
  heightPx: number;
  /**
   * The Android density in dpi. Only the values Android Studio's device schema
   * accepts (`420`, `450`, `480`, `560`, `600`, `640`, …), so Studio still reads
   * the user's `devices.xml` after ADE adds to it.
   */
  density: number;
  ramMb: number;
  /** The folded (cover) screen of a foldable, in pixels. */
  folded?: { widthPx: number; heightPx: number; diagonalInches: number } | null;
};

export type AndroidCatalogEntry = {
  /** Stable id, recorded on the AVD (`ade.catalogId`). */
  id: string;
  name: string;
  brand: AndroidCatalogBrand;
  formFactor: AndroidCatalogFormFactor;
  /**
   * SDK profile ids to try, newest first. The first one this SDK has wins.
   * Empty for an entry with an `adeProfile`.
   */
  sdkProfileIds: readonly string[];
  /** The profile ADE writes, for an entry the SDK has no profile for. */
  adeProfile: AndroidAdeProfileSpec | null;
  /** The real screen, for the tile's size line. */
  screen: { inches: number; widthPx: number; heightPx: number };
  /** A bundled GLB (`assets/android-device-models/<model>.glb`), or null for the procedural body. */
  model: string | null;
  body: AndroidCatalogBodyShape;
  /** First colour = the default. */
  colors: readonly AndroidCatalogColor[];
};

const color = (id: string, name: string, body: string, frame: string): AndroidCatalogColor => ({ id, name, body, frame });

/**
 * The first set (plan §7.1). Specs are the makers' spec sheets; densities are
 * the nearest value Android Studio's schema accepts.
 */
export const ANDROID_DEVICE_CATALOG: readonly AndroidCatalogEntry[] = [
  {
    id: "pixel-10",
    name: "Pixel 10",
    brand: "google",
    formFactor: "phone",
    sdkProfileIds: ["pixel_10", "pixel_9", "pixel_8"],
    adeProfile: null,
    screen: { inches: 6.3, widthPx: 1080, heightPx: 2424 },
    model: null,
    body: { widthMm: 72, heightMm: 152.8, depthMm: 8.6, cornerMm: 11, bezelMm: 1.9, rearCamera: "bar", frontCamera: "punch" },
    colors: [
      color("obsidian", "Obsidian", "#1d1f22", "#2a2c30"),
      color("frost", "Frost", "#d9e3ea", "#c3ccd3"),
      color("indigo", "Indigo", "#3d4a7a", "#4a5687"),
      color("lemongrass", "Lemongrass", "#dde3a2", "#c9cf8f"),
    ],
  },
  {
    id: "pixel-10-pro",
    name: "Pixel 10 Pro",
    brand: "google",
    formFactor: "phone",
    sdkProfileIds: ["pixel_10_pro", "pixel_9_pro", "pixel_8_pro"],
    adeProfile: null,
    screen: { inches: 6.3, widthPx: 1280, heightPx: 2856 },
    model: null,
    body: { widthMm: 72, heightMm: 152.8, depthMm: 8.6, cornerMm: 11, bezelMm: 1.6, rearCamera: "bar", frontCamera: "punch" },
    colors: [
      color("obsidian", "Obsidian", "#1c1d1f", "#3a3b3e"),
      color("porcelain", "Porcelain", "#ece6dc", "#d6cfc3"),
      color("moonstone", "Moonstone", "#7d8a99", "#8f9aa6"),
      color("jade", "Jade", "#c9dccb", "#b5c9b8"),
    ],
  },
  {
    id: "pixel-10-pro-fold",
    name: "Pixel 10 Pro Fold",
    brand: "google",
    formFactor: "foldable",
    sdkProfileIds: ["pixel_10_pro_fold", "pixel_9_pro_fold", "pixel_fold"],
    adeProfile: null,
    // The inner screen: the one an unfolded emulator shows.
    screen: { inches: 8, widthPx: 2076, heightPx: 2152 },
    model: null,
    body: { widthMm: 155.2, heightMm: 154.9, depthMm: 5.2, cornerMm: 9, bezelMm: 2.6, rearCamera: "bar", frontCamera: "punch" },
    colors: [
      color("moonstone", "Moonstone", "#7d8a99", "#8f9aa6"),
      color("jade", "Jade", "#c9dccb", "#b5c9b8"),
    ],
  },
  {
    id: "pixel-tablet",
    name: "Pixel Tablet",
    brand: "google",
    formFactor: "tablet",
    sdkProfileIds: ["pixel_tablet"],
    adeProfile: null,
    screen: { inches: 10.95, widthPx: 2560, heightPx: 1600 },
    model: null,
    // Spec sheet sizes, given portrait (the body draws portrait and turns).
    body: { widthMm: 169, heightMm: 258, depthMm: 8.1, cornerMm: 14, bezelMm: 12, rearCamera: "none", frontCamera: "punch" },
    colors: [
      color("porcelain", "Porcelain", "#ece6dc", "#d6cfc3"),
      color("hazel", "Hazel", "#5f655c", "#6c7268"),
    ],
  },
  {
    id: "pixel-watch",
    name: "Pixel Watch",
    brand: "google",
    formFactor: "wear",
    sdkProfileIds: ["wearos_large_round", "wearos_small_round"],
    adeProfile: null,
    screen: { inches: 1.4, widthPx: 456, heightPx: 456 },
    model: null,
    body: { widthMm: 45, heightMm: 45, depthMm: 12.3, cornerMm: 22.5, bezelMm: 3.4, rearCamera: "none", frontCamera: "none", round: true },
    colors: [
      color("obsidian", "Matte Black", "#1d1f22", "#2a2c30"),
      color("silver", "Polished Silver", "#d4d6d8", "#c0c2c4"),
    ],
  },
  {
    id: "galaxy-s25",
    name: "Galaxy S25",
    brand: "samsung",
    formFactor: "phone",
    sdkProfileIds: [],
    adeProfile: {
      id: "ade_galaxy_s25",
      name: "Galaxy S25",
      manufacturer: "Samsung",
      diagonalInches: 6.2,
      widthPx: 1080,
      heightPx: 2340,
      density: 420,
      ramMb: 12288,
    },
    screen: { inches: 6.2, widthPx: 1080, heightPx: 2340 },
    model: null,
    body: { widthMm: 70.5, heightMm: 146.9, depthMm: 7.2, cornerMm: 9.5, bezelMm: 1.6, rearCamera: "triple-vertical", frontCamera: "punch" },
    colors: [
      color("icyblue", "Icyblue", "#bcd3e6", "#a9c0d3"),
      color("navy", "Navy", "#2a3550", "#36415c"),
      color("mint", "Mint", "#cfe3d6", "#bbd0c3"),
      color("silver-shadow", "Silver Shadow", "#c9cbce", "#b4b6b9"),
    ],
  },
  {
    id: "galaxy-s25-ultra",
    name: "Galaxy S25 Ultra",
    brand: "samsung",
    formFactor: "phone",
    sdkProfileIds: [],
    adeProfile: {
      id: "ade_galaxy_s25_ultra",
      name: "Galaxy S25 Ultra",
      manufacturer: "Samsung",
      diagonalInches: 6.9,
      widthPx: 1440,
      heightPx: 3120,
      density: 560,
      ramMb: 12288,
    },
    screen: { inches: 6.9, widthPx: 1440, heightPx: 3120 },
    model: null,
    body: { widthMm: 77.6, heightMm: 162.8, depthMm: 8.2, cornerMm: 6.5, bezelMm: 1.5, rearCamera: "triple-vertical", frontCamera: "punch" },
    colors: [
      color("titanium-silverblue", "Titanium Silverblue", "#9fb0c2", "#b7c3cf"),
      color("titanium-black", "Titanium Black", "#2b2c2e", "#3d3e41"),
      color("titanium-whitesilver", "Titanium Whitesilver", "#e3e3e1", "#cfcfcd"),
      color("titanium-gray", "Titanium Gray", "#8a8c8e", "#9b9da0"),
    ],
  },
  {
    id: "galaxy-z-fold7",
    name: "Galaxy Z Fold7",
    brand: "samsung",
    formFactor: "foldable",
    sdkProfileIds: [],
    adeProfile: {
      id: "ade_galaxy_z_fold7",
      name: "Galaxy Z Fold7",
      manufacturer: "Samsung",
      diagonalInches: 8,
      widthPx: 1968,
      heightPx: 2184,
      density: 420,
      ramMb: 12288,
      folded: { widthPx: 1080, heightPx: 2520, diagonalInches: 6.5 },
    },
    screen: { inches: 8, widthPx: 1968, heightPx: 2184 },
    model: null,
    body: { widthMm: 143.2, heightMm: 158.4, depthMm: 4.2, cornerMm: 7, bezelMm: 2.4, rearCamera: "triple-vertical", frontCamera: "punch" },
    colors: [
      color("blue-shadow", "Blue Shadow", "#3e4f6b", "#4b5c78"),
      color("silver-shadow", "Silver Shadow", "#c9cbce", "#b4b6b9"),
      color("jetblack", "Jetblack", "#1b1c1e", "#2c2d30"),
    ],
  },
  {
    id: "oneplus-13",
    name: "OnePlus 13",
    brand: "oneplus",
    formFactor: "phone",
    sdkProfileIds: [],
    adeProfile: {
      id: "ade_oneplus_13",
      name: "OnePlus 13",
      manufacturer: "OnePlus",
      diagonalInches: 6.82,
      widthPx: 1440,
      heightPx: 3168,
      density: 560,
      ramMb: 12288,
    },
    screen: { inches: 6.82, widthPx: 1440, heightPx: 3168 },
    model: null,
    body: { widthMm: 76.5, heightMm: 162.9, depthMm: 8.9, cornerMm: 10, bezelMm: 1.6, rearCamera: "island", frontCamera: "punch" },
    colors: [
      color("midnight-ocean", "Midnight Ocean", "#1f2a44", "#2b3650"),
      color("black-eclipse", "Black Eclipse", "#1a1a1b", "#2b2b2d"),
      color("arctic-dawn", "Arctic Dawn", "#e6e7ea", "#d1d2d6"),
    ],
  },
  {
    id: "nothing-phone-3",
    name: "Nothing Phone (3)",
    brand: "nothing",
    formFactor: "phone",
    sdkProfileIds: [],
    adeProfile: {
      id: "ade_nothing_phone_3",
      name: "Nothing Phone (3)",
      manufacturer: "Nothing",
      diagonalInches: 6.67,
      widthPx: 1260,
      heightPx: 2800,
      density: 480,
      ramMb: 12288,
    },
    screen: { inches: 6.67, widthPx: 1260, heightPx: 2800 },
    model: null,
    body: { widthMm: 75.6, heightMm: 160.6, depthMm: 9, cornerMm: 9, bezelMm: 1.7, rearCamera: "island", frontCamera: "punch" },
    colors: [
      color("white", "White", "#e9e9e7", "#d4d4d2"),
      color("black", "Black", "#1b1b1c", "#2c2c2e"),
    ],
  },
];

export const ANDROID_CATALOG_BRAND_NAMES: Readonly<Record<AndroidCatalogBrand, string>> = {
  google: "Google",
  samsung: "Samsung",
  oneplus: "OnePlus",
  nothing: "Nothing",
};

export function androidCatalogEntry(id: string | null | undefined): AndroidCatalogEntry | null {
  if (!id) return null;
  return ANDROID_DEVICE_CATALOG.find((entry) => entry.id === id) ?? null;
}

/** The entry's colour by id, else its first (default) colour. */
export function androidCatalogColor(entry: AndroidCatalogEntry, colorId: string | null | undefined): AndroidCatalogColor {
  return entry.colors.find((entry) => entry.id === colorId) ?? entry.colors[0]!;
}

/** `6.3″ · 1080 × 2424`: the tile's size line. */
export function androidCatalogScreenLine(entry: Pick<AndroidCatalogEntry, "screen">): string {
  const inches = Number.isInteger(entry.screen.inches) ? String(entry.screen.inches) : entry.screen.inches.toFixed(entry.screen.inches * 10 % 1 ? 2 : 1);
  return `${inches}″ · ${entry.screen.widthPx} × ${entry.screen.heightPx}`;
}

/**
 * The profile an entry uses on this machine: its ADE profile, or the first of
 * its SDK ids that this SDK has. `fallback` is true when that is not the
 * entry's own (newest) id, so the tile can say which profile it uses.
 */
export function resolveAndroidCatalogProfile(
  entry: AndroidCatalogEntry,
  availableProfileIds: ReadonlySet<string> | readonly string[],
): { profileId: string; fallback: boolean; ade: boolean } | null {
  if (entry.adeProfile) return { profileId: entry.adeProfile.id, fallback: false, ade: true };
  const available = availableProfileIds instanceof Set ? availableProfileIds : new Set(availableProfileIds as readonly string[]);
  const index = entry.sdkProfileIds.findIndex((id) => available.has(id));
  if (index < 0) return null;
  return { profileId: entry.sdkProfileIds[index]!, fallback: index > 0, ade: false };
}

/** The catalog entry an AVD was made from, by its marker or, failing that, its profile id. */
export function androidCatalogEntryForAvd(avd: { catalogId?: string | null; profileId?: string | null } | null | undefined): AndroidCatalogEntry | null {
  if (!avd) return null;
  const byMarker = androidCatalogEntry(avd.catalogId ?? null);
  if (byMarker) return byMarker;
  const profileId = avd.profileId ?? null;
  if (!profileId) return null;
  return ANDROID_DEVICE_CATALOG.find((entry) => entry.adeProfile?.id === profileId || entry.sdkProfileIds[0] === profileId) ?? null;
}

/** Valid ids for `--catalog`. */
export const ANDROID_CATALOG_IDS: readonly string[] = ANDROID_DEVICE_CATALOG.map((entry) => entry.id);
