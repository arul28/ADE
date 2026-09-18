import { describe, expect, it } from "vitest";
import { isDataUri, isRemoteOrDataUri } from "./chatImageUrls";

describe("chat image URL predicates", () => {
  it("recognizes data URIs case-insensitively", () => {
    expect(isDataUri("data:image/png;base64,AAAA")).toBe(true);
    expect(isDataUri("DATA:image/png;base64,AAAA")).toBe(true);
    expect(isDataUri("data:text/plain,hello")).toBe(true);
  });

  it("rejects file, remote, and empty values", () => {
    for (const value of ["https://cdn.example.com/a.png", "file:///tmp/a.png", "/tmp/a.png", "", null, undefined]) {
      expect(isDataUri(value), String(value)).toBe(false);
    }
  });

  it("treats remote and data URIs as renderable-elsewhere, but not file paths", () => {
    expect(isRemoteOrDataUri("https://cdn.example.com/a.png")).toBe(true);
    expect(isRemoteOrDataUri("http://cdn.example.com/a.png")).toBe(true);
    expect(isRemoteOrDataUri("data:image/png;base64,AAAA")).toBe(true);
    expect(isRemoteOrDataUri("file:///tmp/a.png")).toBe(false);
    expect(isRemoteOrDataUri("/tmp/a.png")).toBe(false);
  });
});
