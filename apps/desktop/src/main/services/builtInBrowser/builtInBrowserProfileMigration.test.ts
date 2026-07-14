import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Cookie, CookiesSetDetails, Session } from "electron";
import { migrateLegacyBuiltInBrowserProfiles } from "./builtInBrowserProfileMigration";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function userDataPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-profile-migration-"));
  tempDirs.push(dir);
  return dir;
}

function cookie(input: Partial<Cookie> & Pick<Cookie, "name" | "value">): Cookie {
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
    cookies.push(cookie({
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

describe("builtInBrowserProfileMigration", () => {
  it("migrates persistent legacy cookies once without overwriting the global profile", async () => {
    const root = userDataPath();
    const legacyName = "ade-browser-project-0123456789abcdef";
    fs.mkdirSync(path.join(root, "Partitions", legacyName), { recursive: true });
    const global = sessionWithCookies([cookie({ name: "existing", value: "global" })]);
    const legacy = sessionWithCookies([
      cookie({ name: "existing", value: "legacy" }),
      cookie({ name: "migrate", value: "secret" }),
      cookie({ name: "session-only", value: "temporary", expirationDate: undefined, session: true }),
      cookie({ name: "expired", value: "old", expirationDate: Date.now() / 1_000 - 60 }),
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
    const root = userDataPath();
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
});
