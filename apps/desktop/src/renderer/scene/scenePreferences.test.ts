/* @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { SCENE_DEFAULTS_REVISION, normalizeScenePreferences } from "./scenePreferences";

afterEach(() => { delete window.__adeWebClient; });

// What clients stored before today's defaults: the first shuffle, then the
// plain background #1883 made the default.
const OLD_SHUFFLE_DEFAULT = {
  mode: "shuffle",
  imageId: null,
  showImage: true,
  texture: "dots",
  dim: 12,
  matchTheme: true,
  shuffleEvery: "wake",
  shuffleExclude: [],
  choiceMade: false,
  defaultsRevision: SCENE_DEFAULTS_REVISION,
};
const OLD_PLAIN_DEFAULT = { ...OLD_SHUFFLE_DEFAULT, mode: "plain", dim: 30 };

it.each([
  [true, null, undefined, "plain", true],
  [false, null, undefined, "shuffle", true],
  [true, OLD_SHUFFLE_DEFAULT, {}, "plain", true],
  [false, OLD_SHUFFLE_DEFAULT, {}, "shuffle", true],
  [true, OLD_PLAIN_DEFAULT, {}, "plain", true],
  [false, OLD_PLAIN_DEFAULT, {}, "shuffle", true],
  [false, OLD_PLAIN_DEFAULT, { choiceMade: true }, "plain", true],
  [true, OLD_SHUFFLE_DEFAULT, { choiceMade: true }, "shuffle", true],
  [false, OLD_SHUFFLE_DEFAULT, { choiceMade: true }, "shuffle", true],
  [true, OLD_SHUFFLE_DEFAULT, { texture: "grain" }, "shuffle", true],
  [false, OLD_SHUFFLE_DEFAULT, { dim: 20 }, "shuffle", true],
  [true, OLD_SHUFFLE_DEFAULT, { matchTheme: false }, "shuffle", true],
  [false, OLD_SHUFFLE_DEFAULT, { showImage: false }, "shuffle", false],
  [true, OLD_SHUFFLE_DEFAULT, { mode: "image", imageId: "ade:lake", choiceMade: true }, "image", true],
])("keeps a chosen scene on web=%s from %j with %j", (web, stored, preference, mode, showImage) => {
  window.__adeWebClient = web;
  const normalized = normalizeScenePreferences(stored === null ? undefined : { ...stored, ...preference });
  expect(normalized.mode).toBe(mode);
  expect(normalized.showImage).toBe(showImage);
  expect(normalized.choiceMade).toBe((preference as { choiceMade?: boolean } | undefined)?.choiceMade === true);
});
