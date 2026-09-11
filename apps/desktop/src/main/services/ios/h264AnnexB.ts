/**
 * Annex-B H.264 stream tools for the iOS simulator live view.
 *
 * ADE streams a simulator by running `idb video-stream --format h264` on the
 * Mac that owns the simulator. That command writes Annex-B H.264: a flat byte
 * stream where each NAL unit starts with `00 00 01` or `00 00 00 01`. The
 * browser decodes it with `VideoDecoder` in Annex-B mode, so the renderer needs
 * whole access units, not arbitrary pipe chunks. A chunk boundary falls in the
 * middle of a NAL far more often than not, and a decoder that receives half a
 * slice drops the frame.
 *
 * This module is pure. It does no I/O, starts no timers, and spawns no
 * processes. It turns bytes into access units and reads the SPS. Keep it that
 * way: the transport layer is easy to test only while the framing rules live
 * apart from the process that produces the bytes.
 */

/** Every emitted access unit uses this start code. See `RULE: 4-byte output`. */
const START_CODE = Uint8Array.from([0x00, 0x00, 0x00, 0x01]);

/**
 * Cap on bytes held back between `push` calls.
 *
 * A NAL is only complete once the NEXT start code arrives, so the parser must
 * retain the current NAL. A corrupt or non-H.264 source never sends another
 * start code, and without a cap the buffer would grow until the main process
 * runs out of memory. The observed access unit averages 4.4 KB and the largest
 * seen was 54 KB, so 8 MiB is over 150 times the worst real unit. Anything past
 * that is a broken stream, not a large frame.
 */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** A `ue(v)` field with more leading zeros than this cannot be a real SPS. */
const MAX_EXP_GOLOMB_LEADING_ZEROS = 32;

/**
 * Profiles whose SPS carries `chroma_format_idc`, the bit depths and the
 * scaling lists. ITU-T H.264 clause 7.3.2.1.1 lists them explicitly. Skipping
 * this branch on a High profile SPS shifts every later field and produces a
 * plausible but wrong resolution, so the set is spelled out rather than
 * approximated with `profile_idc >= 100`.
 */
const PROFILES_WITH_CHROMA_FORMAT = new Set([
  100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134,
]);

/** NAL types 1..5 carry coded slices. Types 6..31 do not. */
const FIRST_VCL_NAL_TYPE = 1;
const LAST_VCL_NAL_TYPE = 5;
const IDR_NAL_TYPE = 5;
const SPS_NAL_TYPE = 7;
const PPS_NAL_TYPE = 8;

export type H264NalUnit = {
  /** NAL type, 1..31. */
  type: number;
  /** The NAL including its leading start code, ready to concatenate. */
  bytes: Uint8Array;
};

export type H264AccessUnit = {
  /** The whole access unit in Annex-B form, start codes included. */
  bytes: Uint8Array;
  /** True when the unit contains an IDR slice (NAL type 5). */
  keyframe: boolean;
  /** NAL types in this unit, in order. */
  nalTypes: number[];
};

export type H264ParameterSets = {
  /** The last SPS, from its NAL header byte on. The start code is removed. */
  sps: Uint8Array | null;
  /** The last PPS, from its NAL header byte on. The start code is removed. */
  pps: Uint8Array | null;
  /** `avc1` + 6 hex digits, or null until an SPS has been seen. */
  codec: string | null;
  width: number | null;
  height: number | null;
};

export type H264AnnexBParser = {
  /** Returns every access unit completed by this chunk. */
  push(chunk: Uint8Array): H264AccessUnit[];
  /** Returns the final access unit still buffered, if any. */
  flush(): H264AccessUnit[];
  /** The most recent parameter sets seen so far. */
  parameterSets(): H264ParameterSets;
  /** Bytes thrown away because the retained buffer hit its cap. */
  droppedBytes(): number;
  reset(): void;
};

