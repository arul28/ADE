import { describe, expect, it } from "vitest";
import { CHAT_STATUS_HEX, chatStatusTextClass, type ChatStatusVisualState } from "./chatStatusVisuals";

describe("CHAT_STATUS_HEX", () => {
  it("maps all expected statuses to hex color strings", () => {
    expect(CHAT_STATUS_HEX.working).toBe("#10B981");
    expect(CHAT_STATUS_HEX.waiting).toBe("#F59E0B");
    expect(CHAT_STATUS_HEX.completed).toBe("#10B981");
    expect(CHAT_STATUS_HEX.failed).toBe("#EF4444");
    expect(CHAT_STATUS_HEX.idle).toBe("#6B7280");
  });

  it("does not expose unexpected keys", () => {
    const keys = Object.keys(CHAT_STATUS_HEX);
    expect(keys).toEqual(expect.arrayContaining(["working", "waiting", "completed", "failed", "idle"]));
    expect(keys).toHaveLength(5);
  });
});

describe("chatStatusTextClass", () => {
  it("returns the correct class for completed status", () => {
    expect(chatStatusTextClass("completed")).toBe("text-emerald-300/75");
  });

  it("returns the correct class for failed status", () => {
    expect(chatStatusTextClass("failed")).toBe("text-red-300/80");
  });

  it("returns the correct class for waiting status", () => {
    expect(chatStatusTextClass("waiting")).toBe("text-amber-300/80");
  });

  it("returns the working default for the working status", () => {
    expect(chatStatusTextClass("working")).toBe("text-emerald-300/80");
  });

  it("returns distinct classes for each status", () => {
    const statuses: ChatStatusVisualState[] = ["working", "waiting", "completed", "failed"];
    const classes = statuses.map(chatStatusTextClass);
    // completed and working are different classes
    expect(classes[0]).not.toBe(classes[1]);
    expect(classes[0]).not.toBe(classes[2]);
    expect(classes[1]).not.toBe(classes[3]);
  });
});
