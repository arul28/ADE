/**
 * The pictures ADE ships as scenes. Files live in `public/scenes/`, with a
 * small copy in `public/scenes/thumbs/` for Settings tiles and colour
 * sampling; ids are prefixed `ade:` so they can never collide with a user's
 * own (`user:`).
 *
 * `position` is the CSS background-position that keeps the subject in frame
 * when the window's aspect ratio crops the picture. `width` and `height` are
 * the file's pixels, so `sceneFitsScreen` can tell which pictures stay sharp
 * on the screen in use. `small` is a 2560×1600 copy in `public/scenes/2560/`
 * that a screen it covers loads instead (`sceneSrcForScreen`).
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
  small?: { src: string; width: number; height: number };
};

function scene(file: string, name: string, width: number, height: number, position = "50% 50%"): BundledScene {
  return { id: `ade:${file}`, name, src: `./scenes/${file}.jpg`, thumb: `./scenes/thumbs/${file}.jpg`, position, width, height };
}

function withSmallCopy(picture: BundledScene): BundledScene {
  const file = picture.id.slice("ade:".length);
  return { ...picture, small: { src: `./scenes/2560/${file}.jpg`, width: 2560, height: 1600 } };
}

export const BUNDLED_SCENES: readonly BundledScene[] = [
  // Ultrawide (32:9).
  scene("night-lake", "Night lake", 5120, 1440),
  scene("snow-range", "Snow range", 5120, 1440),
  scene("dark-castle", "Dark castle", 5120, 1440),
  scene("rooftop-city", "Rooftop city", 5120, 1440),
  scene("tree-village", "Tree village", 5120, 1440),
  // Standard (16:10).
  withSmallCopy(scene("mountain-vista", "Mountain vista", 3840, 2400)),
  withSmallCopy(scene("alpine-chalet", "Alpine chalet", 3840, 2400)),
  withSmallCopy(scene("blossom-geese", "Blossom geese", 3840, 2400)),
  withSmallCopy(scene("bay-city", "Bay city", 3840, 2400)),
  withSmallCopy(scene("neon-city", "Neon city", 3840, 2400)),
  withSmallCopy(scene("star-destroyer", "Star destroyer", 3840, 2400)),
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
 * The file to draw on this screen: the 2560×1600 copy when it covers the
 * screen without stretching (1080p, 1440p), else the full picture. A decoded
 * picture costs memory for every pixel, so a screen that cannot show 3840
 * pixels does not pay for them.
 */
export function sceneSrcForScreen(picture: BundledScene, screen: ScreenPixels): string {
  const small = picture.small;
  return small && screen.width <= small.width && screen.height <= small.height ? small.src : picture.src;
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