type StartCodeHit = {
  /** Index of the first byte of the start code. */
  index: number;
  /** 3 or 4. */
  length: number;
};

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left.slice();
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}

/**
 * Finds the next start code at or after `from`.
 *
 * The scan looks for the 3-byte pattern and then checks the byte in front of
 * it. That byte is `0x00` only for a 4-byte start code, because the last byte
 * of any start code is `0x01`. Reporting the true length matters: the caller
 * uses `index` to close the previous NAL, and a 4-byte code reported as 3 bytes
 * would leave a stray `0x00` on the end of it.
 */
function findStartCode(data: Uint8Array, from: number): StartCodeHit | null {
  const limit = data.length - 2;
  for (let i = Math.max(0, from); i < limit; i += 1) {
    if (data[i] !== 0x00 || data[i + 1] !== 0x00 || data[i + 2] !== 0x01) continue;
    if (i > 0 && data[i - 1] === 0x00) return { index: i - 1, length: 4 };
    return { index: i, length: 3 };
  }
  return null;
}

/**
 * Drops `trailing_zero_8bits` from the end of a NAL.
 *
 * A stream may pad between NALs with extra `0x00` bytes, and a run of them in
 * front of a start code is padding, not payload. RBSP always ends with a stop
 * bit, so a real NAL never ends in `0x00`; removing the run is therefore safe
 * and it keeps the emitted bytes stable no matter how much padding the encoder
 * wrote.
 */
function trimTrailingZeros(nal: Uint8Array): Uint8Array {
  let end = nal.length;
  while (end > 0 && nal[end - 1] === 0x00) end -= 1;
  return end === nal.length ? nal : nal.subarray(0, end);
}

class BitReaderOverrun extends Error {
  constructor() {
    super("h264 bit reader ran past the end of the RBSP");
    this.name = "BitReaderOverrun";
  }
}

/**
 * Big-endian bit reader over an RBSP.
 *
 * It throws on overrun instead of returning zeros. A truncated SPS that reads
 * as zeros still yields a number, and a wrong resolution is worse than no
 * resolution: the renderer would size its canvas from it and show a sheared
 * picture with no error anywhere.
 */
class RbspBitReader {
  private readonly data: Uint8Array;
  private bitPosition = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  readBit(): number {
    const byteIndex = this.bitPosition >> 3;
    if (byteIndex >= this.data.length) throw new BitReaderOverrun();
    const shift = 7 - (this.bitPosition & 7);
    this.bitPosition += 1;
    return (this.data[byteIndex] >> shift) & 1;
  }

  readBits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = value * 2 + this.readBit();
    return value;
  }

  /** Unsigned exp-Golomb, `ue(v)`. */
  readUnsignedExpGolomb(): number {
    let leadingZeros = 0;
    while (this.readBit() === 0) {
      leadingZeros += 1;
      if (leadingZeros > MAX_EXP_GOLOMB_LEADING_ZEROS) throw new BitReaderOverrun();
    }
    if (leadingZeros === 0) return 0;
    return 2 ** leadingZeros - 1 + this.readBits(leadingZeros);
  }

  /** Signed exp-Golomb, `se(v)`. */
  readSignedExpGolomb(): number {
    const code = this.readUnsignedExpGolomb();
    return code % 2 === 1 ? (code + 1) / 2 : -(code / 2);
  }
}

/**
 * Removes emulation prevention bytes.
 *
 * An encoder rewrites any `00 00 00`, `00 00 01`, `00 00 02` or `00 00 03` in
 * the payload as `00 00 03 xx` so the payload can never look like a start code.
 * The bit reader must see the original bytes, so the inserted `03` comes out
 * first. Skipping this step shifts every field after the first escaped pair.
 */
function removeEmulationPrevention(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let written = 0;
  let zeroRun = 0;
  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i];
    if (zeroRun >= 2 && byte === 0x03) {
      zeroRun = 0;
      continue;
    }
    out[written] = byte;
    written += 1;
    zeroRun = byte === 0x00 ? zeroRun + 1 : 0;
  }
  return out.subarray(0, written);
}

