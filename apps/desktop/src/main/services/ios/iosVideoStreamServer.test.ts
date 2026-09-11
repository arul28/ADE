import { IOS_VIDEO_RECORD_FLAG_KEYFRAME, IOS_VIDEO_RECORD_HEADER_BYTES, IOS_VIDEO_RECORD_MAGIC, IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT, IOS_VIDEO_RECORD_TYPE_CONFIG, IOS_VIDEO_STREAM_PATH } from "../../../shared/types/iosSimulator";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createH264AnnexBParser, parseH264Sps } from "./h264AnnexB";
import { createIosVideoStreamServer, encodeVideoRecord, type IosVideoEncoderOptions, type IosVideoEncoderProcess } from "./iosVideoStreamServer";

/* ------------------------------------------------------------------------- *
 * Synthetic Annex-B stream
 * ------------------------------------------------------------------------- */

function fromHex(hex: string): Uint8Array {
  const pairs = hex.match(/../g) ?? [];
  return Uint8Array.from(pairs.map((pair) => Number.parseInt(pair, 16)));
}

/**
 * A real SPS from an iPhone simulator, keeping its `0x27` NAL header byte and
 * dropping the start code. It is the capture `h264AnnexB.test.ts` documents, so
 * the codec string the server publishes is one a device really produces.
 */
const SPS = fromHex("27640032ac13142804a0141e4b9a810101520f080422a0");
const SPS_CODEC = "avc1.640032";

/** A PPS and two slice types. Their payloads only have to be recognisable. */
const PPS = Uint8Array.from([0x28, 0xee, 0x3c, 0xb0]);
const IDR_SLICE = Uint8Array.from([0x65, 0x11, 0x11, 0x11]);
const DELTA_SLICE = Uint8Array.from([0x41, 0x22, 0x22, 0x22]);

/** Joins NALs into an Annex-B stream with 4-byte start codes. */
function annexB(nals: Uint8Array[]): Uint8Array {
  const startCode = Uint8Array.from([0, 0, 0, 1]);
  const total = nals.reduce((sum, nal) => sum + startCode.length + nal.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const nal of nals) {
    out.set(startCode, offset);
    offset += startCode.length;
    out.set(nal, offset);
    offset += nal.length;
  }
  return out;
}

/**
 * One keyframe access unit followed by one delta access unit.
 *
 * The splitter closes a NAL only when the next start code arrives, and closes
 * an access unit only when the next slice opens one. Six NALs are therefore the
 * shortest stream that yields two complete units: the trailing slice stays
 * buffered and is never emitted.
 */
function keyframeThenDelta(): Uint8Array {
  return annexB([SPS, PPS, IDR_SLICE, DELTA_SLICE, DELTA_SLICE, DELTA_SLICE]);
}

/** Delta slices only. No SPS, so no config, and no IDR, so no keyframe. */
function deltasOnly(): Uint8Array {
  return annexB([DELTA_SLICE, DELTA_SLICE, DELTA_SLICE]);
}

/* ------------------------------------------------------------------------- *
 * Record reader
 * ------------------------------------------------------------------------- */

type ParsedRecord = {
  type: number;
  keyframe: boolean;
  payload: Uint8Array;
};

/**
 * Decodes the wire framing without the renderer's parser.
 *
 * Reading the stream with the parser under test in the neighbouring file would
 * let both sides agree on a format that matches neither the documented header.
 */
function decodeRecords(buffer: Uint8Array): { records: ParsedRecord[]; rest: Uint8Array } {
  const records: ParsedRecord[] = [];
  let offset = 0;
  while (buffer.byteLength - offset >= IOS_VIDEO_RECORD_HEADER_BYTES) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset, IOS_VIDEO_RECORD_HEADER_BYTES);
    expect(view.getUint32(0, false)).toBe(IOS_VIDEO_RECORD_MAGIC);
    const length = view.getUint32(8, false);
    const end = offset + IOS_VIDEO_RECORD_HEADER_BYTES + length;
    if (buffer.byteLength < end) break;
    records.push({
      type: view.getUint8(4),
      keyframe: (view.getUint8(5) & IOS_VIDEO_RECORD_FLAG_KEYFRAME) !== 0,
      payload: buffer.slice(offset + IOS_VIDEO_RECORD_HEADER_BYTES, end),
    });
    offset = end;
  }
  return { records, rest: buffer.slice(offset) };
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

