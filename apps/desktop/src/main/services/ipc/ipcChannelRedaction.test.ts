import { describe, expect, it } from "vitest";
import { IPC } from "../../../shared/ipc";
import { ipcChannelRedactionMap, redactIpcArgsForChannel } from "./ipcChannelRedaction";

describe("ipc channel redaction", () => {
  // ADE never reads, stores, or logs a provider credential. When Pi asks for an
  // API key, the user's answer to that prompt IS the credential, and it travels
  // over this channel as an ordinary string — nothing downstream can tell it
  // apart from a device code. Dropping the channel from the map leaks it into
  // any verbose IPC trace, and no other test fails.
  it("redacts a Pi sign-in answer, which may be a raw API key", () => {
    expect(ipcChannelRedactionMap[IPC.aiPiLoginSubmit]?.has("value")).toBe(true);

    const [redacted] = redactIpcArgsForChannel(IPC.aiPiLoginSubmit, [
      { providerId: "anthropic", requestId: "req-1", value: "sk-ant-not-a-real-key" },
    ]) as Array<Record<string, unknown>>;

    expect(redacted.value).toBe("[redacted]");
    expect(JSON.stringify(redacted)).not.toContain("sk-ant-not-a-real-key");
    // Non-secret fields must survive or the trace stops being useful.
    expect(redacted).toMatchObject({ providerId: "anthropic", requestId: "req-1" });
  });

  it("leaves channels with no declared secrets untouched", () => {
    const args = [{ anything: "kept" }];
    expect(redactIpcArgsForChannel("some/unmapped/channel", args)).toBe(args);
  });

  it("does not descend into non-object arguments", () => {
    expect(redactIpcArgsForChannel(IPC.terminalWrite, ["raw", 7, null])).toEqual(["raw", 7, null]);
  });
});
