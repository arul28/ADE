/**
 * Lend ADE's subscription proxy the logins this machine already has (every
 * Claude and Codex account, and the Grok, Kimi, Devin and Muse CLI logins), so
 * a subscription runs in another harness with no second sign-in. Antigravity is
 * never lent: its CLI keeps only a refresh token.
 *
 * Only the ACCESS token is lent. Each vendor rotates the refresh token on every
 * use, so a proxy holding a copy of it would sign the user's own CLI out the
 * first time either side renewed. The CLI stays the one owner of its login:
 * when a lent token nears expiry, ADE asks ADE's pinned copy of that CLI to
 * renew it (Codex: app-server `account/read` with `refreshToken: true`; Claude
 * Code: the SDK-mode startup handshake, which renews a near-expiry token
 * before it answers; Grok: `grok models`, which renews one inside its last few
 * minutes), then lends the new token. None makes a model request.
 *
 * Checked on 2026-10-30 against CLIProxyAPI 7.3.7 and 8.0.48, Codex 0.164.0 and
 * Claude Code 2.1.310: an auth file with no refresh token loads as active, is
 * never refreshed by the proxy, and is re-read when rewritten.
 *
 * A lent login lives in the proxy's auth folder as
 * `ade-borrow-<provider>-<account>.json` with a routing prefix of
 * `ade-<provider>-<account>`. A login the user signed in to the proxy itself
 * (the older flow) is never touched here.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  invalidateCachedClaudeCredentials,
  readClaudeCredentials,
} from "../../../../desktop/src/main/services/ai/providerCredentialSources";
import { resolveClaudeCodeExecutable } from "../../../../desktop/src/main/services/ai/claudeCodeExecutable";
import { resolveCodexExecutable } from "../../../../desktop/src/main/services/ai/codexExecutable";
import { readCodexKeyringAuth } from "../../../../desktop/src/main/services/ai/codexKeyringAuth";
import { resolveGrokExecutable } from "../../../../desktop/src/main/services/ai/acpExecutables";
import {
  codexConfigHome,
  devinCredentialFiles,
  grokConfigHome,
  kimiCodeConfigHome,
  museConfigDir,
} from "../../../../desktop/src/main/services/shared/providerConfigHomes";
import { resolveKimiCodeLogin } from "../../../../desktop/src/main/services/shared/kimiCodeLogin";
import {
  offThreadSpawnEnabled,
  spawnOffThread,
  terminateOffThreadChildTree,
  type OffThreadChild,
} from "../../../../desktop/src/main/services/shared/offThreadSpawn";
import { terminateProcessTree } from "../../../../desktop/src/main/services/shared/processExecution";
import { providerSelfUpdateEnv } from "../../../../desktop/src/shared/pinnedToolSpawnEnv";
import {
  HARNESS_PRESET_SUBSCRIPTION_PROVIDERS,
  type HarnessPresetSubscriptionProvider,
} from "../../../../desktop/src/shared/harnessPresets";
import type { ProviderInstance } from "../../../../desktop/src/shared/types/providerInstances";
import { captureError } from "../../../../desktop/src/shared/sentry/capture";
import { ensurePrivateDirectory, writePrivateFile, type PrivateFileSecurityOptions } from "../../lib/trustedWindowsTools";

/** Every provider whose login can be lent: the subscription sources a preset can name. */
export type BorrowableProvider = HarnessPresetSubscriptionProvider;
const BORROWABLE_PROVIDERS: readonly BorrowableProvider[] = HARNESS_PRESET_SUBSCRIPTION_PROVIDERS;

/** Providers ADE knows one login for per machine (not a provider-instance account). */
export const CLI_LOGIN_PROVIDERS = ["grok", "kimi", "devin", "muse"] as const satisfies readonly BorrowableProvider[];

export type BorrowableAccount = Pick<ProviderInstance, "id" | "configHome" | "isDefault"> & {
  provider: BorrowableProvider;
};

/** A one-per-machine CLI login (Grok, Kimi, Devin, Muse) as a lendable account. */
export type CliLoginAccount = BorrowableAccount & { provider: (typeof CLI_LOGIN_PROVIDERS)[number] };

type CliLogin = {
  accessToken: string;
  expiresAtMs: number | null;
  email: string | null;
  /** Codex only: the proxy sends these as the ChatGPT account headers. */
  idToken?: string;
  accountId?: string;
  /** Provider-specific fields the proxy's executor reads (Kimi's device id, Muse's key form). */
  extra?: Record<string, string>;
};

