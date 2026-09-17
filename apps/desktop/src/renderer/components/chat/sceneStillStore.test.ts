/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";

import {
  readCallStills,
  readSceneStill,
  rememberCallStill,
  rememberSceneStill,
  resetSceneStillsForTest,
  sceneStillSrc,
} from "./sceneStillStore";

/**
 * The index behind "a scene always leaves a picture".
 *
 * Two layers with different lifetimes — the data URL this window captured and
 * the artifact record on disk — so the interesting cases are the ones where one
 * of them is missing: a reopened window has only the record, and a browser
 * preview with no capture route has only the data URL.
 */

const record = (uri: string, title = "Merged PRs") => ({ uri, artifactId: "a1", title });

afterEach(() => { resetSceneStillsForTest(); });

describe("scene stills", () => {
  it("keeps both halves of a still and prefers the pixels already in memory", () => {
    rememberSceneStill("row-1", { dataUrl: "data:image/png;base64,AAA" });
    rememberSceneStill("row-1", { record: record(".ade/artifacts/computer-use/a.png") });
    const still = readSceneStill("row-1");
    expect(still?.dataUrl).toBe("data:image/png;base64,AAA");
    expect(still?.record?.uri).toBe(".ade/artifacts/computer-use/a.png");
    expect(sceneStillSrc(still)).toBe("data:image/png;base64,AAA");
  });

  it("survives the window: a fresh store reads the record back off the index", () => {
    rememberSceneStill("row-2", {
      dataUrl: "data:image/png;base64,BBB",
      record: record(".ade/artifacts/computer-use/b.png"),
    });
    // What a reopened chat looks like: the in-memory half is gone, the
    // persisted half is not.
    const persisted = localStorage.getItem("ade.scene.stills.v1");
    resetSceneStillsForTest();
    localStorage.setItem("ade.scene.stills.v1", persisted ?? "{}");

    const still = readSceneStill("row-2");
    expect(still?.dataUrl).toBeNull();
    expect(sceneStillSrc(still)).toBe("ade-artifact://project/.ade/artifacts/computer-use/b.png");
  });

  it("has nothing to say about a scene it has never seen", () => {
    expect(readSceneStill("row-missing")).toBeNull();
    expect(readSceneStill(null)).toBeNull();
    expect(sceneStillSrc(null)).toBeNull();
  });

  it("refuses an absolute path as an image source rather than drawing a broken tile", () => {
    // `ade-artifact://project/` resolves PROJECT-RELATIVE uris. An absolute one
    // is a still from somewhere this window cannot serve.
    expect(sceneStillSrc({ uri: "/tmp/elsewhere.png", artifactId: null, title: "x" })).toBeNull();
    expect(sceneStillSrc({ uri: "https://example.com/x.png", artifactId: null, title: "x" })).toBeNull();
  });

  it("collects a call's stills in order, once each", () => {
    rememberCallStill("call-1", record(".ade/artifacts/computer-use/1.png", "First"));
    rememberCallStill("call-1", record(".ade/artifacts/computer-use/2.png", "Second"));
    // The same view re-settling is the same picture, not a second one.
    rememberCallStill("call-1", record(".ade/artifacts/computer-use/1.png", "First"));
    expect(readCallStills("call-1").map((entry) => entry.title)).toEqual(["First", "Second"]);
    expect(readCallStills("call-2")).toEqual([]);
  });

  it("keeps the last few views of a long call, not all of them", () => {
    for (let index = 0; index < 12; index += 1) {
      rememberCallStill("call-long", record(`.ade/artifacts/computer-use/${index}.png`, `V${index}`));
    }
    const kept = readCallStills("call-long");
    expect(kept).toHaveLength(8);
    // The last thing drawn is what the user was looking at when they hung up.
    expect(kept.at(-1)?.title).toBe("V11");
  });
});
