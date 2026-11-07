import { execFile } from "node:child_process";
import fs from "node:fs";
import type { DemoArtifactMetadata, DemoEngine, DemoRect, DemoTrack, DemoTrackEvent } from "../../../shared/demoVideo/demoContract";
import type { AndroidRecordingSegment } from "../../../shared/types/androidEmulator";
import { readDemoMp4 } from "../demoVideo/demoMp4Source";
import { DemoRecordingUnusableError, demoLengths, produceDemoVideo } from "../demoVideo/demoRenderService";
import { ensureFfmpegTools, ffmpegDownloadable, resolveFfmpegTools, runFfmpeg } from "../demoVideo/ffmpegDemoEngine";
import { planPlainDemo } from "../../../shared/demoVideo/demoPlanner";
import { resolveExecutableFromKnownLocations } from "../ai/cliExecutableResolver";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { Muxer, StreamTarget } from "mp4-muxer";
import { buildAvcC } from "./androidRecording";

/*
 * A stopped Android recording becomes ONE video, filed once.
 *
 * While it records, the stream's picture changes size when the screen
 * turns, and one MP4 track keeps one size, so the recorder writes a part per
 * orientation. At the stop:
 *
 * 1. One part is the raw file as it is. Several parts are joined into one
 *    raw file on a fixed canvas (the widest part by the tallest part), each
 *    part fitted in it with black bars. With ffmpeg (on the machine, or
 *    ADE's own copy on Windows and Linux) one ffmpeg run scales, pads and
 *    joins them. With only the macOS `ade-media` engine, each part is
 *    rendered plain onto the canvas (the engine fits a picture of another
 *    shape with black bars), and the parts are put into one MP4 here, with
 *    no second encode.
 * 2. The demo track's points are moved from each part's frame into the
 *    canvas, so a tap ring lands on the tap after the join too.
 * 3. `produceDemoVideo` makes the demo (idle cut, rings, badges, captions,
 *    10 MB fit), or the plain video for `--plain`.
 * 4. The video is never lost. When no engine can make the demo (none here,
 *    a download that failed or ran past the time limit, a render error), the
 *    raw file is filed as it is, at any size, and `fallbackReason` says why.
 *    When the parts cannot be joined either, each part is kept and filed.
 *
 * The Swift path writes the joined MP4 with `mp4-muxer`, as the recorder does.
 */

/** The longest a stop may spend on the join and the demo before it files the raw video. */
export const ANDROID_DEMO_BUDGET_MS = 150_000;

const JOIN_BITRATE = 8_000_000;
const JOIN_FPS = 30;

type Size = { width: number; height: number };

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** The canvas several parts share: the widest part's width by the tallest part's height. */
export function androidJoinCanvas(segments: readonly Size[]): Size {
  return {
    width: even(Math.max(...segments.map((segment) => segment.width))),
    height: even(Math.max(...segments.map((segment) => segment.height))),
  };
}

/** Where a part sits in the canvas, as fractions of the canvas. */
function fitRect(part: Size, canvas: Size): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(canvas.width / part.width, canvas.height / part.height);
  const w = (part.width * scale) / canvas.width;
  const h = (part.height * scale) / canvas.height;
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/**
 * The track with every point and rect moved from its part's frame into the
 * canvas. A part covers `[start, start + durationMs)` of the joined video.
 */
export function remapAndroidTrackToCanvas(track: DemoTrack | null, segments: readonly AndroidRecordingSegment[], canvas: Size): DemoTrack | null {
  if (!track || segments.length < 2) return track;
  const spans: Array<{ end: number; fit: ReturnType<typeof fitRect> }> = [];
  let at = 0;
  for (const segment of segments) {
    at += segment.durationMs / 1000;
    spans.push({ end: at, fit: fitRect(segment, canvas) });
  }
  const fitAt = (t: number) => (spans.find((span) => t < span.end) ?? spans[spans.length - 1]!).fit;
  const events: DemoTrackEvent[] = track.events.map((event) => {
    const fit = fitAt(event.t);
    const mapX = (x: number) => fit.x + x * fit.w;
    const mapY = (y: number) => fit.y + y * fit.h;
    const rect: DemoRect | undefined = event.rect
      ? [mapX(event.rect[0]), mapY(event.rect[1]), event.rect[2] * fit.w, event.rect[3] * fit.h]
      : undefined;
    return {
      ...event,
      ...(typeof event.x === "number" ? { x: mapX(event.x) } : {}),
      ...(typeof event.y === "number" ? { y: mapY(event.y) } : {}),
      ...(rect ? { rect } : {}),
      ...(event.to ? { to: [mapX(event.to[0]), mapY(event.to[1])] as [number, number] } : {}),
    };
  });
  return { ...track, events };
}

