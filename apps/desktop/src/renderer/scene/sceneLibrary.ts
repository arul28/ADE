/**
 * The pictures ADE ships as scenes. Files live in `public/scenes/`, with a
 * small copy in `public/scenes/thumbs/` for Settings tiles and colour
 * sampling; ids are prefixed `ade:` so they can never collide with a user's
 * own (`user:`).
 *
 * `position` is the CSS background-position that keeps the subject in frame
 * when the window's aspect ratio crops the picture. `width` and `height` are
 * the file's pixels, so `sceneFitsScreen` can tell which pictures stay sharp
 * on the screen in use. `copies` are smaller files of the same picture, in
 * `public/scenes/<width>/`: a screen loads the smallest one that covers it
 * (`sceneSrcForScreen`).
 */

import { isCssZoomedBrowserSurface } from "../lib/webClientMode";

export type BundledScene = {
  id: `ade:${string}`;
  name: string;
  src: string;
  thumb: string;
  position: string;
  width: number;
  height: number;
  /** Smaller copies of the same picture, smallest first. */
  copies?: readonly SceneCopy[];
};

export type SceneCopy = { src: string; width: number; height: number };

function scene(file: string, name: string, width: number, height: number, position = "50% 50%"): BundledScene {
  return { id: `ade:${file}`, name, src: `./scenes/${file}.jpg`, thumb: `./scenes/thumbs/${file}.jpg`, position, width, height };
}

/**
 * The copies of a 16:10 picture, each the smallest that covers a group of
 * common screens without stretching (device pixels):
 * - 1920×1200: 1080p and 1920×1200 screens.
 * - 2560×1600: 1440p screens, and 2560×1600 laptops.
 * - 3200×2000: MacBook Air 13" and 15" (2560×1664, 2880×1864) and MacBook
 *   Pro 14" (3024×1964). 3072×1920 would miss the 14" by 44 rows.
 * Larger screens (MacBook Pro 16", 4K, 5K) load the full 3840×2400 file.
 */
const STANDARD_COPY_SIZES = [
  [1920, 1200],
  [2560, 1600],
  [3200, 2000],
] as const;

function withCopies(picture: BundledScene): BundledScene {
  const file = picture.id.slice("ade:".length);
  return {
    ...picture,
    copies: STANDARD_COPY_SIZES.map(([width, height]) => ({ src: `./scenes/${width}/${file}.jpg`, width, height })),
  };
}

export const BUNDLED_SCENES: readonly BundledScene[] = [
  // Ultrawide (32:9).
  scene("night-lake", "Night lake", 5120, 1440),
  scene("snow-range", "Snow range", 5120, 1440),
  scene("dark-castle", "Dark castle", 5120, 1440),
  scene("rooftop-city", "Rooftop city", 5120, 1440),
  scene("tree-village", "Tree village", 5120, 1440),
  // Standard (16:10).
  withCopies(scene("mountain-vista", "Mountain vista", 3840, 2400)),
  withCopies(scene("alpine-chalet", "Alpine chalet", 3840, 2400)),
  withCopies(scene("blossom-geese", "Blossom geese", 3840, 2400)),
  withCopies(scene("bay-city", "Bay city", 3840, 2400)),
  withCopies(scene("neon-city", "Neon city", 3840, 2400)),
  withCopies(scene("star-destroyer", "Star destroyer", 3840, 2400)),
];

export function findBundledScene(id: string | null | undefined): BundledScene | null {
  if (!id) return null;
  return BUNDLED_SCENES.find((scene) => scene.id === id) ?? null;
}

export function isUserSceneId(id: string | null | undefined): id is `user:${string}` {
  return typeof id === "string" && id.startsWith("user:");
}

export type ScreenPixels = { width: number; height: number };

/** How far a picture may be stretched before it reads as soft. */
const MAX_UPSCALE = 1.35;
/** The least of a picture's shape a crop may keep (32:9 on a 16:10 screen keeps 45%). */
const MIN_SHAPE_KEPT = 0.6;

/**
 * Whether a picture looks good filling this screen: it covers it without
 * stretching past `MAX_UPSCALE`, and its shape is close enough that the crop
 * keeps most of it. A 32:9 picture fits an ultrawide, a 16:10 one a laptop.
 */
export function sceneFitsScreen(picture: ScreenPixels, screen: ScreenPixels): boolean {
  if (picture.width <= 0 || picture.height <= 0 || screen.width <= 0 || screen.height <= 0) return false;
  const upscale = Math.max(screen.width / picture.width, screen.height / picture.height);
  const pictureShape = picture.width / picture.height;
  const screenShape = screen.width / screen.height;
  const kept = Math.min(pictureShape, screenShape) / Math.max(pictureShape, screenShape);
  return upscale <= MAX_UPSCALE && kept >= MIN_SHAPE_KEPT;
}

/**
 * The file to draw on this screen: the smallest copy that covers the screen
 * without stretching, else the full picture. A decoded picture costs memory
 * for every pixel, so a screen does not pay for pixels it cannot show. Every
 * copy has the picture's shape, so the crop and position stay the same.
 */
export function sceneSrcForScreen(picture: BundledScene, screen: ScreenPixels): string {
  const copy = picture.copies?.find((candidate) => screen.width <= candidate.width && screen.height <= candidate.height);
  return copy ? copy.src : picture.src;
}

/**
 * A copy is made only when it has at most this share of the picture's width:
 * a copy that saves less is not worth its decode and its disk space.
 */
const MAX_COPY_SCALE = 0.85;

/**
 * The size of a user picture's copy for this screen: the picture scaled down,
 * shape kept, until it just covers the screen. Null when the picture is not
 * much larger than that, and the picture itself is drawn.
 */
export function screenCopySize(picture: ScreenPixels, screen: ScreenPixels): ScreenPixels | null {
  if (picture.width <= 0 || picture.height <= 0 || screen.width <= 0 || screen.height <= 0) return null;
  const scale = Math.max(screen.width / picture.width, screen.height / picture.height);
  if (scale > MAX_COPY_SCALE) return null;
  return {
    width: Math.max(screen.width, Math.ceil(picture.width * scale)),
    height: Math.max(screen.height, Math.ceil(picture.height * scale)),
  };
}

/**
 * The device pixels of the screen this window is on. `devicePixelRatio`
 * includes the app's own zoom (ADE opens at 110%) while `screen` does not, so
 * the zoom is divided back out: zooming the UI does not make the screen bigger.
 */
export function readScreenPixels(): ScreenPixels {
  const ratio = (window.devicePixelRatio || 1) / appZoomFactor();
  return { width: Math.round(window.screen.width * ratio), height: Math.round(window.screen.height * ratio) };
}

function appZoomFactor(): number {
  // The hosted web client and the browser preview zoom with CSS, which leaves
  // `devicePixelRatio` alone; only Electron's zoom is in it.
  if (isCssZoomedBrowserSurface()) return 1;
  const factor = window.ade?.zoom?.getFactor?.();
  return typeof factor === "number" && Number.isFinite(factor) && factor > 0 ? factor : 1;
}
