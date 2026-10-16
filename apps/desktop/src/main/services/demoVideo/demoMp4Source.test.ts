import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectDemoMp4, readDemoMp4 } from "./demoMp4Source";
import { box, ftypOnly, full, movie, u32, u64, wideHeader } from "./__fixtures__/demoMp4Bytes";

/**
 * The MP4 reader decides whether a recording is ever filed as proof: an
 * unusable movie is refused, anything else reports the length read from its
 * own index. Its input is a file a native recorder wrote (or failed to finish),
 * so every count in it is untrusted. The movies here are built byte by byte.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeMovie(bytes: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-demo-mp4-"));
  roots.push(dir);
  const file = path.join(dir, "raw.mp4");
  fs.writeFileSync(file, bytes);
  return file;
}

describe("inspectDemoMp4", () => {
  it.each([
    ["a finished H.264 movie", movie({ frames: 3, delta: 100 }), "ok", null],
    ["a movie whose chunk offsets are 64-bit", movie({ frames: 4, delta: 250, co64: true }), "ok", null],
    ["an empty file", Buffer.alloc(0), "unusable", /empty/i],
    ["a recorder that died before writing its index", Buffer.concat([ftypOnly, box("mdat", Buffer.alloc(64))]), "unusable", /never finished/i],
    ["a movie with no frames", movie({ frames: 0 }), "unusable", /no frames/i],
    ["a sample table that claims more entries than it holds", movie({ stszCount: 1_000 }), "unusable", /stsz.*more entries/i],
    ["a sample count of 0xFFFFFFFF", movie({ stszCount: 0xffff_ffff }), "unusable", /stsz/i],
    ["a uniform sample size with a count of 0xFFFFFFFF", movie({ stszUniform: 16, stszCount: 0xffff_ffff }), "unusable", /stsz/i],
    ["a 64-bit box that runs past the end before the index", Buffer.concat([ftypOnly, wideHeader("mdat", 1n << 40n), Buffer.alloc(32)]), "unusable", /cut short/i],
    ["a 64-bit box size no file can have", Buffer.concat([ftypOnly, wideHeader("mdat", 0xffff_ffff_ffff_ffffn), Buffer.alloc(32)]), "unusable", /impossible size/i],
  ])("%s", async (_name, bytes, status, reason) => {
    const inspection = await inspectDemoMp4(writeMovie(bytes));
    expect(inspection.status).toBe(status);
    if (inspection.status === "ok") {
      expect(inspection.durationSeconds).toBeGreaterThan(0);
    } else {
      // Refused with a sentence the caller can show, never a bare code.
      expect(inspection.reason).toMatch(reason!);
      expect(inspection.reason).toMatch(/\.$/);
    }
  });

  it("reads the length from the movie's own index, and the same samples from 32- and 64-bit offsets", async () => {
    const short = await inspectDemoMp4(writeMovie(movie({ frames: 3, delta: 100 })));
    const long = await inspectDemoMp4(writeMovie(movie({ frames: 4, delta: 250, co64: true })));
    expect(short).toEqual({ status: "ok", durationSeconds: 0.3 });
    expect(long).toEqual({ status: "ok", durationSeconds: 1 });

    const stco = await readDemoMp4(writeMovie(movie({ frames: 4, delta: 250 })));
    const co64 = await readDemoMp4(writeMovie(movie({ frames: 4, delta: 250, co64: true })));
    expect(co64.samples.map((sample) => sample.offset)).toEqual(stco.samples.map((sample) => sample.offset));
    expect(co64.samples.map((sample) => sample.t)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(co64).toMatchObject({ width: 320, height: 240, frames: 4, codec: "avc1.42c01e" });
  });
});