export type BorrowedLoginOutcome = {
  provider: BorrowableProvider;
  instanceId: string;
  status: "lent" | "renewed" | "unchanged" | "signed-out" | "expired";
};

const BORROWED_FILE_PREFIX = "ade-borrow-";
/**
 * Ask the CLI to renew a token this close to expiry. Codex renews on request
 * at any time; its tokens last 10 days. Claude Code renews only inside the last
 * ~2 minutes of its ~8-hour token (measured on 2.1.310: yes at 110 s left, no
 * at 170 s), so ADE asks at 100 s, on a timer aimed at each token's expiry.
 */
export const BORROW_RENEW_AHEAD_MS: Record<BorrowableProvider, number> = {
  claude: 100_000,
  codex: 24 * 60 * 60_000,
  // Grok CLI 1.0.46 renews its 6-hour token only near expiry (yes at 240 s
  // left, no at 1200 s).
  grok: 200_000,
  // Kimi Code 2.3.1 has no headless renew: a lent token runs until it lapses
  // and is re-lent whenever the user's own Kimi renews it.
  kimi: 0,
  // Devin's session token and Muse's minted key do not expire.
  devin: 0,
  muse: 0,
};

/** The proxy's own name for each provider's auth file `type` (CLIProxyAPI 8.0.48). */
const PROXY_AUTH_TYPE: Record<BorrowableProvider, string> = {
  claude: "claude",
  codex: "codex",
  grok: "xai",
  kimi: "kimi",
  devin: "devin",
  muse: "meta",
};
/**
 * A lent token closer to expiry than this is not handed to a launch; the
 * launch's prepare step renews it first. Kept below Claude's renew-ahead so a
 * token the launch refuses is always one a renewal pass will renew.
 */
export const BORROW_MIN_REMAINING_MS = 60_000;
const RENEW_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 2 * 60_000;

function safeSegment(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (cleaned === value) return cleaned;
  // An id the cleaning changed ("Work Mac" and "work-mac" both clean to
  // "work-mac") carries a hash of the raw id, so two ids never share a name.
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return cleaned ? `${cleaned}-${hash}` : hash;
}

export function borrowedLoginFileName(provider: BorrowableProvider, instanceId: string): string {
  return `${BORROWED_FILE_PREFIX}${provider}-${safeSegment(instanceId)}.json`;
}

/** The model prefix the proxy routes this account's requests by. */
export function borrowedLoginPrefix(provider: BorrowableProvider, instanceId: string): string {
  return `ade-${provider}-${safeSegment(instanceId)}`;
}

export function isBorrowedLoginFileName(name: string): boolean {
  return name.startsWith(BORROWED_FILE_PREFIX) && name.toLowerCase().endsWith(".json");
}

/** The provider a lent file was written for, from its name; null for any other file. */
function borrowedLoginFileProvider(name: string): BorrowableProvider | null {
  if (!isBorrowedLoginFileName(name)) return null;
  const rest = name.slice(BORROWED_FILE_PREFIX.length);
  return BORROWABLE_PROVIDERS.find((provider) => rest.startsWith(`${provider}-`)) ?? null;
}

