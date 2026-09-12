import { IOS_VIDEO_RECORD_FLAG_KEYFRAME, IOS_VIDEO_RECORD_HEADER_BYTES, IOS_VIDEO_RECORD_MAGIC, IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT, IOS_VIDEO_RECORD_TYPE_CONFIG } from "../../../shared/types/iosSimulator";
import { describe, expect, it } from "vitest";

import { IosSimVideoProtocolError, createIosSimVideoRecordParser } from "./iosSimVideoRecords";

/**
 * Builds one framed record the way the server does.
 *
 * The encoder lives in the main process, so the renderer test writes the header
 * itself. A test that imported the server's encoder would pass even if the two
 * sides drifted apart together.
 */
function frame(
  type: number,
  payload: Uint8Array,
  options: { keyframe?: boolean; magic?: number; declaredLength?: number } = {},
): Uint8Array {
  const record = new Uint8Array(IOS_VIDEO_RECORD_HEADER_BYTES + payload.byteLength);
  const view = new DataView(record.buffer);
  view.setUint32(0, options.magic ?? IOS_VIDEO_RECORD_MAGIC, false);
  view.setUint8(4, type);
  view.setUint8(5, options.keyframe ? IOS_VIDEO_RECORD_FLAG_KEYFRAME : 0);
  view.setUint16(6, 0, false);
  view.setUint32(8, options.declaredLength ?? payload.byteLength, false);
  record.set(payload, IOS_VIDEO_RECORD_HEADER_BYTES);
  return record;
}

function configFrame(config: Record<string, unknown>): Uint8Array {
  return frame(IOS_VIDEO_RECORD_TYPE_CONFIG, new TextEncoder().encode(JSON.stringify(config)));
}

function rawConfigFrame(text: string): Uint8Array {
  return frame(IOS_VIDEO_RECORD_TYPE_CONFIG, new TextEncoder().encode(text));
}

