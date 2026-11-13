import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CredentialStore } from "../credentials/credentialStore";
import type { PasswordRelayItem, PasswordRelayWrite } from "../push/pushRelayClient";
import { createPasswordService, type PasswordsRelay } from "./passwordService";
import { generateSitePassword, openPasswordItem, parsePasswordEnvelope, sealPasswordItem, type PasswordEnvelope } from "./passwordCrypto";
import { normalizeTotpInput, parseTotp, totpCode } from "./passwordTotp";
import { matchLoginsForOrigin, normalizeLoginOrigin } from "./passwordMatching";
import { MAX_PASSWORD_CSV_BYTES, dedupeImportedLogins, parsePasswordCsv, type ImportedLogin, type PasswordCsvFormat } from "./passwordCsvImport";

/**
 * One account's relay, as the push-relay routes behave: opaque rows,
 * revisions, one key per epoch, writes sealed under an older epoch refused,
 * and at most 200 items per write (a bigger request fails whole).
 */
function fakeRelay() {
  const rows = new Map<string, PasswordRelayItem>();
  let clock = 0;
  let key = { dek: crypto.randomBytes(32).toString("base64"), epoch: 1 };
  const control = { online: true, beforePull: null as null | (() => Promise<void>) };
  const relay: PasswordsRelay = {
    async getPasswordItems() {
      const gate = control.beforePull;
      control.beforePull = null;
      if (gate) await gate();
      return { items: [...rows.values()], cursor: null, truncated: false, epoch: key.epoch };
    },
    async putPasswordItems(items: PasswordRelayWrite[]) {
      if (!control.online || items.length > 200) return null;
      return items.map((item) => {
        const sealedEpoch = item.ciphertext ? (JSON.parse(item.ciphertext) as { epoch: number }).epoch : null;
        if (sealedEpoch !== null && sealedEpoch < key.epoch) return { id: item.id, status: "stale_key" as const, revision: null };
        const stored = rows.get(item.id);
        const stale = item.ifRevision === "absent" ? Boolean(stored) : item.ifRevision ? stored?.revision !== item.ifRevision : false;
        if (stale) return { id: item.id, status: "stale" as const, revision: stored?.revision ?? null };
        const revision = `r${(clock += 1)}`;
        rows.set(item.id, { id: item.id, ciphertext: item.deleted ? null : item.ciphertext ?? null, revision, deleted: Boolean(item.deleted) });
        return { id: item.id, status: "ok" as const, revision };
      });
    },
    async requestPasswordKey({ reset }) {
      if (reset) key = { dek: crypto.randomBytes(32).toString("base64"), epoch: key.epoch + 1 };
      return key;
    },
  };
  return { relay, rows, control, reset: () => relay.requestPasswordKey({ deviceId: "x", machineKind: "desktop", reset: true }) };
}

function memoryStore(): CredentialStore {
  const values = new Map<string, string>();
  return {
    get: async (k) => values.get(k) ?? null,
    set: async (k, v) => void values.set(k, v),
    delete: async (k) => void values.delete(k),
  };
}

async function machine(relay: PasswordsRelay, deviceId: string) {
  const service = createPasswordService({
    adeDir: fs.mkdtempSync(path.join(os.tmpdir(), "ade-passwords-")),
    relay,
    getAccountUserId: () => "user_a",
    getDeviceId: () => deviceId,
    machineKind: "desktop",
    store: memoryStore(),
  });
  await service.setEnabled(true);
  return service;
}

