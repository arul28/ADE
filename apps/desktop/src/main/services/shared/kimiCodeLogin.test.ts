import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { kimiCodeOAuthKey, parseKimiConfigToml, resolveKimiCodeLogin } from "./kimiCodeLogin";

const GLOBAL_OAUTH_HOST = "https://auth.kimi.ai";
const GLOBAL_BASE_URL = "https://api.kimi.ai/coding/v1";
/** First 16 hex of sha256('{"oauthHost":"https://auth.kimi.ai","baseUrl":"https://api.kimi.ai/coding/v1"}'). */
const GLOBAL_SLOT = "oauth/kimi-code-env-0e4f99c69cc27850";
const TOKEN = JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: 1_900_000_000 });

const homes: string[] = [];

function kimiHome(files: Record<string, string>): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "ade-kimi-login-"));
  homes.push(home);
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(home, relative)), { recursive: true });
    writeFileSync(path.join(home, relative), text);
  }
  return home;
}

/** The `config.toml` a `kimi login --region global` writes (smol-toml `stringify`). */
function globalLoginConfig(oauth = `[providers."managed:kimi-code".oauth]
storage = "file"
key = "${GLOBAL_SLOT}"
oauth_host = "${GLOBAL_OAUTH_HOST}"`): string {
  return `default_model = "kimi-code/kimi-for-coding"

[providers."managed:kimi-code"]
type = "kimi"
base_url = "${GLOBAL_BASE_URL}"
api_key = ""

${oauth}

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
capabilities = [ "thinking", "tool_use" ]
`;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("resolveKimiCodeLogin", () => {
  it("maps each (OAuth host, API base) pair to the slot Kimi Code uses", () => {
    expect(kimiCodeOAuthKey({})).toBe("oauth/kimi-code");
    expect(kimiCodeOAuthKey({ oauthHost: " https://auth.kimi.com/ ", baseUrl: "https://api.kimi.com/coding/v1/" }))
      .toBe("oauth/kimi-code");
    expect(kimiCodeOAuthKey({ oauthHost: GLOBAL_OAUTH_HOST, baseUrl: GLOBAL_BASE_URL })).toBe(GLOBAL_SLOT);
    expect(kimiCodeOAuthKey({ baseUrl: "https://proxy.example.com/v1" })).toBe("oauth/kimi-code-env-ec7904fbd5c5e234");
  });

  // The bug: ADE read only `credentials/kimi-code.json`, so a `--region global`
  // login, which Kimi keeps in its own scoped file, was never found.
  it("finds a --region global login through config.toml", () => {
    const home = kimiHome({
      "config.toml": globalLoginConfig(),
      "credentials/kimi-code-env-0e4f99c69cc27850.json": TOKEN,
      // A stale mainland login in the default slot must not win.
      "credentials/kimi-code.json": TOKEN,
      region: "mainland-cn\n",
    });
    expect(resolveKimiCodeLogin({ env: { KIMI_CODE_HOME: home } })).toEqual({
      credentialPath: path.join(home, "credentials", "kimi-code-env-0e4f99c69cc27850.json"),
      baseUrl: GLOBAL_BASE_URL,
      source: "config",
    });
  });

  it("reads the oauth ref whether it is a sub-table, an inline table, or dotted keys", () => {
    const layouts = [
      `oauth = { storage = "file", key = "${GLOBAL_SLOT}", oauth_host = "${GLOBAL_OAUTH_HOST}" } # inline`,
      `oauth.storage = 'file'\noauth.key = '${GLOBAL_SLOT}'\noauthHost = "ignored"\noauth.oauthHost = "${GLOBAL_OAUTH_HOST}"`,
    ];
    for (const layout of layouts) {
      const home = kimiHome({
        "config.toml": `[providers."managed:kimi-code"]\ntype = "kimi"\nbase_url = "${GLOBAL_BASE_URL}/"\n${layout}\n`,
        "credentials/kimi-code-env-0e4f99c69cc27850.json": TOKEN,
      });
      expect(resolveKimiCodeLogin({ env: { KIMI_CODE_HOME: home } })).toMatchObject({
        baseUrl: GLOBAL_BASE_URL,
        source: "config",
      });
    }
  });

  it("falls back to the legacy default slot, with the region marker picking the base", () => {
    const home = kimiHome({ "credentials/kimi-code.json": TOKEN, region: "global\n", "config.toml": "# empty\n" });
    expect(resolveKimiCodeLogin({ env: { KIMI_CODE_HOME: home } })).toEqual({
      credentialPath: path.join(home, "credentials", "kimi-code.json"),
      baseUrl: GLOBAL_BASE_URL,
      source: "legacy",
    });
    // Kimi's own switch for the marker, and a marker Kimi does not recognize.
    expect(resolveKimiCodeLogin({ env: { KIMI_CODE_HOME: home, KIMI_CODE_REGION_MARKER: "off" } })?.baseUrl)
      .toBe("https://api.kimi.com/coding/v1");
    writeFileSync(path.join(home, "region"), "Global");
    expect(resolveKimiCodeLogin({ env: { KIMI_CODE_HOME: home } })?.baseUrl).toBe("https://api.kimi.com/coding/v1");
  });

  it("finds the default home under homeDir when KIMI_CODE_HOME is unset", () => {
    const homeDir = kimiHome({ ".kimi-code/credentials/kimi-code.json": TOKEN });
    expect(resolveKimiCodeLogin({ env: {}, homeDir })).toEqual({
      credentialPath: path.join(homeDir, ".kimi-code", "credentials", "kimi-code.json"),
      baseUrl: "https://api.kimi.com/coding/v1",
      source: "legacy",
    });
  });

  it("lets KIMI_CODE_BASE_URL and KIMI_CODE_OAUTH_HOST pick the slot, as Kimi does", () => {
    const home = kimiHome({
      "config.toml": globalLoginConfig(),
      "credentials/kimi-code-env-0e4f99c69cc27850.json": TOKEN,
      "credentials/kimi-code-env-ec7904fbd5c5e234.json": TOKEN,
    });
    expect(resolveKimiCodeLogin({ env: { KIMI_CODE_HOME: home, KIMI_CODE_BASE_URL: "https://proxy.example.com/v1/" } }))
      .toEqual({
        credentialPath: path.join(home, "credentials", "kimi-code-env-ec7904fbd5c5e234.json"),
        baseUrl: "https://proxy.example.com/v1",
        source: "config",
      });
    expect(resolveKimiCodeLogin({
      env: { KIMI_CODE_HOME: home, KIMI_OAUTH_HOST: GLOBAL_OAUTH_HOST, KIMI_CODE_BASE_URL: GLOBAL_BASE_URL },
    })?.credentialPath).toBe(path.join(home, "credentials", "kimi-code-env-0e4f99c69cc27850.json"));
    // A blank variable is unset.
    expect(resolveKimiCodeLogin({ env: { KIMI_CODE_HOME: home, KIMI_CODE_BASE_URL: "  " } })?.baseUrl).toBe(GLOBAL_BASE_URL);
  });

  it("returns null when the slot Kimi would read holds no file, or the login is in the keyring", () => {
    expect(resolveKimiCodeLogin({ env: { KIMI_CODE_HOME: kimiHome({}) } })).toBeNull();
    // Config names the global slot; only a default-slot file exists, and Kimi would not read it.
    expect(resolveKimiCodeLogin({
      env: { KIMI_CODE_HOME: kimiHome({ "config.toml": globalLoginConfig(), "credentials/kimi-code.json": TOKEN }) },
    })).toBeNull();
    const keyring = globalLoginConfig().replace('storage = "file"', 'storage = "keyring"');
    expect(resolveKimiCodeLogin({
      env: { KIMI_CODE_HOME: kimiHome({ "config.toml": keyring, "credentials/kimi-code-env-0e4f99c69cc27850.json": TOKEN }) },
    })).toBeNull();
  });

  it("reads a config Kimi would drop, or cannot parse, as no config", () => {
    const invalidEntry = globalLoginConfig().replace('storage = "file"', 'storage = "vault"');
    const unparseable = `${globalLoginConfig()}\nbroken = \n`;
    // smol-toml rejects a bare word, so Kimi reads this file as an empty config.
    const bareWord = `${globalLoginConfig()}\nk = hello\n`;
    for (const config of [invalidEntry, unparseable, bareWord]) {
      const home = kimiHome({ "config.toml": config, "credentials/kimi-code.json": TOKEN });
      expect(resolveKimiCodeLogin({ env: { KIMI_CODE_HOME: home } })).toMatchObject({
        credentialPath: path.join(home, "credentials", "kimi-code.json"),
        source: "legacy",
      });
    }
  });
});

describe("parseKimiConfigToml", () => {
  it("reads strings in every form and steps over other values", () => {
    const parsed = parseKimiConfigToml([
      "\uFEFF# leading comment",
      "title = \"a \\\"quoted\\\" \\u00e9 # not a comment\" # trailing",
      "literal = 'C:\\path'",
      "multi = \"\"\"",
      "line one",
      "[not.a.header]\"\"\"",
      "raw = '''x''''",
      "when = 1979-05-27 07:32:00Z",
      "list = [ 1, \"two\", { three = 3 }, ]",
      "[a.\"b.c\"]",
      "d = true",
      "[[arr]]",
      "n = 1",
      "[[arr]]",
      "n = 2",
    ].join("\r\n"));
    expect(parsed.title).toBe("a \"quoted\" \u00e9 # not a comment");
    expect(parsed.literal).toBe("C:\\path");
    expect(parsed.multi).toBe("line one\r\n[not.a.header]");
    expect(parsed.raw).toBe("x'");
    expect(parsed.when).toBeNull();
    expect(parsed.list).toEqual([null, "two", { three: null }]);
    expect(parsed.a).toEqual({ "b.c": { d: null } });
    expect(parsed.arr).toEqual([{ n: null }, { n: null }]);
    expect(parsed.not).toBeUndefined();
  });

  it("throws on a duplicate key, a repeated table, or a broken value", () => {
    expect(() => parseKimiConfigToml("a = 1\na = 2\n")).toThrow();
    expect(() => parseKimiConfigToml("[t]\n[t]\n")).toThrow();
    expect(() => parseKimiConfigToml("a = \"unterminated\n")).toThrow();
    expect(() => parseKimiConfigToml("a = 1 b = 2\n")).toThrow();
  });

  it("rejects a bare word as a value, as smol-toml does, and keeps every scalar form", () => {
    for (const value of ["hello", "yes", "trueish", "1abc", "07", "+0x1", ".5", "1979-05-27x"]) {
      expect(() => parseKimiConfigToml(`k = ${value}\n`), value).toThrow();
    }
    const scalars = [
      "true", "false", "0", "-17", "+1_000", "0xDEAD_beef", "0o755", "0b1010", "3.14", "-0.0", "6.626e-34",
      "5E+22", "inf", "-nan", "1979-05-27", "1979-05-27T07:32:00Z", "1979-05-27 07:32:00.999-07:00",
      "07:32:00", "07:32",
    ];
    for (const value of scalars) {
      expect(parseKimiConfigToml(`k = ${value} # note\nlist = [${value}, ${value}]\n`), value)
        .toEqual({ k: null, list: [null, null] });
    }
  });

  it("keeps a __proto__ key as plain data", () => {
    const parsed = parseKimiConfigToml("[__proto__]\npolluted = \"yes\"\n");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(parsed)).toEqual(["__proto__"]);
  });
});
