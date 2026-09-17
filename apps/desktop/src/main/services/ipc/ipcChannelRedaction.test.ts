import { describe, expect, it } from "vitest";
import { IPC } from "../../../shared/ipc";
import {
  ipcChannelRedactionMap,
  redactIpcArgsForChannel,
  shouldRedactIpcKey,
} from "./ipcChannelRedaction";

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

  // The machine-scoped OpenAI key travels as a bare `key` field. It was in
  // neither gate: the channel was absent from the map, and the generic
  // field-name guard matched `apikey` but not `key` — so a verbose IPC trace
  // wrote the user's OpenAI key into the log file verbatim. These two map
  // entries are now the only thing redacting it, so this test is the gate.
  it("redacts the raw provider credential on both key-store channels", () => {
    for (const channel of [IPC.aiStoreApiKey, IPC.aiStoreMachineApiKey]) {
      const [redacted] = redactIpcArgsForChannel(channel, [
        { provider: "openai", key: "sk-proj-not-a-real-key" },
      ]) as Array<Record<string, unknown>>;
      expect(redacted.key).toBe("[redacted]");
      expect(JSON.stringify(redacted)).not.toContain("sk-proj-not-a-real-key");
      expect(redacted.provider).toBe("openai");
    }
  });

  /**
   * The generic guard covers families of names and a few exact ones. A bare
   * `key` is NOT one of them: it is the ordinary word for a lookup key
   * (`projectSetRecentPinned { key, pinned }`), and blanking it made traces
   * that exist to explain those calls say nothing. The credential case is
   * covered above, by the two channels that actually carry one.
   */
  it("redacts secret-shaped field names without blanking a bare lookup key", () => {
    expect(shouldRedactIpcKey("apiKey")).toBe(true);
    expect(shouldRedactIpcKey("API_KEY")).toBe(true);
    expect(shouldRedactIpcKey("accessToken")).toBe(true);
    expect(shouldRedactIpcKey("refresh_token")).toBe(true);
    expect(shouldRedactIpcKey("clientSecret")).toBe(true);
    expect(shouldRedactIpcKey("pairingPin")).toBe(true);
    expect(shouldRedactIpcKey("key")).toBe(false);
    expect(shouldRedactIpcKey("Key")).toBe(false);
    expect(shouldRedactIpcKey("keyboardShortcut")).toBe(false);
    expect(shouldRedactIpcKey(undefined)).toBe(false);
  });

  it("leaves channels with no declared secrets untouched", () => {
    const args = [{ anything: "kept" }];
    expect(redactIpcArgsForChannel("some/unmapped/channel", args)).toBe(args);
  });

  it("does not descend into non-object arguments", () => {
    expect(redactIpcArgsForChannel(IPC.terminalWrite, ["raw", 7, null])).toEqual(["raw", 7, null]);
  });
});