/** Walks one scaling list so the fields after it stay aligned. */
function skipScalingList(reader: RbspBitReader, size: number): void {
  let lastScale = 8;
  let nextScale = 8;
  for (let j = 0; j < size; j += 1) {
    if (nextScale !== 0) {
      const delta = reader.readSignedExpGolomb();
      nextScale = (lastScale + delta + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

function toHexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/**
 * Reads profile/level and resolution out of an SPS NAL payload.
 *
 * `nalPayload` starts at `profile_idc`. Strip the start code AND the one-byte
 * NAL header (`0x67` / `0x27`) before calling. The parser cannot tell a header
 * byte from a `profile_idc` by value alone in every case, so the contract is
 * fixed here rather than guessed per call.
 *
 * Returns null when the SPS does not parse. `width` and `height` are null on
 * their own when the profile and level read but a later field does not, which
 * still lets the caller build a codec string for `VideoDecoder`.
 */
export function parseH264Sps(nalPayload: Uint8Array): {
  codec: string;
  width: number | null;
  height: number | null;
} | null {
  // De-escape the whole payload, not just the part the bit reader sees. A zero
  // run can start at `constraint_flags` and force an escape byte right after
  // `level_idc`, and slicing first would leave that byte in the RBSP.
  const payload = removeEmulationPrevention(nalPayload);
  if (payload.length < 3) return null;
  const profileIdc = payload[0];
  const constraintFlags = payload[1];
  const levelIdc = payload[2];
  const codec = `avc1.${toHexByte(profileIdc)}${toHexByte(constraintFlags)}${toHexByte(levelIdc)}`;

  try {
    const reader = new RbspBitReader(payload.subarray(3));
    reader.readUnsignedExpGolomb(); // seq_parameter_set_id

    let chromaFormatIdc = 1;
    let separateColourPlaneFlag = 0;
    if (PROFILES_WITH_CHROMA_FORMAT.has(profileIdc)) {
      chromaFormatIdc = reader.readUnsignedExpGolomb();
      if (chromaFormatIdc > 3) return { codec, width: null, height: null };
      if (chromaFormatIdc === 3) separateColourPlaneFlag = reader.readBit();
      reader.readUnsignedExpGolomb(); // bit_depth_luma_minus8
      reader.readUnsignedExpGolomb(); // bit_depth_chroma_minus8
      reader.readBit(); // qpprime_y_zero_transform_bypass_flag
      if (reader.readBit() === 1) {
        const listCount = chromaFormatIdc === 3 ? 12 : 8;
        for (let i = 0; i < listCount; i += 1) {
          if (reader.readBit() === 1) skipScalingList(reader, i < 6 ? 16 : 64);
        }
      }
    }

    reader.readUnsignedExpGolomb(); // log2_max_frame_num_minus4
    const picOrderCntType = reader.readUnsignedExpGolomb();
    if (picOrderCntType === 0) {
      reader.readUnsignedExpGolomb(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
      reader.readBit(); // delta_pic_order_always_zero_flag
      reader.readSignedExpGolomb(); // offset_for_non_ref_pic
      reader.readSignedExpGolomb(); // offset_for_top_to_bottom_field
      const cycleLength = reader.readUnsignedExpGolomb();
      if (cycleLength > 255) return { codec, width: null, height: null };
      for (let i = 0; i < cycleLength; i += 1) reader.readSignedExpGolomb();
    } else if (picOrderCntType !== 2) {
      return { codec, width: null, height: null };
    }

    reader.readUnsignedExpGolomb(); // max_num_ref_frames
    reader.readBit(); // gaps_in_frame_num_value_allowed_flag
    const picWidthInMbsMinus1 = reader.readUnsignedExpGolomb();
    const picHeightInMapUnitsMinus1 = reader.readUnsignedExpGolomb();
    const frameMbsOnlyFlag = reader.readBit();
    if (frameMbsOnlyFlag === 0) reader.readBit(); // mb_adaptive_frame_field_flag
    reader.readBit(); // direct_8x8_inference_flag

    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;
    if (reader.readBit() === 1) {
      cropLeft = reader.readUnsignedExpGolomb();
      cropRight = reader.readUnsignedExpGolomb();
      cropTop = reader.readUnsignedExpGolomb();
      cropBottom = reader.readUnsignedExpGolomb();
    }

    // Crop offsets count chroma samples, not luma samples. With 4:2:0 one crop
    // unit is 2 luma columns, so a phone screen whose real width is odd shows
    // up here as the nearest even number. That is the encoder's picture, and
    // the renderer must use it or the image shears.
    const monochromeOrSeparate = chromaFormatIdc === 0 || separateColourPlaneFlag === 1;
    const subWidthC = chromaFormatIdc === 3 ? 1 : 2;
    const subHeightC = chromaFormatIdc === 1 ? 2 : 1;
    const cropUnitX = monochromeOrSeparate ? 1 : subWidthC;
    const cropUnitY = (monochromeOrSeparate ? 1 : subHeightC) * (2 - frameMbsOnlyFlag);

    const width = (picWidthInMbsMinus1 + 1) * 16 - cropUnitX * (cropLeft + cropRight);
    const height =
      (picHeightInMapUnitsMinus1 + 1) * 16 * (2 - frameMbsOnlyFlag) -
      cropUnitY * (cropTop + cropBottom);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return { codec, width: null, height: null };
    }
    return { codec, width, height };
  } catch {
    return { codec, width: null, height: null };
  }
}

/**
 * Incremental splitter. Feed arbitrary chunks; get whole access units back.
 *
 * The parser keeps one partly built access unit and the tail of the byte
 * stream. It never reports a NAL before the next start code arrives, because
 * until then the NAL could still grow.
 */
export function createH264AnnexBParser(): H264AnnexBParser {
  /** Bytes not yet turned into NALs. */
  let buffer: Uint8Array = new Uint8Array(0);
  /** Index in `buffer` of the current NAL payload, or -1 before the first start code. */
  let nalStart = -1;
  /** Index in `buffer` where the next start code search begins. */
  let scanFrom = 0;
  let dropped = 0;

  let pendingNals: H264NalUnit[] = [];
  let pendingHasVcl = false;
  let lastSps: Uint8Array | null = null;
  let lastPps: Uint8Array | null = null;
  let lastCodec: string | null = null;
  let lastWidth: number | null = null;
  let lastHeight: number | null = null;

  function buildAccessUnit(nals: H264NalUnit[]): H264AccessUnit {
    let total = 0;
    for (const nal of nals) total += nal.bytes.length;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const nal of nals) {
      bytes.set(nal.bytes, offset);
      offset += nal.bytes.length;
    }
    return {
      bytes,
      keyframe: nals.some((nal) => nal.type === IDR_NAL_TYPE),
      nalTypes: nals.map((nal) => nal.type),
    };
  }

  function takePendingUnit(out: H264AccessUnit[]): void {
    if (pendingNals.length === 0) return;
    out.push(buildAccessUnit(pendingNals));
    pendingNals = [];
    pendingHasVcl = false;
  }

  /**
   * Adds one NAL to the pending access unit and closes the previous unit when
   * this NAL opens a new one.
   *
   * Parameter sets attach FORWARD, to the unit that follows them. The encoder
   * writes SPS and PPS immediately before the IDR they describe, so a keyframe
   * unit that carries them can be decoded on its own. That is what lets a
   * browser that joins the stream late start from the first keyframe instead of
   * waiting for the next parameter set.
   */
  function consumeNal(raw: Uint8Array, out: H264AccessUnit[]): void {
    const nal = trimTrailingZeros(raw);
    if (nal.length === 0) return;
    const type = nal[0] & 0x1f;
    const isVcl = type >= FIRST_VCL_NAL_TYPE && type <= LAST_VCL_NAL_TYPE;
    if (isVcl && pendingHasVcl) takePendingUnit(out);

    if (type === SPS_NAL_TYPE) {
      lastSps = nal.slice();
      const parsed = parseH264Sps(lastSps.subarray(1));
      if (parsed) {
        lastCodec = parsed.codec;
        lastWidth = parsed.width;
        lastHeight = parsed.height;
      }
    } else if (type === PPS_NAL_TYPE) {
      lastPps = nal.slice();
    }

    const bytes = new Uint8Array(START_CODE.length + nal.length);
    bytes.set(START_CODE, 0);
    bytes.set(nal, START_CODE.length);
    pendingNals.push({ type, bytes });
    if (isVcl) pendingHasVcl = true;
  }

  /**
   * Releases bytes the parser can no longer need, then enforces the cap.
   *
   * Without the cap a source that never sends another start code would grow the
   * buffer without limit. When the cap trips the current NAL has already lost
   * its head, so the parser abandons it and waits for the next start code
   * rather than reporting a NAL it knows is incomplete.
   */
  function compactBuffer(): void {
    const keepFrom = nalStart >= 0 ? nalStart : Math.max(0, buffer.length - 3);
    if (keepFrom > 0) {
      buffer = buffer.slice(keepFrom);
      if (nalStart >= 0) nalStart -= keepFrom;
      scanFrom = Math.max(0, scanFrom - keepFrom);
    }
    if (buffer.length > MAX_BUFFERED_BYTES) {
      const excess = buffer.length - MAX_BUFFERED_BYTES;
      buffer = buffer.slice(excess);
      dropped += excess;
      nalStart = -1;
      scanFrom = Math.max(0, scanFrom - excess);
    }
  }

  function push(chunk: Uint8Array): H264AccessUnit[] {
    const out: H264AccessUnit[] = [];
    if (chunk.length > 0) buffer = concatBytes(buffer, chunk);

    for (;;) {
      const hit = findStartCode(buffer, scanFrom);
      if (!hit) break;
      if (nalStart >= 0 && hit.index > nalStart) {
        consumeNal(buffer.subarray(nalStart, hit.index), out);
      }
      nalStart = hit.index + hit.length;
      scanFrom = nalStart;
    }

    // A start code can straddle a chunk boundary, so the last two bytes must
    // stay searchable on the next push. Everything before them has already been
    // examined, and resuming there keeps a long NAL from being rescanned on
    // every chunk.
    scanFrom = Math.max(scanFrom, Math.max(0, buffer.length - 2));
    compactBuffer();
    return out;
  }

  function flush(): H264AccessUnit[] {
    const out: H264AccessUnit[] = [];
    // At end of stream there is no next start code, so the buffered tail is a
    // complete NAL rather than a partial one.
    if (nalStart >= 0 && buffer.length > nalStart) {
      consumeNal(buffer.subarray(nalStart), out);
    }
    buffer = new Uint8Array(0);
    nalStart = -1;
    scanFrom = 0;
    takePendingUnit(out);
    return out;
  }

  function parameterSets(): H264ParameterSets {
    return {
      sps: lastSps,
      pps: lastPps,
      codec: lastCodec,
      width: lastWidth,
      height: lastHeight,
    };
  }

  function reset(): void {
    buffer = new Uint8Array(0);
    nalStart = -1;
    scanFrom = 0;
    dropped = 0;
    pendingNals = [];
    pendingHasVcl = false;
    lastSps = null;
    lastPps = null;
    lastCodec = null;
    lastWidth = null;
    lastHeight = null;
  }

  return {
    push,
    flush,
    parameterSets,
    droppedBytes: () => dropped,
    reset,
  };
}