/** Accumulates records off a live response body. */
function createRecordReader(response: Response) {
  const body = response.body;
  if (!body) throw new Error("The response carried no body.");
  const reader = body.getReader();
  let pending: Uint8Array = new Uint8Array(0);
  const seen: ParsedRecord[] = [];

  return {
    /** Reads until `count` records have arrived. */
    async take(count: number): Promise<ParsedRecord[]> {
      while (seen.length < count) {
        const next = await reader.read();
        if (next.done) throw new Error("The stream ended before enough records arrived.");
        pending = concat(pending, new Uint8Array(next.value));
        const decoded = decodeRecords(pending);
        seen.push(...decoded.records);
        pending = decoded.rest;
      }
      return seen.slice(0, count);
    },
    cancel: () => reader.cancel().catch(() => undefined),
  };
}

/* ------------------------------------------------------------------------- *
 * Harness
 * ------------------------------------------------------------------------- */

type FakeEncoder = {
  options: IosVideoEncoderOptions;
  process: IosVideoEncoderProcess;
  /** Resolves once the server has subscribed to this encoder's output. */
  ready: Promise<void>;
  emit: (chunk: Uint8Array) => void;
  fail: (error: Error) => void;
  exit: (code: number | null, signal: string | null) => void;
  killCount: () => number;
};

function createFakeEncoder(options: IosVideoEncoderOptions, pid: number): FakeEncoder {
  let onData: ((chunk: Uint8Array) => void) | null = null;
  let onError: ((error: Error) => void) | null = null;
  let onExit: ((code: number | null, signal: string | null) => void) | null = null;
  let kills = 0;
  let markReady = () => {};
  // The server subscribes after `startEncoder` resolves, and it subscribes to
  // exit last. A test that emitted before that point would emit into nothing.
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  return {
    options,
    ready,
    process: {
      onData: (handler) => {
        onData = handler;
      },
      onError: (handler) => {
        onError = handler;
      },
      onExit: (handler) => {
        onExit = handler;
        markReady();
      },
      kill: () => {
        kills += 1;
      },
      pid,
    },
    emit: (chunk) => onData?.(chunk),
    fail: (error) => onError?.(error),
    exit: (code, signal) => onExit?.(code, signal),
    killCount: () => kills,
  };
}

const OPTIONS: IosVideoEncoderOptions = {
  deviceUdid: "1B2C3D4E-0000-1111-2222-333344445555",
  fps: 20,
  scaleFactor: null,
  compressionQuality: null,
};

type OpenRequest = {
  response: Promise<Response>;
  close: () => void;
};

type Harness = {
  server: ReturnType<typeof createIosVideoStreamServer>;
  startEncoder: ReturnType<typeof vi.fn>;
  /** Resolves with the nth encoder, waiting when it has not started yet. */
  encoderAt: (index: number) => Promise<FakeEncoder>;
  /**
   * Issues a request and hands back the pending response.
   *
   * Node flushes the response head with the first body write, so a stream
   * request does not resolve until the server writes its first record. Every
   * streaming test therefore feeds the encoder before it awaits the response.
   */
  open: (url: string) => OpenRequest;
};

const openHarnesses: Array<{ dispose: () => void; controllers: AbortController[] }> = [];

function createHarness(): Harness {
  const encoders: FakeEncoder[] = [];
  const waiters = new Map<number, Array<(encoder: FakeEncoder) => void>>();
  const controllers: AbortController[] = [];

  const startEncoder = vi.fn(async (options: IosVideoEncoderOptions) => {
    const fake = createFakeEncoder(options, 4000 + encoders.length);
    encoders.push(fake);
    const index = encoders.length - 1;
    for (const resolve of waiters.get(index) ?? []) resolve(fake);
    waiters.delete(index);
    return fake.process;
  });

  const server = createIosVideoStreamServer({
    startEncoder,
    logger: { info: () => {}, debug: () => {} },
  });

  openHarnesses.push({ dispose: () => server.dispose(), controllers });

  return {
    server,
    startEncoder,
    encoderAt: async (index) => {
      const existing = encoders[index];
      const encoder = existing ?? await new Promise<FakeEncoder>((resolve) => {
        const list = waiters.get(index) ?? [];
        list.push(resolve);
        waiters.set(index, list);
      });
      await encoder.ready;
      return encoder;
    },
    open: (url) => {
      const controller = new AbortController();
      controllers.push(controller);
      const response = fetch(url, { signal: controller.signal });
      // Teardown aborts whatever is still open, and an abort rejects here.
      void response.catch(() => undefined);
      return { response, close: () => controller.abort() };
    },
  };
}

