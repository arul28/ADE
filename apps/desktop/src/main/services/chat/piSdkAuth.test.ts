import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPiAccountMemo,
  createPiAccountReader,
  isPiLoopbackBaseUrl,
  piAuthSummary,
  piProviderAccountKind,
  piProviderAuthType,
} from "./piSdkAuth";

const TURN = { rules: "turn" } as const;
const SETTINGS = { rules: "settings" } as const;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function agentDirWith(files: { auth?: Record<string, unknown>; providers?: Record<string, unknown> }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pi-auth-"));
  roots.push(root);
  if (files.auth) fs.writeFileSync(path.join(root, "auth.json"), JSON.stringify(files.auth));
  if (files.providers) fs.writeFileSync(path.join(root, "models.json"), JSON.stringify({ providers: files.providers }));
  return root;
}

describe("piAuthSummary", () => {
  it("reads the credential kind Pi writes into auth.json", () => {
    for (const options of [TURN, SETTINGS]) {
      expect(piAuthSummary({ type: "api_key", key: "sk-1" }, options)).toEqual({ type: "api-key", expiresAt: null });
      expect(piAuthSummary({ type: "oauth", access: "a", refresh: "r", expires: 42 }, options))
        .toEqual({ type: "oauth", expiresAt: 42 });
      expect(piAuthSummary({ type: "token" }, options).type).toBe("oauth");
    }
  });

  it("judges an entry without a type by its field names", () => {
    expect(piAuthSummary({ apiKey: "sk-1" }, TURN).type).toBe("api-key");
    expect(piAuthSummary({ access: "a", refresh: "r" }, TURN).type).toBe("oauth");
    expect(piAuthSummary({ note: "x" }, TURN).type).toBe("unknown");
    expect(piAuthSummary(null, TURN).type).toBeNull();
    expect(piAuthSummary(["key"], TURN).type).toBeNull();
    // An untyped { key } is an API key for a turn, and oauth as Settings always has read it.
    expect(piAuthSummary({ key: "sk-1" }, TURN).type).toBe("api-key");
    expect(piAuthSummary({ key: "sk-1" }, SETTINGS).type).toBe("oauth");
  });
});

describe("isPiLoopbackBaseUrl", () => {
  it("knows every loopback host for a turn, and nothing remote", () => {
    for (const url of [
      "http://localhost:1234/v1",
      "http://127.0.0.1:11434",
      "http://127.0.0.2:11434",
      "http://0.0.0.0:8080",
      "http://[::1]:1234/v1",
      "http://studio.localhost:1234",
    ]) {
      expect(isPiLoopbackBaseUrl(url, TURN), url).toBe(true);
    }
    expect(isPiLoopbackBaseUrl("https://gateway.example.com/v1", TURN)).toBe(false);
    expect(isPiLoopbackBaseUrl("not a url", TURN)).toBe(false);
    expect(isPiLoopbackBaseUrl(undefined, TURN)).toBe(false);
  });

  it("keeps Settings to the five spellings it has always known", () => {
    for (const url of ["http://localhost:1", "http://127.0.0.1:1", "http://0.0.0.0:1", "http://[::1]:1", "http://LOCALHOST:1"]) {
      expect(isPiLoopbackBaseUrl(url, SETTINGS), url).toBe(true);
    }
    for (const url of ["http://127.0.0.2:1", "http://studio.localhost:1", "http://[::]:1"]) {
      expect(isPiLoopbackBaseUrl(url, SETTINGS), url).toBe(false);
    }
  });
});

describe("piProviderAuthType / piProviderAccountKind", () => {
  it("lets a stored auth.json entry win over a loopback URL and any key", () => {
    const evidence = {
      authEntry: { type: "oauth", access: "a", refresh: "r" },
      baseUrl: "http://127.0.0.1:1234/v1",
      configKey: "placeholder",
      envKey: true,
    };
    expect(piProviderAuthType(evidence, TURN)).toBe("oauth");
    expect(piProviderAccountKind(evidence)).toBe("subscription");
    expect(piProviderAccountKind({ authEntry: { type: "api_key", key: "sk" } })).toBe("api_key");
  });

  it("reads a loopback server as local even with a placeholder key, then a configured or environment key as an API key, then a bare endpoint as local", () => {
    expect(piProviderAccountKind({ baseUrl: "http://localhost:1234/v1", configKey: "lmstudio", envKey: true })).toBe("local");
    expect(piProviderAccountKind({ baseUrl: "https://gateway.example.com/v1", configKey: "sk" })).toBe("api_key");
    expect(piProviderAccountKind({ envKey: true })).toBe("api_key");
    expect(piProviderAuthType({ baseUrl: "https://gateway.example.com/v1" }, TURN)).toBe("local");
    // Without evidence: nothing.
    expect(piProviderAuthType({}, TURN)).toBeNull();
    expect(piProviderAccountKind({ envKey: false })).toBe("unknown");
  });

  it("never reads the environment under Settings rules", () => {
    expect(piProviderAuthType({ envKey: true }, SETTINGS)).toBeNull();
    expect(piProviderAuthType({ baseUrl: "https://gateway.example.com/v1", envKey: true }, SETTINGS)).toBe("local");
  });
});

