import { describe, expect, it } from "vitest";
import { approxDecodedBytes, maxBase64EncodedLength } from "./chatAttachmentLimits";

describe("base64 length helpers", () => {
  it("admits every payload within the byte limit and nothing a whole block larger", () => {
    for (const bytes of [0, 1, 2, 3, 4, 1024, 10 * 1024 * 1024]) {
      expect(Buffer.alloc(bytes).toString("base64").length).toBeLessThanOrEqual(maxBase64EncodedLength(bytes));
      expect(Buffer.alloc(bytes + 3).toString("base64").length).toBeGreaterThan(maxBase64EncodedLength(bytes));
    }
    expect(maxBase64EncodedLength(10 * 1024 * 1024)).toBe(13_981_016);
  });

  it("never reports fewer bytes than a base64 string decodes to", () => {
    for (const bytes of [1, 2, 3, 1000, 2048]) {
      const encoded = Buffer.alloc(bytes).toString("base64");
      expect(approxDecodedBytes(encoded.length)).toBeGreaterThanOrEqual(bytes);
      expect(approxDecodedBytes(encoded.length) - bytes).toBeLessThan(3);
    }
  });
});
