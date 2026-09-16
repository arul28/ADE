/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { readCursorCloudConnectionForAutomation } from "./AutomationsWorkspace";

describe("automation Cursor Cloud connection probe", () => {
  it("does not fail the automation refresh when AI status is unavailable", async () => {
    const getStatus = vi.fn().mockRejectedValue(new Error("AI bridge unavailable"));

    await expect(readCursorCloudConnectionForAutomation(getStatus)).resolves.toBe(false);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });
});
