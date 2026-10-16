/**
 * An H.264 MP4 as the Chromium demo engine reads it.
 *
 * The Chromium engine decodes `.aderaw` records (see `demoRawFormat.ts`). A
 * recorder that writes an MP4 instead (the Windows desktop driver writes one
 * through Media Foundation) is read here: the movie's sample tables are
 * parsed once, and its H.264 samples are streamed out as `.aderaw` records:
 * one config record, then one Annex-B access unit per sample, the decoder
 * config (SPS/PPS) put in front of every key frame. No temporary file, no
 * re-encode, no ffmpeg; the file is read sample by sample.
 *
 * Also the honest length of an MP4 a demo could not be made of, so a raw file
 * filed as it is still reports its real duration and size.
 *
 * Only a finished, non-fragmented MP4 (one `moov`) with one H.264 (`avc1` or
 * `avc3`) video track is read. Anything else is refused with a sentence.
 */

import fs from "node:fs";
import { Readable } from "node:stream";
import {
  DEMO_RAW_FILE_EXTENSION,
  DEMO_RAW_FILE_MAGIC,
  DEMO_RAW_FLAG_KEYFRAME,
  DEMO_RAW_KIND_H264_ACCESS_UNIT,
  DEMO_RAW_KIND_H264_CONFIG,
} from "../../../shared/demoVideo/demoContract";
import { DEMO_RAW_MAX_PAYLOAD_BYTES, encodeDemoRawRecordHeader } from "./demoRawFormat";

/** The movie extensions this reader takes. */
export const DEMO_MP4_EXTENSIONS = [".mp4", ".m4v", ".mov"] as const;

export function isDemoMp4Path(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return DEMO_MP4_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** What a demo engine reads: an `.aderaw` capture, or an H.264 movie (the Windows desktop driver's recording). */
export const DEMO_ENGINE_INPUT_EXTENSIONS: readonly string[] = [DEMO_RAW_FILE_EXTENSION, ...DEMO_MP4_EXTENSIONS];

/** The one rule for which files a demo engine takes as input. */
export function isDemoEngineInputPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return DEMO_ENGINE_INPUT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** A `moov` larger than this is not a screen recording's. */
const MAX_MOOV_BYTES = 256 * 1024 * 1024;

/**
 * More samples than any screen recording has (over 18 hours at 60 fps). The
 * sample tables' counts come from the file, so each is bounded before
 * anything is allocated for it.
 */
const MAX_SAMPLES = 4_000_000;

export type DemoMp4Sample = {
  offset: number;
  size: number;
  /** Presentation time in seconds, the first frame at 0. */
  t: number;
  key: boolean;
};

export type DemoMp4Info = {
  width: number;
  height: number;
  /** WebCodecs codec string, e.g. `avc1.42c033`. */
  codec: string;
  /** From the first frame to the end of the last one. */
  durationSeconds: number;
  frames: number;
  /** NAL length field size, 1, 2 or 4. */
  lengthSize: number;
  /** SPS then PPS, raw NAL units. */
  parameterSets: Buffer[];
  samples: DemoMp4Sample[];
};

class Mp4Error extends Error {}
/** Raised for a movie that holds nothing to show: no bytes, no index, or no frames. */
class Mp4UnusableError extends Mp4Error {}

type Box = { type: string; start: number; headerSize: number; size: number };

/** The boxes inside `buffer[start, end)`. */
function childBoxes(buffer: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) throw new Mp4Error(`The movie's ${type} box is cut short.`);
    boxes.push({ type, start: offset, headerSize, size });
    offset += size;
  }
  return boxes;
}

function child(buffer: Buffer, parent: Box, type: string): Box | null {
  return childBoxes(buffer, parent.start + parent.headerSize, parent.start + parent.size).find((box) => box.type === type) ?? null;
}

function descend(buffer: Buffer, parent: Box, types: string[]): Box | null {
  let box: Box | null = parent;
  for (const type of types) {
    if (!box) return null;
    box = child(buffer, box, type);
  }
  return box;
}

