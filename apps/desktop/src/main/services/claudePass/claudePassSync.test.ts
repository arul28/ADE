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

/**
 * A failed turn is not proof that Claude dropped a pass: the end mark stops
 * Claude on every cloud computer of the account, so it is written only when
 * Claude refuses the token again, and an ended pass whose token Claude still
 * takes works again.
 */
describe("claude pass sync: end of a pass", () => {
  type Check = "refused" | "accepted" | "unknown";
  function passValue(token: string, endedAt?: number): string {
    return JSON.stringify({
      v: 1, kind: "claude_pass", token, account: { email: "a@example.test" },
      createdAt: Date.now() - 60_000, expiresAt: Date.now() + 86_400_000,
      ...(endedAt != null ? { endedAt } : {}),
    });
  }
  function setup(check: () => Promise<Check>, endedAt?: number) {
    let value = passValue(TOKEN, endedAt);
    let writes = true;
    const vault: ClaudePassSyncVault = {
      list: () => [{ kind: "provider_login", key: PASS_KEY }],
      get: (_scope, kind, key) => (kind === "provider_login" && key === PASS_KEY ? value : null),
      set: (_scope, _kind, _key, next) => {
        if (!writes) return false;
        value = next;
        return true;
      },
      remove: () => true,
      health: () => ({ state: "ready", syncReady: true }),
    };
    const checkToken = vi.fn(check);
    const sync = createClaudePassSync({
      cloudComputer: true,
      adeDir: ADE_DIR,
      vault: () => vault,
      settings: () => ({ get: () => ({ enabled: true }) }),
      store: fakeStore,
      accountUserId: () => "user_a",
      restart: () => {},
      noteChanged: () => {},
      env: {},
      baseHomeHasLogin: () => false,
      checkToken,
    });
    sync.reconcile({ accountUserId: "user_a" });
    return {
      sync,
      checkToken,
      endedAt: () => (JSON.parse(value) as { endedAt?: number }).endedAt ?? null,
      renew: (token: string) => {
        value = passValue(token);
      },
      refuseWrites: (refuse: boolean) => {
        writes = !refuse;
      },
    };
  }

  it.each<[Check, string, boolean]>([
    ["refused", "ended", true],
    ["accepted", "kept", false],
    ["unknown", "kept", false],
  ])("Claude answers %s: the pass is %s", async (answer, result, ended) => {
    const pass = setup(async () => answer);
    await expect(pass.sync.endPass(PASS_ID)).resolves.toBe(result);
    expect(pass.endedAt() != null).toBe(ended);
  });

  it("asks again on the next failed turn after a kept pass, and once while a check runs", async () => {
    const pass = setup(async () => "accepted");
    const [first, second] = await Promise.all([pass.sync.endPass(PASS_ID), pass.sync.endPass(PASS_ID)]);
    expect([first, second]).toEqual(["kept", "already"]);
    await pass.sync.endPass(PASS_ID);
    expect(pass.checkToken).toHaveBeenCalledTimes(2);
  });

  it("ends the pass on a later failed turn when the end mark's write was refused", async () => {
    const pass = setup(async () => "refused");
    pass.refuseWrites(true);
    await expect(pass.sync.endPass(PASS_ID)).resolves.toBe("skipped");
    pass.refuseWrites(false);
    await expect(pass.sync.endPass(PASS_ID)).resolves.toBe("ended");
    expect(pass.endedAt()).not.toBeNull();
  });

  it("writes no end mark when a Renew came during the check", async () => {
    let answer!: (value: Check) => void;
    const pass = setup(() => new Promise<Check>((resolve) => { answer = resolve; }));
    const ending = pass.sync.endPass(PASS_ID);
    pass.renew("sk-ant-oat01-renewedrenewedrenewedrenewed");
    answer("refused");
    await expect(ending).resolves.toBe("skipped");
    expect(pass.endedAt()).toBeNull();
  });

  it.each<[Check, boolean]>([
    ["accepted", false],
    ["refused", true],
    ["unknown", true],
  ])("an ended pass Claude answers %s for: still ended %s, asked once", async (answer, stillEnded) => {
    const pass = setup(async () => answer, Date.now() - 1_000);
    await pass.sync.reviewEndedPasses({ accountUserId: "user_a" });
    await pass.sync.reviewEndedPasses({ accountUserId: "user_a" });
    expect(pass.endedAt() != null).toBe(stillEnded);
    expect(pass.checkToken).toHaveBeenCalledTimes(1);
  });

  it("clears an accepted pass on a later review when the first write was refused, with no second check", async () => {
    const pass = setup(async () => "accepted", Date.now() - 1_000);
    pass.refuseWrites(true);
    await expect(pass.sync.reviewEndedPasses({ accountUserId: "user_a" })).resolves.toEqual([]);
    expect(pass.endedAt()).not.toBeNull();
    pass.refuseWrites(false);
    await expect(pass.sync.reviewEndedPasses({ accountUserId: "user_a" })).resolves.toEqual([PASS_KEY]);
    expect(pass.endedAt()).toBeNull();
    expect(pass.checkToken).toHaveBeenCalledTimes(1);
  });
});
