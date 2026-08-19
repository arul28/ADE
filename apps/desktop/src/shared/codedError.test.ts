import { describe, expect, it } from "vitest";
import {
  codedError,
  encodeCodedErrorMessage,
  extractCodeFromMessage,
  isErrnoLikeCode,
  parseCodedErrorMessage,
  UNKNOWN_SYSTEM_ERRNO_PATTERN,
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

  it("recognizes a code the brain attached, behind the runtime RPC wrapper", () => {
    // The exact chain a daemon-side failure travels: Electron IPC wraps the
    // main process's error, which wraps the runtime client's, which wraps the
    // brain's coded reply. Without the innermost strip the code is invisible
    // and the user gets a generic "couldn't open this project".
    const parsed = parseCodedErrorMessage(new Error(
      "Error invoking remote method 'ade.localRuntime.callAction': Error: "
      + "Remote ADE service method ade/actions/call failed (code -32603): "
      + "storage_read_failed: ADE couldn't read this project's data at /tmp/p/.ade/ade.db.",
    ));
    expect(parsed.code).toBe("storage_read_failed");
    expect(parsed.message).toBe("ADE couldn't read this project's data at /tmp/p/.ade/ade.db.");
  });

  it("leaves an uncoded runtime failure without a code", () => {
    const parsed = parseCodedErrorMessage(new Error(
      "Remote ADE service method attention.call failed (code -32601): Method not found",
    ));
    expect(parsed.code).toBeUndefined();
    expect(parsed.message).toBe("Method not found");
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

describe("isErrnoLikeCode", () => {
  it("claims platform codes, including the Node internal ones that quote paths", () => {
    for (const code of [
      "ENOENT",
      "EDEADLK",
      "ECONNRESET",
      "ERR_MODULE_NOT_FOUND",
      "ERR_FS_EISDIR",
      "ERR_INVALID_ARG_TYPE",
      "MODULE_NOT_FOUND",
    ]) {
      expect(isErrnoLikeCode(code)).toBe(true);
    }
  });

  it("leaves ADE's own verdicts alone, so they still cross a boundary intact", () => {
    for (const code of [
      "storage_read_failed",
      "disk_full",
      "brain_not_installed",
      "migration_incomplete",
      "",
      "   ",
      null,
      undefined,
      42,
    ]) {
      expect(isErrnoLikeCode(code)).toBe(false);
    }
  });
});

describe("UNKNOWN_SYSTEM_ERRNO_PATTERN", () => {
  it("matches the errno libuv could not name, in either casing", () => {
    expect(UNKNOWN_SYSTEM_ERRNO_PATTERN.test("Unknown system error -11: Unknown system error -11, read"))
      .toBe(true);
    expect(UNKNOWN_SYSTEM_ERRNO_PATTERN.test("unknown system error 11")).toBe(true);
    expect(UNKNOWN_SYSTEM_ERRNO_PATTERN.test("ADE couldn't read this project's data.")).toBe(false);
  });
});