describe("password service", () => {
  it("lets a second machine use what the first saved, and never shows a value in a summary or on the relay", async () => {
    const { relay, rows } = fakeRelay();
    const mac = await machine(relay, "mac");
    await mac.saveLogin({ origins: ["https://github.com/login"], username: "arul28", password: "s3cret-pass-123" });
    await mac.saveSecret({ name: "OPENAI_API_KEY", value: "key-value-xyz", projectScope: null });
    await mac.sync();

    expect(JSON.stringify([...rows.values()])).not.toMatch(/github|arul28|s3cret|key-value|OPENAI/);

    const laptop = await machine(relay, "laptop");
    await laptop.sync();
    const summaries = await laptop.listSummaries();
    expect(summaries.map((s) => [s.kind, s.title, s.sites, s.username])).toEqual([
      ["login", "github.com", ["github.com"], "arul28"],
      ["secret", "OPENAI_API_KEY", [], null],
    ]);
    expect(JSON.stringify(summaries)).not.toMatch(/s3cret|key-value/);
    expect(await laptop.resolveSecretValue({ name: "OPENAI_API_KEY", projectScope: "repo:x" })).toBe("key-value-xyz");
  });

  it("fills a login only into a page on its own site", async () => {
    const { relay } = fakeRelay();
    const mac = await machine(relay, "mac");
    const saved = await mac.saveLogin({ origins: ["https://github.com"], username: "arul28", password: "s3cret-pass-123" });
    expect(await mac.resolveForFill({ itemId: saved.id, pageUrl: "https://github.com/session" })).toMatchObject({ password: "s3cret-pass-123" });
    for (const page of ["https://github.com.evil.io/login", "https://gitlab.com/", "http://github.com/login"]) {
      expect(await mac.resolveForFill({ itemId: saved.id, pageUrl: page })).toBeNull();
    }
    expect((await mac.loginsForPage("https://evil.example/")).length).toBe(0);
    // The person's key button matches the whole site; an agent's sign-in only
    // the login's exact saved address, never another subdomain.
    expect(await mac.resolveForFill({ itemId: saved.id, pageUrl: "https://gist.github.com/" })).toMatchObject({ password: "s3cret-pass-123" });
    expect(await mac.resolveForFill({ itemId: saved.id, pageUrl: "https://gist.github.com/", exactOrigin: true })).toBeNull();
    expect((await mac.loginsForPage("https://gist.github.com/", { exactOrigin: true })).length).toBe(0);
    expect((await mac.loginsForPage("https://github.com/login", { exactOrigin: true })).map((login) => login.id)).toEqual([saved.id]);
  });

  it("picks up a reset made on another machine instead of failing to open new items", async () => {
    const { relay, reset } = fakeRelay();
    const mac = await machine(relay, "mac");
    const laptop = await machine(relay, "laptop");
    await mac.saveLogin({ origins: ["https://old.example"], username: "a", password: "old-pass-1" });
    await mac.sync();
    await laptop.sync();
    expect((await laptop.listSummaries()).length).toBe(1);

    // The laptop resets; the Mac still has the old key cached.
    await reset();
    await laptop.purge();
    await laptop.saveLogin({ origins: ["https://new.example"], username: "b", password: "new-pass-2" });
    await laptop.sync();

    // Before it hears of the reset, the Mac saves under its old key: the
    // relay refuses that write, and the Mac seals it again and resends it.
    await mac.saveLogin({ origins: ["https://late.example"], username: "c", password: "late-pass-3" });
    await mac.sync();
    await mac.sync();
    const titles = (await mac.listSummaries()).map((s) => s.title);
    expect(titles).toContain("new.example");
    expect(titles).toContain("late.example");
    await laptop.sync();
    const late = (await laptop.listSummaries()).find((s) => s.title === "late.example");
    expect(late, "the laptop opens the Mac's resealed login").toBeTruthy();
    expect(await laptop.resolveForFill({ itemId: late!.id, pageUrl: "https://late.example/" })).toMatchObject({ password: "late-pass-3" });
  });

  it("keeps unsent saves across a restart and a reset made elsewhere", async () => {
    const { relay, control, reset } = fakeRelay();
    const adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-passwords-"));
    const store = memoryStore();
    const start = () => createPasswordService({ adeDir, relay, getAccountUserId: () => "user_a", getDeviceId: () => "mac", machineKind: "desktop", store });
    const before = start();
    await before.setEnabled(true);
    control.online = false;
    const offline = await before.saveLogin({ origins: ["https://offline.example"], username: "o", password: "offline-pass-1" });
    await before.sync();

    // Another computer resets and saves under the new key; this one restarts.
    await reset();
    control.online = true;
    const laptop = await machine(relay, "laptop");
    await laptop.purge();
    await laptop.saveLogin({ origins: ["https://new.example"], username: "n", password: "new-pass-2" });
    await laptop.sync();
    const after = start();
    await after.sync();
    await after.sync();

    await laptop.sync();
    expect(await laptop.resolveForFill({ itemId: offline.id, pageUrl: "https://offline.example/" })).toMatchObject({ password: "offline-pass-1" });
    expect((await after.listSummaries()).map((s) => s.title).sort()).toEqual(["new.example", "offline.example"]);
  });

  it("keeps a login saved while a sync is pulling, on this machine and on the relay", async () => {
    const { relay, control } = fakeRelay();
    const mac = await machine(relay, "mac");
    await mac.saveLogin({ origins: ["https://first.example"], username: "a", password: "first-pass-1" });
    await mac.sync();

    let releasePull!: () => void;
    let pullStarted!: () => void;
    const started = new Promise<void>((resolve) => { pullStarted = resolve; });
    control.beforePull = () => new Promise<void>((resolve) => { pullStarted(); releasePull = resolve; });
    const syncing = mac.sync();
    await started;
    const during = await mac.saveLogin({ origins: ["https://during.example"], username: "b", password: "during-pass-2" });
    releasePull();
    await syncing;
    await mac.sync();

    expect((await mac.listSummaries()).map((s) => s.title).sort()).toEqual(["during.example", "first.example"]);
    const laptop = await machine(relay, "laptop");
    await laptop.sync();
    expect(await laptop.resolveForFill({ itemId: during.id, pageUrl: "https://during.example/" })).toMatchObject({ password: "during-pass-2" });
  });

  it("sends a backlog bigger than one relay write once the relay is back", async () => {
    const { relay, rows, control } = fakeRelay();
    const mac = await machine(relay, "mac");
    control.online = false;
    for (let index = 0; index < 205; index += 1) {
      await mac.saveLogin({ origins: [`https://site${index}.example`], username: "u", password: `pass-${index}-xyz` });
    }
    await mac.sync();
    expect(rows.size).toBe(0);

    control.online = true;
    await mac.sync();
    expect(rows.size).toBe(205);
    const laptop = await machine(relay, "laptop");
    await laptop.sync();
    expect((await laptop.listSummaries()).length).toBe(205);
  });
});

