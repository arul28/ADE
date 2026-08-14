import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { liveChatProviderRefsFromPersistedState } from "./liveChatProviderRefs";

describe("liveChatProviderRefsFromPersistedState", () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("extracts every native pointer from a live chat JSON file", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-chat-refs-"));
    const sessionId = "chat-1";
    fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({
      provider: "claude",
      sdkSessionId: "sdk-1",
      threadId: "thread-1",
      providerSessionId: "oc-1",
      droidSdkSessionId: "droid-1",
      piSessionId: "pi-1",
      cursorSdkAgentId: "cursor-sdk-1",
      cursorCloudAgentId: "cursor-cloud-1",
      importedFrom: { provider: "codex", sessionId: "imported-1" },
    }), "utf8");
    const refs = liveChatProviderRefsFromPersistedState(dir, sessionId);
    expect(refs).toEqual(expect.arrayContaining([
      { provider: "codex", externalId: "imported-1", chatSessionId: sessionId },
      { provider: "claude", externalId: "sdk-1", chatSessionId: sessionId },
      { provider: "codex", externalId: "thread-1", chatSessionId: sessionId },
      { provider: "claude", externalId: "oc-1", chatSessionId: sessionId },
      { provider: "droid", externalId: "droid-1", chatSessionId: sessionId },
      { provider: "pi", externalId: "pi-1", chatSessionId: sessionId },
      { provider: "cursor", externalId: "cursor-sdk-1", chatSessionId: sessionId },
      { provider: "cursor", externalId: "cursor-cloud-1", chatSessionId: sessionId },
    ]));
  });
});
