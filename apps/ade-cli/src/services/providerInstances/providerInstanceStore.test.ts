import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProviderInstanceStore,
  providerInstanceEnvPatch,
  type ProviderInstanceStore,
  type ProviderInstanceStoreChange,
} from "./providerInstanceStore";
import { removeTestTree } from "../../test/filesystem";

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-provider-instances-"));
  roots.push(root);
  return root;
}

function makeStore(overrides: Partial<Parameters<typeof createProviderInstanceStore>[0]> = {}): {
  store: ProviderInstanceStore;
  adeDir: string;
  homeDir: string;
  changes: ProviderInstanceStoreChange[];
} {
  const root = makeRoot();
  const adeDir = path.join(root, ".ade");
  const homeDir = path.join(root, "home");
  fs.mkdirSync(adeDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const store = createProviderInstanceStore({
    adeDir,
    homeDir,
    env: {},
    resolveBinary: (provider) => `/bin/${provider}`,
    readAccount: async () => ({}),
    ...overrides,
  });
  const changes: ProviderInstanceStoreChange[] = [];
  store.onChange((change) => changes.push(change));
  return { store, adeDir, homeDir, changes };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await removeTestTree(root);
  }
});

describe("providerInstanceStore", () => {
  it("synthesizes one default account per provider with no file on disk", () => {
    const { store, homeDir } = makeStore();

    const instances = store.list();

    expect(instances.map((instance) => instance.id)).toEqual(["claude", "codex"]);
    expect(instances.every((instance) => instance.isDefault)).toBe(true);
    // An account reads as its email, else its id; nothing is named "Default".
    expect(instances.map((instance) => instance.label)).toEqual(["claude", "codex"]);
    expect(instances[0].configHome).toBe(path.join(homeDir, ".claude"));
    expect(instances[1].configHome).toBe(path.join(homeDir, ".codex"));
    expect(fs.existsSync(store.registryPath)).toBe(false);
  });

  it("resolves the default config home from the provider env var, not a frozen copy", () => {
    const root = makeRoot();
    const adeDir = path.join(root, ".ade");
    const homeDir = path.join(root, "home");
    const scoped = path.join(root, "scoped-claude");
    const store = createProviderInstanceStore({
      adeDir,
      homeDir,
      env: { CLAUDE_CONFIG_DIR: scoped },
      resolveBinary: () => "/bin/claude",
      readAccount: async () => ({}),
    });

    expect(store.getDefault("claude").configHome).toBe(scoped);
  });

  it("creates an account with its own config home and a login command", () => {
    const { store, adeDir, changes } = makeStore();

    const created = store.create({ provider: "claude", label: "Work Account", accentColor: "#AABBCC" });

    expect(created.instance.provider).toBe("claude");
    // The typed name only shaped the id; the label is the id until sign-in.
    expect(created.instance.label).toBe("work-account");
    expect(created.instance.accentColor).toBe("#aabbcc");
    expect(created.instance.isDefault).toBe(false);
    expect(created.instance.signedIn).toBe(false);
    expect(created.instance.configHome).toBe(
      path.join(adeDir, "provider-homes", "claude", created.instance.id),
    );
    expect(fs.statSync(created.instance.configHome).isDirectory()).toBe(true);
    expect(created.loginCommand).toEqual({
      command: "/bin/claude",
      args: ["auth", "login"],
      env: { CLAUDE_CONFIG_DIR: created.instance.configHome },
    });
    expect(changes).toEqual([
      { reason: "create", provider: "claude", instanceId: created.instance.id },
    ]);
  });

  it("keeps account creation usable when a POSIX chmod is unavailable", () => {
    vi.spyOn(fs, "chmodSync").mockImplementationOnce(() => {
      throw new Error("chmod unavailable");
    });
    const { store } = makeStore();

    expect(() => store.create({ provider: "claude", label: "Read-only host" })).not.toThrow();
  });

  it("applies an injected owner-only ACL when creating a Windows config home", () => {
    const calls: Array<[string, string[]]> = [];
    const { store, adeDir } = makeStore({
      platform: "win32",
      currentWindowsUser: "ADEBOX\\arul",
      aclRunner: (command, args) => {
        calls.push([command, args]);
        return { status: 0 };
      },
    });

    const created = store.create({ provider: "codex", label: "Windows account" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0].toLowerCase()).toMatch(/icacls\.exe$/);
    expect(calls[0]?.[1]).toEqual([
      created.instance.configHome,
      "/inheritance:r",
      "/grant:r",
      "ADEBOX\\arul:F",
    ]);
    expect(created.instance.configHome).toBe(
      path.join(adeDir, "provider-homes", "codex", created.instance.id),
    );
  });

  it("gives codex accounts the CODEX_HOME login command", () => {
    const { store } = makeStore();

    const created = store.create({ provider: "codex", label: "Personal" });

    expect(created.loginCommand).toEqual({
      command: "/bin/codex",
      args: ["login"],
      env: { CODEX_HOME: created.instance.configHome },
    });
  });

  it("keeps ids unique when two accounts share a label", () => {
    const { store } = makeStore();

    const first = store.create({ provider: "claude", label: "Work" });
    const second = store.create({ provider: "claude", label: "Work" });

    expect(first.instance.id).not.toBe(second.instance.id);
    expect(store.list("claude").map((instance) => instance.id)).toEqual([
      "claude",
      first.instance.id,
      second.instance.id,
    ]);
  });

  it("never mints an id that collides with a provider slug", () => {
    const { store } = makeStore();

    const created = store.create({ provider: "claude", label: "claude" });

    expect(created.instance.id).not.toBe("claude");
    expect(store.get("claude")?.isDefault).toBe(true);
  });

  it("creates an unnamed account with the next short id, and still rejects a label that is too long", () => {
    const { store } = makeStore();

    // No name is the normal case: the account shows as its email once signed in.
    const first = store.create({ provider: "claude" });
    const second = store.create({ provider: "claude", label: "   " });
    expect(first.instance.id).toBe("claude-2");
    expect(second.instance.id).toBe("claude-3");
    expect(first.instance.label).toBe("claude-2");
    expect(() => store.create({ provider: "claude", label: "x".repeat(61) })).toThrow(/at most 60/);
    expect(() => store.create({ provider: "cursor", label: "Nope" })).toThrow(/Unknown provider/);
  });

  it("renames, re-accents and re-defaults, persisting across store instances", () => {
    const { store, adeDir, homeDir } = makeStore();
    const created = store.create({ provider: "codex", label: "Personal" });

    store.rename(created.instance.id, "  Personal   Codex ");
    store.setAccent(created.instance.id, "#123ABC");
    store.setDefault(created.instance.id);

    const reopened = createProviderInstanceStore({
      adeDir,
      homeDir,
      env: {},
      resolveBinary: () => "/bin/codex",
      readAccount: async () => ({}),
    });
    const instance = reopened.get(created.instance.id);
    // The rename is stored but not shown: an account reads as its email or id.
    expect(instance?.label).toBe("personal");
    expect(instance?.accentColor).toBe("#123abc");
    expect(instance?.isDefault).toBe(true);
    expect(reopened.getDefault("codex").id).toBe(created.instance.id);
    // The base identity is still listed, just no longer the default.
    expect(reopened.get("codex")?.isDefault).toBe(false);
  });

  it("clears an accent with null and refuses a non-hex accent", () => {
    const { store } = makeStore();
    const created = store.create({ provider: "claude", label: "Work", accentColor: "#ff0000" });

    expect(store.setAccent(created.instance.id, null).accentColor).toBeUndefined();
    expect(() => store.setAccent(created.instance.id, "red")).toThrow(/#rrggbb/);
  });

  it("renames the base identity without inventing a second one", () => {
    const { store, homeDir } = makeStore();

    store.rename("claude", "Main");

    expect(store.list("claude")).toHaveLength(1);
    expect(store.get("claude")?.label).toBe("claude");
    expect(store.get("claude")?.configHome).toBe(path.join(homeDir, ".claude"));
    expect(store.get("claude")?.isDefault).toBe(true);
  });

  it("refuses to remove the base identity or the current default, and deletes nothing on disk", () => {
    const { store } = makeStore();
    const created = store.create({ provider: "claude", label: "Work" });

    expect(() => store.remove("claude")).toThrow(/cannot be removed/);
    store.setDefault(created.instance.id);
    expect(() => store.remove(created.instance.id)).toThrow(/is the default/);

    store.setDefault("claude");
    const result = store.remove(created.instance.id);
    expect(result).toEqual({ removed: true, configHome: created.instance.configHome });
    expect(fs.existsSync(created.instance.configHome)).toBe(true);
    expect(store.get(created.instance.id)).toBeNull();
  });

  it("falls back to the provider default for a removed instance", () => {
    const { store } = makeStore();
    const created = store.create({ provider: "claude", label: "Work" });

    expect(store.resolve("claude", created.instance.id)).toEqual({
      instance: expect.objectContaining({ id: created.instance.id }),
      fellBack: false,
    });
    store.remove(created.instance.id);
    const resolved = store.resolve("claude", created.instance.id);
    expect(resolved.fellBack).toBe(true);
    expect(resolved.instance.id).toBe("claude");
    expect(store.resolve("claude", undefined)).toEqual({
      instance: expect.objectContaining({ id: "claude" }),
      fellBack: false,
    });
  });

  it("falls back when the requested instance belongs to the other provider", () => {
    const { store } = makeStore();
    const codexAccount = store.create({ provider: "codex", label: "Personal" });

    const resolved = store.resolve("claude", codexAccount.instance.id);

    expect(resolved.fellBack).toBe(true);
    expect(resolved.instance.id).toBe("claude");
  });

  it("falls back to the base identity when the stored default pointer is dangling", () => {
    const { store, adeDir } = makeStore();
    const created = store.create({ provider: "claude", label: "Work" });
    store.setDefault(created.instance.id);

    const file = JSON.parse(fs.readFileSync(path.join(adeDir, "provider-instances.json"), "utf8"));
    file.instances = file.instances.filter((entry: { id: string }) => entry.id !== created.instance.id);
    fs.writeFileSync(path.join(adeDir, "provider-instances.json"), JSON.stringify(file), "utf8");

    expect(store.getDefault("claude").id).toBe("claude");
  });

  it("degrades to base identities when the registry file is unreadable", () => {
    const { store, adeDir } = makeStore();
    store.create({ provider: "claude", label: "Work" });
    fs.writeFileSync(path.join(adeDir, "provider-instances.json"), "{not json", "utf8");

    expect(store.list().map((instance) => instance.id)).toEqual(["claude", "codex"]);
  });

  it("round-trips per-provider settings and defaults them off", () => {
    const { store, changes } = makeStore();

    expect(store.getProviderSettings("claude")).toEqual({
      smartBalance: false,
      autoStartWindows: false,
    });
    expect(store.setProviderSettings("claude", { smartBalance: true })).toEqual({
      smartBalance: true,
      autoStartWindows: false,
    });
    expect(store.getProviderSettings("claude").smartBalance).toBe(true);
    expect(store.getProviderSettings("codex").smartBalance).toBe(false);
    expect(changes.at(-1)).toEqual({ reason: "setSettings", provider: "claude" });
  });

  it("keeps each account's own settings apart and takes only a Claude 1-hour subagent cache", () => {
    const { store, adeDir } = makeStore();
    const work = store.create({ provider: "claude", label: "Work" }).instance;
    const codex = store.getDefault("codex");

    store.setProviderSettings("claude", { compaction: { atTokens: 300_000 } }, work.id);
    store.setProviderSettings("claude", { subagentPromptCacheTtl: "1h" }, work.id);
    // A patch that names one account setting leaves the other alone.
    expect(store.get(work.id)).toMatchObject({ subagentPromptCacheTtl: "1h", compaction: { atTokens: 300_000 } });
    expect(store.getDefault("claude").subagentPromptCacheTtl).toBeUndefined();
    // The choice survives a new store over the same file.
    expect(createProviderInstanceStore({ adeDir, env: {} }).get(work.id)?.subagentPromptCacheTtl).toBe("1h");

    store.setProviderSettings("claude", { compaction: null }, work.id);
    expect(store.get(work.id)?.compaction).toBeUndefined();
    expect(store.get(work.id)?.subagentPromptCacheTtl).toBe("1h");

    // The main-conversation lifetime is its own choice: either value, and null goes back to automatic.
    store.setProviderSettings("claude", { mainPromptCacheTtl: "5m" }, work.id);
    expect(store.get(work.id)).toMatchObject({ mainPromptCacheTtl: "5m", subagentPromptCacheTtl: "1h" });
    expect(createProviderInstanceStore({ adeDir, env: {} }).get(work.id)?.mainPromptCacheTtl).toBe("5m");
    store.setProviderSettings("claude", { mainPromptCacheTtl: "1h" }, work.id);
    expect(store.get(work.id)?.mainPromptCacheTtl).toBe("1h");
    store.setProviderSettings("claude", { mainPromptCacheTtl: null }, work.id);
    expect(store.get(work.id)?.mainPromptCacheTtl).toBeUndefined();
    expect(store.get(work.id)?.subagentPromptCacheTtl).toBe("1h");
    // A Codex account has no such setting.
    store.setProviderSettings("codex", { mainPromptCacheTtl: "1h" }, codex.id);
    expect(store.get(codex.id)?.mainPromptCacheTtl).toBeUndefined();

    // With no account named there is nothing to set it on; saying "saved" would be a lie.
    expect(() => store.setProviderSettings("claude", { subagentPromptCacheTtl: "1h" })).toThrow(/account id/);
    expect(() => store.setProviderSettings("claude", { mainPromptCacheTtl: "1h" })).toThrow(/account id/);
    expect(() => store.setProviderSettings("claude", { onExtraUsage: "stop" })).toThrow(/account id/);
    // One patch that names an account setting and a provider setting saves both.
    const before = store.getProviderSettings("claude").smartBalance;
    const mixed = store.setProviderSettings("claude", { onExtraUsage: "stop", smartBalance: !before }, work.id);
    expect(mixed.smartBalance).toBe(!before);
    expect(store.getProviderSettings("claude").smartBalance).toBe(!before);
    expect(store.get(work.id)).toMatchObject({ onExtraUsage: "stop", subagentPromptCacheTtl: "1h" });
    store.setProviderSettings("claude", { onExtraUsage: null }, work.id);
    expect(store.get(work.id)?.onExtraUsage).toBeUndefined();
    store.setProviderSettings("codex", { subagentPromptCacheTtl: "1h" }, codex.id);
    expect(store.get(codex.id)?.subagentPromptCacheTtl).toBeUndefined();
    store.setProviderSettings("claude", { subagentPromptCacheTtl: "2h" as never }, work.id);
    expect(store.get(work.id)?.subagentPromptCacheTtl).toBeUndefined();
  });

  it("records each account's identity from its own config home", async () => {
    const homes: string[] = [];
    const { store } = makeStore({
      readAccount: async (provider, configHome) => {
        homes.push(`${provider}:${configHome}`);
        return configHome.includes("provider-homes")
          ? { email: "work@example.com", plan: "Claude Max" }
          : {};
      },
    });
    const created = store.create({ provider: "claude", label: "Work" });

    const refreshed = await store.refreshAccounts();

    expect(homes).toContain(`claude:${created.instance.configHome}`);
    const work = refreshed.find((instance) => instance.id === created.instance.id);
    expect(work?.account).toEqual({ email: "work@example.com", plan: "Claude Max" });
    // The card names it by the login it just read.
    expect(work?.label).toBe("work@example.com");
    expect(work?.signedIn).toBe(true);
    expect(refreshed.find((instance) => instance.id === "claude")?.signedIn).toBe(false);
    // With no email the id is the name.
    expect(refreshed.find((instance) => instance.id === "claude")?.label).toBe("claude");
  });

  it("preserves a known account when its config is malformed", async () => {
    let malformed = false;
    const { store, changes } = makeStore({
      readAccount: async () => {
        if (malformed) throw new SyntaxError("Unexpected token in provider config");
        return { email: "known@example.com", plan: "Claude Max" };
      },
    });
    const created = store.create({ provider: "claude", label: "Work" });

    await store.refreshAccounts();
    malformed = true;
    await store.refreshAccounts();

    expect(store.get(created.instance.id)?.account).toEqual({
      email: "known@example.com",
      plan: "Claude Max",
    });
    expect(store.get(created.instance.id)?.signedIn).toBe(true);
    expect(changes.filter((change) => change.reason === "refresh")).toHaveLength(1);
  });

  it("only writes and emits on refresh when an identity actually changed", async () => {
    let email: string | undefined = "first@example.com";
    const { store, changes } = makeStore({ readAccount: async () => ({ ...(email ? { email } : {}) }) });

    await store.refreshAccounts();
    const afterFirst = changes.filter((change) => change.reason === "refresh").length;
    await store.refreshAccounts();
    expect(changes.filter((change) => change.reason === "refresh")).toHaveLength(afterFirst);

    email = undefined;
    await store.refreshAccounts();
    expect(changes.filter((change) => change.reason === "refresh")).toHaveLength(afterFirst + 1);
    expect(store.get("claude")?.account).toBeUndefined();
    expect(store.get("claude")?.signedIn).toBe(false);
  });

  it.each([
    ["claude", "CLAUDE_CONFIG_DIR", true, false],
    ["claude", "CLAUDE_CONFIG_DIR", true, true],
    ["claude", "CLAUDE_CONFIG_DIR", false, false],
    ["codex", "CODEX_HOME", true, false],
    ["codex", "CODEX_HOME", true, true],
    ["codex", "CODEX_HOME", false, false],
  ] as const)("keeps the base %s account when its environment names %s (%s, custom home %s)", async (provider, envKey, insideProviderHomes, customAdeHome) => {
    const seeded = makeStore({
      readAccount: async (readProvider) => readProvider === provider ? { email: "machine@example.com" } : {},
    });
    await seeded.store.refreshAccounts(provider);

    const configHome = insideProviderHomes
      ? path.join(
        customAdeHome ? seeded.homeDir : seeded.adeDir,
        ...(customAdeHome ? ["agent-home"] : []),
        "provider-homes",
        provider,
        "agent-account",
      )
      : path.join(path.dirname(seeded.adeDir), `user-${provider}-config`);
    fs.mkdirSync(configHome, { recursive: true });
    if (provider === "claude") {
      fs.writeFileSync(path.join(configHome, ".claude.json"), JSON.stringify({
        oauthAccount: { emailAddress: "agent@example.com" },
      }));
    } else {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const idToken = `${encode({ alg: "RS256" })}.${encode({ email: "agent@example.com" })}.signature`;
      fs.writeFileSync(path.join(configHome, "auth.json"), JSON.stringify({ tokens: { id_token: idToken } }));
    }

    const previousEnv = process.env[envKey];
    process.env[envKey] = configHome;
    try {
      const store = createProviderInstanceStore({
        adeDir: seeded.adeDir,
        homeDir: seeded.homeDir,
        env: { [envKey]: configHome },
        resolveBinary: (name) => `/bin/${name}`,
      });
      const refreshed = await store.refreshAccounts(provider);
      const base = refreshed.find((instance) => instance.id === provider);

      expect(base?.account?.email).toBe(insideProviderHomes ? "machine@example.com" : "agent@example.com");
      expect(base?.replacedAccount?.email).toBe(insideProviderHomes ? undefined : "machine@example.com");
      expect(base?.configHome).toBe(insideProviderHomes
        ? path.join(seeded.homeDir, provider === "claude" ? ".claude" : ".codex")
        : configHome);
    } finally {
      if (previousEnv === undefined) delete process.env[envKey];
      else process.env[envKey] = previousEnv;
    }
  });

  it("reports a broken login as signed out, keeps its email, and emits once per flip", async () => {
    const { store, changes } = makeStore({
      readAccount: async () => ({ email: "known@example.com", plan: "Claude Max" }),
    });
    const created = store.create({ provider: "claude", label: "Work" });
    await store.refreshAccounts();
    expect(store.get(created.instance.id)?.signedIn).toBe(true);

    store.setLoginBroken(created.instance.id, true);
    const broken = store.get(created.instance.id);
    expect(broken?.signedIn).toBe(false);
    expect(broken?.loginBroken).toBe(true);
    // The email stays: the row still names the account, it just cannot run.
    expect(broken?.account?.email).toBe("known@example.com");
    expect(changes.filter((change) => change.reason === "login")).toHaveLength(1);

    // A repeated flag for the same account is not a change.
    store.setLoginBroken(created.instance.id, true);
    expect(changes.filter((change) => change.reason === "login")).toHaveLength(1);

    // A working read clears it and the account is signed in again.
    store.setLoginBroken(created.instance.id, false);
    const cleared = store.get(created.instance.id);
    expect(cleared?.signedIn).toBe(true);
    expect(cleared?.loginBroken).toBeUndefined();
    expect(changes.filter((change) => change.reason === "login")).toHaveLength(2);
  });

  it("does not carry a broken login onto an account that reuses a removed id", async () => {
    const { store } = makeStore({ readAccount: async () => ({ email: "known@example.com" }) });
    const first = store.create({ provider: "claude", label: "Work" });
    store.setLoginBroken(first.instance.id, true);
    store.remove(first.instance.id);
    // A removed home normally blocks reuse; delete it to reach the reuse path
    // this test is about (a home cleared outside ADE).
    fs.rmSync(first.instance.configHome, { recursive: true, force: true });

    // Same label, same id: the fresh account must not inherit the old flag.
    const second = store.create({ provider: "claude", label: "Work" });
    expect(second.instance.id).toBe(first.instance.id);

    await store.refreshAccounts();
    const reused = store.get(second.instance.id);
    expect(reused?.signedIn).toBe(true);
    expect(reused?.loginBroken).toBeUndefined();
  });

  it("never gives a new account a removed account's config home", () => {
    const { store } = makeStore();

    // No label means the next short id, and a removed account's home stays on
    // disk with its login: minting its id again would hand the new account the
    // old login and history.
    const first = store.create({ provider: "claude" });
    expect(first.instance.id).toBe("claude-2");
    store.remove(first.instance.id);
    expect(fs.existsSync(first.instance.configHome)).toBe(true);

    const second = store.create({ provider: "claude" });
    expect(second.instance.id).toBe("claude-3");
    expect(second.instance.configHome).not.toBe(first.instance.configHome);

    // A typed label from an older phone or script follows the same rule.
    const labeled = store.create({ provider: "claude", label: "Work" });
    expect(labeled.instance.id).toBe("work");
    store.remove(labeled.instance.id);
    const relabeled = store.create({ provider: "claude", label: "Work" });
    expect(relabeled.instance.id).not.toBe("work");
    expect(relabeled.instance.configHome).not.toBe(labeled.instance.configHome);
  });

  it("gives a shared login to the working default account, else the first working one", async () => {
    const { store } = makeStore({
      readAccount: async (_provider, configHome) => (
        configHome.includes("provider-homes") ? { email: "shared@example.com" } : {}
      ),
    });
    const first = store.create({ provider: "claude", label: "First" });
    const second = store.create({ provider: "claude", label: "Second" });
    await store.refreshAccounts();

    // With both working, the first in list order owns the shared email.
    expect(store.get(first.instance.id)?.sameLoginAs).toBeUndefined();
    expect(store.get(second.instance.id)?.sameLoginAs).toBe(first.instance.id);

    // The owner's login breaks: the working copy now owns the email instead.
    store.setLoginBroken(first.instance.id, true);
    expect(store.get(first.instance.id)?.sameLoginAs).toBe(second.instance.id);
    expect(store.get(second.instance.id)?.sameLoginAs).toBeUndefined();

    // The default owns it whatever its place in the list, so smart balance
    // counts the account the usage poller keeps the reading for.
    store.setLoginBroken(first.instance.id, false);
    store.setDefault(second.instance.id);
    expect(store.get(second.instance.id)?.sameLoginAs).toBeUndefined();
    expect(store.get(first.instance.id)?.sameLoginAs).toBe(second.instance.id);

    // …unless the default's own login is broken.
    store.setLoginBroken(second.instance.id, true);
    expect(store.get(first.instance.id)?.sameLoginAs).toBeUndefined();
    expect(store.get(second.instance.id)?.sameLoginAs).toBe(first.instance.id);
  });

  it.each([
    { provider: "claude" as const, args: ["auth", "logout"], envKey: "CLAUDE_CONFIG_DIR" },
    { provider: "codex" as const, args: ["logout"], envKey: "CODEX_HOME" },
  ])("signs a $provider account out in its own home, and refuses the default", ({ provider, args, envKey }) => {
    const { store } = makeStore();
    const created = store.create({ provider, label: "Work" });

    const command = store.logoutCommand(created.instance.id);
    expect(command.args).toEqual(args);
    expect(command.env[envKey]).toBe(created.instance.configHome);
    // The machine's own login is the default until another account is.
    expect(() => store.logoutCommand(provider)).toThrow(/default/);

    store.setDefault(created.instance.id);
    expect(() => store.logoutCommand(created.instance.id)).toThrow(/default/);
    // Then it signs out wherever the environment points.
    expect(store.logoutCommand(provider).env).toEqual({});
  });

  it("does not let an account become the default while its sign-out runs", async () => {
    const { store } = makeStore();
    const created = store.create({ provider: "claude", label: "Work" });
    let finish: () => void = () => undefined;
    const signingOut = store.whileSigningOut(created.instance.id, () => new Promise<void>((resolve) => { finish = resolve; }));

    // It would come out of the logout as a signed-out default.
    expect(() => store.setDefault(created.instance.id)).toThrow(/being signed out/);
    expect(() => store.remove(created.instance.id)).toThrow(/being signed out/);
    await expect(store.whileSigningOut(created.instance.id, async () => undefined)).rejects.toThrow(/already/);

    finish();
    await signingOut;
    expect(store.setDefault(created.instance.id).isDefault).toBe(true);
  });

  it("keeps a listener that throws from rolling back the write", () => {
    const { store } = makeStore();
    store.onChange(() => {
      throw new Error("subscriber exploded");
    });

    const created = store.create({ provider: "claude", label: "Work" });

    expect(store.get(created.instance.id)?.label).toBe("work");
  });

  it("writes the registry file atomically with owner-only permissions", () => {
    const { store, adeDir } = makeStore();

    store.create({ provider: "claude", label: "Work" });

    const registryPath = path.join(adeDir, "provider-instances.json");
    expect(fs.existsSync(registryPath)).toBe(true);
    expect(fs.readdirSync(adeDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    if (process.platform !== "win32") {
      expect(fs.statSync(registryPath).mode & 0o777).toBe(0o600);
    }
  });

  it("builds an env patch and never an empty key", () => {
    expect(providerInstanceEnvPatch({ id: "work", provider: "claude", configHome: "/homes/a" })).toEqual({
      CLAUDE_CONFIG_DIR: "/homes/a",
    });
    expect(providerInstanceEnvPatch({ id: "personal", provider: "codex", configHome: "/homes/b" })).toEqual({
      CODEX_HOME: "/homes/b",
    });
    expect(providerInstanceEnvPatch(null)).toEqual({});
    expect(providerInstanceEnvPatch({ id: "personal", provider: "codex", configHome: "" })).toEqual({});
  });

  it("exports nothing for the base identity, whose login lives wherever the environment points", () => {
    // Claude Code keys its keychain entry by CLAUDE_CONFIG_DIR when the
    // variable is set, so exporting even the default path logs the CLI out.
    expect(providerInstanceEnvPatch({ id: "claude", provider: "claude", configHome: "/Users/me/.claude" })).toEqual({});
    expect(providerInstanceEnvPatch({ id: "codex", provider: "codex", configHome: "/Users/me/.codex" })).toEqual({});

    const { store } = makeStore();
    expect(store.loginCommand("claude").env).toEqual({});
    expect(store.loginCommand("codex").env).toEqual({});
  });
});
