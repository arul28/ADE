import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureFfmpegTools, ffmpegDownloadable, resolveFfmpegTools, runFfmpeg } from "../demoVideo/ffmpegDemoEngine";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";

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

export function isConvertibleVideoPath(filePath: string): boolean {
  return CONVERTIBLE_VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export type PlayableVideoResult =
  | { path: string; converted: false }
  | { path: string; converted: true; via: "ffmpeg-remux" | "ffmpeg" | "avconvert" };

/**
 * An ffmpeg that can encode H.264: one on this machine (a build without
 * libx264, like Fedora's `ffmpeg-free`, is skipped), else ADE's pinned copy,
 * downloaded on first use where ADE ships one.
 */
async function ffmpegPath(): Promise<string | null> {
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
  if (!CONVERTIBLE_VIDEO_EXTENSIONS.has(extension)) return { path: sourcePath, converted: false };
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
      ? `ADE could not convert ${path.basename(sourcePath)} to MP4, so it may not play on every device.`
      : `This machine has no ffmpeg to convert ${path.basename(sourcePath)} to MP4, so it may not play on every device.`,
  );
}

/** A remux keeps the source codec; HEVC or VP9 in an MP4 still fails in most browsers. */
function remuxedIsH264(ffmpegBinary: string, filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    // `ffmpeg -i` with no output prints the stream list on stderr and exits 1.
    execFile(ffmpegBinary, ["-hide_banner", "-i", filePath], { timeout: 15_000, windowsHide: true }, (_error, _stdout, stderr) => {
      const videoLine = String(stderr ?? "").split("\n").find((line) => /Stream #.*Video:/.test(line)) ?? "";
      resolve(/Video:\s*h264\b/.test(videoLine));
    });
  });
}
