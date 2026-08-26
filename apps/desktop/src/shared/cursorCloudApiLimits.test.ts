import { describe, expect, it } from "vitest";
import { CURSOR_CLOUD_MAX_PAGE_LIMIT, clampCursorCloudPageLimit } from "./cursorCloudApiLimits";

describe("clampCursorCloudPageLimit", () => {
  it("caps a page at the 100 rows Cursor accepts", () => {
    expect(CURSOR_CLOUD_MAX_PAGE_LIMIT).toBe(100);
    expect(clampCursorCloudPageLimit(200)).toBe(100);
    expect(clampCursorCloudPageLimit(100)).toBe(100);
    expect(clampCursorCloudPageLimit(99)).toBe(99);
  });

  it("raises a non-positive page to one row", () => {
    expect(clampCursorCloudPageLimit(0)).toBe(1);
    expect(clampCursorCloudPageLimit(-5)).toBe(1);
  });

  it("leaves an unset or non-finite page to the SDK default", () => {
    expect(clampCursorCloudPageLimit(undefined)).toBeUndefined();
    expect(clampCursorCloudPageLimit(null)).toBeUndefined();
    expect(clampCursorCloudPageLimit(Number.NaN)).toBeUndefined();
    expect(clampCursorCloudPageLimit(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("floors a fractional page", () => {
    expect(clampCursorCloudPageLimit(10.9)).toBe(10);
  });
});
