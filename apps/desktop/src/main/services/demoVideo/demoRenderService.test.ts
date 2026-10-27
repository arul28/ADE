import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DemoAnalysis, DemoEngine } from "../../../shared/demoVideo/demoContract";
import { produceDemoVideo } from "./demoRenderService";

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const analysis: DemoAnalysis = {
  version: 1,
  width: 1280,
  height: 720,
  durationSeconds: 3,
  frames: [{ t: 0, changed: 1 }, { t: 1.5, changed: 0.2 }, { t: 3, changed: 0.1 }],
};

describe("produceDemoVideo engine fall-through", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ade-demo-fallthrough-"));

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("hands a recording an engine failed on to the next engine that reads it", async () => {
    const rawPath = path.join(scratch, "recording.mp4");
    const outputPath = path.join(scratch, "demo.mp4");
    fs.writeFileSync(rawPath, "raw-frames");

    // The desktop's Chromium engine can be offered while its bridge probe is
    // still settling and be gone by the render. That must not file the raw
    // recording uncut: the next engine that reads it makes the demo.
    const chromiumRender = vi.fn(async () => {
      throw new Error("the demo renderer is no longer connected");
    });
    const chromium: DemoEngine = {
      id: "chromium",
      canRead: (file) => file.endsWith(".mp4"),
      analyze: async () => analysis,
      render: chromiumRender,
    };
    const ffmpegRender = vi.fn(async (request: { output: string; plan: { durationSeconds: number } }) => {
      fs.writeFileSync(request.output, "demo-bytes");
      return { bytes: 10, durationSeconds: request.plan.durationSeconds, frames: 1 };
    });
    const ffmpeg: DemoEngine = {
      id: "ffmpeg",
      canRead: (file) => file.endsWith(".mp4"),
      analyze: async () => analysis,
      render: ffmpegRender as unknown as DemoEngine["render"],
    };

    const produced = await produceDemoVideo({
      rawPath,
      outputPath,
      track: null,
      plain: false,
      engines: [chromium, ffmpeg],
      logger,
    });

    // The first engine's demo and its plain retry both failed before the
    // second was asked.
    expect(chromiumRender).toHaveBeenCalledTimes(2);
    expect(produced.engine).toBe("ffmpeg");
    expect(produced.metadata.plain).toBe(false);
    // A real demo, not the raw file filed as a fallback.
    expect(produced.metadata.fallbackReason).toBeUndefined();
    expect(fs.readFileSync(outputPath, "utf8")).toBe("demo-bytes");
    expect(fs.existsSync(rawPath)).toBe(false);
  });
});
