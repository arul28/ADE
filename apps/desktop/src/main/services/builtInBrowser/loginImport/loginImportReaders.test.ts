import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readChromiumCookieDatabase, decryptChromiumValue } from "./chromiumCookies";
import { decodeWindowsWrappedKey, deriveChromiumKey, resolveChromiumKeys } from "./chromiumKeys";
import { TrustedWindowsToolError } from "../../../../../../ade-cli/src/lib/trustedWindowsTools";
import { aggregateCookieDomains, selectCookiesForDomains } from "./cookieDomains";
import { cookieScope, isExpired, snapshotCookieDatabase, type ImportedCookie } from "./cookieDatabase";
import { readFirefoxCookieDatabase, readFirefoxCookies } from "./firefoxCookies";
import { parseBinaryCookies, SafariCookieReadError } from "./safariCookies";
import {
  describeLoginImportCapabilities,
  isSafeProfileDirectory,
  parseFirefoxProfilesIni,
  WINDOWS_CHROMIUM_UNSUPPORTED_REASON,
} from "./loginImportSources";

/**
 * Windows-only key unwrap. The default `unwrapWindowsKey` is module-private and
 * is the one process on the machine that gets DPAPI key material on its stdin,
 * so its spawn contract is pinned here rather than left to a Windows host:
 * PowerShell resolved through the GLOBALROOT-checked trusted-tools helper (not
 * `SystemRoot`/`WINDIR`/`PATH`, all caller-controlled), the blob on stdin (not
 * argv, which the process table exposes), `windowsHide` so no console flashes,
 * and a bounded timeout so a wedged shell cannot hang the import forever.
 */
const dpapi = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  resolveTrustedWindowsTool: vi.fn(() => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawnSync: dpapi.spawnSync };
});

vi.mock("../../../../../../ade-cli/src/lib/trustedWindowsTools", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../../../../../ade-cli/src/lib/trustedWindowsTools")
  >();
  return { ...original, resolveTrustedWindowsTool: dpapi.resolveTrustedWindowsTool };
});

type DatabaseSyncConstructor = new (dbPath: string) => DatabaseSyncType;
const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-login-import-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ── Firefox ──────────────────────────────────────────────────────────────── */

type FirefoxRow = {
  host: string;
  name: string;
  value: string;
  path?: string;
  expiry?: number;
  isSecure?: number;
  isHttpOnly?: number;
  sameSite?: number | null;
  rawSameSite?: number | null;
  originAttributes?: string;
};

function createFirefoxDb(rows: FirefoxRow[], schemaVersion: number): string {
  const file = path.join(makeTempDir(), "cookies.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`
    create table moz_cookies (
      id integer primary key, originAttributes text not null default '',
      name text, value text, host text, path text, expiry integer,
      isSecure integer, isHttpOnly integer, sameSite integer, rawSameSite integer
    );
    pragma user_version = ${schemaVersion};
  `);
  const insert = db.prepare(`
    insert into moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite, rawSameSite)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.originAttributes ?? "",
      row.name,
      row.value,
      row.host,
      row.path ?? "/",
      row.expiry ?? 0,
      row.isSecure ?? 0,
      row.isHttpOnly ?? 0,
      row.sameSite ?? null,
      row.rawSameSite ?? null,
    );
  }
  db.close();
  return file;
}

