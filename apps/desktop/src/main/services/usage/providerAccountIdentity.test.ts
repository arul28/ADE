import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearProviderAccountCache,
  decodeJwtEmail,
  formatClaudePlan,
  formatCodexPlan,
  readClaudeAccount,
  readCodexAccount,
  resolveProviderAccounts,
} from "./providerAccountIdentity";
import { usageProviderAccountUrl } from "../../../shared/types";

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(payload)}.signature-not-verified`;
}

describe("decodeJwtEmail", () => {
  it("reads the email claim from a base64url payload", () => {
    expect(decodeJwtEmail(jwt({ email: "dev@example.com", sub: "u_1" }))).toBe("dev@example.com");
  });

  it("decodes payloads that use the url-safe alphabet and no padding", () => {
    // '?' and '~' force '-'/'_' into the encoding and a payload length that is
    // not a multiple of four.
    const email = "a-b_c+d@example.com";
    const token = jwt({ email, note: "??~~" });
    expect(token.split(".")[1]).toMatch(/[-_]/);
    expect(decodeJwtEmail(token)).toBe(email);
  });

  it("falls back to preferred_username when email is absent", () => {
    expect(decodeJwtEmail(jwt({ preferred_username: "dev@example.com" }))).toBe("dev@example.com");
  });

  it("returns undefined for malformed, non-email, or missing tokens", () => {
    expect(decodeJwtEmail(undefined)).toBeUndefined();
    expect(decodeJwtEmail("")).toBeUndefined();
    expect(decodeJwtEmail("not-a-jwt")).toBeUndefined();
    expect(decodeJwtEmail("a.!!!not-base64!!!.c")).toBeUndefined();
    expect(decodeJwtEmail(jwt({ email: "not-an-email" }))).toBeUndefined();
    expect(decodeJwtEmail(jwt({ sub: "u_1" }))).toBeUndefined();
  });
});

describe("provider account email files", () => {
  let home: string;
  const savedCodexHome = process.env.CODEX_HOME;
  const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-account-email-"));
    delete process.env.CODEX_HOME;
    delete process.env.CLAUDE_CONFIG_DIR;
    clearProviderAccountCache();
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
  });

  it("reads the Codex email from the id_token in auth.json", async () => {
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".codex", "auth.json"),
      JSON.stringify({
        tokens: {
          id_token: jwt({ email: "codex-user@example.com" }),
          access_token: "secret-access-token",
        },
      }),
    );
    await expect(readCodexAccount(home)).resolves.toEqual({ email: "codex-user@example.com" });
  });

  it("returns undefined when Codex has no auth file or no id_token", async () => {
    await expect(readCodexAccount(home)).resolves.toEqual({});
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".codex", "auth.json"),
      JSON.stringify({ tokens: { access_token: "secret-access-token" } }),
    );
    await expect(readCodexAccount(home)).resolves.toEqual({});
  });

  it("separates a config that is gone from one that cannot be read", async () => {
    const codexHome = path.join(home, ".codex");
    process.env.CODEX_HOME = codexHome;

    // Nothing there: the authoritative "signed out" answer. A caller holding a
    // previous account must clear it rather than keep showing it forever.
    clearProviderAccountCache();
    const absent = await resolveProviderAccounts(1_000);
    expect(absent.identities.codex).toBeUndefined();
    expect(absent.unreadable.codex).toBeUndefined();

    // There but unparsable (a half-written file): transient, so the previous
    // identity may be carried.
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "auth.json"), '{"tokens": {"id_to');
    clearProviderAccountCache();
    const broken = await resolveProviderAccounts(2_000);
    expect(broken.identities.codex).toBeUndefined();
    expect(broken.unreadable.codex).toBe(true);
  });

  it("carries the last identity it read across an unreadable pass, but not across a sign-out", async () => {
    const codexHome = path.join(home, ".codex");
    process.env.CODEX_HOME = codexHome;
    const authPath = path.join(codexHome, "auth.json");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      authPath,
      JSON.stringify({ tokens: { id_token: jwt({ email: "codex-user@example.com" }) } }),
    );

    clearProviderAccountCache();
    const read = await resolveProviderAccounts(1_000);
    expect(read.identities.codex).toEqual({ email: "codex-user@example.com" });

    // Half-written file: the account line must survive it. Carrying happens in
    // the resolver, so callers never keep a copy of their own.
    fs.writeFileSync(authPath, '{"tokens": {"id_to');
    const unreadable = await resolveProviderAccounts(1_000 + 6 * 60_000);
    expect(unreadable.unreadable.codex).toBe(true);
    expect(unreadable.identities.codex).toEqual({ email: "codex-user@example.com" });

    // Signed out: the authoritative answer clears the carry for good, so a
    // later unreadable pass has nothing stale to resurrect.
    fs.rmSync(authPath);
    const signedOut = await resolveProviderAccounts(1_000 + 12 * 60_000);
    expect(signedOut.identities.codex).toBeUndefined();
    expect(signedOut.unreadable.codex).toBeUndefined();

    fs.writeFileSync(authPath, '{"tokens": {"id_to');
    const afterSignOut = await resolveProviderAccounts(1_000 + 18 * 60_000);
    expect(afterSignOut.unreadable.codex).toBe(true);
    expect(afterSignOut.identities.codex).toBeUndefined();
  });

  it("reads the Claude email from .claude.json oauthAccount", async () => {
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "claude-user@example.com" } }),
    );
    await expect(readClaudeAccount(home)).resolves.toEqual({ email: "claude-user@example.com" });
  });

  it("prefers CLAUDE_CONFIG_DIR over the home copy", async () => {
    const configDir = path.join(home, "custom-config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "scoped@example.com" } }),
    );
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "home@example.com" } }),
    );
    process.env.CLAUDE_CONFIG_DIR = configDir;
    await expect(readClaudeAccount(home)).resolves.toEqual({ email: "scoped@example.com" });
  });

  it("falls back to the credential file tier when the config has no account block", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "secret", subscriptionType: "max" } }),
    );
    await expect(readClaudeAccount(home)).resolves.toEqual({ plan: "Claude Max" });
  });

  it("never reports a payment rail as a plan", async () => {
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "dev@example.com", billingType: "stripe_subscription" },
      }),
    );
    await expect(readClaudeAccount(home)).resolves.toEqual({ email: "dev@example.com" });
  });
});

describe("plan names", () => {
  it("reads the Codex plan from the OpenAI auth claim", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-account-plan-"));
    try {
      fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".codex", "auth.json"),
        JSON.stringify({
          tokens: {
            id_token: jwt({
              email: "pro@example.com",
              "https://api.openai.com/auth": { chatgpt_plan_type: "pro" },
            }),
          },
        }),
      );
      await expect(readCodexAccount(home)).resolves.toEqual({
        email: "pro@example.com",
        plan: "ChatGPT Pro",
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("titles unknown Codex slugs instead of dropping them", () => {
    expect(formatCodexPlan("pro")).toBe("ChatGPT Pro");
    expect(formatCodexPlan("pro_20x")).toBe("ChatGPT Pro 20x");
    expect(formatCodexPlan("")).toBeUndefined();
    expect(formatCodexPlan(7)).toBeUndefined();
  });

  it("normalizes Claude subscription labels", () => {
    expect(formatClaudePlan("max")).toBe("Claude Max");
    expect(formatClaudePlan("claude_max_20x")).toBe("Claude Max 20x");
    expect(formatClaudePlan("  ")).toBeUndefined();
  });

  it("reads the Claude plan from oauthAccount", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-claude-plan-"));
    try {
      fs.writeFileSync(
        path.join(home, ".claude.json"),
        JSON.stringify({
          oauthAccount: { emailAddress: "dev@example.com", subscriptionType: "max" },
        }),
      );
      await expect(readClaudeAccount(home)).resolves.toEqual({
        email: "dev@example.com",
        plan: "Claude Max",
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("usageProviderAccountUrl", () => {
  it("is the one source clients read for the provider limits page", () => {
    expect(usageProviderAccountUrl("claude")).toBe("https://claude.ai/new#settings/usage");
    expect(usageProviderAccountUrl("codex")).toBe(
      "https://chatgpt.com/codex/cloud/settings/analytics#usage",
    );
    expect(usageProviderAccountUrl("cursor")).toBeUndefined();
  });
});