const binding = { accountId: "user_123", itemId: "item_abc", epoch: 1 };
const item = { kind: "login", origins: ["https://example.com"], username: "arul", password: "correct horse battery" };

describe("password item sealing", () => {
  it("opens what it sealed, and nothing readable is left in the envelope", () => {
    const key = crypto.randomBytes(32);
    const envelope = sealPasswordItem(key, binding, item);
    expect(openPasswordItem(key, binding, envelope)).toEqual(item);
    const stored = JSON.stringify(envelope);
    for (const visible of ["example.com", "arul", "correct horse"]) expect(stored).not.toContain(visible);
    // Two seals of the same item never share a nonce or ciphertext.
    const again = sealPasswordItem(key, binding, item);
    expect(again.nonce).not.toBe(envelope.nonce);
    expect(parsePasswordEnvelope(stored)).toEqual(envelope);
  });

  const tamperCases: Array<[string, (key: Buffer, envelope: PasswordEnvelope) => [Buffer, typeof binding, PasswordEnvelope]]> = [
    ["another account", (key, envelope) => [key, { ...binding, accountId: "user_other" }, envelope]],
    ["another item", (key, envelope) => [key, { ...binding, itemId: "item_other" }, envelope]],
    ["an envelope from an older key epoch", (key, envelope) => [key, { ...binding, epoch: 2 }, envelope]],
    ["a different vault key", (_key, envelope) => [crypto.randomBytes(32), binding, envelope]],
    ["one flipped ciphertext byte", (key, envelope) => {
      const body = Buffer.from(envelope.ct, "base64");
      body[0] = body[0]! ^ 0x01;
      return [key, binding, { ...envelope, ct: body.toString("base64") }];
    }],
  ];

  it.each(tamperCases)("refuses to open it under %s, without quoting the content", (_label, mutate) => {
    const key = crypto.randomBytes(32);
    const [useKey, useBinding, useEnvelope] = mutate(key, sealPasswordItem(key, binding, item));
    let message = "";
    try {
      openPasswordItem(useKey, useBinding, useEnvelope);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("correct horse");
    expect(message).not.toContain("arul");
  });

  it("generates site passwords with every character class and no repeats across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const password = generateSitePassword();
      expect(password).toHaveLength(20);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[-_.!@#%]/);
      seen.add(password);
    }
    expect(seen.size).toBe(50);
  });
});

