/* @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { SCENE_DEFAULTS_REVISION, normalizeScenePreferences } from "./scenePreferences";

afterEach(() => { delete window.__adeWebClient; });

// What clients stored before the reset to sharp, per-screen pictures: the
// first shuffle, then the plain background #1883 made the default.
const REVISION_1_SHUFFLE = {
  mode: "shuffle",
  imageId: null,
  showImage: true,
  texture: "dots",
  dim: 12,
  matchTheme: true,
  shuffleEvery: "wake",
  shuffleExclude: [],
  choiceMade: false,
  defaultsRevision: 1,
};
const REVISION_1_PLAIN = { ...REVISION_1_SHUFFLE, mode: "plain", dim: 30 };
const CURRENT = { ...REVISION_1_SHUFFLE, texture: "none", dim: 30, defaultsRevision: SCENE_DEFAULTS_REVISION };

it.each([
  // Nothing stored, or anything stored before the reset: this client's default, no pick.
  [true, null, "plain", true, false],
  [false, null, "shuffle", true, false],
  [true, REVISION_1_SHUFFLE, "plain", true, false],
  [false, REVISION_1_SHUFFLE, "shuffle", true, false],
  [false, REVISION_1_PLAIN, "shuffle", true, false],
  [false, { ...REVISION_1_PLAIN, choiceMade: true }, "shuffle", true, false],
  [false, { ...REVISION_1_SHUFFLE, mode: "gradient", choiceMade: true }, "shuffle", true, false],
  [false, { ...REVISION_1_SHUFFLE, mode: "image", imageId: "ade:snow-range", showImage: false, choiceMade: true }, "shuffle", true, false],
  // Chosen since the reset: the choice stands.
  [true, { ...CURRENT, choiceMade: true }, "shuffle", true, true],
  [false, { ...CURRENT, mode: "plain", choiceMade: true }, "plain", true, true],
  [false, { ...CURRENT, mode: "gradient", choiceMade: true }, "gradient", true, true],
  [false, { ...CURRENT, showImage: false }, "shuffle", false, false],
  [true, { ...CURRENT, mode: "image", imageId: "ade:snow-range", choiceMade: true }, "image", true, true],
  [false, { ...CURRENT, mode: "image", imageId: "user:abc", choiceMade: true }, "image", true, true],
  // A pick of a picture ADE stopped shipping shuffles instead of showing the gradient.
  [false, { ...CURRENT, mode: "image", imageId: "ade:castle-lake", choiceMade: true }, "shuffle", true, true],
])("reads web=%s stored %j as mode %s (showImage %s, choiceMade %s)", (web, stored, mode, showImage, choiceMade) => {
  window.__adeWebClient = web;
  const normalized = normalizeScenePreferences(stored ?? undefined);
  expect(normalized.mode).toBe(mode);
  expect(normalized.showImage).toBe(showImage);
  expect(normalized.choiceMade).toBe(choiceMade);
  expect(normalized.defaultsRevision).toBe(SCENE_DEFAULTS_REVISION);
});