describe("firefox cookie reader", () => {
  it("reads a jar, scoping host-only and domain cookies differently", () => {
    const file = createFirefoxDb(
      [
        { host: "app.example.com", name: "sid", value: "abc", isSecure: 1, isHttpOnly: 1, expiry: 2_000_000_000 },
        { host: ".example.com", name: "wide", value: "def", path: "/x" },
      ],
      15,
    );
    const result = readFirefoxCookies(file);
    expect(result.unreadable).toBe(0);
    const hostOnly = result.cookies.find((cookie) => cookie.name === "sid");
    const domainCookie = result.cookies.find((cookie) => cookie.name === "wide");
    // Passing `domain` for a host-only cookie makes Electron re-add the dot and
    // widen it to every subdomain, so it must stay undefined.
    expect(hostOnly).toMatchObject({
      url: "https://app.example.com/",
      domain: undefined,
      secure: true,
      httpOnly: true,
      expirationDate: 2_000_000_000,
    });
    expect(domainCookie).toMatchObject({ url: "http://example.com/x", domain: ".example.com" });
  });

  it("skips container and private-window cookies", () => {
    const file = createFirefoxDb(
      [
        { host: "a.test", name: "keep", value: "1" },
        { host: "b.test", name: "drop", value: "2", originAttributes: "^userContextId=2" },
        { host: "c.test", name: "drop2", value: "3", originAttributes: "^privateBrowsingId=1" },
      ],
      15,
    );
    expect(readFirefoxCookies(file).cookies.map((cookie) => cookie.name)).toEqual(["keep"]);
  });

  it("reads expiry as milliseconds from schema 16 and seconds before it", () => {
    const millis = createFirefoxDb([{ host: "a.test", name: "n", value: "v", expiry: 2_000_000_000_000 }], 16);
    const seconds = createFirefoxDb([{ host: "a.test", name: "n", value: "v", expiry: 2_000_000_000 }], 15);
    expect(readFirefoxCookies(millis).cookies[0]?.expirationDate).toBe(2_000_000_000);
    expect(readFirefoxCookies(seconds).cookies[0]?.expirationDate).toBe(2_000_000_000);
  });

  it("treats a schema 10-14 Lax+rawNone row as unspecified, not an explicit Lax", () => {
    const file = createFirefoxDb(
      [{ host: "a.test", name: "n", value: "v", sameSite: 1, rawSameSite: 0 }],
      12,
    );
    expect(readFirefoxCookies(file).cookies[0]?.sameSite).toBe("unspecified");
  });

  it("maps a null sameSite column to unspecified rather than guessing none", () => {
    const file = createFirefoxDb([{ host: "a.test", name: "n", value: "v", sameSite: null }], 15);
    expect(readFirefoxCookies(file).cookies[0]?.sameSite).toBe("unspecified");
  });

  it("reads through a snapshot rather than the source file", () => {
    const file = createFirefoxDb([{ host: "a.test", name: "n", value: "v" }], 15);
    const before = fs.statSync(file).mtimeMs;
    const snapshot = snapshotCookieDatabase(file);
    try {
      expect(snapshot.path).not.toBe(file);
      expect(fs.existsSync(snapshot.path)).toBe(true);
      const db = new DatabaseSync(snapshot.path);
      expect(readFirefoxCookieDatabase(db).cookies).toHaveLength(1);
      db.close();
    } finally {
      snapshot.dispose();
    }
    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(fs.existsSync(snapshot.path)).toBe(false);
  });
});

/* ── Chromium ─────────────────────────────────────────────────────────────── */

const AES_CBC_IV = Buffer.alloc(16, 0x20);

function encryptV10Cbc(key: Buffer, plaintext: string, domain?: string): Buffer {
  const body = domain
    ? Buffer.concat([createHash("sha256").update(domain).digest(), Buffer.from(plaintext, "utf8")])
    : Buffer.from(plaintext, "utf8");
  const cipher = createCipheriv("aes-128-cbc", key, AES_CBC_IV);
  return Buffer.concat([Buffer.from("v10", "latin1"), cipher.update(body), cipher.final()]);
}

function encryptV10Gcm(key: Buffer, plaintext: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "latin1"), nonce, body, cipher.getAuthTag()]);
}