// RFC 6238 appendix B: the shared secrets are ASCII "12345678901234567890"
// repeated to the hash's key length, and 8-digit codes at fixed times.
const b32 = (ascii: string) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const byte of Buffer.from(ascii)) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
};
const SHA1 = b32("12345678901234567890");
const SHA256 = b32("12345678901234567890123456789012");
const SHA512 = b32("1234567890123456789012345678901234567890123456789012345678901234");

describe("authenticator codes", () => {
  it.each([
    [59, "SHA1", SHA1, "94287082"],
    [1111111109, "SHA1", SHA1, "07081804"],
    [2000000000, "SHA1", SHA1, "69279037"],
    [59, "SHA256", SHA256, "46119246"],
    [1234567890, "SHA256", SHA256, "91819424"],
    [59, "SHA512", SHA512, "90693936"],
    [20000000000, "SHA512", SHA512, "47863826"],
  ])("matches RFC 6238 at t=%i with %s", (seconds, algorithm, secret, expected) => {
    const params = parseTotp(`otpauth://totp/x?secret=${secret}&digits=8&algorithm=${algorithm}`); // gitleaks:allow (RFC 6238 test key)
    expect(params).not.toBeNull();
    expect(totpCode(params!, seconds * 1000).code).toBe(expected);
  });

  it.each([
    ["not a key", null],
    ["otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQ", null], // gitleaks:allow (RFC 6238 test key)
    ["otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=5", null], // gitleaks:allow (RFC 6238 test key)
    ["otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=MD5", null], // gitleaks:allow (RFC 6238 test key)
  ])("refuses %s", (input, expected) => {
    expect(parseTotp(input)).toBe(expected);
  });

  it("turns a bare key a site shows into a URI that gives the same codes", () => {
    const uri = normalizeTotpInput("gezd gnbv gy3t qojq gezd gnbv gy3t qojq", "github.com");
    expect(uri).toMatch(/^otpauth:\/\/totp\/github\.com\?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ$/);
    expect(totpCode(parseTotp(uri!)!, 59_000).code).toBe("287082");
  });
});

describe("normalizeLoginOrigin", () => {
  it.each([
    { name: "a bare host", input: "github.com", origin: "https://github.com", host: "github.com", site: "github.com" },
    {
      name: "a full URL with a path and a query, lowercased",
      input: "https://GitHub.com/settings?tab=keys",
      origin: "https://github.com",
      host: "github.com",
      site: "github.com",
    },
    {
      name: "a default port, which is dropped",
      input: "https://github.com:443/login",
      origin: "https://github.com",
      host: "github.com",
      site: "github.com",
    },
    {
      name: "a non-default port, which is kept",
      input: "https://example.com:8443/admin",
      origin: "https://example.com:8443",
      host: "example.com",
      site: "example.com",
    },
    {
      name: "an international name, punycoded",
      input: "https://münchen.de",
      origin: "https://xn--mnchen-3ya.de",
      host: "xn--mnchen-3ya.de",
      site: "xn--mnchen-3ya.de",
    },
    {
      name: "a subdomain, whose site is the registrable domain",
      input: "https://login.github.com/session",
      origin: "https://login.github.com",
      host: "login.github.com",
      site: "github.com",
    },
    {
      name: "a multi-label public suffix",
      input: "https://www.bbc.co.uk/news",
      origin: "https://www.bbc.co.uk",
      host: "www.bbc.co.uk",
      site: "bbc.co.uk",
    },
    {
      name: "an IPv4 address, which is its own site",
      input: "https://192.168.1.10",
      origin: "https://192.168.1.10",
      host: "192.168.1.10",
      site: "192.168.1.10",
    },
    {
      name: "an IPv6 address with a port",
      input: "https://[::1]:8443",
      origin: "https://[::1]:8443",
      host: "::1",
      site: "::1",
    },
  ])("reads $name", ({ input, origin, host, site }) => {
    expect(normalizeLoginOrigin(input)).toEqual({ origin, host, site });
  });

  it.each([
    { name: "a site over plain http", input: "http://github.com" },
    { name: "an IP address over plain http", input: "http://192.168.1.10" },
    { name: "an ftp URL", input: "ftp://example.com/files" },
    { name: "an Android app credential", input: "android://x7y8z9@com.example.app/" },
    { name: "a browser extension", input: "chrome-extension://abcdefghijklmnop/options.html" },
    { name: "a mailto link", input: "mailto:ada@example.com" },
    { name: "a javascript URL", input: "javascript:alert(1)" },
    { name: "an empty string", input: "" },
    { name: "whitespace", input: "   " },
    { name: "text that is not a URL", input: "not a url" },
  ])("refuses $name", ({ input }) => {
    expect(normalizeLoginOrigin(input)).toBeNull();
  });

  it.each([
    { name: "localhost with a port", input: "http://localhost:3000", origin: "http://localhost:3000" },
    { name: "a *.localhost name", input: "http://app.localhost:5173", origin: "http://app.localhost:5173" },
    { name: "127.0.0.1", input: "http://127.0.0.1:8080/login", origin: "http://127.0.0.1:8080" },
    { name: "[::1]", input: "http://[::1]:3000", origin: "http://[::1]:3000" },
    { name: "a bare ::1", input: "::1", origin: "http://[::1]" },
  ])("allows $name over http", ({ input, origin }) => {
    expect(normalizeLoginOrigin(input)?.origin).toBe(origin);
  });
});

