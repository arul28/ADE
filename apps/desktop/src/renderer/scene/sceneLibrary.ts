/**
 * The pictures ADE ships as scenes. Files live in `public/scenes/`; ids are
 * prefixed `ade:` so they can never collide with a user's own (`user:`).
 *
 * `position` is the CSS background-position that keeps the subject in frame
 * when the window's aspect ratio crops the picture.
 */

export type BundledScene = {
  id: `ade:${string}`;
  name: string;
  src: string;
  position: string;
};

export const BUNDLED_SCENES: readonly BundledScene[] = [
  { id: "ade:fuji-street", name: "Fuji street", src: "./scenes/fuji-street.jpg", position: "50% 45%" },
  { id: "ade:alpine-path", name: "Alpine path", src: "./scenes/alpine-path.jpg", position: "50% 40%" },
  { id: "ade:castle-lake", name: "Castle lake", src: "./scenes/castle-lake.jpg", position: "60% 45%" },
  { id: "ade:cherry-blossom", name: "Cherry blossom", src: "./scenes/cherry-blossom.jpg", position: "60% 40%" },
  { id: "ade:storm-field", name: "Storm field", src: "./scenes/storm-field.jpg", position: "55% 45%" },
  { id: "ade:midnight-city", name: "Midnight city", src: "./scenes/midnight-city.jpg", position: "50% 40%" },
  { id: "ade:web-swing", name: "Web swing", src: "./scenes/web-swing.jpg", position: "50% 50%" },
];

export function findBundledScene(id: string | null | undefined): BundledScene | null {
  if (!id) return null;
  return BUNDLED_SCENES.find((scene) => scene.id === id) ?? null;
}

export function isUserSceneId(id: string | null | undefined): id is `user:${string}` {
  return typeof id === "string" && id.startsWith("user:");
}
