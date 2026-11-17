import { describe, expect, it } from "vitest";
import { CLOUD_CAPSULE_MAX_BYTES, CLOUD_CAPSULE_MAX_PART_BYTES } from "../../../../account-directory/src/cloud/contract";
import { splitCapsule } from "./cloudRestSave";

describe("splitCapsule", () => {
  const bytes = (length: number) => Uint8Array.from({ length }, (_, index) => index % 251);

  it.each([
    ["one byte", 1, 1],
    ["exactly one part", CLOUD_CAPSULE_MAX_PART_BYTES, 1],
    ["one byte over a part", CLOUD_CAPSULE_MAX_PART_BYTES + 1, 2],
    ["exactly the capsule cap", CLOUD_CAPSULE_MAX_BYTES, Math.ceil(CLOUD_CAPSULE_MAX_BYTES / CLOUD_CAPSULE_MAX_PART_BYTES)],
  ])("splits %s into parts the server takes, in order, with nothing lost", (_label, length, partCount) => {
    const input = bytes(length);
    const parts = splitCapsule(input)!;
    expect(parts).toHaveLength(partCount);
    for (const part of parts) {
      expect(part.byteLength).toBeGreaterThan(0);
      expect(part.byteLength).toBeLessThanOrEqual(CLOUD_CAPSULE_MAX_PART_BYTES);
    }
    expect(Buffer.concat(parts.map((part) => Buffer.from(part))).equals(Buffer.from(input))).toBe(true);
  });

  it.each([
    ["an empty capsule", 0],
    ["a capsule over the cap", CLOUD_CAPSULE_MAX_BYTES + 1],
  ])("saves no parts for %s (the restore replays the transcript)", (_label, length) => {
    expect(splitCapsule(bytes(length))).toBeNull();
  });
});
