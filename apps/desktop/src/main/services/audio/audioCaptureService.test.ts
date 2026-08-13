import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AudioCaptureError, createAudioCaptureService } from "./audioCaptureService";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof createAudioCaptureService>[0]["logger"];

describe("audio capture service", () => {
  let captureDir: string;

  beforeEach(() => {
    captureDir = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "ade-audio-svc-")),
      "audio-captures",
    );
  });

  afterEach(() => {
    fs.rmSync(path.dirname(captureDir), { recursive: true, force: true });
  });

  const service = () => createAudioCaptureService({ logger: silentLogger, captureDir });
  const pcm = (samples = 16_000) => new Int16Array(samples);

  it("writes a readable WAV and reports where it landed", () => {
    const clip = service().writeClip(Int16Array.from([0, 1000, -1000, 500]), { sampleRate: 16_000 });

    const bytes = fs.readFileSync(clip.audioPath);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
    // 44-byte header + one 16-bit sample per PCM entry.
    expect(bytes.byteLength).toBe(44 + 4 * 2);
    expect(path.dirname(clip.audioPath)).toBe(captureDir);
  });

  it("reports duration from the sample count, not the wall clock", () => {
    // One second of 16 kHz audio, regardless of how long the write took.
    expect(service().writeClip(pcm(16_000), { sampleRate: 16_000 }).durationMs).toBe(1000);
    expect(service().writeClip(pcm(8_000), { sampleRate: 16_000 }).durationMs).toBe(500);
  });

  it("refuses empty audio without creating the directory", () => {
    expect(() => service().writeClip(new Int16Array(0))).toThrow(AudioCaptureError);
    expect(fs.existsSync(captureDir)).toBe(false);
  });

  it("refuses an implausible sample rate", () => {
    expect(() => service().writeClip(pcm(16), { sampleRate: 1 })).toThrow(/sample rate/);
    expect(() => service().writeClip(pcm(16), { sampleRate: 1_000_000 })).toThrow(/sample rate/);
  });

  it("gives every clip its own path", () => {
    const svc = service();
    const first = svc.writeClip(pcm(16));
    const second = svc.writeClip(pcm(16));
    expect(first.audioPath).not.toBe(second.audioPath);
    expect(fs.readdirSync(captureDir)).toHaveLength(2);
  });

  it("discards a clip it staged", () => {
    const svc = service();
    const clip = svc.writeClip(pcm(16));
    svc.discardClip(clip.audioPath);
    expect(fs.existsSync(clip.audioPath)).toBe(false);
  });

  it("refuses to delete a path it did not mint", () => {
    // The clip path crosses a process boundary to reach its caller. If any path
    // handed back were deleted, a capture capability would double as an
    // arbitrary file-delete primitive.
    const svc = service();
    svc.writeClip(pcm(16));
    const bystander = path.join(path.dirname(captureDir), "not-ours.txt");
    fs.writeFileSync(bystander, "keep me");

    svc.discardClip(bystander);

    expect(fs.existsSync(bystander)).toBe(true);
  });

  it("accepts a ten-minute recording", () => {
    // Callers ask for `maxDurationMs: 600000`, and the IPC layer's buffer
    // ceiling has to sit clear of that. When it sat BELOW the requested
    // duration, a full-length recording was captured, the user waited through
    // it, and the clip was rejected at the last step with nothing recoverable.
    const tenMinutes = 16_000 * 60 * 10;
    const clip = service().writeClip(new Int16Array(tenMinutes), { sampleRate: 16_000 });
    expect(clip.durationMs).toBe(600_000);
  });

  it("leaves handed-over clips on disk when disposed", () => {
    // A caller may still be reading a clip when the app tears down, and the
    // startup sweep collects what is genuinely stale. Deleting here would race
    // a plugin mid-read.
    const svc = service();
    const clip = svc.writeClip(pcm(16));
    svc.dispose();
    expect(fs.existsSync(clip.audioPath)).toBe(true);
  });
});
