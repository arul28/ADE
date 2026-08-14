import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  liveChatProviderRefsFromPersistedState,
  providerPointersFromChatRecord,
} from "./liveChatProviderRefs";

describe("liveChatProviderRefsFromPersistedState", () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("extracts every native pointer from a live chat JSON file", async () => {
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
    const refs = await liveChatProviderRefsFromPersistedState(dir, sessionId);
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

  it("re-reads a chat file after it changes and stays empty when it is gone", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-chat-refs-"));
    const sessionId = "chat-2";
    const filePath = path.join(dir, `${sessionId}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ provider: "claude", sdkSessionId: "sdk-1" }), "utf8");
    expect(await liveChatProviderRefsFromPersistedState(dir, sessionId)).toEqual([
      { provider: "claude", externalId: "sdk-1", chatSessionId: sessionId },
    ]);
    // The pointer cache is keyed by mtime+size, so a rewritten chat file must
    // yield the new pointer rather than the cached one.
    fs.writeFileSync(filePath, JSON.stringify({ provider: "claude", sdkSessionId: "sdk-2-longer" }), "utf8");
    expect(await liveChatProviderRefsFromPersistedState(dir, sessionId)).toEqual([
      { provider: "claude", externalId: "sdk-2-longer", chatSessionId: sessionId },
    ]);
    fs.rmSync(filePath);
    expect(await liveChatProviderRefsFromPersistedState(dir, sessionId)).toEqual([]);
  });
});

describe("providerPointersFromChatRecord", () => {
  // main.ts scans in-memory sessions through this same extractor. When it rolled
  // its own, OpenCode's persisted `"unified"` provider keyed as `unified:<id>`
  // there and `opencode:<id>` here, so live OpenCode chats never matched their
  // external session and kept showing up as importable.
  it("regression: normalizes a unified provider to opencode", () => {
    expect(providerPointersFromChatRecord({
      provider: "unified",
      providerSessionId: "oc-1",
    })).toEqual([{ provider: "opencode", externalId: "oc-1" }]);
  });

  it("regression: drops pointers whose provider is not a known one", () => {
    expect(providerPointersFromChatRecord({
      provider: "totally-unknown",
      providerSessionId: "x-1",
    })).toEqual([{ provider: "opencode", externalId: "x-1" }]);
    expect(providerPointersFromChatRecord({ importedFrom: { provider: "nope", sessionId: "n-1" } }))
      .toEqual([]);
  });
});
