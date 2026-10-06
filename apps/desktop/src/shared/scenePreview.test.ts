import { describe, expect, it } from "vitest";

import { SCENE_LIMITS } from "./chatScene";
import {
  lintSceneSource,
  scenePreviewTheme,
  sceneSourceFromInput,
  SCENE_PREVIEW_MAX_SOURCE_BYTES,
} from "./scenePreview";

/**
 * `ade scene preview` catches the mistakes a scene's policy turns into silent
 * blanks, by reading the source. Each row is a scene that would draw nothing
 * and the phrase in the one problem it must produce.
 */
describe("lintSceneSource", () => {
  it.each([
    ["a script with a src", '<script src="chart.js"></script>', "never loads"],
    ["a remote image", '<img src="https://example.com/a.png">', "Remote URLs"],
    ["a root-relative stylesheet href", '<link rel="stylesheet" href="//cdn.example/x.css">', "Remote URLs"],
    ["a css url()", "<style>p{background:url(//example.com/b.png)}</style>", "Remote URLs"],
    ["fetch", "fetch('/api').then(r => r.json())", "fetch / XHR / WebSocket"],
    ["XMLHttpRequest", "var x = new XMLHttpRequest();", "fetch / XHR / WebSocket"],
    ["a WebSocket", "new WebSocket('wss://example.com')", "fetch / XHR / WebSocket"],
    ["localStorage", "localStorage.setItem('a', '1')", "Storage and cookies"],
    ["document.cookie", "document.cookie = 'a=1'", "Storage and cookies"],
    ["alert", "alert('hi')", "alert/confirm/prompt"],
    ["a shadowing top", "var top = 3;", 'named "top"'],
    ["a nested iframe", '<iframe src="x.html"></iframe>', "Nested frames and plugins"],
  ])("flags %s", (_label, source, message) => {
    const problems = lintSceneSource(source);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.kind).toBe("lint");
    expect(problems[0]!.message).toContain(message);
  });

  it("says nothing about a scene that uses only allowed features", () => {
    expect(lintSceneSource('<div class="card"><p>3 merged</p></div>')).toEqual([]);
    expect(lintSceneSource("<style>p{color:red}</style><p>x</p>")).toEqual([]);
  });

  /**
   * The byte cap is the chat's own: over it the fence renders as code, not a
   * view, so the preview reports it rather than drawing something the reader
   * will never see.
   */
  it("reports an over-cap scene, and warns near the cap", () => {
    const over = lintSceneSource("x".repeat(SCENE_LIMITS.maxSourceBytes + 1));
    expect(over).toHaveLength(1);
    expect(over[0]!.message).toContain(`over ${SCENE_LIMITS.maxSourceBytes}`);

    const near = lintSceneSource("x".repeat(Math.ceil(SCENE_LIMITS.maxSourceBytes * 0.85)));
    expect(near).toHaveLength(1);
    expect(near[0]!.message).toContain("near");
  });

  /** The preview accepts a whole fence pasted around a scene; the chat cap still applies to its body. */
  it("accepts a fence for a source that is over the chat cap so it can be reported", () => {
    expect(SCENE_PREVIEW_MAX_SOURCE_BYTES).toBeGreaterThan(SCENE_LIMITS.maxSourceBytes);
  });
});

describe("sceneSourceFromInput", () => {
  it("returns a bare body unchanged", () => {
    expect(sceneSourceFromInput("<p>x</p>")).toBe("<p>x</p>");
  });

  it.each([
    ["a backtick fence", '```scene\n<div id="n">3</div>\n```', '<div id="n">3</div>'],
    ["a tilde fence", '~~~~scene\n<div id="n">3</div>\n~~~~', '<div id="n">3</div>'],
    ["a fence with a title in the info string", '```scene title="Chart"\n<p>x</p>\n```', "<p>x</p>"],
  ])("unwraps %s to its body", (_label, input, body) => {
    expect(sceneSourceFromInput(input)).toBe(body);
  });

  it("leaves a non-scene fence alone", () => {
    expect(sceneSourceFromInput("```ts\nconst a = 1;\n```")).toBe("```ts\nconst a = 1;\n```");
  });
});

describe("scenePreviewTheme", () => {
  it("previews in the requested theme and defaults to dark", () => {
    expect(scenePreviewTheme("light").scheme).toBe("light");
    expect(scenePreviewTheme("dark").scheme).toBe("dark");
    expect(scenePreviewTheme(undefined).scheme).toBe("dark");
  });
});
