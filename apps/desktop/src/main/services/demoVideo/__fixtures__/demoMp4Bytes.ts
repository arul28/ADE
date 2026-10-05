/**
 * MP4 movies built byte by byte, for the tests of anything that reads or files
 * a raw recording: the MP4 reader itself, and the recorders that must refuse
 * an empty or unfinished movie as proof but file a finished one.
 */

export const u32 = (...values: number[]): Buffer => {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => out.writeUInt32BE(value >>> 0, index * 4));
  return out;
};
export const u16 = (value: number): Buffer => {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
};
export const u64 = (value: bigint): Buffer => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(value);
  return out;
};

export function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, "latin1"), body]);
}

/** A full box: version 0, no flags. */
export const full = (type: string, ...parts: Buffer[]): Buffer => box(type, Buffer.alloc(4), ...parts);

/** A 64-bit-size box header (`size == 1`) that claims `largeSize` bytes. */
export const wideHeader = (type: string, largeSize: bigint): Buffer =>
  Buffer.concat([u32(1), Buffer.from(type, "latin1"), u64(largeSize)]);

export function avc1(width: number, height: number): Buffer {
  const entry = Buffer.alloc(78);
  entry.writeUInt16BE(1, 6); // data reference index
  entry.writeUInt16BE(width, 24);
  entry.writeUInt16BE(height, 26);
  const sps = Buffer.from([0x67, 0x42, 0xc0, 0x1e, 0xda]);
  const pps = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
  const avcC = box("avcC", Buffer.from([1, 0x42, 0xc0, 0x1e, 0xff, 0xe1]), u16(sps.length), sps, Buffer.from([1]), u16(pps.length), pps);
  return box("avc1", entry, avcC);
}

/**
 * A finished H.264 movie: `ftyp`, the samples in `mdat`, then `moov`. Each
 * sample is one 4-byte length-prefixed NAL, `delta` ticks of a 1000 Hz clock.
 */
export function movie(options: {
  frames?: number;
  delta?: number;
  co64?: boolean;
  /** Overrides the sample count `stsz` claims. */
  stszCount?: number;
  /** A non-zero uniform sample size, with the count as claimed. */
  stszUniform?: number;
} = {}): Buffer {
  const frames = options.frames ?? 3;
  const delta = options.delta ?? 100;
  const samples = Array.from({ length: frames }, (_, index) => {
    const nal = Buffer.from([index === 0 ? 0x65 : 0x41, 0x88, index]);
    return Buffer.concat([u32(nal.length), nal]);
  });
  const ftyp = box("ftyp", Buffer.from("isom"), u32(512), Buffer.from("isomavc1"));
  const mdat = box("mdat", ...samples);
  const firstOffset = ftyp.length + 8;
  const stsz = options.stszUniform
    ? full("stsz", u32(options.stszUniform, options.stszCount ?? frames))
    : full("stsz", u32(0, options.stszCount ?? frames), ...samples.map((sample) => u32(sample.length)));
  const chunkOffsets = options.co64
    ? full("co64", u32(1), u64(BigInt(firstOffset)))
    : full("stco", u32(1, firstOffset));
  const stbl = box(
    "stbl",
    full("stsd", u32(1), avc1(320, 240)),
    full("stts", u32(1, frames, delta)),
    full("stsc", u32(1, 1, Math.max(1, frames), 1)),
    stsz,
    chunkOffsets,
    full("stss", u32(1, 1)),
  );
  const mdia = box(
    "mdia",
    full("mdhd", u32(0, 0, 1000, frames * delta), u16(0x55c4), u16(0)),
    full("hdlr", u32(0), Buffer.from("vide"), Buffer.alloc(12), Buffer.from([0])),
    box("minf", stbl),
  );
  return Buffer.concat([ftyp, mdat, box("moov", box("trak", mdia))]);
}

export const ftypOnly = box("ftyp", Buffer.from("isom"), u32(512));
