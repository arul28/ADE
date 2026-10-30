/**
 * The `ffmpeg` demo engine: the plan executed by the system's `ffmpeg`, so a
 * machine with neither `ade-media` (macOS) nor an attached ADE desktop app (the
 * Chromium engine) still files a cut, zoomed, captioned demo. This is what a
 * Linux box running only the brain uses.
 *
 * - `analyze` decodes the raw file once, scaled to the contract's greyscale
 *   thumbnail by box average (`scale=…:flags=area,format=gray`), reads the
 *   frames off stdout and each frame's time off `showinfo`, and measures change
 *   with the same rules as the other engines.
 * - `render` turns the plan into one filter graph: `select` + `setpts` for the
 *   segments (cuts and speed-ups), `fps` for a constant output rate,
 *   `zoompan` for the camera, an `overlay` of a pointer sprite and of click-ring
 *   sprite sequences (both rasterized here), and `drawtext` for captions and the
 *   speed badge. Overlay positions follow the camera through the same
 *   piecewise-linear expressions the camera uses.
 * - `contactSheet` seeks each time as its own input (`-ss` before `-i`, so the
 *   frame is exact), scales the first frame of each, and lays them out with
 *   `xstack` into one PNG.
 *
 * Differences from the other engines, all cosmetic: caption boxes are square,
 * not pills (drawtext cannot round the box it sizes to its text), a top
 * caption's height is estimated from its line count to keep the badge below
 * it, and on an ffmpeg older than 7 (no `text_align`) wrapped caption lines
 * are left-aligned.
 *
 * ffmpeg is the machine's own when it has one that can render the plan (the
 * libx264 encoder and the drawtext filter: Fedora's ffmpeg-free has no
 * libx264, a minimal build no drawtext). Otherwise ADE downloads its
 * pinned static build (Linux and Windows) the first time a recording needs a
 * demo — `prefetchFfmpegTools` starts that when the recording starts — and
 * never at launch.
 *
 * The output is written beside the target as `.<name>.<pid>.partial.mp4` and
 * renamed at the end, so a cancel or a failure never leaves half a video at
 * `output`.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type {
  DemoAnalysis,
  DemoAnalysisFrame,
  DemoContactSheetResult,
  DemoEngine,
  DemoPlan,
  DemoRenderRequest,
  DemoRenderResult,
} from "../../../shared/demoVideo/demoContract";
import {
  DEMO_ANALYSIS_PIXEL_DELTA,
  DEMO_ANALYSIS_THUMBNAIL_LONG_SIDE,
  DEMO_POINTER_POLYGON,
  RECORDING_MAX_MS,
} from "../../../shared/demoVideo/demoContract";
import type { Logger } from "../logging/logger";
import {
  resolveExecutableCandidatesFromKnownLocations,
  resolveExecutableFromKnownLocations,
} from "../ai/cliExecutableResolver";
import { getPinnedToolStatus, resolvePinnedTool } from "../../../../../ade-cli/src/services/tools/pinnedTool";
import { pinnedToolDownload } from "../../../../../ade-cli/src/services/tools/onDemand";

const READABLE_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm"]);
const ANALYZE_TIMEOUT_MS = Math.max(120_000, RECORDING_MAX_MS);
const RENDER_MIN_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 3_000;
const STDERR_TAIL_LINES = 20;
/** Frames of one click ring's animation. */
const RING_FRAMES = 10;
/** More rings than this in one demo are drawn as the first ones only: each is a graph branch. */
const MAX_RINGS = 60;
/** How far a simplified key track may stray from the planner's, in its own units. */
const CAMERA_TOLERANCE = { zoom: 0.004, center: 0.002 };
const CURSOR_TOLERANCE = 0.0015;
/** Gap between contact-sheet tiles, in pixels, and the colour behind them. */
const CONTACT_SHEET_GAP = 6;
const CONTACT_SHEET_FILL = "0x202020";
/** Each tile is a decoder of its own; more than this in one sheet is refused. */
const CONTACT_SHEET_MAX_TILES = 64;
/** A time past the end shows the frame this far before the end. */
const CONTACT_SHEET_END_BACKOFF_SECONDS = 0.05;

export type FfmpegTools = { ffmpegPath: string; ffprobePath: string };

export type FfmpegDemoEngineDeps = {
  /** Where ffmpeg and ffprobe are, downloading ADE's copy when the machine has none. */
  resolveTools: () => Promise<FfmpegTools>;
  logger?: Logger | null;
};

/** The tools-cache name of ADE's pinned static ffmpeg (Linux and Windows only). */
const FFMPEG_TOOL = "ffmpeg";

/** ffmpeg binary path → whether it has what `render` uses. Asked once per path per process. */
const renderCapable = new Map<string, boolean>();

/**
 * True when this ffmpeg has the libx264 encoder and the drawtext filter.
 * A system build without them is passed over for ADE's pinned copy rather
 * than offered as an engine that fails every render.
 */