/** Body offset of a full box (after version and flags). */
function fullBody(box: Box): number {
  return box.start + box.headerSize + 4;
}

function version(buffer: Buffer, box: Box): number {
  return buffer.readUInt8(box.start + box.headerSize);
}

/** The top-level boxes of the file, read header by header. */
async function topLevelBoxes(handle: fs.promises.FileHandle, fileSize: number): Promise<Box[]> {
  const boxes: Box[] = [];
  const header = Buffer.alloc(16);
  let offset = 0;
  while (offset + 8 <= fileSize) {
    const { bytesRead } = await handle.read(header, 0, 16, offset);
    if (bytesRead < 8) break;
    let size = header.readUInt32BE(0);
    const type = header.toString("latin1", 4, 8);
    let headerSize = 8;
    if (size === 1) {
      if (bytesRead < 16) break;
      const wide = header.readBigUInt64BE(8);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Mp4UnusableError(`The recording's ${type} box claims an impossible size, so it cannot be read.`);
      }
      size = Number(wide);
      headerSize = 16;
    } else if (size === 0) {
      size = fileSize - offset;
    }
    if (size < headerSize) throw new Mp4Error("The movie file is corrupt (a box with an impossible size).");
    if (size > fileSize - offset) {
      // A box that runs past the end: the file was cut short. With the index
      // already read, the movie is still usable up to here; without it, it is not.
      if (!boxes.some((box) => box.type === "moov")) {
        throw new Mp4UnusableError(`The recording's ${type} box runs past the end of the file, so the file was cut short and cannot be played.`);
      }
      boxes.push({ type, start: offset, headerSize, size: fileSize - offset });
      break;
    }
    boxes.push({ type, start: offset, headerSize, size });
    offset += size;
  }
  return boxes;
}

