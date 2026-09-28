/**
 * The `swift` demo engine: a client for the `ade-media` binary
 * (`native/ADEMedia`), macOS only.
 *
 * Each call is one short-lived process:
 *
 * - `ade-media analyze <input>` prints one `DemoAnalysis` JSON line.
 * - `ade-media render <request.json>` prints one `DemoRenderResult` JSON line
 *   and reports `progress 0.42` lines on stderr while it works.
 *
 * On failure the binary exits 1 with `error: <message>` as its last stderr
 * line; that message becomes the rejected Error's message, so the demo
 * service can file it as the fallback reason as is. The binary writes its
 * output beside the target and renames it at the end, and deletes that partial
 * file when it is stopped, so cancelling or timing out never leaves half a
 * video at `output`.
 *
 * Off macOS the engine reads nothing (`canRead` is false) and every call
 * rejects, so importing this module is safe on Windows and Linux.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DemoAnalysis,
  DemoEngine,
  DemoRenderRequest,
  DemoRenderResult,
} from "../../../shared/demoVideo/demoContract";
import {
  DEMO_ANALYSIS_MIN_INTERVAL_SECONDS,
  DEMO_ANALYSIS_PIXEL_DELTA,
  DEMO_ANALYSIS_THUMBNAIL_LONG_SIDE,
  RECORDING_MAX_MS,
} from "../../../shared/demoVideo/demoContract";
import type { Logger } from "../logging/logger";

const READABLE_EXTENSIONS = new Set([".mp4", ".mov", ".m4v"]);

/** A raw file is at most {@link RECORDING_MAX_MS} long; decoding it runs many times faster. */
const ANALYZE_TIMEOUT_MS = Math.max(120_000, RECORDING_MAX_MS);
const RENDER_MIN_TIMEOUT_MS = 60_000;
/** After SIGTERM, how long `ade-media` gets to delete its partial file before SIGKILL. */
const KILL_GRACE_MS = 3_000;
/** The analysis of a five-minute 60 fps file is well under a megabyte. */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_LINES = 20;

export type SwiftDemoEngineDeps = {
  /** From `resolveAdeMediaBinary`. */
  binaryPath: string;
  logger?: Logger | null;
};

/**
 * How long a render may take: three times the output, and never less than a
 * minute. The source the plan reads is counted too, because the binary decodes
 * every frame up to the last segment's end even when most of it is cut.
 */
function swiftRenderTimeoutMs(request: DemoRenderRequest): number {
  const plan = request.plan;
  const lastSourceEnd = plan.segments.reduce((max, segment) => Math.max(max, segment.sourceEnd || 0), 0);
  const seconds = Math.max(3 * (plan.durationSeconds || 0), lastSourceEnd);
  return Math.max(RENDER_MIN_TIMEOUT_MS, Math.ceil(seconds * 1000));
}

export function createSwiftDemoEngine(deps: SwiftDemoEngineDeps): DemoEngine {
  const { binaryPath } = deps;
  const logger = deps.logger ?? null;
  const supported = process.platform === "darwin" && binaryPath.length > 0;

  function assertSupported(): void {
    if (!supported) throw new Error("The Swift demo engine (ade-media) only runs on macOS.");
  }

  return {
    id: "swift",

    canRead(inputPath: string): boolean {
      return supported && READABLE_EXTENSIONS.has(path.extname(inputPath).toLowerCase());
    },

    async analyze(inputPath, options) {
      assertSupported();
      const stdout = await runAdeMedia({
        binaryPath,
        // The contract's analysis rules, so both engines measure the same way.
        args: [
          "analyze",
          inputPath,
          String(DEMO_ANALYSIS_THUMBNAIL_LONG_SIDE),
          String(DEMO_ANALYSIS_PIXEL_DELTA),
          String(DEMO_ANALYSIS_MIN_INTERVAL_SECONDS),
        ],
        timeoutMs: ANALYZE_TIMEOUT_MS,
        signal: options?.signal,
        logger,
        label: "analyze",
      });
      const analysis = parseLastJsonLine(stdout, "analyze") as DemoAnalysis;
      if (
        !analysis
        || typeof analysis.width !== "number"
        || typeof analysis.height !== "number"
        || typeof analysis.durationSeconds !== "number"
        || !Array.isArray(analysis.frames)
      ) {
        throw new Error("ade-media analyze printed something that is not an analysis.");
      }
      return analysis;
    },

    async render(request, options) {
      assertSupported();
      const requestPath = path.join(os.tmpdir(), `ade-media-request-${process.pid}-${randomUUID()}.json`);
      await fs.promises.writeFile(requestPath, JSON.stringify(request), { encoding: "utf8", mode: 0o600 });
      const startedAt = Date.now();
      try {
        const stdout = await runAdeMedia({
          binaryPath,
          args: ["render", requestPath],
          timeoutMs: swiftRenderTimeoutMs(request),
          signal: options?.signal,
          logger,
          label: "render",
          onProgress: options?.onProgress,
        });
        const result = parseLastJsonLine(stdout, "render") as DemoRenderResult;
        if (
          !result
          || typeof result.bytes !== "number"
          || typeof result.durationSeconds !== "number"
          || typeof result.frames !== "number"
        ) {
          throw new Error("ade-media render printed something that is not a render result.");
        }
        logger?.info("demo_video.swift_render_done", {
          output: request.output,
          bytes: result.bytes,
          frames: result.frames,
          outputSeconds: result.durationSeconds,
          elapsedMs: Date.now() - startedAt,
        });
        return result;
      } catch (error) {
        await removePartialOutputs(request.output);
        throw error;
      } finally {
        await fs.promises.rm(requestPath, { force: true }).catch(() => undefined);
      }
    },
  };
}