describe("createPiAccountReader", () => {
  it("does not read a built-in cloud provider's registry URL as a local server", () => {
    const agentDir = agentDirWith({});
    const registry: Record<string, Record<string, unknown>> = {
      cerebras: { baseUrl: "https://api.cerebras.ai/v1" },
      together: { baseUrl: "https://api.together.xyz/v1" },
      zai: { baseUrl: "https://api.z.ai/api/coding/paas/v4" },
    };
    const reader = createPiAccountReader({
      agentDir: () => agentDir,
      getProvider: (id) => registry[id] ?? null,
      env: { CEREBRAS_API_KEY: "sk-env" },
    });
    // The key Pi reads for Cerebras: an API key turn.
    expect(reader.accountFor("cerebras")).toEqual({ kind: "api_key", upstream: "cerebras" });
    // No key ADE can see: unknown, never local and free.
    expect(reader.accountFor("together")).toEqual({ kind: "unknown", upstream: "together" });
    expect(reader.accountFor("zai")).toEqual({ kind: "unknown", upstream: "zai" });
  });

  it("reads a loopback registry URL, and any models.json URL, as the user's own endpoint", () => {
    const agentDir = agentDirWith({ providers: { gateway: { baseUrl: "https://gateway.example.com/v1" } } });
    const reader = createPiAccountReader({
      agentDir: () => agentDir,
      getProvider: (id) => (id === "ollama" ? { baseUrl: "http://127.0.0.1:11434/v1" } : null),
      env: {},
    });
    expect(reader.accountFor("ollama").kind).toBe("local");
    expect(reader.accountFor("gateway").kind).toBe("local");
  });

  it("prefers the stored credential, carries the Codex account id, and rereads after a profile change", () => {
    const agentDir = agentDirWith({
      auth: { "openai-codex": { type: "oauth", access: "a", refresh: "r", accountId: "acct-1" } },
    });
    const reader = createPiAccountReader({ agentDir: () => agentDir, getProvider: () => null, env: {} });
    expect(reader.accountFor("openai-codex")).toEqual({ kind: "subscription", upstream: "openai-codex", accountId: "acct-1" });
    expect(reader.accountFor("anthropic").kind).toBe("unknown");
    fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk-longer-key" } }));
    expect(reader.accountFor("anthropic").kind).toBe("api_key");
  });

  it("survives a registry that throws", () => {
    const reader = createPiAccountReader({
      agentDir: () => null,
      getProvider: () => { throw new Error("registry not ready"); },
      env: {},
    });
    expect(reader.accountFor("openai")).toEqual({ kind: "unknown", upstream: "openai" });
  });
});

describe("createPiAccountMemo", () => {
  it("reuses a reading until the profile files change", () => {
    let stamp = "a";
    const memo = createPiAccountMemo<string>(() => stamp);
    let reads = 0;
    const read = () => `kind-${++reads}`;
    expect(memo.get("anthropic", read)).toBe("kind-1");
    expect(memo.get("anthropic", read)).toBe("kind-1");
    // A sign-out through the Pi CLI rewrites auth.json.
    stamp = "b";
    expect(memo.get("anthropic", read)).toBe("kind-2");
  });

  it("forgets one provider after an in-worker sign-in and keeps the rest", () => {
    const memo = createPiAccountMemo<string>(() => "same");
    let reads = 0;
    const read = () => `kind-${++reads}`;
    memo.get("anthropic", read);
    memo.get("openai", read);
    memo.forget("anthropic");
    expect(memo.get("anthropic", read)).toBe("kind-3");
    expect(memo.get("openai", read)).toBe("kind-2");
  });
});
