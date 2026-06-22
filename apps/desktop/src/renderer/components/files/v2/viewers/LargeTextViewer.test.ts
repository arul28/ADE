import { describe, expect, it } from "vitest";
import { decodeFileRangeContent } from "./LargeTextViewer";

describe("decodeFileRangeContent", () => {
  it("passes UTF-8 chunks through unchanged", () => {
    expect(decodeFileRangeContent("hello\n", "utf-8")).toBe("hello\n");
  });

  it("decodes base64 chunks before appending streamed text", () => {
    const text = "hello\0world\ncafe";
    const base64 = Buffer.from(text, "utf8").toString("base64");

    expect(decodeFileRangeContent(base64, "base64")).toBe(text);
  });
});
