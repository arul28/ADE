import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEMO_RAW_FILE_MAGIC,
  DEMO_RAW_FLAG_KEYFRAME,
  DEMO_RAW_KIND_H264_ACCESS_UNIT,
  DEMO_RAW_KIND_H264_CONFIG,
  DEMO_RAW_KIND_JPEG,
} from "../../../shared/demoVideo/demoContract";
import { createDemoRawWriter, hasDemoRawMagic } from "./demoRawFormat";

const roots: string[] = [];

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-aderaw-"));
  roots.push(dir);
  return path.join(dir, name);
}

/** Reads a capture back by the contract's layout, independently of the writer. */
function readRecords(file: string) {
  const bytes = fs.readFileSync(file);
  const magic = bytes.subarray(0, 8).toString("ascii");
  const records: Array<{ kind: number; flags: number; reserved: number; t: number; payload: string }> = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32LE(offset + 12);
    records.push({
      kind: bytes.readUInt8(offset),
      flags: bytes.readUInt8(offset + 1),
      reserved: bytes.readUInt16LE(offset + 2),
      t: bytes.readDoubleLE(offset + 4),
      payload: bytes.subarray(offset + 16, offset + 16 + length).toString("utf8"),
    });
    offset += 16 + length;
  }
  return { magic, records, trailing: offset - bytes.length };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("createDemoRawWriter", () => {
  it("writes the contract's framing, keeps times from going backwards and counts only pictures", async () => {
    const file = tempFile("take.aderaw");
    const writer = await createDemoRawWriter(file);
    writer.append(DEMO_RAW_KIND_H264_CONFIG, 0, Buffer.from('{"codec":"avc1.64002a"}'));
    writer.append(DEMO_RAW_KIND_H264_ACCESS_UNIT, 0, Buffer.from("key"), DEMO_RAW_FLAG_KEYFRAME);
    writer.append(DEMO_RAW_KIND_H264_ACCESS_UNIT, 0.5, Buffer.from("delta"));
    writer.append(DEMO_RAW_KIND_H264_ACCESS_UNIT, 0.25, Buffer.from("late"));
    const summary = await writer.close();

    const { magic, records, trailing } = readRecords(file);
    expect(magic).toBe(DEMO_RAW_FILE_MAGIC);
    expect(trailing).toBe(0);
    expect(records).toEqual([
      { kind: DEMO_RAW_KIND_H264_CONFIG, flags: 0, reserved: 0, t: 0, payload: '{"codec":"avc1.64002a"}' },
      { kind: DEMO_RAW_KIND_H264_ACCESS_UNIT, flags: DEMO_RAW_FLAG_KEYFRAME, reserved: 0, t: 0, payload: "key" },
      { kind: DEMO_RAW_KIND_H264_ACCESS_UNIT, flags: 0, reserved: 0, t: 0.5, payload: "delta" },
      { kind: DEMO_RAW_KIND_H264_ACCESS_UNIT, flags: 0, reserved: 0, t: 0.5, payload: "late" },
    ]);
    expect(summary).toMatchObject({ frames: 3, lastTime: 0.5, truncated: false, bytes: fs.statSync(file).size });
    await expect(hasDemoRawMagic(file)).resolves.toBe(true);
  });

  it("stops taking records at the size cap and keeps the file whole", async () => {
    const file = tempFile("capped.aderaw");
    // Magic (8) + one 16-byte header with a 10-byte frame = 34; the second frame would cross 40.
    const writer = await createDemoRawWriter(file, { maxBytes: 40 });
    expect(writer.append(DEMO_RAW_KIND_JPEG, 0, Buffer.alloc(10))).toBe(true);
    expect(writer.append(DEMO_RAW_KIND_JPEG, 0.1, Buffer.alloc(10))).toBe(false);
    expect(writer.append(DEMO_RAW_KIND_JPEG, 0.2, Buffer.alloc(1))).toBe(false);
    const summary = await writer.close();

    expect(summary).toMatchObject({ frames: 1, truncated: true, bytes: 34 });
    expect(readRecords(file)).toMatchObject({ records: [{ kind: DEMO_RAW_KIND_JPEG, t: 0 }], trailing: 0 });
  });

  it("refuses to overwrite a file that already exists", async () => {
    const file = tempFile("taken.aderaw");
    fs.writeFileSync(file, "someone else's");
    await expect(createDemoRawWriter(file)).rejects.toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("someone else's");
    await expect(hasDemoRawMagic(file)).resolves.toBe(false);
  });
});
