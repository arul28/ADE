import { describe, expect, it, vi } from "vitest";

import type { OpenProjectBinding } from "../../../shared/types";
import { resolveMacDesktopTimeLapseSrc } from "./ChatMacDesktopTimeLapseCard";

const ROOT = "/Users/me/project";
const CLIP = `${ROOT}/.ade/artifacts/computer-use/mac-desktop-turn-t1.mp4`;
const BASE = "http://127.0.0.1:5123/token";
const localPin = { kind: "local", key: "k", rootPath: ROOT, displayName: "project" } as OpenProjectBinding;
const remotePin = {
  kind: "remote",
  key: "k",
  targetId: "mac-2",
  projectId: "p",
  rootPath: "/Users/other/project",
  displayName: "project",
} as unknown as OpenProjectBinding;

describe("resolveMacDesktopTimeLapseSrc", () => {
  it("plays the clip from the loopback media server, not ade-artifact://", async () => {
    const readArtifactPreview = vi.fn(async () => "data:video/mp4;base64,AAAA");
    const src = await resolveMacDesktopTimeLapseSrc({
      filePath: CLIP,
      rootPath: ROOT,
      pin: localPin,
      webClient: false,
      mediaBaseUrl: async () => BASE,
      readArtifactPreview,
    });
    expect(src).toBe(`${BASE}/project/.ade/artifacts/computer-use/mac-desktop-turn-t1.mp4`);
    expect(readArtifactPreview).not.toHaveBeenCalled();
  });

  it("falls back to the host's preview read when there is no server, as the proof drawer does", async () => {
    const readArtifactPreview = vi.fn(async () => "data:video/quicktime;base64,AAAA");
    const src = await resolveMacDesktopTimeLapseSrc({
      filePath: CLIP,
      rootPath: ROOT,
      pin: null,
      webClient: false,
      mediaBaseUrl: async () => null,
      readArtifactPreview,
    });
    // Chromium refuses `video/quicktime`; the same bytes play as mp4.
    expect(src).toBe("data:video/mp4;base64,AAAA");
    expect(readArtifactPreview).toHaveBeenCalledWith({ uri: CLIP }, null);
  });

  it("reads a paired machine's clip through the pin, never this computer's server", async () => {
    const mediaBaseUrl = vi.fn(async () => BASE);
    const readArtifactPreview = vi.fn(async () => "data:video/mp4;base64,BBBB");
    const src = await resolveMacDesktopTimeLapseSrc({
      filePath: "/Users/other/project/.ade/artifacts/clip.mp4",
      rootPath: "/Users/other/project",
      pin: remotePin,
      webClient: false,
      mediaBaseUrl,
      readArtifactPreview,
    });
    expect(src).toBe("data:video/mp4;base64,BBBB");
    expect(mediaBaseUrl).not.toHaveBeenCalled();
    expect(readArtifactPreview).toHaveBeenCalledWith({ uri: "/Users/other/project/.ade/artifacts/clip.mp4" }, remotePin);
  });

  it("answers null when neither path has the bytes, so the card shows nothing", async () => {
    const src = await resolveMacDesktopTimeLapseSrc({
      filePath: "/elsewhere/clip.mp4",
      rootPath: ROOT,
      pin: localPin,
      webClient: false,
      mediaBaseUrl: async () => BASE,
      readArtifactPreview: async () => null,
    });
    expect(src).toBeNull();
  });
});
