import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ARTIFACT_RANGE_READ_MAX_BYTES } from "../../../shared/artifactStreamUrl";
import { readFileRange } from "./fileRange";

describe("readFileRange", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-file-range-"));
  const file = path.join(dir, "clip.mp4");
  const bytes = Buffer.alloc(ARTIFACT_RANGE_READ_MAX_BYTES + 10);
  for (let index = 0; index < bytes.length; index += 997) bytes[index] = index % 251;
  fs.writeFileSync(file, bytes);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reads a slice, cut to the cap", async () => {
    const whole = await readFileRange(file, 0, 64 * 1024 * 1024);
    expect(whole).toMatchObject({ totalSize: bytes.length, rangeStart: 0, rangeEnd: ARTIFACT_RANGE_READ_MAX_BYTES, eof: false });
    expect(Buffer.from(whole.base64, "base64")).toEqual(bytes.subarray(0, ARTIFACT_RANGE_READ_MAX_BYTES));
  });

  it("reads the tail and says it reached the end", async () => {
    const tail = await readFileRange(file, bytes.length - 4, 100);
    expect(tail).toMatchObject({ rangeStart: bytes.length - 4, rangeEnd: bytes.length, eof: true });
    expect(Buffer.from(tail.base64, "base64")).toEqual(bytes.subarray(bytes.length - 4));
  });

  it("answers an empty end-of-file slice past the end, and treats a bad offset as 0", async () => {
    expect(await readFileRange(file, bytes.length + 5)).toEqual({
      totalSize: bytes.length,
      rangeStart: bytes.length,
      rangeEnd: bytes.length,
      base64: "",
      eof: true,
    });
    expect((await readFileRange(file, Number.NaN, 3)).rangeStart).toBe(0);
  });

  it("refuses a missing file and a folder", async () => {
    await expect(readFileRange(path.join(dir, "gone.mp4"))).rejects.toThrow(/does not exist/);
    await expect(readFileRange(dir)).rejects.toThrow(/does not exist/);
  });
});
