/**
 * The `ffmpeg` engine's contact sheet: each time is seeked as its own input
 * (`-ss` before `-i`, so the frame is exact), the first frame of each is
 * scaled to a tile, and `xstack` lays the tiles out into one PNG with the
 * contract's gap and fill. The caller (`proofReview.ts`) has already checked
 * the request against the contract's limits.
 *
 * The PNG is written beside the target as `.<name>.<pid>.partial.png` and
 * renamed at the end, so a failure never leaves half a sheet at `output`.
 */

import fs from "node:fs";
import path from "node:path";
import type { DemoContactSheetRequest, DemoContactSheetResult } from "../../../shared/demoVideo/demoContract";
import { DEMO_CONTACT_SHEET_FILL, DEMO_CONTACT_SHEET_GAP } from "../../../shared/demoVideo/demoContract";
import type { Logger } from "../logging/logger";
import type { FfmpegRun, FfmpegTools, FfmpegVideoProbe } from "./ffmpegDemoEngine";

/** A time past the end shows the frame this far before the end. */
const END_BACKOFF_SECONDS = 0.05;
const TIMEOUT_MS = 60_000;

/** `#RRGGBB` as ffmpeg's colour syntax. */
const FILL = `0x${DEMO_CONTACT_SHEET_FILL.replace(/^#/u, "")}`;

export async function ffmpegContactSheet(
  request: DemoContactSheetRequest,
  context: {
    tools: FfmpegTools;
    probe: FfmpegVideoProbe;
    run: FfmpegRun;
    logger: Logger | null;
    signal?: AbortSignal;
  },
): Promise<DemoContactSheetResult> {
  const { tools, signal } = context;
  const count = request.times.length;
  const columns = request.columns;
  const tileWidth = request.tileWidth;
  const gap = DEMO_CONTACT_SHEET_GAP;
  const probe = await context.probe(tools.ffprobePath, request.input, signal);
  const tileHeight = Math.max(2, Math.round((tileWidth * probe.height) / probe.width));
  const lastTime = probe.durationSeconds === null ? null : Math.max(0, probe.durationSeconds - END_BACKOFF_SECONDS);
  const times = request.times.map((t) => Math.max(0, lastTime === null ? t : Math.min(t, lastTime)));
  const cols = Math.min(columns, count);
  const rows = Math.ceil(count / columns);
  const width = cols * tileWidth + (cols - 1) * gap;
  const height = rows * tileHeight + (rows - 1) * gap;

  // Each tile is the first frame at or after its seek point.
  const chains = times.map((_, index) =>
    `[${index}:v]trim=end_frame=1,setpts=PTS-STARTPTS,scale=${tileWidth}:${tileHeight},setsar=1,format=rgb24[t${index}]`);
  if (count === 1) chains.push("[t0]null[out]");
  else {
    const layout = times.map((_, index) =>
      `${(index % columns) * (tileWidth + gap)}_${Math.floor(index / columns) * (tileHeight + gap)}`).join("|");
    chains.push(`${times.map((_, index) => `[t${index}]`).join("")}xstack=inputs=${count}:layout=${layout}:fill=${FILL}[out]`);
  }
  const partial = path.join(path.dirname(request.output), `.${path.basename(request.output)}.${process.pid}.partial.png`);
  try {
    await context.run({
      binaryPath: tools.ffmpegPath,
      args: [
        "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        ...times.flatMap((t) => ["-ss", t.toFixed(3), "-i", request.input]),
        "-filter_complex", chains.join(";"),
        "-map", "[out]",
        "-frames:v", "1", "-update", "1",
        "-f", "image2", "-c:v", "png",
        partial,
      ],
      timeoutMs: TIMEOUT_MS,
      signal,
      logger: context.logger,
      label: "contact sheet",
    });
    // ffmpeg exits cleanly with nothing written when a seek finds no frame.
    if (!fs.existsSync(partial)) throw new Error("ffmpeg contact sheet failed: the video has no frame at the asked times.");
    await fs.promises.rename(partial, request.output);
    return { width, height };
  } catch (error) {
    await fs.promises.rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }
}