function jwtClaims(token: string | undefined): Record<string, unknown> | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringField(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The machine's own login: the account whose id is the provider slug. It reads
 * and renews with no config-home variable, exactly as ADE launches it
 * (`isBaseProviderInstance`). Not `isDefault`, which is the account the user
 * picked for new chats and can be any of them.
 */
function isBaseLogin(account: BorrowableAccount): boolean {
  return account.id === account.provider;
}

/** The base Codex account follows `CODEX_HOME`, as the Codex reader does. */
function codexHomeFor(account: BorrowableAccount, env: NodeJS.ProcessEnv): string {
  return isBaseLogin(account) ? codexConfigHome({ env }) : path.resolve(account.configHome);
}

async function readCodexLogin(account: BorrowableAccount, env: NodeJS.ProcessEnv, fresh = false): Promise<CliLogin | null> {
  const codexHome = codexHomeFor(account, env);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8")) as Record<string, unknown>;
  } catch {
    // Codex set to keep its login in the OS keyring has no `auth.json`.
    const fromKeyring = await readCodexKeyringAuth(codexHome, { fresh });
    if (!fromKeyring) return null;
    try {
      parsed = JSON.parse(fromKeyring) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const tokens = parsed.tokens && typeof parsed.tokens === "object" ? parsed.tokens as Record<string, unknown> : null;
  const accessToken = stringField(tokens, "access_token");
  if (!accessToken) return null;
  const idToken = stringField(tokens, "id_token");
  const exp = jwtClaims(accessToken)?.exp;
  return {
    accessToken,
    expiresAtMs: typeof exp === "number" ? exp * 1000 : null,
    email: stringField(jwtClaims(idToken), "email") ?? null,
    ...(idToken ? { idToken } : {}),
    ...(stringField(tokens, "account_id") ? { accountId: stringField(tokens, "account_id") } : {}),
  };
}

async function readClaudeLogin(account: BorrowableAccount): Promise<CliLogin | null> {
  const credentials = await readClaudeCredentials({
    // Claude Code writes its Keychain item through `security` itself, so this
    // read raises no macOS prompt. The base account reads the bare item.
    allowKeychain: true,
    skipMissCache: true,
    ...(isBaseLogin(account) ? {} : { configHome: account.configHome }),
  });
  if (!credentials?.accessToken) return null;
  return {
    accessToken: credentials.accessToken,
    expiresAtMs: credentials.expiresAt ?? null,
    email: null,
  };
}

/** Grok's `auth.json` keys one login per issuer; its `key` is the bearer. */
function readGrokLogin(account: BorrowableAccount): CliLogin | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(account.configHome, "auth.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const value of Object.values(parsed)) {
    const entry = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    const accessToken = stringField(entry, "key");
    if (!accessToken) continue;
    const expires = Date.parse(stringField(entry, "expires_at") ?? "");
    return {
      accessToken,
      expiresAtMs: Number.isNaN(expires) ? null : expires,
      email: stringField(entry, "email") ?? null,
    };
  }
  return null;
}

function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Kimi Code's OAuth file for this region's login slot (`resolveKimiCodeLogin`):
 * `access_token` and `expires_at` in Unix seconds. The proxy also needs the
 * device id Kimi sends (`<home>/device_id`) and the API root without `/v1`.
 */
function readKimiLogin(env: NodeJS.ProcessEnv): CliLogin | null {
  const login = resolveKimiCodeLogin({ env });
  if (!login) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readTextFile(login.credentialPath) ?? "") as Record<string, unknown>;
  } catch {
    return null;
  }
  const accessToken = stringField(parsed, "access_token");
  if (!accessToken) return null;
  const expiresAt = typeof parsed.expires_at === "number" && parsed.expires_at > 0 ? parsed.expires_at * 1000 : null;
  const baseUrl = login.baseUrl.replace(/\/v1$/, "");
  const deviceId = readTextFile(path.join(kimiCodeConfigHome({ env }), "device_id"))?.trim();
  return {
    accessToken,
    expiresAtMs: expiresAt,
    email: null,
    extra: {
      base_url: baseUrl,
      domain: /kimi\.ai/.test(baseUrl) ? "kimi.ai" : "kimi.com",
      ...(deviceId ? { device_id: deviceId } : {}),
    },
  };
}

/** Devin's `credentials.toml` holds a session token that does not expire. */
function readDevinLogin(env: NodeJS.ProcessEnv): CliLogin | null {
  for (const file of devinCredentialFiles({ env })) {
    const token = /^\s*windsurf_api_key\s*=\s*"([^"]+)"/m.exec(readTextFile(file) ?? "")?.[1]?.trim();
    if (token) return { accessToken: token, expiresAtMs: null, email: null, extra: { session_token: token } };
  }
  return null;
}

/**
 * Muse's `auth.json` (`providers: { <id>: <credential> }`). A `dca:` value is
 * the OAuth token the proxy mints a key from; anything else is the key itself.
 */
