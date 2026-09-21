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
    expect(instances.every((instance) => instance.label === "Default")).toBe(true);
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
    expect(created.instance.label).toBe("Work Account");
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

  it("rejects a label that is empty or too long", () => {
    const { store } = makeStore();

    expect(() => store.create({ provider: "claude", label: "   " })).toThrow(/needs a label/);
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
    expect(instance?.label).toBe("Personal Codex");
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
    expect(store.get("claude")?.label).toBe("Main");
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

  it("falls back to the provider default when an instance id no longer exists", () => {
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
    expect(work?.signedIn).toBe(true);
    expect(refreshed.find((instance) => instance.id === "claude")?.signedIn).toBe(false);
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

  it("keeps a listener that throws from rolling back the write", () => {
    const { store } = makeStore();
    store.onChange(() => {
      throw new Error("subscriber exploded");
    });

    const created = store.create({ provider: "claude", label: "Work" });

    expect(store.get(created.instance.id)?.label).toBe("Work");
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
