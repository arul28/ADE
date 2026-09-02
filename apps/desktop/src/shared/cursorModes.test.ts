import { describe, expect, it } from "vitest";
import {
  CURSOR_AVAILABLE_MODE_IDS,
  CURSOR_DEFAULT_MODE_ID,
  effectiveCursorModeId,
  legacyPermissionModeToCursorModeId,
} from "./cursorModes";

describe("Cursor mode compatibility mapping", () => {
  it("maps native legacy modes and preserves absence for plain-agent modes", () => {
    expect(legacyPermissionModeToCursorModeId("full-auto")).toBe("full-auto");
    expect(legacyPermissionModeToCursorModeId("plan")).toBe("plan");
    // Materialising "agent" would pin the next launch to a real selection.
    expect(legacyPermissionModeToCursorModeId("default")).toBeNull();
    expect(legacyPermissionModeToCursorModeId("edit")).toBeNull();
    expect(legacyPermissionModeToCursorModeId("ask")).toBeNull();
    expect(CURSOR_AVAILABLE_MODE_IDS).toContain(CURSOR_DEFAULT_MODE_ID);
  });

  it("prefers an explicit native mode over the legacy permission field", () => {
    expect(effectiveCursorModeId("agent", "full-auto")).toBe("agent");
    expect(effectiveCursorModeId("ask", "plan")).toBe("ask");
    expect(effectiveCursorModeId("  agent  ", "full-auto")).toBe("agent");
    expect(effectiveCursorModeId("", "plan")).toBe("plan");
  });

  it("resolves legacy modes and the default when no explicit mode exists", () => {
    expect(effectiveCursorModeId(null, "full-auto")).toBe("full-auto");
    expect(effectiveCursorModeId(undefined, "plan")).toBe("plan");
    expect(effectiveCursorModeId(null, "edit")).toBe(CURSOR_DEFAULT_MODE_ID);
    expect(effectiveCursorModeId(null, null)).toBe(CURSOR_DEFAULT_MODE_ID);
    expect(effectiveCursorModeId(null)).toBe(CURSOR_DEFAULT_MODE_ID);
  });
});