function readMuseLogin(env: NodeJS.ProcessEnv): CliLogin | null {
  let parsed: { providers?: Record<string, unknown> };
  try {
    parsed = JSON.parse(readTextFile(path.join(museConfigDir({ env }), "auth.json")) ?? "") as typeof parsed;
  } catch {
    return null;
  }
  const values = Object.entries(parsed.providers ?? {})
    .sort(([a], [b]) => Number(b === "meta") - Number(a === "meta"))
    .map(([, value]) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  const credential = values[0];
  if (!credential) return null;
  return {
    accessToken: credential,
    expiresAtMs: null,
    email: null,
    extra: credential.startsWith("dca:") ? { dca_token: credential } : { api_key: credential },
  };
}

function kimiLoginUsable(env: NodeJS.ProcessEnv): boolean {
  const login = readKimiLogin(env);
  return login !== null && (login.expiresAtMs == null || login.expiresAtMs - Date.now() >= BORROW_MIN_REMAINING_MS);
}

function readLogin(account: BorrowableAccount, env: NodeJS.ProcessEnv, fresh = false): Promise<CliLogin | null> {
  switch (account.provider) {
    case "codex": return readCodexLogin(account, env, fresh);
    case "grok": return Promise.resolve(readGrokLogin(account));
    case "kimi": return Promise.resolve(readKimiLogin(env));
    case "devin": return Promise.resolve(readDevinLogin(env));
    case "muse": return Promise.resolve(readMuseLogin(env));
    case "claude": return readClaudeLogin(account);
  }
}

/**
 * The one-per-machine CLI logins this machine has (Grok, Kimi, Devin, Muse),
 * as lendable accounts. Mostly only whether a login is present is checked
 * here; Kimi's is also checked for expiry, because nothing can renew it
 * headlessly and an expired one would be offered and then fail at launch.
 */
export function cliLoginBorrowableAccounts(env: NodeJS.ProcessEnv = process.env): CliLoginAccount[] {
  const present: Record<(typeof CLI_LOGIN_PROVIDERS)[number], { home: string; found: boolean }> = {
    grok: { home: grokConfigHome({ env }), found: fs.existsSync(path.join(grokConfigHome({ env }), "auth.json")) },
    kimi: { home: kimiCodeConfigHome({ env }), found: kimiLoginUsable(env) },
    devin: { home: path.dirname(devinCredentialFiles({ env })[0]!), found: devinCredentialFiles({ env }).some((file) => fs.existsSync(file)) },
    muse: { home: museConfigDir({ env }), found: fs.existsSync(path.join(museConfigDir({ env }), "auth.json")) },
  };
  return CLI_LOGIN_PROVIDERS
    .filter((provider) => present[provider].found)
    .map((provider) => ({ id: provider, provider, configHome: present[provider].home, isDefault: true }));
}

/** Spawn ADE's pinned CLI, run one request/response exchange on stdio, then stop it. */
function exchange(args: {
  command: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  writes: string[];
  done: (stdout: string) => boolean;
  /** A command that answers by exiting: a clean exit is success. */
  exitZeroIsDone?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    // Off the event loop: renewals run on the keeper's timer inside the brain,
    // where a direct spawn blocks every chat for the whole CreateProcess.
    const offThread = offThreadSpawnEnabled();
    const child: OffThreadChild | ChildProcess = offThread
      ? spawnOffThread(args.command, args.argv, { env: args.env, cwd: os.tmpdir(), keepStdinOpen: true })
      : spawn(args.command, args.argv, { env: args.env, cwd: os.tmpdir(), stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (offThread) terminateOffThreadChildTree(child as OffThreadChild);
      else terminateProcessTree(child as ChildProcess);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), RENEW_TIMEOUT_MS);
    child.on("error", () => finish(false));
    child.on("close", (code: number | null) => finish(args.done(stdout) || (args.exitZeroIsDone === true && code === 0)));
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (args.done(stdout)) finish(true);
    });
    // A direct child's pipe can close under a write; the worker swallows that itself.
    if (!offThread) (child as ChildProcess).stdin?.on("error", () => undefined);
    for (const line of args.writes) child.stdin?.write(`${line}\n`);
  });
}

function renewCodexLogin(account: BorrowableAccount, env: NodeJS.ProcessEnv): Promise<boolean> {
  const executable = resolveCodexExecutable({ env });
  if (!executable.path) return Promise.resolve(false);
  return exchange({
    command: executable.path,
    argv: ["app-server"],
    env: { ...env, ...providerSelfUpdateEnv("codex"), CODEX_HOME: codexHomeFor(account, env) },
    writes: [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "ade-login-lender", version: "1" }, capabilities: {} } }),
      JSON.stringify({ jsonrpc: "2.0", method: "initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/read", params: { refreshToken: true } }),
    ],
    done: (stdout) => /"id"\s*:\s*2\b/.test(stdout),
  });
}