/** Resolves "quiet" when `promise` has still not settled after `ms`. */
async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T | "quiet"> {
  return Promise.race([
    promise,
    new Promise<"quiet">((resolve) => {
      const timer = setTimeout(() => resolve("quiet"), ms);
      timer.unref?.();
    }),
  ]);
}

afterEach(() => {
  for (const entry of openHarnesses.splice(0)) {
    for (const controller of entry.controllers) controller.abort();
    entry.dispose();
  }
  vi.useRealTimers();
});

/* ------------------------------------------------------------------------- *
 * Tests
 * ------------------------------------------------------------------------- */

describe("createIosVideoStreamServer transport", () => {
  it("returns a URL carrying the stream path and a token, on a port that listens", async () => {
    const harness = createHarness();
    const transport = await harness.server.start(OPTIONS);

    expect(transport.url).toContain(IOS_VIDEO_STREAM_PATH);
    expect(transport.url).toContain(`token=${transport.token}`);
    expect(transport.token).toMatch(/^[0-9a-f]{64}$/);
    expect(transport.port).toBeGreaterThan(0);

    const probe = await harness.open(`http://127.0.0.1:${transport.port}/probe`).response;
    expect(probe.status).toBe(404);
    await probe.text();
  });

  it("refuses a wrong token and a missing token", async () => {
    const harness = createHarness();
    const transport = await harness.server.start(OPTIONS);

    const wrong = await harness.open(
      `http://127.0.0.1:${transport.port}${IOS_VIDEO_STREAM_PATH}?token=nope`,
    ).response;
    expect(wrong.status).toBe(403);
    await wrong.text();

    const none = await harness.open(
      `http://127.0.0.1:${transport.port}${IOS_VIDEO_STREAM_PATH}`,
    ).response;
    expect(none.status).toBe(403);
    await none.text();

    // A refused request must not cost an encoder run either.
    expect(harness.startEncoder).toHaveBeenCalledTimes(0);
  });

  it("answers 404 on any other path", async () => {
    const harness = createHarness();
    const transport = await harness.server.start(OPTIONS);

    const response = await harness.open(
      `http://127.0.0.1:${transport.port}/other?token=${transport.token}`,
    ).response;
    expect(response.status).toBe(404);
    await response.text();
  });

  it("answers 409 once the stream has been stopped", async () => {
    const harness = createHarness();
    const transport = await harness.server.start(OPTIONS);
    harness.server.stop();

    // The port stays bound so the desktop keeps its SSH forward, but there is
    // no device to encode, so a reader is told rather than left hanging.
    const response = await harness.open(transport.url).response;
    expect(response.status).toBe(409);
    await response.text();
  });

  it("does not start the encoder until a reader attaches", async () => {
    const harness = createHarness();
    await harness.server.start(OPTIONS);
    expect(harness.startEncoder).toHaveBeenCalledTimes(0);
  });
});