function canRenderDemos(ffmpegPath: string): boolean {
  const known = renderCapable.get(ffmpegPath);
  if (known !== undefined) return known;
  const list = (what: string): string => {
    const result = spawnSync(ffmpegPath, ["-hide_banner", what], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    return result.status === 0 ? result.stdout : "";
  };
  const capable = /\blibx264\b/u.test(list("-encoders")) && /\bdrawtext\b/u.test(list("-filters"));
  renderCapable.set(ffmpegPath, capable);
  return capable;
}

/** ffmpeg binary path → its major version, or null when it would not say. */
const majorVersions = new Map<string, number | null>();

/**
 * The option that reads the filter graph from a file. ffmpeg 7 added
 * `-/filter_complex <file>` and ffmpeg 9 removed `-filter_complex_script`, so
 * Arch's ffmpeg 9 refuses the old one and Ubuntu 24.04's 6.1 knows only it. A
 * git build (`N-…`) or an unreadable version is new enough for the new form.
 */
function filterScriptArgs(ffmpegPath: string, scriptPath: string): string[] {
  return olderThan7(ffmpegPath)
    ? ["-filter_complex_script", scriptPath]
    : ["-/filter_complex", scriptPath];
}

/** True for an ffmpeg that says it is 6 or older; a git build or an unreadable version is not. */
function olderThan7(ffmpegPath: string): boolean {
  if (!majorVersions.has(ffmpegPath)) {
    const result = spawnSync(ffmpegPath, ["-hide_banner", "-version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    const match = /ffmpeg version n?(\d+)\./u.exec(result.stdout ?? "");
    majorVersions.set(ffmpegPath, match ? Number(match[1]) : null);
  }
  const major = majorVersions.get(ffmpegPath);
  return major !== null && major !== undefined && major < 7;
}

/**
 * ffmpeg and ffprobe already on this machine: the first system ffmpeg that can
 * render a demo, then ADE's pinned copy if an earlier demo downloaded it.
 * Null when neither is.
 */
export function resolveFfmpegTools(): FfmpegTools | null {
  const ffmpeg = resolveExecutableCandidatesFromKnownLocations("ffmpeg").find((candidate) => canRenderDemos(candidate.path));
  const ffprobe = resolveExecutableFromKnownLocations("ffprobe");
  if (ffmpeg && ffprobe) return { ffmpegPath: ffmpeg.path, ffprobePath: ffprobe.path };
  const pinned = resolvePinnedTool(FFMPEG_TOOL);
  const pinnedProbe = pinned?.files.ffprobe;
  return pinned && pinnedProbe ? { ffmpegPath: pinned.entryPath, ffprobePath: pinnedProbe } : null;
}

/** True when ADE can fetch its own ffmpeg here: pinned for this host and downloads allowed. */
export function ffmpegDownloadable(): boolean {
  const status = getPinnedToolStatus(FFMPEG_TOOL);
  return status.fetchAllowed && status.state !== "unavailable";
}

/**
 * Starts ADE's ffmpeg download now when this machine has none, without
 * waiting on it: a recording that just started is minutes from needing it.
 */
export function prefetchFfmpegTools(): void {
  if (resolveFfmpegTools()) return;
  const pending = pinnedToolDownload(FFMPEG_TOOL);
  if (pending) void pending.catch(() => undefined);
}

/** The tools, downloading ADE's pinned copy on first need (joining a prefetch). */
export async function ensureFfmpegTools(): Promise<FfmpegTools> {
  const found = resolveFfmpegTools();
  if (found) return found;
  const pending = pinnedToolDownload(FFMPEG_TOOL);
  if (pending) {
    const failure = await pending;
    if (failure) throw new Error(`ADE could not download ffmpeg to make the demo (${failure.message}).`);
  }
  const fetched = resolveFfmpegTools();
  if (!fetched) throw new Error("This machine has no ffmpeg, and ADE's own copy is not available.");
  return fetched;
}

export function createFfmpegDemoEngine(deps: FfmpegDemoEngineDeps): DemoEngine {
  const logger = deps.logger ?? null;
  return {
    id: "ffmpeg",

    canRead(inputPath: string): boolean {
      return READABLE_EXTENSIONS.has(path.extname(inputPath).toLowerCase());
    },

    async analyze(inputPath, options) {
      const tools = await deps.resolveTools();
      const probe = await probeVideo(tools.ffprobePath, inputPath, options?.signal);
      const longSide = DEMO_ANALYSIS_THUMBNAIL_LONG_SIDE;
      const landscape = probe.width >= probe.height;
      const tw = landscape ? longSide : Math.max(1, Math.round((longSide * probe.width) / probe.height));
      const th = landscape ? Math.max(1, Math.round((longSide * probe.height) / probe.width)) : longSide;
      const frameBytes = tw * th;

      const changes: Array<Omit<DemoAnalysisFrame, "t">> = [];
      const times: number[] = [];
      let previous: Buffer | null = null;
      let pending: Buffer = Buffer.alloc(0);
      const measure = (frame: Buffer): void => {
        if (!previous) {
          changes.push({ changed: 1 });
          previous = Buffer.from(frame);
          return;
        }
        let count = 0;
        let minX = tw;
        let minY = th;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < th; y += 1) {
          const row = y * tw;
          for (let x = 0; x < tw; x += 1) {
            const index = row + x;
            if (Math.abs(frame[index]! - previous[index]!) > DEMO_ANALYSIS_PIXEL_DELTA) {
              count += 1;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        frame.copy(previous);
        changes.push(count > 0
          ? { changed: count / frameBytes, box: [minX / tw, minY / th, (maxX - minX + 1) / tw, (maxY - minY + 1) / th] }
          : { changed: 0 });
      };

      await runFfmpeg({
        binaryPath: tools.ffmpegPath,
        args: [
          "-hide_banner", "-nostdin", "-loglevel", "info",
          "-i", inputPath,
          "-an",
          "-vf", `setpts=PTS-STARTPTS,scale=${tw}:${th}:flags=area,format=gray,showinfo`,
          "-fps_mode", "passthrough",
          "-f", "rawvideo", "pipe:1",
        ],
        timeoutMs: ANALYZE_TIMEOUT_MS,
        signal: options?.signal,
        logger,
        label: "analyze",
        onStdout: (chunk) => {
          pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
          while (pending.length >= frameBytes) {
            measure(pending.subarray(0, frameBytes));
            pending = pending.subarray(frameBytes);
          }
        },
        onStderrLine: (line) => {
          if (!line.includes("showinfo")) return false;
          const match = /pts_time:\s*(-?[0-9.]+(?:e[-+]?\d+)?)/u.exec(line);
          if (match) times.push(Number(match[1]));
          return true;
        },
      });

      const frames: DemoAnalysisFrame[] = changes.map((change, index) => ({
        t: Math.max(0, times[index] ?? (index > 0 ? (times[index - 1] ?? 0) : 0)),
        ...change,
      }));
      const lastT = frames.length ? frames[frames.length - 1]!.t : 0;
      const durationSeconds = Math.max(lastT, probe.durationSeconds ?? lastT);
      return { version: 1, width: probe.width, height: probe.height, durationSeconds, frames } satisfies DemoAnalysis;
    },

    async render(request, options) {
      const tools = await deps.resolveTools();
      const startedAt = Date.now();
      const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ade-ffmpeg-demo-"));
      const partial = path.join(path.dirname(request.output), `.${path.basename(request.output)}.${process.pid}.partial.mp4`);
      try {
        // drawtext's `text_align` (each wrapped line centered) arrived after ffmpeg 6.
        const graph = await writeRenderGraph(request.plan, scratch, { centerLines: !olderThan7(tools.ffmpegPath) });
        let frames = 0;
        const plan = request.plan;
        const fps = plan.output.fps;
        const bitrate = Math.max(100_000, Math.round(plan.output.bitrate));
        await runFfmpeg({
          binaryPath: tools.ffmpegPath,
          args: [
            "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
            "-i", request.input,
            ...graph.inputArgs,
            ...filterScriptArgs(tools.ffmpegPath, graph.scriptPath),
            "-map", "[out]",
            "-an",
            "-t", plan.durationSeconds.toFixed(3),
            "-r", String(fps),
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
            "-b:v", String(bitrate),
            "-maxrate", String(Math.round(bitrate * 1.5)),
            "-bufsize", String(bitrate * 2),
            "-g", String(Math.max(1, Math.round(fps * plan.output.keyframeIntervalSeconds))),
            "-movflags", "+faststart",
            "-progress", "pipe:1", "-nostats",
            partial,
          ],
          timeoutMs: renderTimeoutMs(plan),
          signal: options?.signal,
          logger,
          label: "render",
          onStdout: (chunk) => {
            for (const line of chunk.toString("utf8").split(/\r?\n/u)) {
              const frame = /^frame=(\d+)/u.exec(line);
              if (frame) frames = Number(frame[1]);
              const time = /^out_time_us=(\d+)/u.exec(line);
              if (time && plan.durationSeconds > 0) {
                try {
                  options?.onProgress?.(Math.min(1, Number(time[1]) / 1e6 / plan.durationSeconds));
                } catch {
                  // A progress listener that throws must not fail the render.
                }
              }
            }
          },
        });
        await fs.promises.rename(partial, request.output);
        const { size } = await fs.promises.stat(request.output);
        logger?.info("demo_video.ffmpeg_render_done", {
          output: request.output,
          bytes: size,
          frames,
          outputSeconds: plan.durationSeconds,
          elapsedMs: Date.now() - startedAt,
        });
        return { bytes: size, durationSeconds: plan.durationSeconds, frames } satisfies DemoRenderResult;
      } catch (error) {
        await fs.promises.rm(partial, { force: true }).catch(() => undefined);
        throw error;
      } finally {
        await fs.promises.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      }
    },

    async contactSheet(request, options) {
      const count = request.times.length;
      const columns = Math.floor(request.columns);
      const tileWidth = Math.round(request.tileWidth);
      if (!count) throw new Error("A contact sheet needs at least one time.");
      if (count > CONTACT_SHEET_MAX_TILES) throw new Error(`A contact sheet holds at most ${CONTACT_SHEET_MAX_TILES} frames (asked for ${count}).`);
      if (!request.times.every(Number.isFinite)) throw new Error("A contact sheet's times must be numbers of seconds.");
      if (!(columns >= 1)) throw new Error("A contact sheet needs at least one column.");
      if (!(tileWidth >= 2)) throw new Error("A contact sheet's tiles must be at least 2 px wide.");
      const tools = await deps.resolveTools();
      const probe = await probeVideo(tools.ffprobePath, request.input, options?.signal);
      const tileHeight = Math.max(2, Math.round((tileWidth * probe.height) / probe.width));
      const lastTime = probe.durationSeconds === null ? null : Math.max(0, probe.durationSeconds - CONTACT_SHEET_END_BACKOFF_SECONDS);
      const times = request.times.map((t) => Math.max(0, lastTime === null ? t : Math.min(t, lastTime)));
      const cols = Math.min(columns, count);
      const rows = Math.ceil(count / columns);
      const width = cols * tileWidth + (cols - 1) * CONTACT_SHEET_GAP;
      const height = rows * tileHeight + (rows - 1) * CONTACT_SHEET_GAP;

      // Each tile is the first frame at or after its seek point.
      const chains = times.map((_, index) =>
        `[${index}:v]trim=end_frame=1,setpts=PTS-STARTPTS,scale=${tileWidth}:${tileHeight},setsar=1,format=rgb24[t${index}]`);
      if (count === 1) chains.push("[t0]null[out]");
      else {
        const layout = times.map((_, index) =>
          `${(index % columns) * (tileWidth + CONTACT_SHEET_GAP)}_${Math.floor(index / columns) * (tileHeight + CONTACT_SHEET_GAP)}`).join("|");
        chains.push(`${times.map((_, index) => `[t${index}]`).join("")}xstack=inputs=${count}:layout=${layout}:fill=${CONTACT_SHEET_FILL}[out]`);
      }
      const partial = path.join(path.dirname(request.output), `.${path.basename(request.output)}.${process.pid}.partial.png`);
      try {
        await runFfmpeg({
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
          timeoutMs: RENDER_MIN_TIMEOUT_MS,
          signal: options?.signal,
          logger,
          label: "contact sheet",
        });
        // ffmpeg exits cleanly with nothing written when a seek finds no frame.
        if (!fs.existsSync(partial)) throw new Error("ffmpeg contact sheet failed: the video has no frame at the asked times.");
        await fs.promises.rename(partial, request.output);
        return { width, height } satisfies DemoContactSheetResult;
      } catch (error) {
        await fs.promises.rm(partial, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}

function renderTimeoutMs(plan: DemoPlan): number {
  const lastSourceEnd = plan.segments.reduce((max, segment) => Math.max(max, segment.sourceEnd || 0), 0);
  const seconds = Math.max(4 * (plan.durationSeconds || 0), lastSourceEnd);
  return Math.max(RENDER_MIN_TIMEOUT_MS, Math.ceil(seconds * 1000));
}

// ---------------------------------------------------------------------------
// The filter graph
// ---------------------------------------------------------------------------

type Key = { t: number; v: number[] };

/** Number for an expression: fixed precision, no exponent. */
function n(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const text = value.toFixed(5).replace(/\.?0+$/u, "");
  return text === "-0" || text === "" ? "0" : text;
}

/**
 * Drops keys the linear interpolation of their neighbours already reproduces
 * within `tolerance`: the planner samples easing densely, and an expression
 * with a term per key would be thousands of terms long.
 */
function simplifyKeys(keys: Key[], tolerance: number[]): Key[] {
  if (keys.length <= 2) return keys;
  const kept: Key[] = [keys[0]!];
  let anchor = 0;
  for (let i = 2; i < keys.length; i += 1) {
    const a = keys[anchor]!;
    const b = keys[i]!;
    let fits = true;
    for (let j = anchor + 1; j < i && fits; j += 1) {
      const mid = keys[j]!;
      const f = b.t > a.t ? (mid.t - a.t) / (b.t - a.t) : 0;
      for (let d = 0; d < mid.v.length; d += 1) {
        const expected = a.v[d]! + (b.v[d]! - a.v[d]!) * f;
        if (Math.abs(expected - mid.v[d]!) > tolerance[d]!) {
          fits = false;
          break;
        }
      }
    }
    if (!fits) {
      kept.push(keys[i - 1]!);
      anchor = i - 1;
    }
  }
  kept.push(keys[keys.length - 1]!);
  return kept;
}

/** A piecewise-linear expression of `variable` through `keys`, holding the ends. */
function linearExpression(keys: Key[], dimension: number, variable: string): string {
  if (!keys.length) return "0";
  if (keys.length === 1) return n(keys[0]!.v[dimension]!);
  const terms = [`lt(${variable},${n(keys[0]!.t)})*${n(keys[0]!.v[dimension]!)}`];
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (b.t <= a.t) continue;
    const va = a.v[dimension]!;
    const slope = (b.v[dimension]! - va) / (b.t - a.t);
    terms.push(`gte(${variable},${n(a.t)})*lt(${variable},${n(b.t)})*(${n(va)}+${n(slope)}*(${variable}-${n(a.t)}))`);
  }
  const last = keys[keys.length - 1]!;
  terms.push(`gte(${variable},${n(last.t)})*${n(last.v[dimension]!)}`);
  return terms.join("+");
}

type CameraExpressions = { zoom: string; x0: string; y0: string };

/** Zoom and the viewport's top-left corner in source pixels, as functions of `variable`. */
function cameraExpressions(plan: DemoPlan, variable: string): CameraExpressions {
  const sw = plan.source.width;
  const sh = plan.source.height;
  const keys = simplifyKeys(
    (plan.camera ?? [])
      .filter((key) => [key.t, key.zoom, key.cx, key.cy].every(Number.isFinite))
      .map((key) => ({ t: key.t, v: [Math.max(1, key.zoom), key.cx, key.cy] })),
    [CAMERA_TOLERANCE.zoom, CAMERA_TOLERANCE.center, CAMERA_TOLERANCE.center],
  );
  if (!keys.length) return { zoom: "1", x0: "0", y0: "0" };
  const zoom = `max(1,${linearExpression(keys, 0, variable)})`;
  const cx = linearExpression(keys, 1, variable);
  const cy = linearExpression(keys, 2, variable);
  return {
    zoom,
    x0: `max(0,min(${n(sw)}-${n(sw)}/(${zoom}),(${cx})*${n(sw)}-${n(sw)}/(${zoom})/2))`,
    y0: `max(0,min(${n(sh)}-${n(sh)}/(${zoom}),(${cy})*${n(sh)}-${n(sh)}/(${zoom})/2))`,
  };
}

/** Where a normalized source point lands in the output, through the camera. */
function mappedExpressions(plan: DemoPlan, camera: CameraExpressions, nx: string, ny: string): { x: string; y: string } {
  const sw = plan.source.width;
  const sh = plan.source.height;
  const W = plan.output.width;
  const H = plan.output.height;
  return {
    x: `((${nx})*${n(sw)}-(${camera.x0}))*${n(W)}*(${camera.zoom})/${n(sw)}`,
    y: `((${ny})*${n(sh)}-(${camera.y0}))*${n(H)}*(${camera.zoom})/${n(sh)}`,
  };
}

/**
 * Quotes a filter option value: commas and colons inside expressions stay literal.
 *
 * ffmpeg's filter-option parser treats `\` as an escape even inside single
 * quotes, so a Windows path (`C:\Users\…`) would lose every separator and name
 * a file that does not exist. Escaping each backslash first leaves POSIX paths
 * — which contain none — byte-identical.
 */
function q(value: string): string {
  return `'${value.replace(/\\/gu, "\\\\").replace(/'/gu, "")}'`;
}

async function writeRenderGraph(
  plan: DemoPlan,
  scratch: string,
  options: { centerLines: boolean },
): Promise<{ scriptPath: string; inputArgs: string[] }> {
  const W = plan.output.width;
  const H = plan.output.height;
  const fps = plan.output.fps;
  const S = Math.min(W, H);
  const style = plan.style;
  const chains: string[] = [];
  const inputArgs: string[] = [];
  let nextInput = 1;

  // Segments: keep the covered source ranges, then lay them out in output time.
  const segments = plan.segments.filter((segment) => segment.sourceEnd > segment.sourceStart && segment.outputEnd > segment.outputStart);
  const base: string[] = ["setpts=PTS-STARTPTS"];
  if (segments.length) {
    const inside = (segment: (typeof segments)[number], index: number, variable: string): string =>
      `gte(${variable},${n(segment.sourceStart)})*${index === segments.length - 1 ? "lte" : "lt"}(${variable},${n(segment.sourceEnd)})`;
    base.push(`select=${q(segments.map((segment, index) => inside(segment, index, "t")).join("+"))}`);
    base.push(`setpts=${q(`(${segments.map((segment, index) => {
      const speed = (segment.sourceEnd - segment.sourceStart) / (segment.outputEnd - segment.outputStart);
      return `${inside(segment, index, "T")}*(${n(segment.outputStart)}+(T-${n(segment.sourceStart)})/${n(speed)})`;
    }).join("+")})/TB`)}`);
  }
  base.push(`fps=${fps}`);
  const zoomCamera = cameraExpressions(plan, "it");
  base.push(`zoompan=z=${q(zoomCamera.zoom)}:x=${q(zoomCamera.x0)}:y=${q(zoomCamera.y0)}:d=1:s=${W}x${H}:fps=${fps}`);
  base.push("format=yuv420p");
  chains.push(`[0:v]${base.join(",")}[v0]`);
  let current = "v0";
  let label = 0;
  const nextLabel = (): string => `v${++label}`;
  const camera = cameraExpressions(plan, "t");

  // Click rings: one sprite sequence, a branch per ring offset to its time.
  const rings = (plan.rings ?? []).filter((ring) => [ring.t, ring.x, ring.y].every(Number.isFinite)).slice(0, MAX_RINGS);
  if (rings.length) {
    const ring = await writeRingSprites(scratch, style, S);
    const input = nextInput++;
    inputArgs.push("-framerate", n(RING_FRAMES / Math.max(0.05, style.ringDurationSeconds)), "-i", ring.pattern);
    const copies = rings.map((_, index) => `r${index}`);
    chains.push(`[${input}:v]format=rgba,split=${rings.length}${copies.map((name) => `[${name}]`).join("")}`);
    rings.forEach((entry, index) => {
      const at = mappedExpressions(plan, camera, n(entry.x), n(entry.y));
      const timed = `rt${index}`;
      chains.push(`[r${index}]setpts=PTS-STARTPTS+${n(entry.t)}/TB[${timed}]`);
      const out = nextLabel();
      chains.push(`[${current}][${timed}]overlay=x=${q(`${at.x}-${ring.half}`)}:y=${q(`${at.y}-${ring.half}`)}:eof_action=pass:enable=${q(`between(t,${n(entry.t)},${n(entry.t + style.ringDurationSeconds)})`)}[${out}]`);
      current = out;
    });
  }

  // The pointer: one sprite, moved and shown by expressions of output time.
  const pointer = pointerTrack(plan);
  if (pointer.intervals.length) {
    const sprite = await writePointerSprite(scratch, style, S);
    const input = nextInput++;
    inputArgs.push("-loop", "1", "-i", sprite.path);
    const at = mappedExpressions(plan, camera, pointer.x, pointer.y);
    const shown = pointer.intervals.map(([start, end]) => `between(t,${n(start)},${n(end)})`).join("+");
    const out = nextLabel();
    chains.push(`[${current}][${input}:v]overlay=x=${q(`${at.x}-${sprite.tipX}`)}:y=${q(`${at.y}-${sprite.tipY}`)}:shortest=1:enable=${q(shown)}[${out}]`);
    current = out;
  }

  const fonts = resolveFonts();
  const fontOption = (bold: boolean): string => {
    const file = bold ? fonts.bold : fonts.regular;
    return file ? `fontfile=${q(file)}` : `font=${q(bold ? "Sans:style=Bold" : "Sans")}`;
  };

  // Captions are laid out first: a badge shown with a top caption moves below its box.
  const captionFontSize = style.captionFontSize * S;
  const captionPadX = captionFontSize;
  const captionPadY = 0.5 * captionFontSize;
  const captionMargin = style.captionMargin * S;
  const captions = [...(plan.captions ?? []).entries()]
    .filter(([, caption]) => caption.text?.trim() && caption.end > caption.start)
    .map(([index, caption]) => {
      const lines = wrapCaption(caption.text, captionFontSize, 0.8 * W - 2 * captionPadX);
      // drawtext's line height is about 1.2 em; the box adds the padding above and below.
      const boxHeight = lines.length * 1.2 * captionFontSize + (lines.length - 1) * 0.25 * captionFontSize + 2 * captionPadY;
      return { index, caption, lines, top: caption.position === "top", boxBottom: captionMargin + boxHeight };
    });

  // The speed badge, top right.
  for (const [index, badge] of (plan.badges ?? []).entries()) {
    if (!badge.text?.trim() || !(badge.end > badge.start)) continue;
    const fontSize = style.badgeFontSize * S;
    const padX = 0.5 * fontSize;
    const padY = 0.25 * fontSize;
    const inset = 0.8 * fontSize;
    const textPath = path.join(scratch, `badge-${index}.txt`);
    await fs.promises.writeFile(textPath, badge.text.trim(), "utf8");
    const drops = captions
      .filter((entry) => entry.top && entry.caption.start < badge.end && entry.caption.end > badge.start)
      .map((entry) => `between(t,${n(entry.caption.start)},${n(entry.caption.end)})*${n(entry.boxBottom + 0.5 * fontSize - inset)}`);
    const y = drops.length ? q(`${n(inset + padY)}+${drops.reduce((a, b) => `max(${a},${b})`)}`) : n(inset + padY);
    const out = nextLabel();
    chains.push(`[${current}]drawtext=${fontOption(true)}:textfile=${q(textPath)}:expansion=none:fontsize=${n(fontSize)}:fontcolor=white:box=1:boxcolor=0x111111@0.72:boxborderw=${Math.round(padY)}|${Math.round(padX)}:x=${q(`w-${n(inset + padX)}-text_w`)}:y=${y}:enable=${q(`between(t,${n(badge.start)},${n(badge.end)})`)}[${out}]`);
    current = out;
  }

  // Captions, bottom or top center, with the other engines' short fade.
  for (const { index, caption, lines, top } of captions) {
    const fontSize = captionFontSize;
    const padX = captionPadX;
    const padY = captionPadY;
    const textPath = path.join(scratch, `caption-${index}.txt`);
    await fs.promises.writeFile(textPath, lines.join("\n"), "utf8");
    const fade = Math.min(0.15, (caption.end - caption.start) / 2);
    const alpha = fade > 0
      ? `max(0,min(1,min((t-${n(caption.start)})/${n(fade)},(${n(caption.end)}-t)/${n(fade)})))`
      : "1";
    const out = nextLabel();
    chains.push(`[${current}]drawtext=${fontOption(true)}:textfile=${q(textPath)}:expansion=none:fontsize=${n(fontSize)}:line_spacing=${n(0.25 * fontSize)}${options.centerLines && lines.length > 1 ? ":text_align=center" : ""}:fontcolor=white:box=1:boxcolor=0x111111@0.8:boxborderw=${Math.round(padY)}|${Math.round(padX)}:x=${q("(w-text_w)/2")}:y=${top ? n(captionMargin + padY) : q(`h-${n(captionMargin + padY)}-text_h`)}:alpha=${q(alpha)}:enable=${q(`between(t,${n(caption.start)},${n(caption.end)})`)}[${out}]`);
    current = out;
  }

  chains.push(`[${current}]null[out]`);
  const scriptPath = path.join(scratch, "graph.txt");
  await fs.promises.writeFile(scriptPath, chains.join(";\n"), "utf8");
  return { scriptPath, inputArgs };
}

/**
 * The pointer as expressions: its position between visible keys, held on a
 * visible key until the next one, and the output-time spans it shows in.
 */
function pointerTrack(plan: DemoPlan): { x: string; y: string; intervals: Array<[number, number]> } {
  const keys = (plan.cursor ?? []).filter((key) => [key.t, key.x, key.y].every(Number.isFinite));
  const intervals: Array<[number, number]> = [];
  const moves: Key[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]!;
    if (!key.visible) continue;
    const next = keys[i + 1];
    const end = next ? next.t : Math.max(key.t, plan.durationSeconds);
    const last = intervals[intervals.length - 1];
    if (last && Math.abs(last[1] - key.t) < 1e-6) last[1] = end;
    else intervals.push([key.t, end]);
    moves.push({ t: key.t, v: [key.x, key.y] });
    if (next && !next.visible) moves.push({ t: next.t, v: [key.x, key.y] });
  }
  const simplified = simplifyKeys(moves, [CURSOR_TOLERANCE, CURSOR_TOLERANCE]);
  return {
    x: linearExpression(simplified, 0, "t"),
    y: linearExpression(simplified, 1, "t"),
    intervals,
  };
}

/** Up to two lines, measured with DejaVu Sans Bold's average advance; the rest is ellipsized. */
function wrapCaption(text: string, fontSize: number, maxWidth: number): string[] {
  const advance = 0.62 * fontSize;
  const maxChars = Math.max(4, Math.floor(maxWidth / advance));
  const words = text.trim().split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || candidate.length <= maxChars) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  const two = lines.length > 2 ? [lines[0]!, lines.slice(1).join(" ")] : lines;
  return two.map((entry) => (entry.length > maxChars ? `${entry.slice(0, maxChars - 1).trimEnd()}…` : entry));
}

let cachedFonts: { regular: string | null; bold: string | null } | null = null;

/**
 * A font file Windows ships, under `%WINDIR%\Fonts`.
 *
 * `fc-match` is a fontconfig tool and Windows has no fontconfig, so the
 * fallback `font=Sans` needs the ffmpeg build to carry one. A real file from
 * the system font directory always works.
 */
function windowsFontFile(names: readonly string[]): string | null {
  const root = process.env.WINDIR?.trim() || process.env.SystemRoot?.trim();
  if (!root) return null;
  for (const name of names) {
    const candidate = path.join(root, "Fonts", name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Font files via fontconfig (macOS and Linux) or the Windows system fonts. */
function resolveFonts(): { regular: string | null; bold: string | null } {
  if (cachedFonts) return cachedFonts;
  const match = (pattern: string): string | null => {
    try {
      const result = spawnSync("fc-match", ["-f", "%{file}", pattern], { encoding: "utf8", timeout: 5_000 });
      const file = result.status === 0 ? result.stdout.trim() : "";
      return file && fs.existsSync(file) ? file : null;
    } catch {
      return null;
    }
  };
  const onWindows = process.platform === "win32";
  const regular = onWindows
    ? windowsFontFile(["segoeui.ttf", "arial.ttf"]) ?? match("sans")
    : match("sans");
  const bold = onWindows
    ? windowsFontFile(["segoeuib.ttf", "arialbd.ttf"]) ?? match("sans:bold")
    : match("sans:bold");
  cachedFonts = { regular, bold };
  return cachedFonts;
}

// ---------------------------------------------------------------------------
// Sprites: rasterized here, written as PNG
// ---------------------------------------------------------------------------

type Rgba = { width: number; height: number; data: Uint8Array };

function hexColor(value: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/iu.exec(value.trim());
  const hex = match ? match[1]! : "8b5cf6";
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const f = length > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
  return Math.hypot(px - (ax + f * dx), py - (ay + f * dy));
}

function insidePolygon(px: number, py: number, polygon: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 4×4 supersampling: `shade` answers the colour at a point, or null for clear. */
function rasterize(width: number, height: number, shade: (x: number, y: number) => [number, number, number, number] | null): Rgba {
  const data = new Uint8Array(width * height * 4);
  const grid = 4;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < grid; sy += 1) {
        for (let sx = 0; sx < grid; sx += 1) {
          const sample = shade(x + (sx + 0.5) / grid, y + (sy + 0.5) / grid);
          if (!sample) continue;
          r += sample[0] * sample[3];
          g += sample[1] * sample[3];
          b += sample[2] * sample[3];
          a += sample[3];
        }
      }
      const offset = (y * width + x) * 4;
      if (a > 0) {
        data[offset] = Math.round(r / a);
        data[offset + 1] = Math.round(g / a);
        data[offset + 2] = Math.round(b / a);
        data[offset + 3] = Math.round((a / (grid * grid)) * 255);
      }
    }
  }
  return { width, height, data };
}

async function writePointerSprite(scratch: string, style: DemoPlan["style"], S: number): Promise<{ path: string; tipX: number; tipY: number }> {
  const h = Math.max(8, style.pointerHeight * S);
  const stroke = 0.06 * h;
  const margin = Math.ceil(stroke) + 1;
  const width = Math.ceil(0.6 * h) + margin * 2;
  const height = Math.ceil(h) + margin * 2;
  const polygon = DEMO_POINTER_POLYGON.map(([x, y]) => [margin + x * h, margin + y * h] as [number, number]);
  const image = rasterize(width, height, (x, y) => {
    let edge = Infinity;
    for (let i = 0; i < polygon.length; i += 1) {
      const [ax, ay] = polygon[i]!;
      const [bx, by] = polygon[(i + 1) % polygon.length]!;
      edge = Math.min(edge, distanceToSegment(x, y, ax, ay, bx, by));
    }
    if (edge <= stroke / 2) return [17, 17, 17, 1];
    return insidePolygon(x, y, polygon) ? [255, 255, 255, 1] : null;
  });
  const file = path.join(scratch, "pointer.png");
  await fs.promises.writeFile(file, encodePng(image));
  return { path: file, tipX: margin, tipY: margin };
}

async function writeRingSprites(scratch: string, style: DemoPlan["style"], S: number): Promise<{ pattern: string; half: number }> {
  const [r, g, b] = hexColor(style.accent);
  const lineWidth = Math.max(1, style.ringLineWidth * S);
  const maxRadius = Math.max(style.ringStartRadius, style.ringEndRadius) * S;
  const half = Math.ceil(maxRadius + lineWidth) + 1;
  const size = half * 2;
  for (let frame = 0; frame < RING_FRAMES; frame += 1) {
    const p = (frame + 0.5) / RING_FRAMES;
    const eased = 1 - (1 - p) * (1 - p);
    const radius = Math.max(0, (style.ringStartRadius + (style.ringEndRadius - style.ringStartRadius) * eased) * S);
    const alpha = 1 - p;
    const image = rasterize(size, size, (x, y) =>
      Math.abs(Math.hypot(x - half, y - half) - radius) <= lineWidth / 2 ? [r, g, b, alpha] : null);
    await fs.promises.writeFile(path.join(scratch, `ring-${String(frame).padStart(2, "0")}.png`), encodePng(image));
  }
  return { pattern: path.join(scratch, "ring-%02d.png"), half };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(payload)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An 8-bit RGBA PNG, unfiltered rows. */
function encodePng(image: Rgba): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(image.data.buffer, image.data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

async function probeVideo(
  ffprobePath: string,
  inputPath: string,
  signal?: AbortSignal,
): Promise<{ width: number; height: number; durationSeconds: number | null }> {
  let stdout = "";
  await runFfmpeg({
    binaryPath: ffprobePath,
    args: [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height:format=duration",
      "-of", "json",
      inputPath,
    ],
    timeoutMs: 30_000,
    signal,
    logger: null,
    label: "probe",
    onStdout: (chunk) => {
      stdout += chunk.toString("utf8");
    },
  });
  let parsed: { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("ffprobe printed something that is not JSON.");
  }
  const stream = parsed.streams?.[0];
  if (!stream?.width || !stream?.height) throw new Error("ffprobe found no video stream in the recording.");
  const duration = Number(parsed.format?.duration);
  return { width: stream.width, height: stream.height, durationSeconds: Number.isFinite(duration) ? duration : null };
}

function abortError(label: string): Error {
  const error = new Error(`ffmpeg ${label} was cancelled.`);
  error.name = "AbortError";
  return error;
}

/** Runs ffmpeg or ffprobe once without a shell. */
function runFfmpeg(args: {
  binaryPath: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  logger: Logger | null;
  label: string;
  onStdout?: (chunk: Buffer) => void;
  /** True when the line was consumed and is not an error line. */
  onStderrLine?: (line: string) => boolean;
}): Promise<void> {
  const { label, logger, signal } = args;
  if (signal?.aborted) return Promise.reject(abortError(label));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let stopReason: Error | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let stderrBuffer = "";
    const stderrTail: string[] = [];
    const child = spawn(args.binaryPath, args.args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const stop = (reason: Error): void => {
      if (stopReason || settled) return;
      stopReason = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const onAbort = (): void => stop(abortError(label));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      stop(new Error(`ffmpeg ${label} timed out after ${Math.round(args.timeoutMs / 1000)} s.`));
    }, args.timeoutMs);
    timeout.unref?.();

    const consumeStderrLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed || args.onStderrLine?.(trimmed)) return;
      stderrTail.push(trimmed);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        args.onStdout?.(chunk);
      } catch (error) {
        stop(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      let newline = stderrBuffer.indexOf("\n");
      while (newline >= 0) {
        consumeStderrLine(stderrBuffer.slice(0, newline));
        stderrBuffer = stderrBuffer.slice(newline + 1);
        newline = stderrBuffer.indexOf("\n");
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      logger?.warn("demo_video.ffmpeg_spawn_failed", { label, binaryPath: args.binaryPath, error: error.message });
      finish(new Error(`Could not start ${path.basename(args.binaryPath)} (${error.code ?? error.message}).`));
    });
    child.once("close", (code: number | null, exitSignal: NodeJS.Signals | null) => {
      if (killTimer) clearTimeout(killTimer);
      if (stderrBuffer) consumeStderrLine(stderrBuffer);
      if (stopReason) {
        finish(stopReason);
        return;
      }
      if (code === 0) {
        finish(null);
        return;
      }
      const detail = stderrTail[stderrTail.length - 1] ?? (exitSignal ? `killed by ${exitSignal}` : `exit code ${code}`);
      logger?.warn("demo_video.ffmpeg_failed", { label, code, signal: exitSignal, stderr: stderrTail.join("\n") });
      finish(new Error(`ffmpeg ${label} failed: ${detail}`));
    });
  });
}
