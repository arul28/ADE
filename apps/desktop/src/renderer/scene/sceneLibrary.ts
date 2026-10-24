/**
 * The pictures ADE ships as scenes. Files live in `public/scenes/`, with a
 * small copy in `public/scenes/thumbs/` for Settings tiles; ids are prefixed
 * `ade:` so they can never collide with a user's own (`user:`).
 *
 * `position` is the CSS background-position that keeps the subject in frame
 * when the window's aspect ratio crops the picture. `width` and `height` are
 * the file's pixels, so `sceneFitsScreen` can tell which pictures stay sharp
 * on the screen in use.
 */

export type BundledScene = {
  id: `ade:${string}`;
  name: string;
  src: string;
  thumb: string;
  position: string;
  width: number;
  height: number;
};

function scene(file: string, name: string, width: number, height: number, position = "50% 50%"): BundledScene {
  return { id: `ade:${file}`, name, src: `./scenes/${file}.jpg`, thumb: `./scenes/thumbs/${file}.jpg`, position, width, height };
}

export const BUNDLED_SCENES: readonly BundledScene[] = [
  // Ultrawide (32:9).
  scene("night-lake", "Night lake", 5120, 1440),
  scene("snow-range", "Snow range", 5120, 1440),
  scene("dark-castle", "Dark castle", 5120, 1440),
  scene("rooftop-city", "Rooftop city", 5120, 1440),
  scene("tree-village", "Tree village", 5120, 1440),
  // Standard (16:10).
  scene("mountain-vista", "Mountain vista", 3840, 2400),
  scene("alpine-chalet", "Alpine chalet", 3840, 2400),
  scene("blossom-geese", "Blossom geese", 3840, 2400),
  scene("bay-city", "Bay city", 3840, 2400),
  scene("neon-city", "Neon city", 3840, 2400),
  scene("star-destroyer", "Star destroyer", 3840, 2400),
  // The first set. Small, so they only count as a fit on small screens.
  scene("fuji-street", "Fuji street", 2140, 1200, "50% 45%"),
  scene("alpine-path", "Alpine path", 1308, 736, "50% 40%"),
  scene("castle-lake", "Castle lake", 1256, 572, "60% 45%"),
  scene("cherry-blossom", "Cherry blossom", 1472, 736, "60% 40%"),
  scene("storm-field", "Storm field", 1595, 736, "55% 45%"),
  scene("midnight-city", "Midnight city", 1330, 736, "50% 40%"),
  scene("web-swing", "Web swing", 1308, 736),
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

/** The device pixels of the screen this window is on. */
export function readScreenPixels(): ScreenPixels {
  const ratio = window.devicePixelRatio || 1;
  return { width: Math.round(window.screen.width * ratio), height: Math.round(window.screen.height * ratio) };
}