describe("matchLoginsForOrigin", () => {
  it.each([
    { name: "the same host", page: "https://github.com/settings/profile", saved: ["https://github.com"], matches: true },
    { name: "a deeper subdomain", page: "https://gist.github.com/octocat", saved: ["https://github.com"], matches: true },
    { name: "a sibling subdomain", page: "https://gist.github.com", saved: ["https://login.github.com"], matches: true },
    { name: "a saved subdomain on its apex", page: "https://google.com", saved: ["https://accounts.google.com"], matches: true },
    { name: "a saved URL path", page: "https://github.com", saved: ["https://github.com/login?return_to=%2F"], matches: true },
    {
      name: "a domain that ends in the saved name",
      page: "https://github.com.evil.io/login",
      saved: ["https://github.com"],
      matches: false,
    },
    { name: "one letter more", page: "https://githubb.com", saved: ["https://github.com"], matches: false },
    // The punycode for "gіthub.com", with a Cyrillic і: it renders like the real thing.
    { name: "a punycode lookalike", page: "https://xn--gthub-n2e.com", saved: ["https://github.com"], matches: false },
    { name: "a country suffix", page: "https://github.com.br", saved: ["https://github.com"], matches: false },
    {
      name: "a tenant of a private suffix",
      page: "https://someone.github.io/repo",
      saved: ["https://alice.github.io"],
      matches: false,
    },
    { name: "a host written inside a path", page: "https://evil.io/github.com", saved: ["https://github.com"], matches: false },
    { name: "a different local port", page: "http://localhost:3001", saved: ["http://localhost:3000"], matches: false },
    { name: "the same local app", page: "http://localhost:3000/login", saved: ["http://localhost:3000"], matches: true },
    { name: "another loopback port", page: "http://127.0.0.1:9000", saved: ["http://127.0.0.1:8080"], matches: false },
    { name: "the same loopback app", page: "http://127.0.0.1:8080/x", saved: ["http://127.0.0.1:8080"], matches: true },
  ])("$name is $matches for the page", ({ page, saved, matches }) => {
    const savedLogin = { id: "saved", origins: saved };
    expect(matchLoginsForOrigin([savedLogin], page)).toEqual(matches ? [savedLogin] : []);
  });

  it("offers an exact host before the rest of the site, keeping the caller's order", () => {
    const subdomain = { id: "subdomain", origins: ["https://gist.github.com"] };
    const sibling = { id: "sibling", origins: ["https://login.github.com"] };
    const exact = { id: "exact", origins: ["https://github.com"] };
    expect(matchLoginsForOrigin([subdomain, sibling, exact], "https://github.com/notifications")).toEqual([
      exact,
      subdomain,
      sibling,
    ]);
    expect(matchLoginsForOrigin([subdomain, exact], "https://gist.github.com/octocat")).toEqual([subdomain, exact]);
  });

  it("offers a login once even when several of its origins match", () => {
    const login = { id: "many", origins: ["https://github.com", "https://gist.github.com", "https://gitlab.com"] };
    expect(matchLoginsForOrigin([login], "https://gist.github.com")).toEqual([login]);
  });

  it("ignores origins it cannot read and pages that are not http(s)", () => {
    const unreadable = { id: "unreadable", origins: ["android://x7y8z9@com.example.app/", "not a url", ""] };
    const empty = { id: "empty", origins: [] };
    const readable = { id: "readable", origins: ["https://github.com"] };
    expect(matchLoginsForOrigin([unreadable, empty, readable], "https://github.com")).toEqual([readable]);
    expect(matchLoginsForOrigin([readable], "ftp://github.com")).toEqual([]);
    expect(matchLoginsForOrigin([readable], "")).toEqual([]);
  });
});

