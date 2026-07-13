import { describe, expect, it } from "vitest";
import {
  codedError,
  encodeCodedErrorMessage,
  extractCodeFromMessage,
  parseCodedErrorMessage,
} from "./codedError";

describe("codedError wire format", () => {
  it("round-trips a code and message across the encode/parse boundary", () => {
    const wire = encodeCodedErrorMessage("disk_full", "Free up space, then try again.");
    const parsed = parseCodedErrorMessage(new Error(wire));
    expect(parsed).toEqual({ code: "disk_full", message: "Free up space, then try again." });
  });

  it("strips the Electron IPC wrapper before parsing", () => {
    const wire = encodeCodedErrorMessage("brain_crash_looping", "Restart ADE, then run repair again.");
    const parsed = parseCodedErrorMessage(new Error(`Error invoking remote method 'ade.project.openRepo': Error: ${wire}`));
    expect(parsed.code).toBe("brain_crash_looping");
    expect(parsed.message).toBe("Restart ADE, then run repair again.");
  });

  it("carries an encoded rootPath the renderer never saw, without leaking it into the message", () => {
    const rootPath = "/Users/dev/Projects/My App";
    const wire = encodeCodedErrorMessage("disk_full", "Free up space, then try again.", { rootPath });
    const parsed = parseCodedErrorMessage(new Error(wire));
    expect(parsed).toEqual({
      code: "disk_full",
      message: "Free up space, then try again.",
      rootPath,
    });
    // The delimiter must not survive into user-facing message text.
    expect(parsed.message).not.toContain(rootPath);
  });

  it("preserves a rootPath with leading and trailing whitespace exactly", () => {
    const rootPath = "  /Users/dev/Projects/ Spaced App  ";
    const wire = encodeCodedErrorMessage("disk_full", "Free up space.", { rootPath });
    expect(parseCodedErrorMessage(new Error(wire)).rootPath).toBe(rootPath);
  });

  it("omits rootPath when none was encoded and preserves messages containing spaces and colons", () => {
    const wire = encodeCodedErrorMessage("db_integrity", "Ratio 3:1 exceeded; contact support.");
    const parsed = parseCodedErrorMessage(new Error(wire));
    expect(parsed.rootPath).toBeUndefined();
    expect(parsed.message).toBe("Ratio 3:1 exceeded; contact support.");
  });

  it("prefers an attached code property over the message prefix and reads a bare message", () => {
    expect(extractCodeFromMessage(codedError("plain text with no prefix", "socket_stale_no_owner")))
      .toBe("socket_stale_no_owner");
    expect(parseCodedErrorMessage(new Error("just a message")).code).toBeUndefined();
  });
});