function renewClaudeLogin(account: BorrowableAccount, env: NodeJS.ProcessEnv): Promise<boolean> {
  const executable = resolveClaudeCodeExecutable({ env });
  if (!executable.path) return Promise.resolve(false);
  const childEnv: NodeJS.ProcessEnv = { ...env, ...providerSelfUpdateEnv("claude") };
  // The base login is the unscoped one; a scoped account names its folder.
  if (isBaseLogin(account)) delete childEnv.CLAUDE_CONFIG_DIR;
  else childEnv.CLAUDE_CONFIG_DIR = account.configHome;
  return exchange({
    command: executable.path,
    // No MCP servers, hooks or settings: the handshake only has to load the
    // login (which is when Claude Code renews it), not start the user's setup.
    argv: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--setting-sources", ""],
    env: childEnv,
    writes: [JSON.stringify({ type: "control_request", request_id: "ade-renew", request: { subtype: "initialize" } })],
    done: (stdout) => stdout.includes("\"ade-renew\""),
  });
}

function renewGrokLogin(account: BorrowableAccount, env: NodeJS.ProcessEnv): Promise<boolean> {
  const executable = resolveGrokExecutable({ env });
  if (!executable.path) return Promise.resolve(false);
  return exchange({
    command: executable.path,
    argv: ["--no-auto-update", "models"],
    env: { ...env, ...providerSelfUpdateEnv("grok"), GROK_HOME: account.configHome },
    writes: [],
    // `models` prints its list and exits; the renewal is already on disk then.
    done: () => false,
    exitZeroIsDone: true,
  });
}

function renewLogin(account: BorrowableAccount, env: NodeJS.ProcessEnv): Promise<boolean> {
  switch (account.provider) {
    case "codex": return renewCodexLogin(account, env);
    case "grok": return renewGrokLogin(account, env);
    case "claude": return renewClaudeLogin(account, env);
    // No headless renew (Kimi), or nothing that expires (Devin, Muse).
    default: return Promise.resolve(false);
  }
}

type BorrowedFile = Record<string, unknown>;

function readBorrowedFile(filePath: string): BorrowedFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as BorrowedFile : null;
  } catch {
    return null;
  }
}

function borrowedFileBody(account: BorrowableAccount, login: CliLogin, now: number): BorrowedFile {
  const expired = login.expiresAtMs ? new Date(login.expiresAtMs).toISOString() : undefined;
  return {
    type: PROXY_AUTH_TYPE[account.provider],
    // The proxy reads `type`; ADE matches a launch's provider on this.
    ade_provider: account.provider,
    prefix: borrowedLoginPrefix(account.provider, account.id),
    ...(login.email ? { email: login.email } : {}),
    access_token: login.accessToken,
    ...(login.idToken ? { id_token: login.idToken } : {}),
    ...(login.accountId ? { account_id: login.accountId } : {}),
    ...(expired ? { expired } : {}),
    ...login.extra,
    last_refresh: new Date(now).toISOString(),
    ade_borrowed: true,
    ade_instance_id: account.id,
    ade_default: account.isDefault,
  };
}

/** Write through a temp name so the proxy's file watcher never reads half a token. */
function writeBorrowedFile(filePath: string, body: BorrowedFile, security: PrivateFileSecurityOptions): void {
  const contents = `${JSON.stringify(body, null, 2)}\n`;
  const temp = `${filePath}.${process.pid}.tmp`;
  writePrivateFile(temp, contents, security);
  try {
    fs.renameSync(temp, filePath);
  } catch {
    // Windows refuses to replace a file another process holds open (the proxy
    // reading it); write in place instead, which its watcher re-reads.
    removeQuietly(temp);
    writePrivateFile(filePath, contents, security);
  }
}

function removeQuietly(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // A file another process already removed is the outcome we wanted.
  }
}

/**
 * One renewal at a time per machine. Two processes (desktop main and the
 * brain) can both own a proxy service, and two pinned CLIs renewing one login
 * at once would race the vendor's refresh-token rotation.
 */
