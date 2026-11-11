import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { withClaudePassEnv } from "./claudePassLaunch";
import { createClaudePassSync, type ClaudePassSyncStore, type ClaudePassSyncVault } from "./claudePassSync";

/**
 * A cloud computer holds each pass token in memory for the Claude processes it
 * starts. After the ADE account signs out, no new Claude process may start on
 * the last account's pass, and the idle ones that hold it restart. Nothing on
 * screen shows which token a process got, so the test is the check.
 */

const PASS_KEY = "claude-pass/a0a0a0a0a0a1";
const PASS_ID = "pass-a0a0a0a0a0a1";
const TOKEN = "sk-ant-oat01-passtokenpasstokenpasstoken";
const ADE_DIR = path.join(path.sep, "ade-test");

function fakeVault(): ClaudePassSyncVault {
  const value = JSON.stringify({
    v: 1, kind: "claude_pass", token: TOKEN, account: { email: "a@example.test" },
    createdAt: Date.now() - 60_000, expiresAt: Date.now() + 86_400_000,
  });
  return {
    list: () => [{ kind: "provider_login", key: PASS_KEY }],
    get: (_scope, kind, key) => (kind === "provider_login" && key === PASS_KEY ? value : null),
    set: () => true,
    remove: () => true,
    health: () => ({ state: "ready", syncReady: true }),
  };
}

function fakeStore(): ClaudePassSyncStore {
  let ids: string[] = [];
  return {
    syncCloudPasses: ({ passes }) => {
      const next = passes.map((pass) => pass.id);
      const added = next.filter((id) => !ids.includes(id));
      const removed = ids.filter((id) => !next.includes(id));
      ids = next;
      return { added, removed, changed: [], wrote: added.length + removed.length > 0 };
    },
    list: () => ids.map((id) => ({ id, signedIn: true })),
  };
}

describe("claude pass sync: sign-out", () => {
  it("drops the pass tokens from new Claude processes and restarts the idle ones that hold them", () => {
    const restart = vi.fn();
    const sync = createClaudePassSync({
      cloudComputer: true,
      adeDir: ADE_DIR,
      vault: fakeVault,
      settings: () => ({ get: () => ({ enabled: true }) }),
      store: fakeStore,
      accountUserId: () => "user_a",
      restart,
      noteChanged: () => {},
      env: {},
      baseHomeHasLogin: () => false,
    });
    const passHome = path.join(ADE_DIR, "provider-homes", "claude", PASS_ID);

    sync.reconcile({ accountUserId: "user_a" });
    expect(withClaudePassEnv({ CLAUDE_CONFIG_DIR: passHome }).CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(withClaudePassEnv({}).CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    restart.mockClear();

    const result = sync.reconcile({ accountUserId: null });
    expect(withClaudePassEnv({ CLAUDE_CONFIG_DIR: passHome }).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(withClaudePassEnv({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN }).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(restart).toHaveBeenCalledTimes(1);
    expect([...restart.mock.calls[0]![1].instanceIds].sort()).toEqual(["claude", PASS_ID]);
    expect(result.restarted.sort()).toEqual(["claude", PASS_ID]);

    // Signed out again: nothing left to drop, nothing restarts.
    sync.reconcile({ accountUserId: null });
    expect(restart).toHaveBeenCalledTimes(1);
  });
});
