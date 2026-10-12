import { describe, expect, it } from "vitest";
import path from "node:path";
import { readRecycleBinOriginalPath, recycleBinDataName, recycleBinRecordFor } from "./recycleBinRecord";

const ORIGINAL = "C:\\Users\\ada\\Projects\\app\\.ade";

/** A `$I…` record as Windows writes it. */
function record(version: 1 | 2, original: string): Buffer {
  const header = Buffer.alloc(24);
  header.writeBigUInt64LE(BigInt(version), 0);
  header.writeBigUInt64LE(4096n, 8);
  header.writeBigUInt64LE(133_000_000_000_000_000n, 16);
  const text = Buffer.from(`${original}\u0000`, "utf16le");
  if (version === 1) {
    const field = Buffer.alloc(520);
    text.copy(field);
    return Buffer.concat([header, field]);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32LE(original.length + 1, 0);
  return Buffer.concat([header, length, text]);
}

describe("readRecycleBinOriginalPath", () => {
  it.each([
    { name: "a Windows 10+ record", input: record(2, ORIGINAL), expected: ORIGINAL },
    { name: "a Vista-to-Windows-8 record", input: record(1, ORIGINAL), expected: ORIGINAL },
    { name: "an unknown version", input: Buffer.concat([Buffer.from([3, 0, 0, 0, 0, 0, 0, 0]), record(2, ORIGINAL).subarray(8)]), expected: null },
    { name: "a truncated record", input: record(2, ORIGINAL).subarray(0, 20), expected: null },
  ])("reads $name", ({ input, expected }) => {
    expect(readRecycleBinOriginalPath(input)).toBe(expected);
  });

  it("pairs a record and the data item it describes, both ways", () => {
    expect(recycleBinDataName("$IK7Q2ZX")).toBe("$RK7Q2ZX");
    expect(recycleBinDataName("desktop.ini")).toBeNull();
    expect(recycleBinRecordFor(path.join("bin", "$RK7Q2ZX"))).toBe(path.join("bin", "$IK7Q2ZX"));
    expect(recycleBinRecordFor(path.join("trash", ".ade"))).toBeNull();
  });
});