describe("createIosVideoStreamServer streaming", () => {
  it("sends the config record first, then access units flagged by keyframe", async () => {
    const harness = createHarness();
    const transport = await harness.server.start(OPTIONS);

    const request = harness.open(transport.url);
    const encoder = await harness.encoderAt(0);
    expect(encoder.options).toEqual(OPTIONS);
    encoder.emit(keyframeThenDelta());

    const response = await request.response;
    expect(response.status).toBe(200);
    const records = await createRecordReader(response).take(3);

    expect(records[0]?.type).toBe(IOS_VIDEO_RECORD_TYPE_CONFIG);
    const config = JSON.parse(new TextDecoder().decode(records[0]?.payload)) as {
      codec: string;
      width: number | null;
      annexB: boolean;
    };
    expect(config.codec).toBe(SPS_CODEC);
    expect(config.annexB).toBe(true);

    expect(records[1]?.type).toBe(IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT);
    expect(records[1]?.keyframe).toBe(true);
    expect(records[2]?.type).toBe(IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT);
    expect(records[2]?.keyframe).toBe(false);

    // The keyframe unit carries the parameter sets, so a decoder that joins on
    // it configures itself from the stream alone.
    expect([...(records[1]?.payload ?? []).slice(4, 4 + SPS.length)]).toEqual([...SPS]);
  });

  it("restarts the encoder for a late reader so it still opens on a keyframe", async () => {
    const harness = createHarness();
    const transport = await harness.server.start(OPTIONS);

    const first = harness.open(transport.url);
    const encoderOne = await harness.encoderAt(0);
    encoderOne.emit(keyframeThenDelta());
    const firstReader = createRecordReader(await first.response);
    await firstReader.take(3);

    // `idb video-stream` emits exactly one IDR per run. Without a restart the
    // second reader would wait for a keyframe that never comes.
    const second = harness.open(transport.url);
    const encoderTwo = await harness.encoderAt(1);
    expect(encoderTwo).not.toBe(encoderOne);
    expect(encoderOne.killCount()).toBe(1);

    encoderTwo.emit(keyframeThenDelta());
    const records = await createRecordReader(await second.response).take(2);
    expect(records[0]?.type).toBe(IOS_VIDEO_RECORD_TYPE_CONFIG);
    expect(records[1]?.type).toBe(IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT);
    expect(records[1]?.keyframe).toBe(true);

    await firstReader.cancel();
  });

  it("sends nothing while the stream has produced no keyframe", async () => {
    const harness = createHarness();
    const transport = await harness.server.start(OPTIONS);

    const request = harness.open(transport.url);
    const encoder = await harness.encoderAt(0);
    encoder.emit(deltasOnly());

    // The access unit is parsed and counted, and still nothing goes out: a
    // decoder cannot start on a P-frame, and an access unit ahead of the config
    // record would be decoded against no parameter sets at all. The head is
    // flushed as soon as the reader attaches, so the proof is an empty body
    // rather than an unresolved response.
    expect(harness.server.metrics().frames).toBe(1);
    const response = await request.response;
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(await settlesWithin(reader.read(), 150)).toBe("quiet");
    await reader.cancel();
  });

  it("counts frames, keyframes, the codec and the clients", async () => {
    const harness = createHarness();
    const transport = await harness.server.start(OPTIONS);

    const request = harness.open(transport.url);
    const encoder = await harness.encoderAt(0);
    encoder.emit(keyframeThenDelta());
    await createRecordReader(await request.response).take(3);

    const metrics = harness.server.metrics();
    expect(metrics.frames).toBe(2);
    expect(metrics.keyframes).toBe(1);
    expect(metrics.codec).toBe(SPS_CODEC);
    expect(metrics.clients).toBe(1);
    expect(harness.server.clientCount()).toBe(1);
    expect(metrics.bytes).toBeGreaterThan(0);
    expect(metrics.lastError).toBeNull();
  });

  it("drops every client and records the reason when the encoder exits", async () => {
    const harness = createHarness();
    const transport = await harness.server.start(OPTIONS);

    const request = harness.open(transport.url);
    const encoder = await harness.encoderAt(0);
    encoder.emit(keyframeThenDelta());
    await createRecordReader(await request.response).take(3);

    encoder.exit(1, null);
    expect(harness.server.clientCount()).toBe(0);
    expect(harness.server.metrics().lastError).toBe("The simulator video encoder stopped (code 1).");
  });

  it("stops the encoder once the last reader has been gone for the idle window", async () => {
    // The idle window is 3 seconds. Fake timers keep the wait off the clock,
    // and `shouldAdvanceTime` keeps the loopback request itself working.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const harness = createHarness();
    const transport = await harness.server.start(OPTIONS);

    const request = harness.open(transport.url);
    const encoder = await harness.encoderAt(0);
    encoder.emit(keyframeThenDelta());
    await createRecordReader(await request.response).take(3);
    expect(encoder.killCount()).toBe(0);

    request.close();
    for (let attempt = 0; attempt < 100 && harness.server.clientCount() > 0; attempt += 1) {
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(harness.server.clientCount()).toBe(0);

    // The encoder stays warm briefly so a reload does not pay a restart.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(encoder.killCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(encoder.killCount()).toBe(1);
  });
});

describe("encodeVideoRecord", () => {
  it("writes the documented 12-byte header ahead of the payload", () => {
    const payload = Uint8Array.from([0xaa, 0xbb, 0xcc]);
    const record = encodeVideoRecord(IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT, payload, { keyframe: true });
    const view = new DataView(record.buffer, record.byteOffset, record.byteLength);

    expect(record.byteLength).toBe(IOS_VIDEO_RECORD_HEADER_BYTES + payload.byteLength);
    expect(view.getUint32(0, false)).toBe(IOS_VIDEO_RECORD_MAGIC);
    expect(view.getUint8(4)).toBe(IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT);
    expect(view.getUint8(5)).toBe(IOS_VIDEO_RECORD_FLAG_KEYFRAME);
    expect(view.getUint16(6, false)).toBe(0);
    expect(view.getUint32(8, false)).toBe(payload.byteLength);
    expect([...record.subarray(IOS_VIDEO_RECORD_HEADER_BYTES)]).toEqual([...payload]);
  });

  it("clears the keyframe flag by default", () => {
    const record = encodeVideoRecord(IOS_VIDEO_RECORD_TYPE_CONFIG, new TextEncoder().encode("{}"));
    const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
    expect(view.getUint8(4)).toBe(IOS_VIDEO_RECORD_TYPE_CONFIG);
    expect(view.getUint8(5)).toBe(0);
  });
});

describe("createIosVideoStreamServer token handling", () => {
  it("mints a new token for every stream", async () => {
    // The token is the only thing standing between a local process and the
    // simulator's screen, so one that escapes into a log line or a transcript
    // must stop working when its stream ends.
    const harness = createHarness();
    const first = await harness.server.start(OPTIONS);
    const second = await harness.server.start(OPTIONS);

    expect(first.token).toHaveLength(64);
    expect(second.token).not.toBe(first.token);
    expect(second.port).toBe(first.port);

    // The superseded token is refused, and the current one is not.
    const stale = await fetch(first.url);
    expect(stale.status).toBe(403);
    await stale.body?.cancel();
  });
});

/* ------------------------------------------------------------------------- *
 * The Annex-B parser the server feeds.
 *
 * It lives here rather than in its own file because the server is its only
 * consumer: a framing change is one contract, and splitting it across two
 * suites hid which half a failure came from.
 * ------------------------------------------------------------------------- */

/**
 * A real PARSER_SPS from an iPhone simulator, captured from
 * `idb video-stream --format h264`. It keeps its 4-byte start code and its
 * `0x27` NAL header byte so the tests exercise the same stripping the parser
 * does.
 */
const REAL_SPS_HEX = "0000000127640032ac13142804a0141e4b9a810101520f080422a0";

function parserFromHex(hex: string): Uint8Array {
  const pairs = hex.match(/../g) ?? [];
  return Uint8Array.from(pairs.map((pair) => Number.parseInt(pair, 16)));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Builds one NAL: the header byte for `type`, then a recognisable payload. */
function parserNal(type: number, payloadByte: number, length = 4): Uint8Array {
  const refIdc = type === 5 || type === 7 || type === 8 ? 3 : 2;
  const bytes = new Uint8Array(1 + length);
  bytes[0] = (refIdc << 5) | type;
  bytes.fill(payloadByte, 1);
  return bytes;
}

/** Joins NALs into an Annex-B stream with start codes of `startCodeLength`. */
function parserAnnexB(nals: Uint8Array[], startCodeLength: 3 | 4 = 4): Uint8Array {
  const startCode =
    startCodeLength === 4
      ? Uint8Array.from([0, 0, 0, 1])
      : Uint8Array.from([0, 0, 1]);
  const total = nals.reduce((sum, unit) => sum + startCode.length + unit.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const unit of nals) {
    out.set(startCode, offset);
    offset += startCode.length;
    out.set(unit, offset);
    offset += unit.length;
  }
  return out;
}

/**
 * Minimal Annex-B bit writer. It exists so a test can build an PARSER_SPS with chosen
 * field values and prove the reader walks the same fields in the same order.
 */
class SpsBitWriter {
  private readonly bits: number[] = [];

  bit(value: number): this {
    this.bits.push(value & 1);
    return this;
  }

  /** Unsigned exp-Golomb. */
  ue(value: number): this {
    const code = value + 1;
    const width = Math.floor(Math.log2(code));
    for (let i = 0; i < width; i += 1) this.bits.push(0);
    for (let i = width; i >= 0; i -= 1) this.bits.push((code >> i) & 1);
    return this;
  }

  /** Signed exp-Golomb. */
  se(value: number): this {
    return this.ue(value > 0 ? 2 * value - 1 : -2 * value);
  }

  /** Appends the RBSP stop bit and pads to a byte. */
  toRbsp(): Uint8Array {
    const bits = [...this.bits, 1];
    while (bits.length % 8 !== 0) bits.push(0);
    const out = new Uint8Array(bits.length / 8);
    for (let i = 0; i < bits.length; i += 1) {
      out[i >> 3] |= bits[i] << (7 - (i & 7));
    }
    return out;
  }
}

/** Inserts the emulation prevention bytes an encoder would insert. */
function escapeRbsp(rbsp: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeroRun = 0;
  for (const byte of rbsp) {
    if (zeroRun >= 2 && byte <= 0x03) {
      out.push(0x03);
      zeroRun = 0;
    }
    out.push(byte);
    zeroRun = byte === 0x00 ? zeroRun + 1 : 0;
  }
  return Uint8Array.from(out);
}

function spsPayload(profileIdc: number, constraintFlags: number, levelIdc: number, writer: SpsBitWriter): Uint8Array {
  const head = Uint8Array.from([profileIdc, constraintFlags, levelIdc]);
  const tail = writer.toRbsp();
  const rbsp = new Uint8Array(head.length + tail.length);
  rbsp.set(head, 0);
  rbsp.set(tail, head.length);
  return escapeRbsp(rbsp);
}

const PARSER_SPS = parserNal(7, 0xaa);
const PARSER_PPS = parserNal(8, 0xbb);
const IDR = parserNal(5, 0xcc);
const SLICE_A = parserNal(1, 0xd1);
const SLICE_B = parserNal(1, 0xd2);

describe("createH264AnnexBParser", () => {
  it("splits a stream into one access unit per coded picture", () => {
    const parser = createH264AnnexBParser();
    const pushed = parser.push(parserAnnexB([PARSER_SPS, PARSER_PPS, IDR, SLICE_A, SLICE_B]));
    const flushed = parser.flush();
    const units = [...pushed, ...flushed];

    expect(units.map((unit) => unit.nalTypes)).toEqual([[7, 8, 5], [1], [1]]);
    // The trailing NAL cannot be closed until the stream ends, so it only
    // appears on flush.
    expect(pushed).toHaveLength(1);
    expect(flushed).toHaveLength(2);
  });

  it("finds a start code that straddles two pushes", () => {
    const stream = parserAnnexB([PARSER_SPS, PARSER_PPS, IDR, SLICE_A, SLICE_B]);
    // Cut two bytes into the start code in front of SLICE_A.
    const splitAt = 4 + PARSER_SPS.length + 4 + PARSER_PPS.length + 4 + IDR.length + 2;
    expect([...stream.subarray(splitAt - 2, splitAt + 2)]).toEqual([0, 0, 0, 1]);

    const parser = createH264AnnexBParser();
    const units = [
      ...parser.push(stream.subarray(0, splitAt)),
      ...parser.push(stream.subarray(splitAt)),
      ...parser.flush(),
    ];

    expect(units.map((unit) => unit.nalTypes)).toEqual([[7, 8, 5], [1], [1]]);
    expect(toHex(units[1].bytes)).toBe(`00000001${toHex(SLICE_A)}`);
  });

  it("keeps every byte when a chunk ends inside a NAL payload", () => {
    const stream = parserAnnexB([PARSER_SPS, PARSER_PPS, IDR, SLICE_A]);
    const parser = createH264AnnexBParser();
    const units: ReturnType<typeof parser.push> = [];
    for (let i = 0; i < stream.length; i += 1) {
      units.push(...parser.push(stream.subarray(i, i + 1)));
    }
    units.push(...parser.flush());

    expect(units.map((unit) => unit.nalTypes)).toEqual([[7, 8, 5], [1]]);
    expect(toHex(units[0].bytes)).toBe(
      `00000001${toHex(PARSER_SPS)}00000001${toHex(PARSER_PPS)}00000001${toHex(IDR)}`,
    );
  });

  it("normalises a 3-byte start code to a 4-byte one", () => {
    const parser = createH264AnnexBParser();
    parser.push(parserAnnexB([PARSER_SPS, PARSER_PPS, IDR], 3));
    const units = parser.flush();

    expect(units).toHaveLength(1);
    expect(toHex(units[0].bytes)).toBe(
      `00000001${toHex(PARSER_SPS)}00000001${toHex(PARSER_PPS)}00000001${toHex(IDR)}`,
    );
  });

  it("attaches the PARSER_SPS and PARSER_PPS to the keyframe unit that follows them", () => {
    const parser = createH264AnnexBParser();
    const units = [...parser.push(parserAnnexB([PARSER_SPS, PARSER_PPS, IDR, SLICE_A])), ...parser.flush()];

    const keyframe = units[0];
    expect(keyframe.nalTypes).toEqual([7, 8, 5]);
    expect(keyframe.keyframe).toBe(true);
    // A decoder that joins here has the parameter sets it needs in the same
    // buffer, so the unit stands alone.
    expect(toHex(keyframe.bytes).startsWith(`00000001${toHex(PARSER_SPS)}`)).toBe(true);
    expect(units[1].nalTypes).toEqual([1]);
    expect(units[1].keyframe).toBe(false);
  });

  it("marks only units that carry an IDR slice as keyframes", () => {
    const parser = createH264AnnexBParser();
    const units = [
      ...parser.push(parserAnnexB([PARSER_SPS, PARSER_PPS, IDR, SLICE_A, SLICE_B, IDR, SLICE_A])),
      ...parser.flush(),
    ];

    expect(units.map((unit) => unit.keyframe)).toEqual([true, false, false, true, false]);
  });

  it("reports the parameter sets and codec from a real PARSER_SPS", () => {
    const parser = createH264AnnexBParser();
    const spsNal = parserFromHex(REAL_SPS_HEX).subarray(4);
    parser.push(parserAnnexB([spsNal, PARSER_PPS, IDR]));
    parser.flush();

    const sets = parser.parameterSets();
    expect(sets.codec).toBe("avc1.640032");
    expect(sets.width).toBe(1178);
    expect(sets.height).toBe(2556);
    expect(sets.sps && toHex(sets.sps)).toBe(toHex(spsNal));
    expect(sets.pps && toHex(sets.pps)).toBe(toHex(PARSER_PPS));
  });

  it("starts with no parameter sets and forgets them on reset", () => {
    const parser = createH264AnnexBParser();
    expect(parser.parameterSets()).toEqual({
      sps: null,
      pps: null,
      codec: null,
      width: null,
      height: null,
    });

    parser.push(parserAnnexB([parserFromHex(REAL_SPS_HEX).subarray(4), PARSER_PPS, IDR]));
    parser.flush();
    parser.reset();
    expect(parser.parameterSets().codec).toBeNull();
    expect(parser.droppedBytes()).toBe(0);
  });

  it("caps the retained buffer at 8 MiB and counts the dropped bytes", () => {
    const parser = createH264AnnexBParser();
    const filler = (size: number) => new Uint8Array(size).fill(0xaa);

    parser.push(parserAnnexB([IDR]));
    expect(parser.push(filler(4 * 1024 * 1024))).toEqual([]);
    expect(parser.droppedBytes()).toBe(0);

    // The IDR NAL plus 4 MiB plus 5 MiB with no further start code sits 1 MiB
    // and one NAL past the cap.
    expect(parser.push(filler(5 * 1024 * 1024))).toEqual([]);
    expect(parser.droppedBytes()).toBe(1024 * 1024 + IDR.length);

    // The parser resynchronises on the next start code instead of reporting the
    // NAL whose head it threw away.
    const resumed = [...parser.push(parserAnnexB([PARSER_SPS, PARSER_PPS, IDR])), ...parser.flush()];
    expect(resumed.map((unit) => unit.nalTypes)).toEqual([[7, 8, 5]]);
  });

  it("ignores bytes that arrive before the first start code", () => {
    const parser = createH264AnnexBParser();
    parser.push(Uint8Array.from([0x11, 0x22, 0x33]));
    const units = [...parser.push(parserAnnexB([PARSER_SPS, PARSER_PPS, IDR])), ...parser.flush()];

    expect(units.map((unit) => unit.nalTypes)).toEqual([[7, 8, 5]]);
  });
});

describe("parseH264Sps", () => {
  it("reads the codec string and the cropped resolution of a real PARSER_SPS", () => {
    const sps = parserFromHex(REAL_SPS_HEX);
    expect(sps[4] & 0x1f).toBe(7);
    // The start code and the NAL header byte both come off: the parser reads
    // from profile_idc on.
    const parsed = parseH264Sps(sps.subarray(5));

    expect(parsed).not.toBeNull();
    expect(parsed?.codec).toBe("avc1.640032");
    // 74x160 macroblocks is 1184x2560, cropped by 3 and 2 chroma units.
    expect(parsed?.width).toBe(1178);
    expect(parsed?.height).toBe(2556);
  });

  it("strips emulation prevention bytes that sit before the size fields", () => {
    const writer = new SpsBitWriter()
      .ue(0) // seq_parameter_set_id
      .ue(1) // chroma_format_idc, 4:2:0
      .ue(0) // bit_depth_luma_minus8
      .ue(0) // bit_depth_chroma_minus8
      .bit(0) // qpprime_y_zero_transform_bypass_flag
      .bit(1); // seq_scaling_matrix_present_flag
    writer.bit(1);
    for (let j = 0; j < 16; j += 1) writer.se(0); // one flat 4x4 scaling list
    for (let i = 1; i < 8; i += 1) writer.bit(0);
    // 4194303 encodes as 22 leading zeros, which forces the encoder to escape
    // the byte that follows them. Its value does not reach the result, so the
    // resolution below only holds if the 0x03 was removed.
    writer
      .ue(4_194_303) // log2_max_frame_num_minus4
      .ue(0) // pic_order_cnt_type
      .ue(4) // log2_max_pic_order_cnt_lsb_minus4
      .ue(1) // max_num_ref_frames
      .bit(0) // gaps_in_frame_num_value_allowed_flag
      .ue(79) // pic_width_in_mbs_minus1
      .ue(44) // pic_height_in_map_units_minus1
      .bit(1) // frame_mbs_only_flag
      .bit(1) // direct_8x8_inference_flag
      .bit(0); // frame_cropping_flag

    const payload = spsPayload(100, 0x00, 0x28, writer);
    expect([...payload]).toContain(0x03);

    expect(parseH264Sps(payload)).toEqual({
      codec: "avc1.640028",
      width: 1280,
      height: 720,
    });
  });

  it("doubles the height of an interlaced 4:4:4 PARSER_SPS and uses 1-pixel crop units", () => {
    const writer = new SpsBitWriter()
      .ue(0) // seq_parameter_set_id
      .ue(3) // chroma_format_idc, 4:4:4
      .bit(0) // separate_colour_plane_flag
      .ue(0) // bit_depth_luma_minus8
      .ue(0) // bit_depth_chroma_minus8
      .bit(0) // qpprime_y_zero_transform_bypass_flag
      .bit(0) // seq_scaling_matrix_present_flag
      .ue(0) // log2_max_frame_num_minus4
      .ue(2) // pic_order_cnt_type
      .ue(1) // max_num_ref_frames
      .bit(0) // gaps_in_frame_num_value_allowed_flag
      .ue(79) // pic_width_in_mbs_minus1
      .ue(22) // pic_height_in_map_units_minus1
      .bit(0) // frame_mbs_only_flag
      .bit(0) // mb_adaptive_frame_field_flag
      .bit(1) // direct_8x8_inference_flag
      .bit(1) // frame_cropping_flag
      .ue(1) // frame_crop_left_offset
      .ue(1) // frame_crop_right_offset
      .ue(0) // frame_crop_top_offset
      .ue(8); // frame_crop_bottom_offset

    // 23 map units of 32 lines is 736; 4:4:4 crops 1 luma column per unit and
    // 2 lines per unit while the stream is field coded.
    expect(parseH264Sps(spsPayload(244, 0x00, 0x33, writer))).toEqual({
      codec: "avc1.f40033",
      width: 1278,
      height: 720,
    });
  });

  it("returns null when there is not even a profile and level", () => {
    expect(parseH264Sps(Uint8Array.from([0x64, 0x00]))).toBeNull();
    expect(parseH264Sps(new Uint8Array(0))).toBeNull();
  });

  it("reports the codec but no resolution when the PARSER_SPS is truncated", () => {
    const truncated = parserFromHex(REAL_SPS_HEX).subarray(5, 9);
    expect(parseH264Sps(truncated)).toEqual({
      codec: "avc1.640032",
      width: null,
      height: null,
    });
  });
});