/**
 * An ffmpeg on this machine that can join the parts: the demo engine's, else
 * any one with libx264 (a join needs no drawtext). Null when there is none.
 */
let joinFfmpegCache: Promise<string | null> | null = null;
/** Asked once per process, off the event loop: the brain keeps serving while ffmpeg lists its encoders. */
function localJoinFfmpeg(logger: Logger | null): Promise<string | null> {
  const demo = resolveFfmpegTools();
  if (demo) return Promise.resolve(demo.ffmpegPath);
  joinFfmpegCache ??= new Promise<string | null>((resolve) => {
    const found = resolveExecutableFromKnownLocations("ffmpeg");
    if (!found) {
      resolve(null);
      return;
    }
    execFile(found.path, ["-hide_banner", "-encoders"], { encoding: "utf8", timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        logger?.warn("android.recording_join_ffmpeg_probe_failed", { error: getErrorMessage(error) });
        resolve(null);
        return;
      }
      resolve(/\blibx264\b/u.test(stdout) ? found.path : null);
    });
  });
  return joinFfmpegCache;
}

/** One ffmpeg run: each part scaled into the canvas with black bars, then all joined. */
async function joinWithFfmpeg(
  segments: readonly AndroidRecordingSegment[],
  outputPath: string,
  canvas: Size,
  signal: AbortSignal,
  localFfmpeg: string | null,
  logger: Logger | null,
): Promise<void> {
  const tools = localFfmpeg ? { ffmpegPath: localFfmpeg } : await Promise.race([
    ensureFfmpegTools(),
    new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("the time for the join ran out")), { once: true })),
  ]);
  const { width: W, height: H } = canvas;
  const chains = segments.map((_, index) =>
    `[${index}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${JOIN_FPS},format=yuv420p[v${index}]`);
  const filter = `${chains.join(";")};${segments.map((_, index) => `[v${index}]`).join("")}concat=n=${segments.length}:v=1:a=0[out]`;
  // The stop's budget (`signal`) ends it; the timeout is only a backstop.
  await runFfmpeg({
    binaryPath: tools.ffmpegPath,
    args: [
      "-hide_banner", "-loglevel", "error", "-y",
      ...segments.flatMap((segment) => ["-i", segment.path]),
      "-filter_complex", filter,
      "-map", "[out]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outputPath,
    ],
    timeoutMs: ANDROID_DEMO_BUDGET_MS,
    signal,
    logger,
    label: "join",
  });
}

/** An MP4 sample's NALs with 4-byte length fields, as the avcC here says. */
function withFourByteLengths(sample: Buffer, lengthSize: number): Buffer {
  if (lengthSize === 4) return sample;
  const parts: Buffer[] = [];
  let at = 0;
  while (at + lengthSize <= sample.length) {
    let size = 0;
    for (let i = 0; i < lengthSize; i += 1) size = size * 256 + sample[at + i]!;
    at += lengthSize;
    if (size <= 0 || at + size > sample.length) break;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(size);
    parts.push(length, sample.subarray(at, at + size));
    at += size;
  }
  return Buffer.concat(parts);
}

/**
 * Puts the encoded samples of the rendered parts into one MP4, with no second
 * encode. The engine's encoder can reorder frames (B-frames), so each sample
 * keeps its decode time and its presentation time (a ctts table). A part's
 * decode times are its presentation times in order, moved back by `shift` so
 * that no frame decodes after it shows.
 */
