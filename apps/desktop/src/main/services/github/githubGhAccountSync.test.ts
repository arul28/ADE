import { describe, expect, it, vi } from "vitest";
import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import type { AccountVaultBridge } from "../account/accountVaultBridge";
import { createGithubGhAccountSync } from "./githubGhAccountSync";

// Obviously fake tokens. They are never real credentials.
const TOKEN_A = "gho_fake_machine_a_0001";
const TOKEN_B = "gho_fake_machine_b_0002";
const TOKEN_C = "gho_fake_machine_b_0003";
const TOKEN_OTHER_MACHINE = "gho_fake_other_machine_0004";

type LoginHost = "github.com" | "other" | "unknown";

/** An in-memory credential store: the machine's encrypted file is the process boundary. */
function createStore() {
  const values = new Map<string, string>();
  const store = {
    getSync: (key: string) => values.get(key) ?? null,
    setSync: (key: string, value: string) => {
      values.set(key, value);
    },
    deleteSync: (key: string) => {
      values.delete(key);
    },
  };
  return { values, store: store as unknown as SyncCredentialStore };
}

/**
 * An in-memory account vault for the one `github-cli` item. A list reads the
 * item as it was when the list started, so a test can hold a list open.
 */
function createFakeVault() {
  let current: { value: string | null; deleted: boolean } | null = null;
  let failRemovesLeft = 0;
  let holdNextList: { started: Promise<void>; markStarted: () => void; release: Promise<void>; open: () => void } | null = null;
  const writes = {
    set: [] as Array<{ value: string; expectedAccountUserId?: string }>,
    remove: [] as Array<{ expectedAccountUserId?: string }>,
  };
  const vault = {
    list: vi.fn(async () => {
      const snapshot = current
        ? [{ scope: "all", kind: "integration", key: "github-cli", value: current.value, deleted: current.deleted, updatedAt: "2026-11-11T00:00:00.000Z" }]
        : [];
      if (holdNextList) {
        const hold = holdNextList;
        holdNextList = null;
        hold.markStarted();
        await hold.release;
      }
      return { ok: true as const, value: snapshot };
    }),
    get: vi.fn(async () => ({ ok: true as const, value: current && !current.deleted ? current.value : null })),
    set: vi.fn(async (_scope: string, _kind: string, _key: string, value: string, options?: { expectedAccountUserId?: string }) => {
      writes.set.push({ value, expectedAccountUserId: options?.expectedAccountUserId });
      current = { value, deleted: false };
      return { ok: true as const, value: undefined };
    }),
    remove: vi.fn(async (_scope: string, _kind: string, _key: string, options?: { expectedAccountUserId?: string }) => {
      writes.remove.push({ expectedAccountUserId: options?.expectedAccountUserId });
      if (failRemovesLeft > 0) {
        failRemovesLeft -= 1;
        return { ok: false as const, unavailable: true as const, message: "vault unavailable" };
      }
      current = { value: null, deleted: true };
      return { ok: true as const, value: undefined };
    }),
  };
  return {
    bridge: vault as unknown as AccountVaultBridge,
    writes,
    /** The item's decoded value, or null when it is absent or a tombstone. */
    decoded(): unknown {
      return current && !current.deleted && current.value ? JSON.parse(current.value) : null;
    },
    /** Put a value into the vault as another machine would. */
    putAsOtherMachine(value: object): void {
      current = { value: JSON.stringify(value), deleted: false };
    },
    failNextRemoves(count: number): void {
      failRemovesLeft = count;
    },
    /** The next list holds until `open` is called; `started` resolves once it has taken its snapshot. */
    holdNextList(): { started: Promise<void>; open: () => void } {
      let markStarted!: () => void;
      let open!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const release = new Promise<void>((resolve) => {
        open = resolve;
      });
      holdNextList = { started, markStarted, release, open };
      return { started, open };
    },
  };
}

/** One machine: its own gh login and hosts.yml, its credential store, and the account's vault. */
function setupMachine(initial: { localToken?: string | null; accountUserId?: string | null } = {}) {
  const machine = {
    accountUserId: initial.accountUserId === undefined ? "acct-A" : initial.accountUserId,
    localToken: initial.localToken === undefined ? null : initial.localToken,
    hostsSignature: "sig-1",
    loginHost: "github.com" as LoginHost,
    loginError: null as Error | null,
    environmentTokens: [] as string[],
  };
  const { values, store } = createStore();
  const vault = createFakeVault();
  const readLocalGhToken = vi.fn(async (_options: { fresh: boolean }) => machine.localToken);
  const sync = createGithubGhAccountSync({
    credentialStore: store,
    getAccountVault: () => vault.bridge,
    getAccountUserId: () => machine.accountUserId,
    readLocalGhToken,
    readGhHostsSignature: async () => machine.hostsSignature,
    readGhLoginHost: async () => {
      if (machine.loginError) throw machine.loginError;
      return machine.loginHost;
    },
    readEnvironmentTokens: () => machine.environmentTokens,
  });
  return { machine, values, vault, readLocalGhToken, sync };
}