async function withRenewLock<T>(authDir: string, run: () => Promise<T>): Promise<T | null> {
  const lockPath = path.join(authDir, ".ade-borrow-renew.lock");
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      // Steal a crashed holder's lock by renaming it aside, then check what was
      // taken: another process that saw the same stale lock may already have
      // replaced it with its own fresh one, and that one is put back.
      const claimed = `${lockPath}.${process.pid}.${Date.now()}.stale`;
      try {
        fs.renameSync(lockPath, claimed);
        if (Date.now() - fs.statSync(claimed).mtimeMs > LOCK_STALE_MS) {
          removeQuietly(claimed);
        } else {
          fs.renameSync(claimed, lockPath);
          return null;
        }
      } catch {
        // Another process moved it first; whatever lock stands now is theirs.
      }
    }
  } catch {
    // No lock.
  }
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "wx");
  } catch {
    return null;
  }
  try {
    return await run();
  } finally {
    fs.closeSync(fd);
    removeQuietly(lockPath);
  }
}

/**
 * Lend every Claude and Codex account's current login to the proxy, renewing
 * through the account's own CLI when `renew` is set and a token is near expiry.
 * Removes the lent file of an account that is gone or signed out.
 */
export async function syncBorrowedLogins(args: {
  authDir: string;
  accounts: readonly BorrowableAccount[];
  renew: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  security?: PrivateFileSecurityOptions;
  renewLogin?: (account: BorrowableAccount, env: NodeJS.ProcessEnv) => Promise<boolean>;
}): Promise<BorrowedLoginOutcome[]> {
  const env = args.env ?? process.env;
  const now = args.now ?? Date.now;
  const security = args.security ?? {};
  const renew = args.renewLogin ?? renewLogin;
  ensurePrivateDirectory(args.authDir, security);
  const outcomes: BorrowedLoginOutcome[] = [];
  const kept = new Set<string>();

  for (const account of args.accounts) {
    const fileName = borrowedLoginFileName(account.provider, account.id);
    const filePath = path.join(args.authDir, fileName);
    kept.add(fileName);
    let login = await readLogin(account, env);
    let renewed = false;
    const nearExpiry = (candidate: CliLogin | null) => Boolean(
      candidate?.expiresAtMs && candidate.expiresAtMs - now() < BORROW_RENEW_AHEAD_MS[account.provider],
    );
    if (login && args.renew && nearExpiry(login)) {
      const ok = await withRenewLock(args.authDir, () => renew(account, env));
      if (ok) {
        if (account.provider === "claude") invalidateCachedClaudeCredentials(isBaseLogin(account) ? undefined : account.configHome);
        const after = await readLogin(account, env, true);
        renewed = Boolean(after && after.accessToken !== login.accessToken);
        login = after ?? login;
      }
    }
    if (!login) {
      removeQuietly(filePath);
      outcomes.push({ provider: account.provider, instanceId: account.id, status: "signed-out" });
      continue;
    }
    if (login.expiresAtMs && login.expiresAtMs - now() < BORROW_MIN_REMAINING_MS) {
      removeQuietly(filePath);
      outcomes.push({ provider: account.provider, instanceId: account.id, status: "expired" });
      continue;
    }
    // The proxy writes its own fields back into a lent file (and may mark it
    // disabled after a refused request), so only an enabled file carrying this
    // exact token and default flag counts as current.
    const existing = readBorrowedFile(filePath);
    if (
      existing?.access_token === login.accessToken
      && existing.ade_default === account.isDefault
      && existing.disabled !== true
    ) {
      outcomes.push({ provider: account.provider, instanceId: account.id, status: "unchanged" });
      continue;
    }
    writeBorrowedFile(filePath, borrowedFileBody(account, login, now()), security);
    outcomes.push({ provider: account.provider, instanceId: account.id, status: renewed ? "renewed" : "lent" });
  }

  // Sweep the CLI logins always (a file probe, so a provider missing from the
  // list is signed out), and Claude and Codex only when the registry listed
  // them: a registry that could not be read keeps what it has lent, and every
  // machine has a base Claude and Codex account, so a listed one is never empty.
  const listed = new Set<string>([...CLI_LOGIN_PROVIDERS, ...args.accounts.map((account) => account.provider)]);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(args.authDir);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    const provider = borrowedLoginFileProvider(name);
    if (provider && listed.has(provider) && !kept.has(name)) removeQuietly(path.join(args.authDir, name));
  }
  return outcomes;
}