describe("chromium cookie decryption", () => {
  const key = deriveChromiumKey("test-secret", 1003);

  it("decrypts a v10 CBC record with an injected key", () => {
    const blob = encryptV10Cbc(key, "session-token");
    expect(decryptChromiumValue(blob, { cbcV10: key }, "example.com", 23, "darwin")).toBe("session-token");
  });

  it("strips the schema-24 domain-hash prefix and voids a mismatched one", () => {
    const bound = encryptV10Cbc(key, "value", "example.com");
    expect(decryptChromiumValue(bound, { cbcV10: key }, "example.com", 24, "darwin")).toBe("value");
    // A record whose hash does not match its row's host is not this cookie's
    // plaintext; importing it would write another domain's value.
    expect(decryptChromiumValue(bound, { cbcV10: key }, "evil.com", 24, "darwin")).toBeNull();
  });

  it("skips a record whose scheme has no key instead of failing the read", () => {
    const v11 = Buffer.concat([Buffer.from("v11", "latin1"), Buffer.alloc(16)]);
    expect(decryptChromiumValue(v11, { cbcV10: key }, "example.com", 23, "linux")).toBeNull();
  });

  it("retries with the empty-passphrase key for crbug.com/1195256 data", () => {
    const empty = deriveChromiumKey("", 1);
    const blob = encryptV10Cbc(empty, "legacy");
    expect(decryptChromiumValue(blob, { cbcV10: key, cbcEmpty: empty }, "a.test", 23, "linux")).toBe("legacy");
  });

  it("reads a prefix-less blob as plaintext on macOS but never on Windows", () => {
    const legacy = Buffer.from("plain-value", "utf8");
    expect(decryptChromiumValue(legacy, {}, "a.test", 23, "darwin")).toBe("plain-value");
    // On Windows a prefix-less blob may be an app-bound v20 payload; reading it
    // as text would put ciphertext into a cookie value.
    expect(decryptChromiumValue(legacy, {}, "a.test", 23, "win32")).toBeNull();
  });

  it("decrypts a Windows legacy v10 GCM record", () => {
    const gcmKey = randomBytes(32);
    expect(
      decryptChromiumValue(encryptV10Gcm(gcmKey, "win-token"), { gcmV10: gcmKey }, "a.test", 23, "win32"),
    ).toBe("win-token");
  });
});

