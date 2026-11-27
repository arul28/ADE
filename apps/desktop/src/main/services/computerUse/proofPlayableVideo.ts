import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveExecutableFromKnownLocations } from "../ai/cliExecutableResolver";
import { ensureFfmpegTools, ffmpegDownloadable, resolveFfmpegTools, runFfmpeg } from "../demoVideo/ffmpegDemoEngine";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { BRAND } from "../../../shared/brand";

/**
 * Videos every ADE viewer can play: the desktop's Chromium, the hosted web
 * client in any browser, and AVPlayer on the phone. An H.264 MP4 plays in all
 * of them; a WebM does not play on the phone, and a MOV or MKV is a gamble in
 * a browser that is not Safari.
 */
const PLAYABLE_VIDEO_EXTENSIONS = new Set([".mp4", ".m4v"]);
const CONVERTIBLE_VIDEO_EXTENSIONS = new Set([".mov", ".qt", ".webm", ".mkv", ".avi"]);
/** Every video extension the CTO shows: the ones that play everywhere and the ones it converts. */
export const PROOF_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([...PLAYABLE_VIDEO_EXTENSIONS, ...CONVERTIBLE_VIDEO_EXTENSIONS]);
/** Containers whose video is usually already H.264 (screen and phone recordings). */
const REMUX_FIRST_EXTENSIONS = new Set([".mov", ".qt", ".mkv"]);
const CONVERT_TIMEOUT_MS = 5 * 60_000;

/** A video `ensurePlayableVideo` may need to copy: every container, since an MP4 can hold HEVC. */
export function isProofVideoPath(filePath: string): boolean {
  return PROOF_VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export type PlayableVideoResult =
  | { path: string; converted: false }
  | { path: string; converted: true; via: "ffmpeg-remux" | "ffmpeg" | "avconvert" };

/** Local ffmpeg builds already checked for libx264, by path. */
const h264Capable = new Map<string, boolean>();

function encodesH264(binaryPath: string): Promise<boolean> {
  const known = h264Capable.get(binaryPath);
  if (known !== undefined) return Promise.resolve(known);
  return new Promise((resolve) => {
    execFile(binaryPath, ["-hide_banner", "-encoders"], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      const capable = !error && /\blibx264\b/.test(String(stdout ?? ""));
      h264Capable.set(binaryPath, capable);
      resolve(capable);
    });
  });
}

/**
 * An ffmpeg that can encode H.264: one on this machine with libx264 (a build
 * without it, like Fedora's `ffmpeg-free`, is skipped; drawtext, which the
 * demo renderer also needs, is not), else the demo renderer's choice, else
 * ADE's pinned copy, downloaded on first use where ADE ships one.
 */
async function ffmpegPath(): Promise<string | null> {
  const local = resolveExecutableFromKnownLocations("ffmpeg")?.path;
  if (local && await encodesH264(local)) return local;
  const found = resolveFfmpegTools();
  if (found) return found.ffmpegPath;
  if (!ffmpegDownloadable()) return null;
  return (await ensureFfmpegTools()).ffmpegPath;
}