/** Beside the proxy's config: the models each lent login answers for. */
export const BORROWED_MODELS_FILE = "borrowed-models.json";

export type BorrowedModel = { id: string; label: string };

/**
 * Remember which models the proxy serves for each lent provider, from its
 * `/v1/models` list, so a source list can name them without a network call.
 * A model the proxy files under a lent prefix (`ade-grok-grok/grok-4.7`), or
 * under its upstream owner, belongs to that provider.
 */
export function writeBorrowedModelCache(proxyDir: string, listed: ReadonlyArray<{ id?: unknown; owned_by?: unknown }>): void {
  const ownerProvider: Record<string, BorrowableProvider> = { anthropic: "claude", openai: "codex", xai: "grok", moonshot: "kimi", meta: "muse" };
  const byProvider: Partial<Record<BorrowableProvider, BorrowedModel[]>> = {};
  for (const entry of listed) {
    const rawId = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!rawId) continue;
    const slash = rawId.indexOf("/");
    const prefixed = slash > 0 ? rawId.slice(0, slash) : "";
    const prefixProvider = BORROWABLE_PROVIDERS.find((candidate) => prefixed.startsWith(`ade-${candidate}-`));
    const provider = prefixProvider
      ?? (prefixed ? undefined : ownerProvider[typeof entry.owned_by === "string" ? entry.owned_by : ""]);
    if (!provider) continue;
    const id = prefixProvider ? rawId.slice(slash + 1) : rawId;
    const models = (byProvider[provider] ??= []);
    if (!models.some((model) => model.id === id)) models.push({ id, label: id });
  }
  try {
    fs.writeFileSync(
      path.join(proxyDir, BORROWED_MODELS_FILE),
      `${JSON.stringify({ updatedAt: new Date().toISOString(), providers: byProvider }, null, 2)}\n`,
    );
  } catch (error) {
    // A list that could not be written is re-read on the next pass.
    captureError(error, { tags: { feature: "proxy", stage: "borrow_models_cache" }, fingerprint: ["proxy.borrow_models_cache"] });
  }
}

/** The models the proxy last served for each lent provider; empty lists before the first pass. */
export function readBorrowedModels(proxyDir: string): Record<BorrowableProvider, BorrowedModel[]> {
  const result = Object.fromEntries(BORROWABLE_PROVIDERS.map((provider) => [provider, [] as BorrowedModel[]])) as Record<BorrowableProvider, BorrowedModel[]>;
  let providers: Record<string, unknown> | undefined;
  try {
    providers = (JSON.parse(fs.readFileSync(path.join(proxyDir, BORROWED_MODELS_FILE), "utf8")) as {
      providers?: Record<string, unknown>;
    }).providers;
  } catch {
    return result;
  }
  for (const provider of Object.keys(result) as BorrowableProvider[]) {
    const models = providers?.[provider];
    if (!Array.isArray(models)) continue;
    result[provider] = models.filter((model): model is BorrowedModel =>
      Boolean(model) && typeof (model as BorrowedModel).id === "string" && typeof (model as BorrowedModel).label === "string");
  }
  return result;
}

/**
 * When the soonest lent token enters its renew window, or null when nothing is
 * lent. The proxy service aims its next pass at this.
 */
export function nextBorrowRenewalAt(authDir: string, options: { after?: number } = {}): number | null {
  let soonest: number | null = null;
  let names: string[];
  try {
    names = fs.readdirSync(authDir).filter(isBorrowedLoginFileName);
  } catch {
    return null;
  }
  for (const name of names) {
    const body = readBorrowedFile(path.join(authDir, name));
    const named = body?.ade_provider;
    const provider = typeof named === "string" && named in BORROW_RENEW_AHEAD_MS ? named as BorrowableProvider : null;
    const expires = typeof body?.expired === "string" ? Date.parse(body.expired) : Number.NaN;
    if (!provider || Number.isNaN(expires)) continue;
    const due = expires - BORROW_RENEW_AHEAD_MS[provider];
    if (options.after !== undefined && due <= options.after) continue;
    soonest = soonest === null ? due : Math.min(soonest, due);
  }
  return soonest;
}

/** Whether any account's login is currently lent (the keeper only runs then). */
export function hasBorrowedLogins(authDir: string): boolean {
  try {
    return fs.readdirSync(authDir).some(isBorrowedLoginFileName);
  } catch {
    return false;
  }
}
