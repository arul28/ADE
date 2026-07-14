import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Cookie, CookiesSetDetails, Session } from "electron";
import { migrateLegacyBuiltInBrowserProfiles } from "./builtInBrowserProfileMigration";
import { createBuiltInBrowserStateStore } from "./builtInBrowserStateStore";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function profileCookie(input: Partial<Cookie> & Pick<Cookie, "name" | "value">): Cookie {
  return {
    domain: ".example.com",
    expirationDate: Date.now() / 1_000 + 86_400,
    hostOnly: false,
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: true,
    session: false,
    ...input,
  };
}

function sessionWithCookies(initial: Cookie[]) {
  const cookies = [...initial];
  const set = vi.fn(async (details: CookiesSetDetails) => {
    cookies.push(profileCookie({
      name: details.name ?? "",
      value: details.value ?? "",
      domain: details.domain ?? new URL(details.url).hostname,
      expirationDate: details.expirationDate,
      hostOnly: details.domain == null,
      httpOnly: details.httpOnly,
      path: details.path,
      sameSite: details.sameSite ?? "lax",
      secure: details.secure,
      session: details.expirationDate == null,
    }));
  });
  const flushStore = vi.fn(async () => {});
  return {
    session: { cookies: { get: vi.fn(async () => [...cookies]), set, flushStore } } as unknown as Session,
    cookies,
    set,
    flushStore,
  };
}

describe("built-in browser profile migration", () => {
  it("migrates persistent legacy cookies once without overwriting the global profile", async () => {
    const root = createTempDir("ade-browser-profile-migration-");
    const legacyName = "ade-browser-project-0123456789abcdef";
    fs.mkdirSync(path.join(root, "Partitions", legacyName), { recursive: true });
    const global = sessionWithCookies([profileCookie({ name: "existing", value: "global" })]);
    const legacy = sessionWithCookies([
      profileCookie({ name: "existing", value: "legacy" }),
      profileCookie({ name: "migrate", value: "secret" }),
      profileCookie({ name: "session-only", value: "temporary", expirationDate: undefined, session: true }),
      profileCookie({ name: "expired", value: "old", expirationDate: Date.now() / 1_000 - 60 }),
    ]);
    const sessions = new Map<string, Session>([
      ["persist:ade-browser", global.session],
      [`persist:${legacyName}`, legacy.session],
    ]);

    const first = await migrateLegacyBuiltInBrowserProfiles({
      userDataPath: root,
      getSession: (partition) => sessions.get(partition)!,
    });
    expect(first).toMatchObject({
      discoveredPartitionCount: 1,
      migratedCookieCount: 1,
      skippedCookieCount: 1,
      deferredCookieCount: 0,
    });
    expect(global.set).toHaveBeenCalledTimes(1);
    expect(global.set.mock.calls[0]?.[0]).toMatchObject({
      name: "migrate",
      value: "secret",
      domain: ".example.com",
      secure: true,
      httpOnly: true,
    });
    expect(global.flushStore).toHaveBeenCalledTimes(1);

    const second = await migrateLegacyBuiltInBrowserProfiles({
      userDataPath: root,
      getSession: (partition) => sessions.get(partition)!,
    });
    expect(second.migratedCookieCount).toBe(0);
    expect(global.set).toHaveBeenCalledTimes(1);
    const marker = JSON.parse(fs.readFileSync(path.join(root, "ade-browser-profile-migration-v1.json"), "utf8"));
    expect(marker).toMatchObject({ version: 1, completedPartitions: [legacyName] });
    expect(fs.statSync(path.join(root, "ade-browser-profile-migration-v1.json")).mode & 0o777).toBe(0o600);
  });

  it("ignores unrelated partition directories", async () => {
    const root = createTempDir("ade-browser-profile-migration-");
    fs.mkdirSync(path.join(root, "Partitions", "ade-browser"), { recursive: true });
    fs.mkdirSync(path.join(root, "Partitions", "other"), { recursive: true });
    const global = sessionWithCookies([]);

    await expect(migrateLegacyBuiltInBrowserProfiles({
      userDataPath: root,
      getSession: () => global.session,
    })).resolves.toMatchObject({
      discoveredPartitionCount: 0,
      migratedCookieCount: 0,
    });
  });

  it("keeps the global cookie when legacy hostOnly metadata differs", async () => {
    const root = createTempDir("ade-browser-profile-migration-");
    const legacyName = "ade-browser-project-fedcba9876543210";
    fs.mkdirSync(path.join(root, "Partitions", legacyName), { recursive: true });
    const global = sessionWithCookies([profileCookie({
      name: "session",
      value: "current-global",
      domain: "example.com",
      hostOnly: true,
    })]);
    const legacy = sessionWithCookies([profileCookie({
      name: "session",
      value: "stale-legacy",
      domain: ".example.com",
      hostOnly: false,
    })]);
    const sessions = new Map<string, Session>([
      ["persist:ade-browser", global.session],
      [`persist:${legacyName}`, legacy.session],
    ]);

    await expect(migrateLegacyBuiltInBrowserProfiles({
      userDataPath: root,
      getSession: (partition) => sessions.get(partition)!,
    })).resolves.toMatchObject({
      migratedCookieCount: 0,
      skippedCookieCount: 1,
    });
    expect(global.set).not.toHaveBeenCalled();
    expect(global.cookies[0]?.value).toBe("current-global");
  });
});

describe("built-in browser tab persistence", () => {
  function statePath(): string {
    return path.join(createTempDir("ade-browser-state-"), "browser-state.json");
  }

  it("persists bounded project tab URLs and restores the active index", async () => {
    const filePath = statePath();
    const store = createBuiltInBrowserStateStore({ filePath });
    store.record("project-0123456789abcdef", {
      tabs: [
        { url: "https://github.com/login" },
        { url: "https://console.aws.amazon.com/" },
        { url: "file:///tmp/secret" },
      ],
      activeIndex: 1,
    });
    await store.flush();

    const restored = createBuiltInBrowserStateStore({ filePath }).restore("project-0123456789abcdef");
    expect(restored).toEqual({
      tabs: [
        { url: "https://github.com/login" },
        { url: "https://console.aws.amazon.com/" },
      ],
      activeIndex: 1,
    });
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("persists an unscoped window collection without accepting agent ownership or session data", async () => {
    const filePath = statePath();
    const store = createBuiltInBrowserStateStore({ filePath });
    store.record("window", {
      tabs: [{ url: "about:blank" }, { url: "https://example.test" }],
      activeIndex: 0,
    });
    await store.flush();

    expect(store.restore("window")).toEqual({
      tabs: [{ url: "about:blank" }, { url: "https://example.test/" }],
      activeIndex: 0,
    });
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      version: 1,
      collections: {
        window: expect.objectContaining({
          tabs: [{ url: "about:blank" }, { url: "https://example.test/" }],
          activeIndex: 0,
        }),
      },
    });
  });

  it("ignores malformed persisted state", () => {
    const filePath = statePath();
    fs.writeFileSync(filePath, "{not-json", "utf8");

    expect(createBuiltInBrowserStateStore({ filePath }).restore("personal")).toBeNull();
  });
});
