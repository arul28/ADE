import { describe, expect, it } from "vitest";
import { parseCodexServerVersion } from "./agentChatService";
import {
  compactionFailLabel,
  PINNED_CODEX_APP_SERVER_VERSION,
  codexServerSupportsBackgroundTerminals,
  codexServerSupportsDeferGoalContinuation,
  codexServerSupportsMemoryRpc,
  codexServerSupportsPaginatedHistory,
  codexServerSupportsThreadQueue,
  codexServerSupportsThreadRevert,
  codexServerSupportsThreadSettings,
  codexServerSupportsUserShell,
} from "./codexAppServerFeatures";

describe("codex app-server feature gates", () => {
  it("keeps 0.144 on the old rewind/rollback path", () => {
    const v144 = parseCodexServerVersion("codex/0.144.5");
    expect(codexServerSupportsPaginatedHistory(v144)).toBe(false);
    expect(codexServerSupportsThreadQueue(v144)).toBe(false);
    expect(codexServerSupportsThreadRevert(v144)).toBe(false);
  });

  it("unlocks 0.149 surfaces", () => {
    const v149 = parseCodexServerVersion("codex/0.149.1");
    expect(codexServerSupportsPaginatedHistory(v149)).toBe(true);
    expect(codexServerSupportsDeferGoalContinuation(v149)).toBe(true);
    expect(codexServerSupportsThreadQueue(v149)).toBe(true);
    expect(codexServerSupportsThreadSettings(v149)).toBe(true);
    expect(codexServerSupportsThreadRevert(v149)).toBe(true);
    expect(codexServerSupportsBackgroundTerminals(v149)).toBe(true);
    expect(codexServerSupportsUserShell(v149)).toBe(true);
    expect(codexServerSupportsMemoryRpc(v149)).toBe(true);
  });

  it("pins the app-server version ADE ships", () => {
    expect(PINNED_CODEX_APP_SERVER_VERSION).toBe("0.149.1");
  });

  it("does not invent support when the user-agent is missing", () => {
    expect(codexServerSupportsThreadQueue(null)).toBe(false);
    expect(codexServerSupportsThreadRevert(null)).toBe(false);
  });

  it("labels compaction failures", () => {
    expect(compactionFailLabel("timed_out")).toBe("Compaction timed out");
    expect(compactionFailLabel("interrupted")).toBe("Compaction failed");
    expect(compactionFailLabel("teardown")).toBe("Compaction failed");
  });
});
