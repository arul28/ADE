/* @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { DEFAULT_SCENE_PREFERENCES, normalizeScenePreferences } from "./scenePreferences";

afterEach(() => { delete window.__adeWebClient; });

it.each([
  [true, undefined, "plain", true],
  [true, {}, "plain", true],
  [false, undefined, "shuffle", true],
  [false, {}, "shuffle", true],
  [true, { choiceMade: true }, "shuffle", true],
  [true, { texture: "grain" }, "shuffle", true],
  [true, { dim: 20 }, "shuffle", true],
  [true, { matchTheme: false }, "shuffle", true],
  [true, { showImage: false }, "shuffle", false],
  [true, { mode: "image", imageId: "ade:lake", choiceMade: true }, "image", true],
])("keeps a chosen scene on web=%s with %j", (web, preference, mode, showImage) => {
  window.__adeWebClient = web;
  const normalized = normalizeScenePreferences(preference === undefined ? undefined : { ...DEFAULT_SCENE_PREFERENCES, ...preference });
  expect(normalized.mode).toBe(mode);
  expect(normalized.showImage).toBe(showImage);
  expect(normalized.choiceMade).toBe((preference as { choiceMade?: boolean } | undefined)?.choiceMade === true);
});