function avconvert(source: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/avconvert",
      ["--source", source, "--output", output, "--preset", "PresetHighestQuality", "--replace"],
      { timeout: CONVERT_TIMEOUT_MS, windowsHide: true },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

async function nonEmptyFile(filePath: string): Promise<boolean> {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  return Boolean(stat?.isFile() && stat.size > 0);
}

/**
 * `sourcePath` as a video every viewer plays. An MP4 comes back as it is.
 * A MOV, MKV, WebM or AVI becomes an H.264 MP4 next to `outputDir`: remuxed
 * when its video already is H.264 (seconds), re-encoded otherwise. On a Mac
 * with no ffmpeg, a MOV goes through the system's `avconvert`.
 *
 * Throws a sentence the caller can repeat when no converter can read it. Any
 * other kind of file comes back unchanged: this is only about videos.
 */
export async function ensurePlayableVideo(args: {
  sourcePath: string;
  outputDir: string;
  logger?: Logger | null;
  signal?: AbortSignal;
}): Promise<PlayableVideoResult> {
  const { sourcePath, outputDir, logger = null, signal } = args;
  const extension = path.extname(sourcePath).toLowerCase();
  if (PLAYABLE_VIDEO_EXTENSIONS.has(extension)) {
    // An MP4 is a container: HEVC or VP9 inside one fails in most browsers.
    // Probed with any ffmpeg here (any build reads a codec), else the one
    // conversion would use, downloaded where ADE ships one. With none at
    // all (a Mac without ffmpeg) it passes as it is.
    const probe = resolveExecutableFromKnownLocations("ffmpeg")?.path
      ?? await ffmpegPath().catch((error) => {
        logger?.warn("proof.video_convert_ffmpeg_unavailable", { error: getErrorMessage(error) });
        return null;
      });
    const codec = probe ? await videoCodec(probe, sourcePath) : null;
    if (!codec || codec === "h264") return { path: sourcePath, converted: false };
  } else if (!CONVERTIBLE_VIDEO_EXTENSIONS.has(extension)) {
    return { path: sourcePath, converted: false };
  }
  await fs.promises.mkdir(outputDir, { recursive: true });
  const output = path.join(outputDir, `${path.basename(sourcePath, path.extname(sourcePath))}-${randomUUID()}.mp4`);
  const tryFfmpeg = async (binaryPath: string, remux: boolean): Promise<boolean> => {
    try {
      await runFfmpeg({
        binaryPath,
        args: [
          "-hide_banner", "-loglevel", "error", "-y",
          "-i", sourcePath,
          ...(remux
            ? ["-c:v", "copy", "-c:a", "aac"]
            : [
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
                // libx264 needs even sides; a window recording often has an odd one.
                "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                "-c:a", "aac",
              ]),
          "-movflags", "+faststart",
          output,
        ],
        timeoutMs: CONVERT_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
        logger,
        label: remux ? "proof-remux" : "proof-convert",
      });
      if (!(await nonEmptyFile(output))) return false;
      if (remux && !(await remuxedIsH264(binaryPath, output))) return false;
      return true;
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        await fs.promises.rm(output, { force: true }).catch(() => undefined);
        throw error;
      }
      logger?.warn("proof.video_convert_attempt_failed", { sourcePath, remux, error: getErrorMessage(error) });
      return false;
    }
  };
  const ffmpeg = await ffmpegPath().catch((error) => {
    logger?.warn("proof.video_convert_ffmpeg_unavailable", { error: getErrorMessage(error) });
    return null;
  });
  if (ffmpeg) {
    if (REMUX_FIRST_EXTENSIONS.has(extension) && await tryFfmpeg(ffmpeg, true)) {
      return { path: output, converted: true, via: "ffmpeg-remux" };
    }
    if (await tryFfmpeg(ffmpeg, false)) return { path: output, converted: true, via: "ffmpeg" };
  }
  if (process.platform === "darwin" && (extension === ".mov" || extension === ".qt")) {
    try {
      await avconvert(sourcePath, output);
      if (await nonEmptyFile(output)) return { path: output, converted: true, via: "avconvert" };
    } catch (error) {
      logger?.warn("proof.video_convert_avconvert_failed", { sourcePath, error: getErrorMessage(error) });
    }
  }
  await fs.promises.rm(output, { force: true }).catch(() => undefined);
  throw new Error(
    ffmpeg
      ? `${BRAND.NAME} could not convert ${path.basename(sourcePath)} to MP4, so it may not play on every device.`
      : `This machine has no ffmpeg to convert ${path.basename(sourcePath)} to MP4, so it may not play on every device.`,
  );
}

/** The first video stream's codec (`h264`, `hevc`, `vp9`), or null when there is none or ffmpeg cannot read it. */
function videoCodec(ffmpegBinary: string, filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    // `ffmpeg -i` with no output prints the stream list on stderr and exits 1.
    execFile(ffmpegBinary, ["-hide_banner", "-i", filePath], { timeout: 15_000, windowsHide: true }, (_error, _stdout, stderr) => {
      const match = /Stream #.*Video:\s*([a-z0-9_]+)/i.exec(String(stderr ?? ""));
      resolve(match ? match[1]!.toLowerCase() : null);
    });
  });
}

/** A remux keeps the source codec; HEVC or VP9 in an MP4 still fails in most browsers. */
async function remuxedIsH264(ffmpegBinary: string, filePath: string): Promise<boolean> {
  return (await videoCodec(ffmpegBinary, filePath)) === "h264";
}
