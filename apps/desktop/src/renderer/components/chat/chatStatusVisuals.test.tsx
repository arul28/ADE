import { describe, expect, it } from "vitest";

import {
  CHAT_STATUS_HEX,
  chatStatusTextClass,
  type ChatStatusVisualState,
} from "./chatStatusVisuals";

describe("CHAT_STATUS_HEX", () => {
  it("maps working and completed to the same emerald hex", () => {
    expect(CHAT_STATUS_HEX.working).toBe("#10B981");
    expect(CHAT_STATUS_HEX.completed).toBe("#10B981");
  });

  it("maps waiting to amber", () => {
    expect(CHAT_STATUS_HEX.waiting).toBe("#F59E0B");
  });

  it("maps failed to red", () => {
    expect(CHAT_STATUS_HEX.failed).toBe("#EF4444");
  });

  it("maps idle to gray", () => {
    expect(CHAT_STATUS_HEX.idle).toBe("#6B7280");
  });

  it("exposes exactly the expected keys", () => {
    expect(Object.keys(CHAT_STATUS_HEX).sort()).toEqual(
      ["completed", "failed", "idle", "waiting", "working"].sort(),
    );
  });
});

describe("chatStatusTextClass", () => {
  it("returns emerald for completed", () => {
    expect(chatStatusTextClass("completed")).toBe("text-emerald-300/75");
  });

  it("returns red for failed", () => {
    expect(chatStatusTextClass("failed")).toBe("text-red-300/80");
  });

  it("returns amber for waiting", () => {
    expect(chatStatusTextClass("waiting")).toBe("text-amber-300/80");
  });

  it("returns default emerald for working", () => {
    expect(chatStatusTextClass("working")).toBe("text-emerald-300/80");
  });

  it("returns default emerald for unknown values (default branch)", () => {
    // Cast to exercise the default branch defensively even though the
    // type disallows this at compile time.
    expect(chatStatusTextClass("idle" as unknown as ChatStatusVisualState)).toBe(
      "text-emerald-300/80",
    );
    expect(chatStatusTextClass("anything-else" as unknown as ChatStatusVisualState)).toBe(
      "text-emerald-300/80",
    );
  });
});