function hex2(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/** The video track's sample tables, turned into samples in decode order. */
function readSamples(
  buffer: Buffer,
  stbl: Box,
  timescale: number,
  fileSize: number,
): Array<DemoMp4Sample & { end: number }> {
  const req = (type: string): Box => {
    const box = child(buffer, stbl, type);
    if (!box) throw new Mp4Error(`The movie's video track has no ${type} table.`);
    return box;
  };
  const refuse = (type: string): never => {
    throw new Mp4UnusableError(`The recording's ${type} table claims more entries than the file holds, so it cannot be read.`);
  };
  /** A table's entry count, refused when its entries would not fit in its box. */
  const entryCount = (box: Box, countAt: number, entrySize: number): number => {
    const n = buffer.readUInt32BE(countAt);
    if (n > MAX_SAMPLES || countAt + 4 + n * entrySize > box.start + box.size) refuse(box.type);
    return n;
  };

  const stsz = req("stsz");
  let o = fullBody(stsz);
  const uniformSize = buffer.readUInt32BE(o);
  const count = uniformSize ? buffer.readUInt32BE(o + 4) : entryCount(stsz, o + 4, 4);
  if (count > MAX_SAMPLES || (uniformSize && count > Math.floor(fileSize / uniformSize))) refuse("stsz");
  const sizes = new Array<number>(count);
  for (let i = 0; i < count; i += 1) sizes[i] = uniformSize || buffer.readUInt32BE(o + 8 + i * 4);

  const stco = child(buffer, stbl, "stco");
  const co64 = child(buffer, stbl, "co64");
  if (!stco && !co64) throw new Mp4Error("The movie's video track has no chunk offsets.");
  const chunkOffsets: number[] = [];
  if (stco) {
    o = fullBody(stco);
    const n = entryCount(stco, o, 4);
    for (let i = 0; i < n; i += 1) chunkOffsets.push(buffer.readUInt32BE(o + 4 + i * 4));
  } else if (co64) {
    o = fullBody(co64);
    const n = entryCount(co64, o, 8);
    for (let i = 0; i < n; i += 1) chunkOffsets.push(Number(buffer.readBigUInt64BE(o + 4 + i * 8)));
  }

  const stsc = req("stsc");
  o = fullBody(stsc);
  const stscCount = entryCount(stsc, o, 12);
  const runs: Array<{ firstChunk: number; perChunk: number }> = [];
  for (let i = 0; i < stscCount; i += 1) {
    runs.push({ firstChunk: buffer.readUInt32BE(o + 4 + i * 12), perChunk: buffer.readUInt32BE(o + 8 + i * 12) });
  }
  const offsets = new Array<number>(count);
  let sample = 0;
  for (let r = 0; r < runs.length && sample < count; r += 1) {
    const lastChunk = r + 1 < runs.length ? runs[r + 1]!.firstChunk - 1 : chunkOffsets.length;
    for (let chunk = runs[r]!.firstChunk; chunk <= lastChunk && sample < count; chunk += 1) {
      let at = chunkOffsets[chunk - 1];
      if (at === undefined) throw new Mp4Error("The movie's sample-to-chunk table points past its chunks.");
      for (let k = 0; k < runs[r]!.perChunk && sample < count; k += 1) {
        offsets[sample] = at;
        at += sizes[sample]!;
        sample += 1;
      }
    }
  }
  if (sample < count) throw new Mp4Error("The movie's sample tables do not cover every sample.");

  const stts = req("stts");
  o = fullBody(stts);
  const sttsCount = entryCount(stts, o, 8);
  const dts = new Array<number>(count);
  const durations = new Array<number>(count);
  let time = 0;
  sample = 0;
  for (let i = 0; i < sttsCount && sample < count; i += 1) {
    const n = buffer.readUInt32BE(o + 4 + i * 8);
    const delta = buffer.readUInt32BE(o + 8 + i * 8);
    for (let k = 0; k < n && sample < count; k += 1) {
      dts[sample] = time;
      durations[sample] = delta;
      time += delta;
      sample += 1;
    }
  }
  for (; sample < count; sample += 1) {
    dts[sample] = time;
    durations[sample] = 0;
  }

  const composition = new Array<number>(count).fill(0);
  const ctts = child(buffer, stbl, "ctts");
  if (ctts) {
    const signed = version(buffer, ctts) === 1;
    o = fullBody(ctts);
    const n = entryCount(ctts, o, 8);
    sample = 0;
    for (let i = 0; i < n && sample < count; i += 1) {
      const runLength = buffer.readUInt32BE(o + 4 + i * 8);
      const offset = signed ? buffer.readInt32BE(o + 8 + i * 8) : buffer.readUInt32BE(o + 8 + i * 8);
      for (let k = 0; k < runLength && sample < count; k += 1) composition[sample++] = offset;
    }
  }

  const stss = child(buffer, stbl, "stss");
  let keys: Set<number> | null = null;
  if (stss) {
    o = fullBody(stss);
    const n = entryCount(stss, o, 4);
    keys = new Set();
    for (let i = 0; i < n; i += 1) keys.add(buffer.readUInt32BE(o + 4 + i * 4) - 1);
  }

  const out: Array<DemoMp4Sample & { end: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const pts = dts[i]! + composition[i]!;
    out.push({
      offset: offsets[i]!,
      size: sizes[i]!,
      t: pts / timescale,
      end: (pts + durations[i]!) / timescale,
      key: keys ? keys.has(i) : true,
    });
  }
  return out;
}

/**
 * Parses the movie's index. Rejects with a readable sentence when the file is
 * not a finished H.264 MP4: a recorder that died before it finalised leaves
 * an `mdat` with no `moov`, and that is said as such.
 */
export async function readDemoMp4(filePath: string): Promise<DemoMp4Info> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, "r");
    const { size: fileSize } = await handle.stat();
    if (fileSize < 8) throw new Mp4UnusableError("The recording file is empty.");
    const top = await topLevelBoxes(handle, fileSize);
    const moovBox = top.find((box) => box.type === "moov");
    if (!moovBox) {
      throw new Mp4UnusableError("The recording was never finished (its MP4 has no index), so it cannot be played.");
    }
    if (top.some((box) => box.type === "moof")) {
      throw new Mp4Error("The recording is a fragmented MP4, which the demo engine does not read.");
    }
    if (moovBox.size > MAX_MOOV_BYTES) throw new Mp4Error("The recording's MP4 index is impossibly large.");
    const buffer = Buffer.alloc(moovBox.size);
    await handle.read(buffer, 0, moovBox.size, moovBox.start);
    const moov: Box = { ...moovBox, start: 0 };

    for (const trak of childBoxes(buffer, moov.headerSize, moov.size).filter((box) => box.type === "trak")) {
      const hdlr = descend(buffer, trak, ["mdia", "hdlr"]);
      if (!hdlr || buffer.toString("latin1", fullBody(hdlr) + 4, fullBody(hdlr) + 8) !== "vide") continue;
      const mdhd = descend(buffer, trak, ["mdia", "mdhd"]);
      const stbl = descend(buffer, trak, ["mdia", "minf", "stbl"]);
      const stsd = stbl ? child(buffer, stbl, "stsd") : null;
      if (!mdhd || !stbl || !stsd) throw new Mp4Error("The recording's video track is incomplete.");
      const timescale = version(buffer, mdhd) === 1
        ? buffer.readUInt32BE(fullBody(mdhd) + 16)
        : buffer.readUInt32BE(fullBody(mdhd) + 8);
      if (!timescale) throw new Mp4Error("The recording's video track has no time scale.");
      // stsd: full box, u32 entry count, then sample entries.
      const entries = childBoxes(buffer, fullBody(stsd) + 4, stsd.start + stsd.size);
      const entry = entries[0];
      if (!entry || (entry.type !== "avc1" && entry.type !== "avc3")) {
        throw new Mp4Error(`The recording's video is ${entry?.type ?? "of no known type"}, not H.264.`);
      }
      // Visual sample entry: 8 bytes of SampleEntry, 16 reserved, then width/height.
      const body = entry.start + entry.headerSize;
      const width = buffer.readUInt16BE(body + 24);
      const height = buffer.readUInt16BE(body + 26);
      const avcC = childBoxes(buffer, body + 78, entry.start + entry.size).find((box) => box.type === "avcC");
      if (!avcC) throw new Mp4Error("The recording's H.264 track has no decoder config.");
      let o = avcC.start + avcC.headerSize;
      const profile = buffer.readUInt8(o + 1);
      const compatibility = buffer.readUInt8(o + 2);
      const level = buffer.readUInt8(o + 3);
      const lengthSize = (buffer.readUInt8(o + 4) & 0x03) + 1;
      const parameterSets: Buffer[] = [];
      const spsCount = buffer.readUInt8(o + 5) & 0x1f;
      o += 6;
      for (let i = 0; i < spsCount; i += 1) {
        const length = buffer.readUInt16BE(o);
        parameterSets.push(Buffer.from(buffer.subarray(o + 2, o + 2 + length)));
        o += 2 + length;
      }
      const ppsCount = buffer.readUInt8(o);
      o += 1;
      for (let i = 0; i < ppsCount; i += 1) {
        const length = buffer.readUInt16BE(o);
        parameterSets.push(Buffer.from(buffer.subarray(o + 2, o + 2 + length)));
        o += 2 + length;
      }
      const samples = readSamples(buffer, stbl, timescale, fileSize);
      for (const sample of samples) {
        if (sample.offset + sample.size > fileSize) throw new Mp4Error("The recording's samples run past the end of the file.");
      }
      const first = samples.reduce((min, sample) => Math.min(min, sample.t), Number.POSITIVE_INFINITY);
      const last = samples.reduce((max, sample) => Math.max(max, sample.end), 0);
      return {
        width,
        height,
        codec: `avc1.${hex2(profile)}${hex2(compatibility)}${hex2(level)}`,
        durationSeconds: samples.length ? Math.max(0, last - first) : 0,
        frames: samples.length,
        lengthSize,
        parameterSets,
        samples: samples.map(({ offset, size, t, key }) => ({ offset, size, t: Math.max(0, t - first), key })),
      };
    }
    throw new Mp4Error("The recording has no video track.");
  } catch (error) {
    if (error instanceof Mp4Error) throw error;
    if (error instanceof RangeError) throw new Mp4Error("The recording's MP4 index is corrupt.");
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export type DemoMp4Inspection =
  | { status: "ok"; durationSeconds: number }
  /** Nothing to show: empty, never finalised, or no frames. Never proof. */
  | { status: "unusable"; reason: string }
  /** Some other movie (HEVC, fragmented, a corrupt table): not judged here. */
  | { status: "unknown"; reason: string };

/** What a finished recording's MP4 holds, without reading its samples. */
export async function inspectDemoMp4(filePath: string): Promise<DemoMp4Inspection> {
  try {
    const info = await readDemoMp4(filePath);
    if (!info.frames) return { status: "unusable", reason: "The recording has no frames." };
    return { status: "ok", durationSeconds: info.durationSeconds };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return error instanceof Mp4UnusableError || (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { status: "unusable", reason }
      : { status: "unknown", reason };
  }
}

const START_CODE = Buffer.from([0, 0, 0, 1]);

/** One length-prefixed sample as Annex-B; a key frame gets the SPS/PPS in front unless it carries its own. */
function annexB(sample: Buffer, lengthSize: number, key: boolean, parameterSets: Buffer[]): Buffer {
  const nals: Buffer[] = [];
  let carriesSps = false;
  let o = 0;
  while (o + lengthSize <= sample.length) {
    const length = lengthSize === 4 ? sample.readUInt32BE(o)
      : lengthSize === 2 ? sample.readUInt16BE(o)
        : lengthSize === 1 ? sample.readUInt8(o)
          : sample.readUIntBE(o, 3);
    o += lengthSize;
    if (length === 0) continue;
    if (o + length > sample.length) throw new Error("A video sample in the recording is corrupt.");
    const nal = sample.subarray(o, o + length);
    if ((nal[0]! & 0x1f) === 7) carriesSps = true;
    nals.push(nal);
    o += length;
  }
  if (key && !carriesSps) {
    // After an access unit delimiter (Media Foundation writes one), which
    // must stay the unit's first NAL: a decoder reads a delimiter after the
    // SPS as the start of the next unit and then finds no key frame.
    const at = nals.length && (nals[0]![0]! & 0x1f) === 9 ? 1 : 0;
    nals.splice(at, 0, ...parameterSets);
  }
  const parts: Buffer[] = [];
  for (const nal of nals) parts.push(START_CODE, nal);
  return Buffer.concat(parts);
}

/**
 * The movie as an `.aderaw` byte stream. Reads one sample at a time; the file
 * handle closes when the stream ends or is destroyed.
 */
export function demoRawStreamFromMp4(filePath: string, info: DemoMp4Info): Readable {
  async function* records(): AsyncGenerator<Buffer> {
    const handle = await fs.promises.open(filePath, "r");
    try {
      yield Buffer.from(DEMO_RAW_FILE_MAGIC, "ascii");
      const config = Buffer.from(JSON.stringify({ codec: info.codec, width: info.width, height: info.height }), "utf8");
      yield encodeDemoRawRecordHeader(DEMO_RAW_KIND_H264_CONFIG, 0, 0, config.length);
      yield config;
      let scratch = Buffer.alloc(0);
      for (const sample of info.samples) {
        if (sample.size > DEMO_RAW_MAX_PAYLOAD_BYTES) throw new Error("A video sample in the recording is impossibly large.");
        if (scratch.length < sample.size) scratch = Buffer.alloc(Math.max(sample.size, scratch.length * 2));
        const { bytesRead } = await handle.read(scratch, 0, sample.size, sample.offset);
        if (bytesRead < sample.size) throw new Error("The recording ends inside a video sample.");
        const payload = annexB(scratch.subarray(0, sample.size), info.lengthSize, sample.key, info.parameterSets);
        yield encodeDemoRawRecordHeader(
          DEMO_RAW_KIND_H264_ACCESS_UNIT,
          sample.key ? DEMO_RAW_FLAG_KEYFRAME : 0,
          sample.t,
          payload.length,
        );
        yield payload;
      }
    } finally {
      await handle.close().catch(() => {});
    }
  }
  return Readable.from(records(), { objectMode: false });
}
