import { describe, expect, it } from "vitest";
import { firstUserTextFromRecords } from "./discoveryUtils";

describe("firstUserTextFromRecords", () => {
  it("skips message records with explicit assistant role", () => {
    const text = firstUserTextFromRecords([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Assistant summary should not win." }],
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Use this request as the title." }],
        },
      },
    ]);

    expect(text).toBe("Use this request as the title.");
  });
});