async function remuxParts(files: readonly string[], outputPath: string, canvas: Size): Promise<void> {
  const target = `${outputPath}.join.mp4`;
  const fd = fs.openSync(target, "w");
  let closed = false;
  try {
    const muxer = new Muxer({
      target: new StreamTarget({
        onData: (data, position) => {
          fs.writeSync(fd, data, 0, data.length, position);
        },
      }),
      video: { codec: "avc", width: canvas.width, height: canvas.height },
      fastStart: false,
      firstTimestampBehavior: "offset",
    });
    let offsetUs = 0;
    let firstSets: { sps: Buffer; pps: Buffer } | null = null;
    for (const file of files) {
      const info = await readDemoMp4(file);
      const [sps, pps] = info.parameterSets;
      if (!sps || !pps) throw new Error("a rendered part has no SPS or PPS");
      if (!firstSets) firstSets = { sps, pps };
      else if (!firstSets.sps.equals(sps) || !firstSets.pps.equals(pps)) throw new Error("the rendered parts use different encoder settings");
      const ptsUs = info.samples.map((sample) => Math.round(sample.t * 1_000_000));
      const sorted = [...ptsUs].sort((a, b) => a - b);
      let shift = 0;
      for (let i = 0; i < ptsUs.length; i += 1) shift = Math.max(shift, sorted[i]! - ptsUs[i]!);
      const frameUs = info.frames > 0 ? Math.max(1, Math.round((info.durationSeconds * 1_000_000) / info.frames)) : 33_333;
      const handle = await fs.promises.open(file, "r");
      try {
        for (const [i, sample] of info.samples.entries()) {
          const bytes = Buffer.alloc(sample.size);
          await handle.read(bytes, 0, sample.size, sample.offset);
          const decodeUs = offsetUs + sorted[i]!;
          const showUs = offsetUs + shift + ptsUs[i]!;
          const durationUs = i + 1 < sorted.length ? sorted[i + 1]! - sorted[i]! : frameUs;
          const meta = offsetUs === 0 && i === 0
            ? { decoderConfig: { codec: info.codec, codedWidth: canvas.width, codedHeight: canvas.height, description: buildAvcC(sps, pps) } }
            : undefined;
          muxer.addVideoChunkRaw(withFourByteLengths(bytes, info.lengthSize), sample.key ? "key" : "delta", showUs, durationUs, meta as never, showUs - decodeUs);
        }
      } finally {
        await handle.close();
      }
      offsetUs += shift + Math.round(info.durationSeconds * 1_000_000);
    }
    muxer.finalize();
    fs.closeSync(fd);
    closed = true;
    fs.renameSync(target, outputPath);
  } finally {
    if (!closed) {
      fs.closeSync(fd);
      fs.rmSync(target, { force: true });
    }
  }
}

/**
 * The macOS path with no ffmpeg: each part rendered plain onto the canvas by
 * the engine, then the encoded samples put into one MP4 here.
 */
async function joinWithEngine(
  engine: DemoEngine,
  segments: readonly AndroidRecordingSegment[],
  outputPath: string,
  canvas: Size,
  signal: AbortSignal,
): Promise<void> {
  const fitted: string[] = [];
  try {
    for (const [index, segment] of segments.entries()) {
      const analysis = await engine.analyze(segment.path, { signal });
      const plan = planPlainDemo(analysis);
      const target = `${outputPath}.part${index + 1}.mp4`;
      fitted.push(target);
      await engine.render({
        input: segment.path,
        output: target,
        plan: { ...plan, output: { width: canvas.width, height: canvas.height, fps: JOIN_FPS, bitrate: JOIN_BITRATE, keyframeIntervalSeconds: 2 } },
      }, { signal });
    }
    await remuxParts(fitted, outputPath, canvas);
  } finally {
    for (const file of fitted) fs.rmSync(file, { force: true });
  }
}

/** Joins the parts into one raw file. Throws when no tool here can. */
async function joinSegments(args: {
  segments: readonly AndroidRecordingSegment[];
  rawPath: string;
  engines: DemoEngine[];
  signal: AbortSignal;
  logger: Logger | null;
}): Promise<Size> {
  const canvas = androidJoinCanvas(args.segments);
  const swift = args.engines.find((engine) => engine.id === "swift" && engine.canRead(args.segments[0]!.path)) ?? null;
  // ffmpeg on the machine first (one run, no download); then ade-media on
  // macOS; then ADE's own ffmpeg, which may need a download.
  const localFfmpeg = await localJoinFfmpeg(args.logger);
  if (localFfmpeg) {
    await joinWithFfmpeg(args.segments, args.rawPath, canvas, args.signal, localFfmpeg, args.logger);
  } else if (swift) {
    await joinWithEngine(swift, args.segments, args.rawPath, canvas, args.signal);
  } else if (ffmpegDownloadable()) {
    await joinWithFfmpeg(args.segments, args.rawPath, canvas, args.signal, null, args.logger);
  } else {
    throw new Error("this machine has no video engine to join the parts of a turned screen");
  }
  args.logger?.info("android.recording_joined", { parts: args.segments.length, width: canvas.width, height: canvas.height });
  return canvas;
}

export type AndroidRecordingVideo = {
  /** The files to keep and file: one, unless the parts could not be joined. */
  files: AndroidRecordingSegment[];
  demo: DemoArtifactMetadata | null;
  durationMs: number;
  wallDurationMs: number;
  idleCutMs: number;
  bytes: number;
  /** Set when the recording holds nothing to show: nothing is filed. */
  unusable: string | null;
};