const CHROME_HEADER = "name,url,username,password,note";
const APPLE_HEADER = "Title,URL,Username,Password,Notes,OTPAuth";

function login(overrides: Partial<ImportedLogin> = {}): ImportedLogin {
  return {
    title: "GitHub",
    origins: ["https://github.com"],
    username: "ada@example.com",
    password: "correct horse battery staple",
    notes: "",
    totpUri: null,
    ...overrides,
  };
}

describe("parsePasswordCsv", () => {
  const vendorSamples: Array<{ name: string; csv: string; format: PasswordCsvFormat; rows: ImportedLogin[] }> = [
    {
      name: "an Apple Passwords export",
      format: "apple",
      csv: [
        "Title,URL,Username,Password,Notes,OTPAuth",
        "GitHub,https://github.com,ada.lovelace@example.com,correct horse battery staple,Work account,otpauth://totp/GitHub:ada.lovelace@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
        'Fastmail,https://app.fastmail.com,ada@example.com,"3,1415 and ""more""",Personal mail,',
      ].join("\r\n"),
      rows: [
        login({
          title: "GitHub",
          origins: ["https://github.com"],
          username: "ada.lovelace@example.com",
          notes: "Work account",
          totpUri: "otpauth://totp/GitHub:ada.lovelace@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
        }),
        login({
          title: "Fastmail",
          origins: ["https://app.fastmail.com"],
          username: "ada@example.com",
          password: '3,1415 and "more"',
          notes: "Personal mail",
        }),
      ],
    },
    {
      name: "a Chrome export",
      format: "chrome",
      csv: [
        CHROME_HEADER,
        "Linear,https://linear.app,ada@example.com,marginal-utility-note,Team planning",
        'Figma,https://www.figma.com/login,ada@example.com,"design, review, ship",Imported from Chrome',
      ].join("\n"),
      rows: [
        login({
          title: "Linear",
          origins: ["https://linear.app"],
          password: "marginal-utility-note",
          notes: "Team planning",
        }),
        login({
          title: "Figma",
          origins: ["https://www.figma.com"],
          password: "design, review, ship",
          notes: "Imported from Chrome",
        }),
      ],
    },
    {
      name: "a Firefox export, whose rows have no title",
      format: "firefox",
      csv: [
        "url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged",
        "https://news.ycombinator.com/login,ada,orange-tab-42,,https://news.ycombinator.com,{c0ffee00-1111-2222-3333-444455556666},1699999999000,1699999999000,1699999999000",
      ].join("\n"),
      rows: [
        login({
          title: "news.ycombinator.com",
          origins: ["https://news.ycombinator.com"],
          username: "ada",
          password: "orange-tab-42",
        }),
      ],
    },
    {
      name: "a Bitwarden export, keeping only its logins",
      format: "bitwarden",
      csv: [
        "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
        'Personal,0,1,Canvas,Learning,"",0,"https://canvas.instructure.com, https://school.instructure.com",ada@example.com,sketchbook-1999,',
        "Work,0,1,Vercel,,,0,https://vercel.com/login,ada@example.com,atomic-deploy-77,JBSWY3DPEHPK3PXP",
        "Personal,0,2,Passport scan,,,0,,,,",
      ].join("\n"),
      rows: [
        login({
          title: "Canvas",
          origins: ["https://canvas.instructure.com", "https://school.instructure.com"],
          password: "sketchbook-1999",
          notes: "Learning",
        }),
        login({
          title: "Vercel",
          origins: ["https://vercel.com"],
          password: "atomic-deploy-77",
          totpUri: "otpauth://totp/Vercel?secret=JBSWY3DPEHPK3PXP",
        }),
      ],
    },
    {
      name: "a 1Password export with its newer column names",
      format: "onepassword",
      csv: [
        "Title,Website,Username,Password,One-Time Password,Notes",
        'Fastmail,https://app.fastmail.com,ada@example.com,marginal-utility,otpauth://totp/Fastmail:ada@example.com?secret=KRSXG5DSN5XGK4TF,"Mail, calendar and files"',
      ].join("\n"),
      rows: [
        login({
          title: "Fastmail",
          origins: ["https://app.fastmail.com"],
          password: "marginal-utility",
          notes: "Mail, calendar and files",
          totpUri: "otpauth://totp/Fastmail:ada@example.com?secret=KRSXG5DSN5XGK4TF",
        }),
      ],
    },
    {
      name: "a 1Password export with the shared Apple column names",
      format: "onepassword",
      csv: ["Title,Url,Username,Password,Notes,OTPAuth", "Cloudflare,https://dash.cloudflare.com,ada@example.com,tunnel-vision-88,,"].join(
        "\n",
      ),
      rows: [
        login({
          title: "Cloudflare",
          origins: ["https://dash.cloudflare.com"],
          password: "tunnel-vision-88",
        }),
      ],
    },
    {
      name: "a generic export, finding the columns by name",
      format: "generic",
      csv: ["Site,Login,Pass,Comment", "https://example.org/login,ada,orchid-notes,imported by hand"].join("\n"),
      rows: [
        login({
          title: "example.org",
          origins: ["https://example.org"],
          username: "ada",
          password: "orchid-notes",
          notes: "imported by hand",
        }),
      ],
    },
  ];

  it.each(vendorSamples)("reads $name", ({ csv, format, rows }) => {
    expect(parsePasswordCsv(csv)).toEqual({ rows, skippedInvalid: 0, format });
  });

  it("keeps newlines inside quoted fields", () => {
    const parsed = parsePasswordCsv(
      [
        CHROME_HEADER,
        'Linear,https://linear.app,ada@example.com,quoted-newline,"Line one\nLine two, with a comma"',
      ].join("\r\n"),
    );
    expect(parsed.rows[0]?.notes).toBe("Line one\nLine two, with a comma");
    expect(parsed.rows).toHaveLength(1);
  });

  it.each([
    { name: "LF line endings", csv: `${CHROME_HEADER}\nLinear,https://linear.app,ada,pass,` },
    { name: "CRLF line endings", csv: `${CHROME_HEADER}\r\nLinear,https://linear.app,ada,pass,` },
    { name: "a BOM", csv: `\uFEFF${CHROME_HEADER}\nLinear,https://linear.app,ada,pass,` },
    { name: "a BOM and CRLF", csv: `\uFEFF${CHROME_HEADER}\r\nLinear,https://linear.app,ada,pass,` },
  ])("reads a file with $name", ({ csv }) => {
    const parsed = parsePasswordCsv(csv);
    expect(parsed.format).toBe("chrome");
    expect(parsed.rows).toEqual([
      login({ title: "Linear", origins: ["https://linear.app"], username: "ada", password: "pass" }),
    ]);
  });

  it.each([
    { name: "a row with no password", row: "No password,https://example.com,ada,,", skipped: 1 },
    { name: "a site over plain http", row: "Plain http,http://example.com,ada,pass,", skipped: 1 },
    { name: "an Android app credential", row: "Android,android://x7y8z9@com.example.app/,ada,pass,", skipped: 1 },
    { name: "a row with no URL", row: "No URL,,ada,pass,", skipped: 1 },
    { name: "a row whose URL is unreadable", row: "Junk,not a url,ada,pass,", skipped: 1 },
    { name: "localhost", row: "Vite,http://localhost:5173,ada,pass,", skipped: 0 },
    { name: "loopback", row: "Dev server,http://127.0.0.1:3000,ada,pass,", skipped: 0 },
  ])("counts $name as invalid only when it cannot be saved", ({ row, skipped }) => {
    expect(parsePasswordCsv([CHROME_HEADER, row].join("\n")).skippedInvalid).toBe(skipped);
  });

  it("keeps the readable origins of a row that lists several URLs", () => {
    const parsed = parsePasswordCsv(
      [CHROME_HEADER, 'Two sites,"https://example.com, http://insecure.example.com",ada,pass,'].join("\n"),
    );
    expect(parsed.rows[0]?.origins).toEqual(["https://example.com"]);
    expect(parsed.skippedInvalid).toBe(0);
  });

  it.each([
    {
      name: "a full otpauth URI",
      cell: "otpauth://totp/GitHub:ada@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
      expected: "otpauth://totp/GitHub:ada@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",
    },
    {
      name: "a bare base32 secret",
      cell: "JBSWY3DPEHPK3PXP",
      expected: "otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP",
    },
    {
      name: "a secret grouped with spaces, dashes and padding",
      cell: "jbsw y3dp-ehpk 3pxp====",
      expected: "otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP",
    },
    {
      name: "a counter-based HOTP URI, which is not a TOTP",
      cell: "otpauth://hotp/GitHub?secret=JBSWY3DPEHPK3PXP&counter=1",
      expected: null,
    },
    { name: "an empty value", cell: "", expected: null },
    { name: "text that is not a secret", cell: "two factor", expected: null },
  ])("reads $name in the TOTP column", ({ cell, expected }) => {
    const parsed = parsePasswordCsv([APPLE_HEADER, `GitHub,https://github.com,ada,pass,,${cell}`].join("\n"));
    expect(parsed.rows[0]?.totpUri).toBe(expected);
  });

  it("refuses a file over 5 MB without quoting its contents", () => {
    const row = "GitHub,https://github.com,ada,hunter2,hunter2\n";
    const oversized = CHROME_HEADER + "\n" + row.repeat(Math.ceil(MAX_PASSWORD_CSV_BYTES / row.length) + 1);
    expect(() => parsePasswordCsv(oversized)).toThrow("The file is over 5 MB.");
    let message = "";
    try {
      parsePasswordCsv(oversized);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("hunter2");
  });

  it("accepts a file at the 5 MB limit", () => {
    const atLimit = `${CHROME_HEADER}\n${"x".repeat(MAX_PASSWORD_CSV_BYTES - CHROME_HEADER.length - 1)}`;
    expect(() => parsePasswordCsv(atLimit)).not.toThrow();
  });

  it.each([
    { name: "an empty file", text: "" },
    { name: "a BOM alone", text: "\uFEFF" },
    { name: "blank lines", text: "\n\r\n" },
  ])("reads $name as no rows", ({ text }) => {
    expect(parsePasswordCsv(text)).toEqual({ rows: [], skippedInvalid: 0, format: "generic" });
  });
});

describe("dedupeImportedLogins", () => {
  it("skips a login the vault already holds, or that an earlier row in the file added", () => {
    const rows = [
      login({ title: "GitHub", origins: ["https://github.com"] }),
      login({ title: "GitHub on a subdomain", origins: ["https://gist.github.com"] }),
      login({ title: "A new password", password: "changed-but-here" }),
      login({ title: "Another user", username: "grace@example.com" }),
      login({ title: "A lookalike site", origins: ["https://github.com.evil.io"] }),
      login({ title: "Already saved", origins: ["https://gitlab.com"] }),
    ];
    const existing = [{ origins: ["https://gitlab.com"], username: "ada@example.com", password: "correct horse battery staple" }];

    expect(dedupeImportedLogins(rows, existing)).toEqual({
      fresh: [rows[0], rows[2], rows[3], rows[4]],
      skippedDuplicate: 2,
    });
  });

  it("keeps a login whose site cannot be read", () => {
    const rows = [login({ title: "Unreadable", origins: ["android://x7y8z9@com.example.app/"] })];
    expect(dedupeImportedLogins(rows, []).fresh).toEqual(rows);
  });
});
