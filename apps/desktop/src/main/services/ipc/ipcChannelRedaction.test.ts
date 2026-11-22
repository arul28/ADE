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

  // A link handed to a browser is not a secret by name, so the generic
  // field-name guard leaves `url` alone. A link a user opens is often the
  // sensitive one though: a presigned URL, or an OAuth callback still carrying
  // its `code`.
  it("redacts the URL handed to a chosen browser", () => {
    const url = "https://example.test/callback?code=not-a-real-code";

    const [redacted] = redactIpcArgsForChannel(IPC.appOpenInBrowser, [
      { url, browserId: "chrome" },
    ]) as Array<Record<string, unknown>>;

    expect(redacted.url).toBe("[redacted]");
    expect(JSON.stringify(redacted)).not.toContain("not-a-real-code");
    // The browser id is a catalog name, not user content, so the trace still
    // says where the link went.
    expect(redacted.browserId).toBe("chrome");
  });

  // A provider key travels as a bare `key` field, which the generic
  // field-name guard does not treat as a secret. These map entries are the
  // only thing redacting it, so this test is the gate.
  it("redacts the raw provider credential on every key-store channel", () => {
    for (const channel of [
      IPC.aiStoreApiKey,
      IPC.aiSetOpencodeProviderKey,
    ]) {
      const [redacted] = redactIpcArgsForChannel(channel, [
        { provider: "openai", providerId: "openai", key: "sk-proj-not-a-real-key" },
      ]) as Array<Record<string, unknown>>;
      expect(redacted.key).toBe("[redacted]");
      expect(JSON.stringify(redacted)).not.toContain("sk-proj-not-a-real-key");
      expect(redacted.provider).toBe("openai");
    }
  });

  // A saved secret's value, or a `.env` import's entries, travel inside
  // `passwords.call`'s `args` under ordinary words (`value`, `entries`) the
  // generic field-name guard would not catch, so the map is the only gate.
  it("redacts what a Passwords & Secrets call carries", () => {
    const calls = [
      { action: "saveSecret", args: { name: "STRIPE_KEY", value: "sk_live_not_a_real_secret", projectScope: null } },
      { action: "importSecrets", args: { projectScope: null, entries: [{ name: "STRIPE_KEY", value: "sk_live_not_a_real_secret" }] } },
    ];
    for (const call of calls) {
      const [redacted] = redactIpcArgsForChannel(IPC.passwordsCall, [call]) as Array<Record<string, unknown>>;
      expect(redacted.action).toBe(call.action);
      expect(JSON.stringify(redacted)).not.toContain("sk_live_not_a_real_secret");
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