/**
 * `ade-media` deletes its partial file (`.<name>.<pid>.partial.mp4`, plus the
 * writer's `…sb-*` scratch copy) itself, unless it had to be SIGKILLed after
 * the grace period. This sweeps what such a kill left beside `output`.
 */
async function removePartialOutputs(output: string): Promise<void> {
  const directory = path.dirname(output);
  const prefix = `.${path.basename(output)}.`;
  const names = await fs.promises.readdir(directory).catch(() => [] as string[]);
  await Promise.all(names
    .filter((name) => name.startsWith(prefix) && name.includes(".partial.mp4"))
    .map((name) => fs.promises.rm(path.join(directory, name), { force: true }).catch(() => undefined)));
}

function parseLastJsonLine(stdout: string, label: string): unknown {
  const line = stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean).pop();
  if (!line) throw new Error(`ade-media ${label} finished without printing a result.`);
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`ade-media ${label} printed a result that is not JSON.`);
  }
}

function abortError(label: string): Error {
  const error = new Error(`ade-media ${label} was cancelled.`);
  error.name = "AbortError";
  return error;
}

/** Runs `ade-media` once without a shell; resolves with its stdout on exit 0. */
function runAdeMedia(args: {
  binaryPath: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  logger: Logger | null;
  label: string;
  onProgress?: (fraction: number) => void;
}): Promise<string> {
  const { label, logger, signal } = args;
  if (signal?.aborted) return Promise.reject(abortError(label));

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stdoutBytes = 0;
    let stderrBuffer = "";
    const stderrTail: string[] = [];
    let errorLine: string | null = null;
    let stopReason: Error | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let timeout: NodeJS.Timeout | null = null;

    const child = spawn(args.binaryPath, args.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "en_US.UTF-8" },
      windowsHide: true,
    });

    const finish = (error: Error | null, value?: string): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value ?? "");
    };

    // SIGTERM first: `ade-media` deletes its partial output on it. SIGKILL
    // only if it has not gone after the grace period.
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
    timeout = setTimeout(() => {
      stop(new Error(`ade-media ${label} timed out after ${Math.round(args.timeoutMs / 1000)} s.`));
    }, args.timeoutMs);
    timeout.unref?.();

    const consumeStderrLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const progress = /^progress\s+([0-9.]+)$/u.exec(trimmed);
      if (progress) {
        const fraction = Number(progress[1]);
        if (Number.isFinite(fraction)) {
          try {
            args.onProgress?.(Math.min(1, Math.max(0, fraction)));
          } catch {
            // A progress listener that throws must not fail the render.
          }
        }
        return;
      }
      if (trimmed.startsWith("error:")) errorLine = trimmed.slice("error:".length).trim();
      stderrTail.push(trimmed);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        stop(new Error(`ade-media ${label} printed more than ${MAX_STDOUT_BYTES} bytes.`));
        return;
      }
      stdout += chunk;
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
      // ENOENT or EACCES: the binary is missing or not executable.
      logger?.warn("demo_video.swift_spawn_failed", { label, binaryPath: args.binaryPath, error: error.message });
      finish(new Error(`Could not start ade-media (${error.code ?? error.message}).`));
    });

    child.once("close", (code: number | null, exitSignal: NodeJS.Signals | null) => {
      if (killTimer) clearTimeout(killTimer);
      if (stderrBuffer) consumeStderrLine(stderrBuffer);
      if (stopReason) {
        finish(stopReason);
        return;
      }
      if (code === 0) {
        finish(null, stdout);
        return;
      }
      const message = errorLine
        ?? (exitSignal ? `ade-media ${label} was killed by ${exitSignal}.` : `ade-media ${label} exited with code ${code}.`);
      logger?.warn("demo_video.swift_failed", { label, code, signal: exitSignal, message, stderr: stderrTail.join("\n") });
      finish(new Error(message));
    });
  });
}
