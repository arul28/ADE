import { describe, expect, it, vi } from "vitest";
import {
  CURSOR_CLOUD_RENAME_BLOCKED_MESSAGE,
  assertCursorCloudRenameAllowed,
  cursorOwnsSessionName,
} from "./cursorCloudNaming";

describe("cursorOwnsSessionName", () => {
  it("treats a real agent id as owned and ignores blanks", () => {
    expect(cursorOwnsSessionName("bc-1")).toBe(true);
    expect(cursorOwnsSessionName("  ")).toBe(false);
    expect(cursorOwnsSessionName(null)).toBe(false);
    expect(cursorOwnsSessionName(undefined)).toBe(false);
  });
});

describe("assertCursorCloudRenameAllowed", () => {
  it("refuses a title write when Cursor owns the name", async () => {
    const getSessionSummary = vi.fn().mockResolvedValue({ cursorCloudAgentId: "cloud-agent-1" });
    await expect(assertCursorCloudRenameAllowed(getSessionSummary, {
      sessionId: "session-1",
      title: "ADE-owned title",
    })).rejects.toThrow(CURSOR_CLOUD_RENAME_BLOCKED_MESSAGE);
    expect(getSessionSummary).toHaveBeenCalledWith("session-1");
  });

  it("lets a pin-only patch through without reading the chat", async () => {
    const getSessionSummary = vi.fn();
    await expect(assertCursorCloudRenameAllowed(getSessionSummary, {
      sessionId: "session-1",
    })).resolves.toBeUndefined();
    expect(getSessionSummary).not.toHaveBeenCalled();
  });

  it("ignores a whitespace-only cloud agent id", async () => {
    const getSessionSummary = vi.fn().mockResolvedValue({ cursorCloudAgentId: "  " });
    await expect(assertCursorCloudRenameAllowed(getSessionSummary, {
      sessionId: "session-1",
      title: "Local title",
    })).resolves.toBeUndefined();
  });
});
