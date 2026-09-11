import { describe, expect, it, vi } from "vitest";

import { createBuiltInBrowserIpcArgParsers } from "./builtInBrowserIpcArgs";

const CHANNEL = "ade.builtInBrowser.test";

function parsers() {
  const onInvalid = vi.fn();
  return { onInvalid, ...createBuiltInBrowserIpcArgParsers({ onInvalid }) };
}

describe("createBuiltInBrowserIpcArgParsers", () => {
  it("logs the rejection through onInvalid before throwing", () => {
    const p = parsers();
    expect(() => p.parseBuiltInBrowserNavigateArgs({ url: "  " }, CHANNEL)).toThrow(
      /url must be a non-empty string/,
    );
    expect(p.onInvalid).toHaveBeenCalledWith(CHANNEL, "url must be a non-empty string");
  });

  it("requires an object payload where the channel demands one", () => {
    const p = parsers();
    expect(() => p.parseBuiltInBrowserTabArgs(null, CHANNEL)).toThrow(/payload object is required/);
    expect(() => p.parseBuiltInBrowserNavigateArgs("https://x.test", CHANNEL)).toThrow(
      /payload must be an object/,
    );
    // Optional-payload channels accept absence and return an empty scope.
    expect(p.parseBuiltInBrowserTabTargetArgs(null, CHANNEL)).toEqual({});
  });

  it("rejects a URL with an embedded null byte or past the length cap", () => {
    const p = parsers();
    expect(() => p.parseBuiltInBrowserNavigateArgs({ url: "https://x.test/\0" }, CHANNEL)).toThrow(
      /url is invalid/,
    );
    expect(() =>
      p.parseBuiltInBrowserNavigateArgs({ url: `https://x.test/${"a".repeat(4097)}` }, CHANNEL),
    ).toThrow(/url is invalid/);
  });

  it("refuses a scope that names both a project root and the personal collection", () => {
    const p = parsers();
    expect(() =>
      p.parseBuiltInBrowserProjectScopeInput(
        { projectRoot: "/tmp/proj", tabCollection: "personal" },
        CHANNEL,
      ),
    ).toThrow(/tabCollection and projectRoot cannot both be set/);
    expect(() =>
      p.parseBuiltInBrowserProjectScopeInput({ tabCollection: "shared" }, CHANNEL),
    ).toThrow(/tabCollection is invalid/);
  });

  it("keeps optional booleans out of the result when they were not supplied", () => {
    const p = parsers();
    // Regression guard for the `optionalField` rewrite: absent stays absent,
    // and an explicit `false` survives rather than being dropped as falsy.
    expect(p.parseBuiltInBrowserSetZoomArgs({ factor: 1.5 }, CHANNEL)).toEqual({ factor: 1.5 });
    expect(p.parseBuiltInBrowserSetZoomArgs({ reset: false }, CHANNEL)).toEqual({ reset: false });
    expect(p.parseBuiltInBrowserSetZoomArgs({ reset: true }, CHANNEL)).toEqual({ reset: true });
    expect(p.parseBuiltInBrowserFindInPageArgs({ text: "hi", matchCase: false }, CHANNEL)).toEqual({
      text: "hi",
      matchCase: false,
    });
  });

  it("enforces numeric bounds", () => {
    const p = parsers();
    expect(() => p.parseBuiltInBrowserSetZoomArgs({ factor: 99 }, CHANNEL)).toThrow(
      /factor is above the maximum/,
    );
    expect(() => p.parseBuiltInBrowserSetZoomArgs({ factor: 0 }, CHANNEL)).toThrow(
      /factor is below the minimum/,
    );
    expect(() => p.parseBuiltInBrowserSetZoomArgs({ factor: "1" }, CHANNEL)).toThrow(
      /factor must be a finite number/,
    );
    expect(() =>
      p.parseBuiltInBrowserFindInPageArgs({ text: "hi", timeoutMs: 10 }, CHANNEL),
    ).toThrow(/timeoutMs is below the minimum/);
  });

  it("validates the find and devtools enums", () => {
    const p = parsers();
    expect(() => p.parseBuiltInBrowserFindInPageArgs({ text: "   " }, CHANNEL)).toThrow(
      /text must be a non-empty string/,
    );
    expect(() =>
      p.parseBuiltInBrowserStopFindInPageArgs({ action: "burnItDown" }, CHANNEL),
    ).toThrow(/action is invalid/);
    expect(p.parseBuiltInBrowserStopFindInPageArgs({ action: "keepSelection" }, CHANNEL)).toMatchObject(
      { action: "keepSelection" },
    );
    expect(() => p.parseBuiltInBrowserSetDevToolsArgs({}, CHANNEL)).toThrow(
      /open must be a boolean/,
    );
    expect(() => p.parseBuiltInBrowserSetDevToolsArgs({ open: true, mode: "sideways" }, CHANNEL))
      .toThrow(/mode is invalid/);
  });

  it("requires a tab id where the channel acts on one specific tab", () => {
    const p = parsers();
    expect(() => p.parseBuiltInBrowserTabArgs({ tabId: "" }, CHANNEL)).toThrow(
      /tabId must be a non-empty string/,
    );
    expect(p.parseBuiltInBrowserTabArgs({ tabId: " tab-1 " }, CHANNEL)).toMatchObject({
      tabId: "tab-1",
    });
  });

  it("bounds the recording fps to the supported range", () => {
    const p = parsers();
    expect(p.parseBuiltInBrowserStartRecordingArgs({ fps: 60 }, CHANNEL)).toMatchObject({ fps: 60 });
    expect(() => p.parseBuiltInBrowserStartRecordingArgs({ fps: 120 }, CHANNEL)).toThrow(
      /fps is above the maximum/,
    );
  });
});
