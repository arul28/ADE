import { describe, expect, it } from "vitest";
import { triggerSourcesForConnection } from "./TriggerCard";

describe("Cursor Cloud automation trigger visibility", () => {
  it("hides the Cursor Cloud trigger until the Cursor connection is confirmed", () => {
    const disconnected = triggerSourcesForConnection(false);
    const connected = triggerSourcesForConnection(true);

    expect(disconnected.length).toBeGreaterThan(0);
    expect(disconnected.some((source) => source.value === "cursor")).toBe(false);
    expect(connected.some((source) => source.value === "cursor")).toBe(true);
    expect(connected.length).toBe(disconnected.length + 1);
  });
});