function createChromiumDb(
  rows: Array<{
    host_key: string;
    name: string;
    value: string;
    encrypted_value: Uint8Array;
    path?: string;
    expires_utc?: number;
    is_secure?: number;
    is_httponly?: number;
    samesite?: number;
    top_frame_site_key?: string;
  }>,
  schemaVersion: number,
): string {
  const file = path.join(makeTempDir(), "Cookies");
  const db = new DatabaseSync(file);
  db.exec(`
    create table meta (key text primary key, value text);
    create table cookies (
      host_key text, name text, value text, encrypted_value blob, path text,
      expires_utc integer, is_secure integer, is_httponly integer, samesite integer,
      top_frame_site_key text not null default ''
    );
  `);
  db.prepare("insert into meta (key, value) values ('version', ?)").run(String(schemaVersion));
  const insert = db.prepare(`
    insert into cookies (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, top_frame_site_key)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.host_key,
      row.name,
      row.value,
      row.encrypted_value,
      row.path ?? "/",
      row.expires_utc ?? 0,
      row.is_secure ?? 0,
      row.is_httponly ?? 0,
      row.samesite ?? -1,
      row.top_frame_site_key ?? "",
    );
  }
  db.close();
  return file;
}

describe("chromium cookie database", () => {
  const key = deriveChromiumKey("test-secret", 1003);

  it("decrypts rows, converts 1601-epoch expiry, and drops partitioned cookies", () => {
    const file = createChromiumDb(
      [
        {
          host_key: "example.com",
          name: "sid",
          value: "",
          encrypted_value: encryptV10Cbc(key, "token"),
          // 1601-epoch microseconds for 2033-05-18T03:33:20Z.
          expires_utc: (2_000_000_000 + 11_644_473_600) * 1_000_000,
          is_secure: 1,
          samesite: 1,
        },
        {
          host_key: "partitioned.test",
          name: "chips",
          value: "",
          encrypted_value: encryptV10Cbc(key, "nope"),
          top_frame_site_key: "https://other.test",
        },
      ],
      23,
    );
    const db = new DatabaseSync(file);
    const result = readChromiumCookieDatabase(db, { cbcV10: key }, "darwin");
    db.close();

    expect(result.cookies).toHaveLength(1);
    expect(result.unreadable).toBe(1);
    expect(result.cookies[0]).toMatchObject({
      url: "https://example.com/",
      name: "sid",
      value: "token",
      expirationDate: 2_000_000_000,
      sameSite: "lax",
    });
  });

  it("counts an undecryptable row instead of dropping it silently", () => {
    const file = createChromiumDb(
      [
        {
          host_key: "a.test",
          name: "n",
          value: "",
          encrypted_value: Buffer.concat([Buffer.from("v11", "latin1"), Buffer.alloc(16)]),
        },
      ],
      23,
    );
    const db = new DatabaseSync(file);
    const result = readChromiumCookieDatabase(db, { cbcV10: key }, "linux");
    db.close();
    expect(result.cookies).toHaveLength(0);
    expect(result.unreadable).toBe(1);
  });

  it("maps an unrecognised samesite int to unspecified, never no_restriction", () => {
    const file = createChromiumDb(
      [{ host_key: "a.test", name: "n", value: "plain", encrypted_value: new Uint8Array(0), samesite: -1 }],
      23,
    );
    const db = new DatabaseSync(file);
    const result = readChromiumCookieDatabase(db, {}, "linux");
    db.close();
    expect(result.cookies[0]?.sameSite).toBe("unspecified");
  });
});

describe("chromium key resolution", () => {
  it("stretches the macOS keychain secret with 1003 iterations", () => {
    const keys = resolveChromiumKeys(
      { platform: "darwin", keychainService: "Chrome Safe Storage", keychainAccount: "Chrome" },
      { readMacKeychainSecret: () => "s3cret" },
    );
    expect(keys.cbcV10).toEqual(deriveChromiumKey("s3cret", 1003));
  });

  it("reports a keychain denial as key_unavailable rather than an empty key", () => {
    expect(() =>
      resolveChromiumKeys(
        { platform: "darwin", keychainService: "S", keychainAccount: "A" },
        { readMacKeychainSecret: () => null },
      ),
    ).toThrowError(/keychain/i);
  });

  it("keeps the peanuts v10 key usable when the Linux keyring does not answer", () => {
    const keys = resolveChromiumKeys(
      { platform: "linux", linuxSecretApplication: "chrome" },
      { readLinuxSecret: () => null },
    );
    expect(keys.cbcV10).toEqual(deriveChromiumKey("peanuts", 1));
    expect(keys.cbcEmpty).toEqual(deriveChromiumKey("", 1));
    expect(keys.cbcV11).toBeUndefined();
  });

  it("adds the v11 key when the Linux keyring answers", () => {
    const keys = resolveChromiumKeys(
      { platform: "linux", linuxSecretApplication: "chrome" },
      { readLinuxSecret: () => "ring" },
    );
    expect(keys.cbcV11).toEqual(deriveChromiumKey("ring", 1));
  });

  it("refuses an app-bound Windows Local State with the documented reason", () => {
    expect(() =>
      decodeWindowsWrappedKey(
        JSON.stringify({ os_crypt: { encrypted_key: "x", app_bound_encrypted_key: "y" } }),
      ),
    ).toThrowError(WINDOWS_CHROMIUM_UNSUPPORTED_REASON);
  });

  it("strips the DPAPI prefix from a legacy Windows key", () => {
    const wrapped = Buffer.concat([Buffer.from("DPAPI"), Buffer.from("payload")]);
    const contents = JSON.stringify({ os_crypt: { encrypted_key: wrapped.toString("base64") } });
    expect(decodeWindowsWrappedKey(contents).toString()).toBe("payload");
  });
});

/* ── Safari ───────────────────────────────────────────────────────────────── */

const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;

type SafariFixtureCookie = {
  host: string;
  name: string;
  cookiePath: string;
  value: string;
  flags?: number;
  /** UNIX seconds; 0 for a session cookie. */
  expiresAt?: number;
};

function buildSafariCookieRecord(cookie: SafariFixtureCookie): Buffer {
  const strings = [cookie.host, cookie.name, cookie.cookiePath, cookie.value].map((text) =>
    Buffer.concat([Buffer.from(text, "utf8"), Buffer.from([0])]));
  const offsets: number[] = [];
  let cursor = 56;
  for (const buffer of strings) {
    offsets.push(cursor);
    cursor += buffer.length;
  }
  const size = cursor;
  const record = Buffer.alloc(size);
  record.writeUInt32LE(size, 0);
  record.writeUInt32LE(0, 4);
  record.writeUInt32LE(cookie.flags ?? 0, 8);
  record.writeUInt32LE(0, 12);
  record.writeUInt32LE(offsets[0]!, 16);
  record.writeUInt32LE(offsets[1]!, 20);
  record.writeUInt32LE(offsets[2]!, 24);
  record.writeUInt32LE(offsets[3]!, 28);
  record.writeBigUInt64LE(0n, 32);
  record.writeDoubleLE(
    cookie.expiresAt ? cookie.expiresAt - APPLE_EPOCH_OFFSET_SECONDS : 0,
    40,
  );
  record.writeDoubleLE(0, 48);
  for (let index = 0; index < strings.length; index += 1) {
    strings[index]!.copy(record, offsets[index]!);
  }
  return record;
}

function buildBinaryCookies(cookies: SafariFixtureCookie[], options: { trailer?: Buffer } = {}): Buffer {
  const records = cookies.map(buildSafariCookieRecord);
  const headerSize = 12 + records.length * 4;
  const offsets: number[] = [];
  let cursor = headerSize;
  for (const record of records) {
    offsets.push(cursor);
    cursor += record.length;
  }
  const page = Buffer.alloc(cursor);
  page.writeUInt32BE(0x00000100, 0);
  page.writeUInt32LE(records.length, 4);
  for (let index = 0; index < records.length; index += 1) {
    page.writeUInt32LE(offsets[index]!, 8 + index * 4);
    records[index]!.copy(page, offsets[index]!);
  }

  const header = Buffer.alloc(12);
  header.write("cook", 0, "latin1");
  header.writeUInt32BE(1, 4);
  header.writeUInt32BE(page.length, 8);
  return Buffer.concat([header, page, options.trailer ?? Buffer.alloc(8)]);
}

describe("safari binarycookies parser", () => {
  it("parses secure/httpOnly flags, Apple-epoch expiry, and cookie scope", () => {
    const buffer = buildBinaryCookies([
      {
        host: ".example.com",
        name: "sid",
        cookiePath: "/app",
        value: "token",
        flags: 0x1 | 0x4,
        expiresAt: 2_000_000_000,
      },
      { host: "host.test", name: "session", cookiePath: "/", value: "v" },
    ]);
    const cookies = parseBinaryCookies(buffer);
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatchObject({
      url: "https://example.com/app",
      domain: ".example.com",
      name: "sid",
      value: "token",
      secure: true,
      httpOnly: true,
      expirationDate: 2_000_000_000,
      // The SameSite bits are undocumented; Lax is the modern default and
      // claiming "none" would widen every imported cookie.
      sameSite: "lax",
    });
    expect(cookies[1]).toMatchObject({
      url: "http://host.test/",
      domain: undefined,
      expirationDate: undefined,
    });
  });

  it("rejects a file whose magic is wrong", () => {
    expect(() => parseBinaryCookies(Buffer.from("nope____"))).toThrowError(SafariCookieReadError);
  });

  it("rejects a page whose declared size runs past the file", () => {
    const buffer = buildBinaryCookies([{ host: "a.test", name: "n", cookiePath: "/", value: "v" }]);
    buffer.writeUInt32BE(buffer.readUInt32BE(8) + 4096, 8);
    expect(() => parseBinaryCookies(buffer)).toThrowError(SafariCookieReadError);
  });

  it("rejects an unexplained trailer rather than importing a partial jar", () => {
    const buffer = buildBinaryCookies(
      [{ host: "a.test", name: "n", cookiePath: "/", value: "v" }],
      { trailer: Buffer.alloc(37) },
    );
    expect(() => parseBinaryCookies(buffer)).toThrowError(SafariCookieReadError);
  });

  it("rejects a record offset that overlaps an already-accepted record", () => {
    const buffer = buildBinaryCookies([
      { host: "a.test", name: "n1", cookiePath: "/", value: "v1" },
      { host: "b.test", name: "n2", cookiePath: "/", value: "v2" },
    ]);
    // Point the second record at the first one's bytes.
    const pageStart = 12;
    const firstOffset = buffer.readUInt32LE(pageStart + 8);
    buffer.writeUInt32LE(firstOffset, pageStart + 12);
    expect(() => parseBinaryCookies(buffer)).toThrowError(SafariCookieReadError);
  });
});

/* ── Domain aggregation ───────────────────────────────────────────────────── */

function cookie(host: string, name: string, expirationDate?: number): ImportedCookie {
  const scope = cookieScope(host, "/", false);
  return {
    url: scope.url,
    name,
    value: "v",
    domain: scope.domain,
    path: "/",
    secure: false,
    httpOnly: false,
    expirationDate,
    sameSite: "unspecified",
  };
}

describe("domain aggregation", () => {
  const now = 1_000_000;

  it("groups by host, counts session cookies, and never offers expired ones", () => {
    const cookies = [
      cookie("example.com", "a", now + 100),
      cookie(".example.com", "b"),
      cookie("example.com", "old", now - 1),
      cookie("other.test", "c", now + 100),
    ];
    expect(aggregateCookieDomains(cookies, now)).toEqual([
      { domain: "example.com", cookieCount: 2, expiredCount: 1, sessionCookieCount: 1 },
      { domain: "other.test", cookieCount: 1, expiredCount: 0, sessionCookieCount: 0 },
    ]);
  });

  it("treats an expiry exactly at now as expired", () => {
    expect(isExpired(cookie("a.test", "n", now), now)).toBe(true);
    expect(isExpired(cookie("a.test", "n", now + 1), now)).toBe(false);
    expect(isExpired(cookie("a.test", "n"), now)).toBe(false);
  });

  it("selects only the chosen hosts, and never a parent domain by suffix", () => {
    const cookies = [
      cookie("example.com", "a", now + 10),
      cookie("login.example.com", "b", now + 10),
      cookie("example.com", "expired", now - 10),
    ];
    const selected = selectCookiesForDomains(cookies, ["example.com"], now);
    expect(selected.map((entry) => entry.name)).toEqual(["a"]);
  });

  it("selects nothing when no domain was chosen", () => {
    expect(selectCookiesForDomains([cookie("a.test", "n", now + 1)], [], now)).toEqual([]);
  });
});

/* ── Capabilities matrix ──────────────────────────────────────────────────── */

describe("login import capabilities", () => {
  const capabilityFor = (platform: NodeJS.Platform, browserId: string) =>
    describeLoginImportCapabilities(platform).browsers.find((entry) => entry.browserId === browserId);

  it("supports the Chromium family, Safari, and Firefox on macOS", () => {
    for (const id of ["chrome", "brave", "edge", "arc", "vivaldi", "opera", "helium", "safari", "firefox"]) {
      expect(capabilityFor("darwin", id)?.supported, id).toBe(true);
    }
  });

  it("names app-bound encryption for every Windows Chromium fork except Helium", () => {
    for (const id of ["chrome", "chromium", "brave", "edge", "vivaldi", "opera", "arc"]) {
      expect(capabilityFor("win32", id), id).toMatchObject({
        supported: false,
        reason: WINDOWS_CHROMIUM_UNSUPPORTED_REASON,
      });
    }
    expect(capabilityFor("win32", "helium")?.supported).toBe(true);
    expect(capabilityFor("win32", "firefox")?.supported).toBe(true);
    expect(capabilityFor("win32", "safari")).toMatchObject({ supported: false });
  });

  it("supports Firefox and the Chromium family on Linux, but not Arc or Safari", () => {
    for (const id of ["chrome", "chromium", "brave", "edge", "vivaldi", "opera", "helium", "firefox"]) {
      expect(capabilityFor("linux", id)?.supported, id).toBe(true);
    }
    expect(capabilityFor("linux", "arc")?.supported).toBe(false);
    expect(capabilityFor("linux", "safari")?.supported).toBe(false);
  });

  it("reports nothing supported on an unknown platform", () => {
    const matrix = describeLoginImportCapabilities("freebsd" as NodeJS.Platform);
    expect(matrix.platform).toBe("other");
    expect(matrix.anySupported).toBe(false);
    expect(matrix.browsers.every((entry) => entry.reason !== null)).toBe(true);
  });
});

describe("profile discovery inputs", () => {
  it("rejects a Local State profile key that would escape the user-data root", () => {
    expect(isSafeProfileDirectory("Default")).toBe(true);
    expect(isSafeProfileDirectory("Profile 2")).toBe(true);
    expect(isSafeProfileDirectory("..")).toBe(false);
    expect(isSafeProfileDirectory("../../etc")).toBe(false);
    expect(isSafeProfileDirectory("a\\b")).toBe(false);
    expect(isSafeProfileDirectory("")).toBe(false);
  });

  it("reads only [ProfileN] blocks from profiles.ini and honours IsRelative", () => {
    const parsed = parseFirefoxProfilesIni([
      "[Install123]",
      "Default=Profiles/abc.default",
      "",
      "[Profile0]",
      "Name=default-release",
      "IsRelative=1",
      "Path=Profiles/abc.default-release",
      "",
      "[Profile1]",
      "Name=absolute",
      "IsRelative=0",
      "Path=/tmp/somewhere",
    ].join("\n"));
    expect(parsed).toEqual([
      { name: "default-release", relativePath: "Profiles/abc.default-release", isRelative: true },
      { name: "absolute", relativePath: "/tmp/somewhere", isRelative: false },
    ]);
  });
});

describe("windows DPAPI key unwrap", () => {
  const WRAPPED = Buffer.from("wrapped-blob");
  const localState = JSON.stringify({
    os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), WRAPPED]).toString("base64") },
  });

  afterEach(() => {
    dpapi.spawnSync.mockReset();
    dpapi.resolveTrustedWindowsTool.mockReset();
    dpapi.resolveTrustedWindowsTool.mockReturnValue(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("runs a trusted PowerShell hidden and bounded, with the blob on stdin and never in argv", () => {
    const plain = Buffer.alloc(32, 7);
    dpapi.spawnSync.mockReturnValue({ status: 0, stdout: plain.toString("base64"), error: undefined });

    const keys = resolveChromiumKeys(
      { platform: "win32", windowsLocalStatePath: "C:\\Users\\x\\Local State" },
      { readFile: () => localState },
    );

    expect(keys.gcmV10).toEqual(plain);
    expect(dpapi.resolveTrustedWindowsTool).toHaveBeenCalledWith("powershell");
    const [command, argv, options] = dpapi.spawnSync.mock.calls[0]!;
    expect(command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    // Key material rides on stdin; a command line is readable machine-wide.
    expect(options).toMatchObject({ input: WRAPPED.toString("base64"), windowsHide: true });
    expect(options.timeout).toBeGreaterThan(0);
    expect((argv as string[]).join(" ")).not.toContain(WRAPPED.toString("base64"));
    expect(argv).toContain("-NonInteractive");
  });

  it("reports a refused trusted-tool lookup as key_unavailable instead of shelling out anyway", () => {
    dpapi.resolveTrustedWindowsTool.mockImplementation(() => {
      throw new TrustedWindowsToolError("powershell is not where Windows says it is");
    });

    expect(() =>
      resolveChromiumKeys(
        { platform: "win32", windowsLocalStatePath: "C:\\Users\\x\\Local State" },
        { readFile: () => localState },
      ),
    ).toThrowError(/trusted PowerShell/i);
    expect(dpapi.spawnSync).not.toHaveBeenCalled();
  });
});
