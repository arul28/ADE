import { describe, expect, it } from "vitest";
import { playableMediaDataUrl, playableVideoMime } from "./playableMedia";

describe("playableMedia", () => {
  it("labels a QuickTime movie as MP4 so Chromium plays it", () => {
    expect(playableVideoMime("video/quicktime")).toBe("video/mp4");
    expect(playableVideoMime("Video/QuickTime")).toBe("video/mp4");
    expect(playableMediaDataUrl("data:video/quicktime;base64,AAAA")).toBe("data:video/mp4;base64,AAAA");
  });

  it("leaves every other type alone", () => {
    expect(playableVideoMime("video/webm")).toBe("video/webm");
    expect(playableMediaDataUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(playableMediaDataUrl("ade-artifact://x.mov")).toBe("ade-artifact://x.mov");
    expect(playableMediaDataUrl(null)).toBeNull();
  });
});