function fileSegment(filePath: string, size: Size, durationMs: number, frames: number): AndroidRecordingSegment {
  let bytes = 0;
  try {
    bytes = fs.statSync(filePath).size;
  } catch {
    bytes = 0;
  }
  return { path: filePath, width: size.width, height: size.height, durationMs, bytes, frames };
}

/**
 * The video as it was recorded, at any size: `files` are filed unchanged.
 * `reason` says why there is no demo; null leaves the demo record out.
 */
export function androidRawVideoFallback(
  files: AndroidRecordingSegment[],
  wallMs: number,
  reason: string | null,
): AndroidRecordingVideo {
  return {
    files,
    demo: reason === null
      ? null
      : { plain: true, engine: null, sourceSeconds: wallMs / 1000, outputSeconds: wallMs / 1000, cutSeconds: 0, spedUpSourceSeconds: 0, steps: [], fallbackReason: reason },
    durationMs: wallMs,
    wallDurationMs: wallMs,
    idleCutMs: 0,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    unusable: null,
  };
}

/**
 * Turns the recorder's parts into the one video ADE keeps at `outputPath`
 * (`<id>.mp4`). Only that file stays (or, when nothing could join them, the
 * parts). Never throws for a render failure: the raw video is filed instead.
 */
export async function produceAndroidRecordingVideo(args: {
  segments: AndroidRecordingSegment[];
  outputPath: string;
  track: DemoTrack | null;
  plain: boolean;
  engines: DemoEngine[];
  missingEngineReason?: string | null;
  logger: Logger;
  budgetMs?: number;
}): Promise<AndroidRecordingVideo> {
  const { segments, outputPath, logger } = args;
  const wallMs = segments.reduce((sum, segment) => sum + segment.durationMs, 0);
  const frames = segments.reduce((sum, segment) => sum + segment.frames, 0);
  const signal = AbortSignal.timeout(args.budgetMs ?? ANDROID_DEMO_BUDGET_MS);
  const rawPath = outputPath.replace(/\.mp4$/u, ".raw.mp4");
  const keepParts = (reason: string): AndroidRecordingVideo => {
    logger.warn("android.recording_join_failed", { parts: segments.length, reason });
    return androidRawVideoFallback(segments, wallMs, reason);
  };

  let rawSize: Size = segments[0]!;
  let track = args.track;
  if (segments.length === 1) {
    fs.renameSync(segments[0]!.path, rawPath);
  } else {
    try {
      rawSize = await joinSegments({ segments, rawPath, engines: args.engines, signal, logger });
      track = remapAndroidTrackToCanvas(args.track, segments, rawSize);
    } catch (error) {
      fs.rmSync(rawPath, { force: true });
      return keepParts(`the parts of the turned screen could not be joined (${getErrorMessage(error)}), so each part is kept`);
    }
    for (const segment of segments) fs.rmSync(segment.path, { force: true });
  }

  try {
    const produced = await produceDemoVideo({
      rawPath,
      outputPath,
      track,
      plain: args.plain,
      engines: args.engines,
      missingEngineReason: args.missingEngineReason ?? null,
      logger,
      signal,
    });
    const lengths = demoLengths(produced.metadata);
    return {
      files: [fileSegment(produced.path, rawSize, lengths.durationMs, frames)],
      demo: produced.metadata,
      ...lengths,
      bytes: produced.bytes,
      unusable: null,
    };
  } catch (error) {
    if (error instanceof DemoRecordingUnusableError) {
      fs.rmSync(rawPath, { force: true });
      return { files: [], demo: null, durationMs: 0, wallDurationMs: wallMs, idleCutMs: 0, bytes: 0, unusable: error.message };
    }
    // No demo (no engine, a download that failed or took too long, a render
    // error, a raw file over 10 MB with no engine): the video is still kept
    // and filed as it was recorded, at any size.
    const reason = signal.aborted
      ? `the demo took longer than ${Math.round((args.budgetMs ?? ANDROID_DEMO_BUDGET_MS) / 1000)} s`
      : getErrorMessage(error).replace(/^The demo video could not be made: /u, "");
    logger.warn("android.recording_demo_fallback", { reason });
    if (fs.existsSync(rawPath)) {
      fs.rmSync(outputPath, { force: true });
      fs.renameSync(rawPath, outputPath);
    }
    return androidRawVideoFallback([fileSegment(outputPath, rawSize, wallMs, frames)], wallMs, reason);
  }
}