describe("githubGhAccountSync", () => {
  it.each<[string, (machine: ReturnType<typeof setupMachine>) => Promise<void>]>([
    [
      "a failed gh lookup keeps the copy and asks again without fresh",
      async (m) => {
        await m.sync.hydrate();
        expect(m.vault.writes.set.at(-1)?.expectedAccountUserId).toBe("acct-A");
        expect(m.vault.decoded()).toEqual({ v: 1, token: TOKEN_A });

        // hosts.yml changes (a gh re-login) and the lookup now fails for a github.com login.
        m.machine.hostsSignature = "sig-2";
        m.machine.localToken = null;
        await m.sync.hydrate();
        expect(m.readLocalGhToken).toHaveBeenLastCalledWith({ fresh: true });
        expect(m.vault.writes.remove).toHaveLength(0);
        expect(m.vault.decoded()).toEqual({ v: 1, token: TOKEN_A });

        // Nothing changed on disk since, so the next sync asks gh again without fresh.
        await m.sync.hydrate();
        expect(m.readLocalGhToken).toHaveBeenLastCalledWith({ fresh: false });
        expect(m.vault.writes.remove).toHaveLength(0);
        expect(m.vault.decoded()).toEqual({ v: 1, token: TOKEN_A });
      },
    ],
    [
      "a failed release keeps the digest, retries, and the signed-out machine does not adopt its own token",
      async (m) => {
        await m.sync.hydrate();
        expect(m.vault.decoded()).toEqual({ v: 1, token: TOKEN_A });
        expect(m.sync.readAccountToken()).toBeNull();

        // gh logs out here. The release write fails once.
        m.machine.hostsSignature = "sig-2";
        m.machine.localToken = null;
        m.machine.loginHost = "other";
        m.vault.failNextRemoves(1);
        await m.sync.hydrate();
        expect(m.vault.writes.remove).toHaveLength(1);
        expect(m.vault.decoded()).toEqual({ v: 1, token: TOKEN_A });
        expect(m.sync.readAccountToken()).toBeNull();

        // The digest was kept, so the next sync releases the copy.
        await m.sync.hydrate();
        expect(m.vault.writes.remove).toHaveLength(2);
        expect(m.vault.decoded()).toBeNull();
        expect(m.sync.readAccountToken()).toBeNull();
      },
    ],
  ])("%s", async (_label, run) => {
    await run(setupMachine({ localToken: TOKEN_A }));
  });

  it.each<[string, (machine: ReturnType<typeof setupMachine>) => void]>([
    ["an environment token stands in front of the gh login", (m) => { m.machine.environmentTokens = [TOKEN_A]; }],
    ["the only login is for GitHub Enterprise", (m) => { m.machine.loginHost = "other"; }],
    ["GH_HOST names another host", (m) => { m.machine.loginHost = "unknown"; }],
    ["hosts.yml cannot be read", (m) => { m.machine.loginError = Object.assign(new Error("denied"), { code: "EPERM" }); }],
  ])("publishes nothing and stores no copy when %s", async (_label, configure) => {
    const m = setupMachine({ localToken: TOKEN_A });
    configure(m);
    await m.sync.hydrate();
    expect(m.vault.writes.set).toHaveLength(0);
    expect(m.vault.decoded()).toBeNull();
    expect(m.sync.readAccountToken()).toBeNull();
    expect([...m.values.values()]).not.toContain(TOKEN_A);
  });

  it("stores no copy and publishes nothing when the account changes while the vault is read", async () => {
    const m = setupMachine({ localToken: TOKEN_A, accountUserId: "acct-A" });
    const originalList = m.vault.bridge.list;
    (m.vault.bridge as unknown as { list: typeof originalList }).list = async (scope: string) => {
      const listed = await originalList(scope);
      // The person signs in to another account while the read is in flight.
      m.machine.accountUserId = "acct-B";
      return listed;
    };
    await m.sync.hydrate();
    expect(m.vault.writes.set).toHaveLength(0);
    expect(m.sync.readAccountToken()).toBeNull();
    expect([...m.values.values()]).not.toContain(TOKEN_A);
  });

  it("a sync that read the vault before a removal cannot publish over the removal", async () => {
    const m = setupMachine({ localToken: TOKEN_A });
    const hold = m.vault.holdNextList();
    const sync = m.sync.hydrate();
    // The sync has taken its snapshot of the empty vault and is held.
    await hold.started;
    const removal = m.sync.removeFromAccount();
    hold.open();
    await Promise.all([sync, removal]);
    expect(m.vault.decoded()).toEqual({ v: 1, removed: true });
    expect(m.vault.writes.set.at(-1)?.value).toBe(JSON.stringify({ v: 1, removed: true }));
  });

  it("a removal persists across unchanged logins, and a share from another machine is not overwritten by an unchanged login", async () => {
    const m = setupMachine({ localToken: TOKEN_B });
    await m.sync.hydrate();
    expect(m.vault.decoded()).toEqual({ v: 1, token: TOKEN_B });

    await m.sync.removeFromAccount();
    const setsAfterRemoval = m.vault.writes.set.length;
    expect(m.sync.state()).toMatchObject({ ghRemovedFromAccount: true, ghSharedFromHere: false });

    // Same login on this machine, sync again: nothing is published.
    await m.sync.hydrate();
    expect(m.vault.writes.set).toHaveLength(setsAfterRemoval);
    expect(m.vault.decoded()).toEqual({ v: 1, removed: true });

    // Another machine shares its login. This machine's login has not changed, so it keeps that copy.
    m.vault.putAsOtherMachine({ v: 1, token: TOKEN_OTHER_MACHINE });
    await m.sync.hydrate();
    expect(m.vault.writes.set).toHaveLength(setsAfterRemoval);
    expect(m.sync.readAccountToken()).toBe(TOKEN_OTHER_MACHINE);

    // This machine signs in with a new login: the newest login becomes the copy, once.
    m.machine.localToken = TOKEN_C;
    m.machine.hostsSignature = "sig-2";
    await m.sync.hydrate();
    expect(m.vault.writes.set).toHaveLength(setsAfterRemoval + 1);
    expect(m.vault.decoded()).toEqual({ v: 1, token: TOKEN_C });
  });
});