function accessUnitFrame(payload: number[], keyframe = false): Uint8Array {
  return frame(IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT, Uint8Array.from(payload), { keyframe });
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const CONFIG = { codec: "avc1.640032", width: 1170, height: 2532, annexB: true };

describe("createIosSimVideoRecordParser", () => {
  it("parses a config record and an access unit from one chunk", () => {
    const parser = createIosSimVideoRecordParser();
    const records = parser.push(concat(configFrame(CONFIG), accessUnitFrame([1, 2, 3], true)));

    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      kind: "config",
      codec: "avc1.640032",
      width: 1170,
      height: 2532,
      annexB: true,
    });
    const unit = records[1];
    expect(unit?.kind).toBe("access-unit");
    if (unit?.kind !== "access-unit") throw new Error("Expected an access unit.");
    expect([...unit.bytes]).toEqual([1, 2, 3]);
    expect(unit.keyframe).toBe(true);
  });

  it("reads a config record with no width or height as null", () => {
    const parser = createIosSimVideoRecordParser();
    const records = parser.push(configFrame({ codec: "avc1.42e01e" }));
    expect(records[0]).toEqual({
      kind: "config",
      codec: "avc1.42e01e",
      width: null,
      height: null,
      annexB: true,
    });
  });

  it("reassembles a record split across three chunks, including inside the header", () => {
    const parser = createIosSimVideoRecordParser();
    const record = accessUnitFrame([9, 8, 7, 6], true);

    // The first split lands at byte 5, inside the header. A parser that read a
    // partial header would take the magic from bytes it has not received.
    expect(parser.push(record.subarray(0, 5))).toEqual([]);
    expect(parser.push(record.subarray(5, 13))).toEqual([]);
    const records = parser.push(record.subarray(13));

    expect(records).toHaveLength(1);
    const unit = records[0];
    if (unit?.kind !== "access-unit") throw new Error("Expected an access unit.");
    expect([...unit.bytes]).toEqual([9, 8, 7, 6]);
    expect(parser.pendingBytes()).toBe(0);
  });

  it("parses two records that arrive in one chunk", () => {
    const parser = createIosSimVideoRecordParser();
    const records = parser.push(concat(accessUnitFrame([1], true), accessUnitFrame([2])));

    expect(records.map((record) => record.kind)).toEqual(["access-unit", "access-unit"]);
    expect(records.map((record) => (record.kind === "access-unit" ? record.keyframe : null)))
      .toEqual([true, false]);
  });

  it("reports only the keyframe flag, not the other header bits", () => {
    const parser = createIosSimVideoRecordParser();
    const record = accessUnitFrame([1, 2]);
    // Set a second flag bit the reader does not know about.
    record[5] = IOS_VIDEO_RECORD_FLAG_KEYFRAME | 0b10;
    const unit = parser.push(record)[0];
    if (unit?.kind !== "access-unit") throw new Error("Expected an access unit.");
    expect(unit.keyframe).toBe(true);
  });

  it("reports the tail it is still holding", () => {
    const parser = createIosSimVideoRecordParser();
    const record = accessUnitFrame([4, 5, 6]);

    expect(parser.push(record.subarray(0, 6))).toEqual([]);
    expect(parser.pendingBytes()).toBe(6);

    const withTail = concat(record.subarray(6), accessUnitFrame([7]).subarray(0, 4));
    expect(parser.push(withTail)).toHaveLength(1);
    expect(parser.pendingBytes()).toBe(4);
  });

  it("throws on bad magic", () => {
    const parser = createIosSimVideoRecordParser();
    const record = frame(IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT, Uint8Array.from([1]), { magic: 0xdeadbeef });
    expect(() => parser.push(record)).toThrow(IosSimVideoProtocolError);
  });

  it("throws on a declared length larger than any record the server sends", () => {
    const parser = createIosSimVideoRecordParser();
    // A desynchronised reader misreads the length field. Allocating on it is
    // how a stray chunk turns into an out-of-memory crash.
    const record = frame(IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT, Uint8Array.from([1]), {
      declaredLength: 64 * 1024 * 1024,
    });
    expect(() => parser.push(record)).toThrow(IosSimVideoProtocolError);
    expect(() => parser.push(record)).toThrow("declared a 67108864 byte record");
  });

  it("throws when the config payload is not JSON", () => {
    const parser = createIosSimVideoRecordParser();
    expect(() => parser.push(rawConfigFrame("{not json"))).toThrow(IosSimVideoProtocolError);
  });

  it("throws when the config names no codec", () => {
    const parser = createIosSimVideoRecordParser();
    expect(() => parser.push(configFrame({ width: 100, height: 200 })))
      .toThrow(IosSimVideoProtocolError);
    expect(() => parser.push(configFrame({ codec: "" }))).toThrow(IosSimVideoProtocolError);
  });

  it("skips an unknown record type and keeps the record behind it", () => {
    const parser = createIosSimVideoRecordParser();
    // A newer server may add a record type. An older reader must step over it
    // by its length rather than stop, or the stream is lost from that byte on.
    const records = parser.push(concat(
      frame(99, Uint8Array.from([1, 2, 3, 4, 5])),
      accessUnitFrame([42], true),
    ));

    expect(records).toHaveLength(1);
    const unit = records[0];
    if (unit?.kind !== "access-unit") throw new Error("Expected an access unit.");
    expect([...unit.bytes]).toEqual([42]);
  });

  it("drops the tail on reset", () => {
    const parser = createIosSimVideoRecordParser();
    parser.push(accessUnitFrame([1, 2, 3]).subarray(0, 7));
    expect(parser.pendingBytes()).toBe(7);

    parser.reset();
    expect(parser.pendingBytes()).toBe(0);
    // After a reset the next chunk is the start of a record, not a continuation.
    expect(parser.push(accessUnitFrame([1, 2, 3]))).toHaveLength(1);
  });

  it("returns bytes the caller cannot mutate", () => {
    const parser = createIosSimVideoRecordParser();
    const chunk = accessUnitFrame([5, 6, 7], true);
    const unit = parser.push(chunk)[0];
    if (unit?.kind !== "access-unit") throw new Error("Expected an access unit.");

    // The reader reuses its receive buffer, and the decoder keeps the view it
    // was handed. A view onto the caller's chunk would decode different bytes.
    chunk[IOS_VIDEO_RECORD_HEADER_BYTES] = 0xff;
    expect([...unit.bytes]).toEqual([5, 6, 7]);
  });
});
