import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCodexServerVersion } from "./agentChatService";
import {
  PINNED_CODEX_APP_SERVER_VERSION,
  codexServerSupportsBackgroundTerminals,
  codexServerSupportsDeferGoalContinuation,
  codexServerSupportsGoalMutationOrigin,
  codexServerSupportsMemoryRpc,
  codexServerSupportsPaginatedHistory,
  codexServerSupportsThreadQueue,
  codexServerSupportsThreadRevert,
  codexServerSupportsThreadSample,
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
    // The gates below are written against the app-server ADE installs, so the
    // declared pin and `ade-cli`'s Codex dependency must move together: when
    // one is bumped alone, ADE sends or withholds RPCs the binary disagrees
    // about. Read the real dependency instead of repeating its literal here.
    const cliPackagePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../../ade-cli/package.json",
    );
    const cliPackage = JSON.parse(fs.readFileSync(cliPackagePath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(cliPackage.dependencies?.["@openai/codex"]).toBe(PINNED_CODEX_APP_SERVER_VERSION);
  });

  it("does not invent support when the user-agent is missing", () => {
    expect(codexServerSupportsThreadQueue(null)).toBe(false);
    expect(codexServerSupportsThreadRevert(null)).toBe(false);
  });

  it("gates the goal mutation `origin` on 0.162, and on nothing older", () => {
    // The server reads a missing provenance as "no user authorization", so this
    // gate is what keeps older servers exactly as they behaved before the field
    // existed rather than sending them one they do not know.
    expect(codexServerSupportsGoalMutationOrigin(parseCodexServerVersion("codex/0.161.0"))).toBe(false);
    expect(codexServerSupportsGoalMutationOrigin(parseCodexServerVersion("codex/0.162.0"))).toBe(true);
    expect(codexServerSupportsGoalMutationOrigin(parseCodexServerVersion("codex/0.162.1"))).toBe(true);
    expect(codexServerSupportsGoalMutationOrigin(null)).toBe(false);
  });

  it("gates `thread/sample` on 0.164, and on nothing older", () => {
    // A server that predates the experimental method answers "method not
    // found"; asking anyway turns every helper failure into a wasted round trip
    // before the fallback gives up, so the gate has to hold exactly at 0.164.
    expect(codexServerSupportsThreadSample(parseCodexServerVersion("codex/0.162.1"))).toBe(false);
    expect(codexServerSupportsThreadSample(parseCodexServerVersion("codex/0.163.0"))).toBe(false);
    expect(codexServerSupportsThreadSample(parseCodexServerVersion("codex/0.164.0"))).toBe(true);
    expect(codexServerSupportsThreadSample(null)).toBe(false);
  });
});
