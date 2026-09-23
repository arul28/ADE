import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isIsoMediaExtension,
  readMp4CreationTime,
  readMp4CreationTimeFromFile,
} from "./mediaCreationTime";

const MAC_EPOCH_OFFSET = 2_082_844_800;
const CREATED = new Date("2026-09-23T05:19:00.000Z");
const CREATED_MAC_SECONDS = CREATED.getTime() / 1000 + MAC_EPOCH_OFFSET;

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
}

function largeBox(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, "latin1");
  header.writeBigUInt64BE(BigInt(16 + payload.length), 8);
  return Buffer.concat([header, payload]);
}

function mvhdV0(seconds: number): Buffer {
  const payload = Buffer.alloc(100);
  payload.writeUInt8(0, 0);
  payload.writeUInt32BE(seconds, 4);
  payload.writeUInt32BE(seconds, 8);
  return box("mvhd", payload);
}

function mvhdV1(seconds: bigint): Buffer {
  const payload = Buffer.alloc(112);
  payload.writeUInt8(1, 0);
  payload.writeBigUInt64BE(seconds, 4);
  payload.writeBigUInt64BE(seconds, 12);
  return box("mvhd", payload);
}

const ftyp = box("ftyp", Buffer.from("isom\0\0\0\0isomiso2", "latin1"));

function readerFor(bytes: Buffer) {
  const reads: Array<{ position: number; length: number }> = [];
  const read = (position: number, length: number) => {
    reads.push({ position, length });
    return bytes.subarray(position, Math.min(bytes.length, position + length));
  };
  return { read, reads };
}

describe("readMp4CreationTime", () => {
  it("reads a version 0 mvhd (32-bit seconds since 1904)", () => {
    const file = Buffer.concat([ftyp, box("moov", mvhdV0(CREATED_MAC_SECONDS))]);
    const { read } = readerFor(file);
    expect(readMp4CreationTime(read, file.length)?.toISOString()).toBe(CREATED.toISOString());
  });

  it("reads a version 1 mvhd (64-bit seconds)", () => {
    const file = Buffer.concat([ftyp, box("moov", mvhdV1(BigInt(CREATED_MAC_SECONDS)))]);
    const { read } = readerFor(file);
    expect(readMp4CreationTime(read, file.length)?.toISOString()).toBe(CREATED.toISOString());
  });

  it("finds moov after a large mdat by seeking, without reading the media", () => {
    const mdat = box("mdat", Buffer.alloc(2_000_000, 7));
    const file = Buffer.concat([ftyp, mdat, box("moov", Buffer.concat([box("udta", Buffer.alloc(4)), mvhdV0(CREATED_MAC_SECONDS)]))]);
    const { read, reads } = readerFor(file);
    expect(readMp4CreationTime(read, file.length)?.toISOString()).toBe(CREATED.toISOString());
    const bytesRead = reads.reduce((sum, entry) => sum + entry.length, 0);
    expect(bytesRead).toBeLessThan(200);
  });

  it("walks past a box with a 64-bit largesize", () => {
    const mdat = largeBox("mdat", Buffer.alloc(64, 1));
    const file = Buffer.concat([ftyp, mdat, box("moov", mvhdV0(CREATED_MAC_SECONDS))]);
    const { read } = readerFor(file);
    expect(readMp4CreationTime(read, file.length)?.toISOString()).toBe(CREATED.toISOString());
  });

  it("accepts a moov that uses size 0 to run to the end of the file", () => {
    const moov = box("moov", mvhdV0(CREATED_MAC_SECONDS));
    moov.writeUInt32BE(0, 0);
    const file = Buffer.concat([ftyp, moov]);
    const { read } = readerFor(file);
    expect(readMp4CreationTime(read, file.length)?.toISOString()).toBe(CREATED.toISOString());
  });

  it("treats a zero creation time as unknown", () => {
    const file = Buffer.concat([ftyp, box("moov", mvhdV0(0))]);
    const { read } = readerFor(file);
    expect(readMp4CreationTime(read, file.length)).toBeNull();
  });

  it("returns null when there is no moov or no mvhd", () => {
    const noMoov = Buffer.concat([ftyp, box("mdat", Buffer.alloc(32))]);
    expect(readMp4CreationTime(readerFor(noMoov).read, noMoov.length)).toBeNull();
    const noMvhd = Buffer.concat([ftyp, box("moov", box("trak", Buffer.alloc(16)))]);
    expect(readMp4CreationTime(readerFor(noMvhd).read, noMvhd.length)).toBeNull();
  });

  it("returns null for a truncated file instead of throwing", () => {
    const whole = Buffer.concat([ftyp, box("moov", mvhdV0(CREATED_MAC_SECONDS))]);
    const cutInsideMvhd = whole.subarray(0, ftyp.length + 8 + 8 + 4);
    expect(readMp4CreationTime(readerFor(cutInsideMvhd).read, cutInsideMvhd.length)).toBeNull();
    const cutInsideHeader = whole.subarray(0, 5);
    expect(readMp4CreationTime(readerFor(cutInsideHeader).read, cutInsideHeader.length)).toBeNull();
  });

  it("stops on a corrupt box size instead of looping", () => {
    const corrupt = Buffer.concat([ftyp, box("free", Buffer.alloc(4))]);
    corrupt.writeUInt32BE(3, ftyp.length);
    expect(readMp4CreationTime(readerFor(corrupt).read, corrupt.length)).toBeNull();
  });
});

describe("readMp4CreationTimeFromFile", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the creation time from disk and is null for a missing file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-mvhd-"));
    dirs.push(dir);
    const file = path.join(dir, "clip.mp4");
    fs.writeFileSync(file, Buffer.concat([ftyp, box("mdat", Buffer.alloc(4096)), box("moov", mvhdV1(BigInt(CREATED_MAC_SECONDS)))]));
    expect(readMp4CreationTimeFromFile(file)?.toISOString()).toBe(CREATED.toISOString());
    expect(readMp4CreationTimeFromFile(path.join(dir, "missing.mp4"))).toBeNull();
  });

  it("knows which extensions are ISO media", () => {
    expect(isIsoMediaExtension("mp4")).toBe(true);
    expect(isIsoMediaExtension(".MOV")).toBe(true);
    expect(isIsoMediaExtension("webm")).toBe(false);
  });
});
