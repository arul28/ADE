import { describe, expect, it } from "vitest";

import { latestScenePreviewOutput, readScenePreviewPath } from "./ScenePreviewThumb";

/**
 * A preview PNG is named by `ade scene preview` output that may arrive as plain
 * command text or as a JSON-encoded tool result. The path has to be read back
 * out of both, on either platform, or the reader sees a shell row instead of
 * the picture the agent drew.
 */
describe("readScenePreviewPath", () => {
  it.each([
    [
      "a posix path",
      "/Users/jane/proj/.ade/cache/scene-previews/scene-2026-10-06-1.png",
      "/Users/jane/proj/.ade/cache/scene-previews/scene-2026-10-06-1.png",
    ],
    [
      "a path with spaces",
      "screenshot  /home/Jane Doe/My Project/.ade/cache/scene-previews/scene-1.png",
      "/home/Jane Doe/My Project/.ade/cache/scene-previews/scene-1.png",
    ],
    [
      "a windows path with spaces and backslashes",
      "screenshot  C:\\Users\\Jane Doe\\My Project\\.ade\\cache\\scene-previews\\scene-2.png",
      "C:\\Users\\Jane Doe\\My Project\\.ade\\cache\\scene-previews\\scene-2.png",
    ],
    [
      "a JSON-encoded result",
      '{"output":"ok\\nscreenshot  C:\\\\Users\\\\Jane\\\\.ade\\\\cache\\\\scene-previews\\\\scene-3.png"}',
      "C:\\Users\\Jane\\.ade\\cache\\scene-previews\\scene-3.png",
    ],
  ])("reads %s", (_label, output, expected) => {
    expect(readScenePreviewPath(output)).toBe(expected);
  });

  it("returns null when the output names no preview", () => {
    expect(readScenePreviewPath(null)).toBeNull();
    expect(readScenePreviewPath("")).toBeNull();
    expect(readScenePreviewPath("scene preview: ok, no picture")).toBeNull();
    expect(readScenePreviewPath("/tmp/.ade/cache/other/scene-1.png")).toBeNull();
  });
});

describe("latestScenePreviewOutput", () => {
  it("returns the newest entry that ran a preview, ignoring later non-preview results", () => {
    const older = { command: "ade scene preview /a.html", output: "screenshot  /p/.ade/cache/scene-previews/scene-a.png" };
    const newer = { command: "ade scene preview /b.html", output: "screenshot  /p/.ade/cache/scene-previews/scene-b.png" };
    const unrelated = { command: "ade git status", output: "clean" };
    const output = latestScenePreviewOutput([older, unrelated, newer, unrelated]);
    expect(output).toBe(newer.output);
    expect(readScenePreviewPath(output)).toBe("/p/.ade/cache/scene-previews/scene-b.png");
  });

  it("reads a preview reported as a structured tool result", () => {
    const entry = {
      args: { command: "ade scene preview /a.html" },
      result: { output: "screenshot  /p/.ade/cache/scene-previews/scene-a.png" },
    };
    // The result is stringified whole; the path reader decodes it.
    const output = latestScenePreviewOutput([entry]);
    expect(readScenePreviewPath(output)).toBe("/p/.ade/cache/scene-previews/scene-a.png");
  });

  it("returns null when no entry names one", () => {
    expect(latestScenePreviewOutput([])).toBeNull();
    expect(latestScenePreviewOutput([{ command: "ade git status", output: "clean" }])).toBeNull();
  });
});
