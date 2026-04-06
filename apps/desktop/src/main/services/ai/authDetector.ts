// ---------------------------------------------------------------------------
// Auth Detector — discovers available authentication methods
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { spawnAsync } from "../shared/utils";
import {
  augmentProcessPathWithShellAndKnownCliDirs,
  resolveExecutableFromKnownLocations,
} from "./cliExecutableResolver";
import { resolveDroidExecutable } from "./droidExecutable";

type CliName = "claude" | "codex" | "cursor" | "droid";

type ApiKeySource = "config" | "env" | "store";

export type ApiKeyVerificationResult = {
  provider: string;
  ok: boolean;
  message: string;
  endpoint?: string;
  statusCode?: number | null;
  verifiedAt: string;
};

export type CliAuthStatus = {
  cli: CliName;
  installed: boolean;
  path: string | null;
  authenticated: boolean;
  verified: boolean;
  /** Cursor CLI only — when false, user is on free/hobby tier. */
  paidPlan?: boolean;
};

export type DetectedAuth =
  | {
      type: "cli-subscription";
      cli: "claude" | "codex" | "cursor" | "droid";
      path: string;
      authenticated: boolean;
      verified: boolean;
      /** Cursor: false when CLI reports hobby/free tier (chat may still open with a notice). */
      paidPlan?: boolean;
    }
  | { type: "api-key"; provider: string; key: string; source: ApiKeySource }
  | { type: "openrouter"; key: string; source: ApiKeySource }
  | { type: "local"; provider: "ollama" | "lmstudio" | "vllm"; endpoint: string };

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const CLI_AUTH_PROBES: Record<CliName, string[][]> = {
  claude: [
    ["auth", "status", "--json"],
    ["auth", "status"],
    ["whoami"],
  ],
  codex: [
    ["login", "status"],
  ],
  cursor: [
    ["status", "--json"],
    ["status"],
  ],
  droid: [["--version"], ["-V"], ["version"]],
};

function cliSpawnCommand(cli: CliName): string {
  if (cli === "cursor") return "agent";
  return cli;
}

const AUTH_INDICATORS = [
  /logged in/i,
  /authenticated/i,
  /signed in/i,
  /active session/i,
  /account:/i,
  /token valid/i,
];

/** Strong unauth signals — explicit negations that always indicate "not logged in". */
const STRONG_UNAUTH_INDICATORS = [
  /not logged in/i,
  /not authenticated/i,
  /login required/i,
  /sign in required/i,
  /unauthorized/i,
  /forbidden/i,
  /invalid token/i,
  /expired/i,
];

/**
 * Weak unauth signals — patterns that can appear in help/usage text even when
 * the user IS authenticated (e.g. "run `claude auth login` to switch accounts").
 * These should not override a positive auth indicator.
 */
const WEAK_UNAUTH_INDICATORS = [
  /run .*login/i,
];

const UNAUTH_INDICATORS = [...STRONG_UNAUTH_INDICATORS, ...WEAK_UNAUTH_INDICATORS];

const UNSUPPORTED_INDICATORS = [
  /unknown command/i,
  /unrecognized/i,
  /invalid option/i,
  /no such option/i,
  /unexpected argument/i,
];

function hasPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function getLookupShell(): string {
  return process.env.SHELL || "/bin/zsh";
}

function findExplicitCommandPath(command: string): string | null {
  return resolveExecutableFromKnownLocations(command)?.path ?? null;
}

async function commandExists(command: string): Promise<boolean> {
  // Strategy 1: Direct spawn — bypasses shell init (.zshrc errors, slow profiles).
  // If the binary exists, --version will produce *some* exit code.
  // A spawn error (ENOENT) means the binary isn't on PATH → status is null.
  try {
    const direct = await spawnAsync(command, ["--version"], { timeout: 5_000 });
    if (direct.status !== null) return true;
  } catch {
    // fall through to shell-based check
  }

  const explicitPath = findExplicitCommandPath(command);
  if (explicitPath) return true;

  // Strategy 2: Shell-based lookup (fallback for edge cases)
  try {
    if (process.platform === "win32") {
      const result = await spawnAsync("where", [command], { timeout: 5_000 });
      return result.status === 0;
    }
    const result = await spawnAsync(getLookupShell(), ["-lc", 'command -v "$1" >/dev/null 2>&1', "--", command], { timeout: 5_000 });
    return result.status === 0;
  } catch {
    // fall through to explicit common-path lookup
  }

  return explicitPath != null;
}

async function commandPath(command: string): Promise<string> {
  try {
    if (process.platform === "win32") {
      const result = await spawnAsync("where", [command], { timeout: 5_000 });
      return result.stdout?.trim().split(/\r?\n/)[0] ?? command;
    }
    // Try which first (simpler, doesn't load full login shell)
    const which = await spawnAsync("which", [command], { timeout: 3_000 });
    if (which.status === 0 && which.stdout?.trim()) {
      return which.stdout.trim();
    }
    const explicitPath = findExplicitCommandPath(command);
    if (explicitPath) {
      return explicitPath;
    }
    // Fallback to login shell lookup
    const result = await spawnAsync(getLookupShell(), ["-lc", 'command -v "$1"', "--", command], { timeout: 5_000 });
    return result.stdout?.trim() || command;
  } catch {
    return findExplicitCommandPath(command) ?? command;
  }
}

async function refreshProcessPathFromShell(): Promise<void> {
  const nextPath = augmentProcessPathWithShellAndKnownCliDirs({
    env: process.env,
    includeInteractiveShell: true,
    timeoutMs: 2_000,
  });
  if (nextPath) {
    process.env.PATH = nextPath;
  }
}

/** JSON fields that indicate a positive login state across CLI versions. */
const JSON_AUTH_FIELDS = ["loggedIn", "logged_in", "authenticated", "signedIn", "signed_in", "active"] as const;

type ParsedJsonAuthStatus = {
  authenticated: boolean;
  verified: true;
  json: Record<string, unknown>;
} | null;

function parseJsonAuthStatus(stdout: string): ParsedJsonAuthStatus {
  try {
    const json = JSON.parse(stdout.trim() || "");
    if (typeof json !== "object" || json === null) return null;

    // Check well-known boolean fields
    for (const field of JSON_AUTH_FIELDS) {
      if (field in json) {
        return { authenticated: Boolean(json[field]), verified: true, json: json as Record<string, unknown> };
      }
    }

    // If the JSON has an email/account field and no explicit false auth flag,
    // the user is likely authenticated.
    if (
      (typeof json.email === "string" && json.email.trim().length > 0)
      || (typeof json.account === "string" && json.account.trim().length > 0)
    ) {
      return { authenticated: true, verified: true, json: json as Record<string, unknown> };
    }
  } catch {
    // Not JSON — fall through to regex matching.
  }
  return null;
}

async function inspectCliAuthentication(
  cli: CliName,
  command: string = cli,
): Promise<Pick<CliAuthStatus, "authenticated" | "verified">> {
  const probes = CLI_AUTH_PROBES[cli] ?? [];
  let sawUnsupported = false;

  for (const args of probes) {
    try {
      const result = await spawnAsync(command, args, { timeout: 8_000 });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      const normalized = output.toLowerCase();

      // Try JSON parsing first (e.g. `claude auth status --json` returns {"loggedIn": true, ...})
      const jsonResult = parseJsonAuthStatus(result.stdout ?? "");
      if (jsonResult) return jsonResult;

      // Check both AUTH and UNAUTH indicators, then resolve conflicts.
      // Help text from an authenticated CLI session can mention "run … login"
      // (a weak unauth signal) even when the user IS logged in, so only strong
      // unauth patterns override a positive auth indicator.
      const matchesAuth = hasPattern(normalized, AUTH_INDICATORS);
      const matchesStrongUnauth = hasPattern(normalized, STRONG_UNAUTH_INDICATORS);
      const matchesWeakUnauth = hasPattern(normalized, WEAK_UNAUTH_INDICATORS);

      if (matchesStrongUnauth) {
        // Strong negative signal ("not logged in", "unauthorized", etc.) always wins.
        return { authenticated: false, verified: true };
      }

      if (matchesAuth) {
        // Positive signal with no strong negation — authenticated.
        // Weak unauth patterns (e.g. help text "run … login") are ignored.
        return { authenticated: true, verified: true };
      }

      if (matchesWeakUnauth) {
        // Only weak unauth with no positive signal — likely unauthenticated.
        return { authenticated: false, verified: true };
      }

      // Exit 0 with no recognizable output → treat as authenticated
      if (result.status === 0 && normalized.length === 0) {
        return { authenticated: true, verified: true };
      }

      // Exit 0 with unrecognized output → likely authenticated
      if (result.status === 0 && normalized.length > 0) {
        return { authenticated: true, verified: true };
      }

      if (hasPattern(normalized, UNSUPPORTED_INDICATORS)) {
        sawUnsupported = true;
      }
    } catch {
      // Continue probing fallback commands.
    }
  }

  // Backward-compatible behavior: if auth probing is unsupported for this CLI,
  // treat it as available but mark the status as unverified.
  if (sawUnsupported) {
    return { authenticated: true, verified: false };
  }

  return { authenticated: false, verified: false };
}

function inferCursorPaidPlanFromJson(json: Record<string, unknown>): boolean {
  const plan = String(json.plan ?? json.subscription ?? json.tier ?? json.accountType ?? "").toLowerCase();
  const sub = String(json.subscriptionType ?? json.billing ?? "").toLowerCase();
  const combined = `${plan} ${sub}`;
  if (
    /\bfree\b|\bhobby\b|\btrial\b|no[_-]?subscription|personal[_-]?free/.test(combined)
    && !/pro|plus|ultra|business|team/.test(combined)
  ) {
    return false;
  }
  if (/pro|plus|ultra|business|team|enterprise|paid/.test(combined)) {
    return true;
  }
  return true;
}

async function inspectCursorCliAuthentication(command: string): Promise<{
  authenticated: boolean;
  verified: boolean;
  paidPlan: boolean;
}> {
  const probes = CLI_AUTH_PROBES.cursor ?? [];
  let sawUnsupported = false;

  for (const args of probes) {
    try {
      const result = await spawnAsync(command, args, { timeout: 8_000 });
      const stdout = result.stdout ?? "";
      const normalized = `${stdout}\n${result.stderr ?? ""}`.trim().toLowerCase();

      // Try structured JSON auth first
      const jsonAuth = parseJsonAuthStatus(stdout);
      if (jsonAuth) {
        const paidPlan = inferCursorPaidPlanFromJson(jsonAuth.json);
        return {
          authenticated: jsonAuth.authenticated,
          verified: true,
          paidPlan,
        };
      }

      if (hasPattern(normalized, STRONG_UNAUTH_INDICATORS)) {
        return { authenticated: false, verified: true, paidPlan: false };
      }
      if (hasPattern(normalized, AUTH_INDICATORS)) {
        return { authenticated: true, verified: true, paidPlan: true };
      }
      if (hasPattern(normalized, WEAK_UNAUTH_INDICATORS)) {
        return { authenticated: false, verified: true, paidPlan: false };
      }

      if (result.status === 0 && normalized.length === 0) {
        return { authenticated: true, verified: true, paidPlan: true };
      }

      if (hasPattern(normalized, UNSUPPORTED_INDICATORS)) {
        sawUnsupported = true;
      }
    } catch {
      // continue
    }
  }

  if (sawUnsupported) {
    return { authenticated: true, verified: false, paidPlan: true };
  }

  return { authenticated: false, verified: false, paidPlan: false };
}

async function inspectDroidCliPresence(command: string): Promise<{
  installed: boolean;
  authenticated: boolean;
  verified: boolean;
}> {
  const probes = CLI_AUTH_PROBES.droid ?? [];
  let sawVersionOk = false;
  for (const args of probes) {
    try {
      const result = await spawnAsync(command, args, { timeout: 8_000 });
      const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      if (result.status === 0 && combined.length > 0) {
        sawVersionOk = true;
        break;
      }
      if (result.status === 0) {
        sawVersionOk = true;
        break;
      }
    } catch {
      // try next probe
    }
  }
  if (!sawVersionOk) {
    return { installed: false, authenticated: false, verified: false };
  }

  if (process.env.FACTORY_API_KEY?.trim()) {
    return { installed: true, authenticated: true, verified: true };
  }

  const settingsPath = path.join(homedir(), ".factory", "settings.json");
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const tokenLike =
      typeof parsed.accessToken === "string" && parsed.accessToken.trim().length > 0
        ? parsed.accessToken
        : typeof parsed.token === "string" && parsed.token.trim().length > 0
          ? parsed.token
          : null;
    if (tokenLike) {
      return { installed: true, authenticated: true, verified: true };
    }
  } catch {
    // missing or unreadable settings — not authenticated via file
  }

  const authProbes: string[][] = [
    ["account", "status"],
    ["whoami"],
  ];
  for (const args of authProbes) {
    try {
      const result = await spawnAsync(command, args, { timeout: 12_000 });
      const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      if (result.status !== 0) continue;
      if (hasPattern(combined, STRONG_UNAUTH_INDICATORS)) continue;
      if (hasPattern(combined, AUTH_INDICATORS)) {
        return { installed: true, authenticated: true, verified: true };
      }
    } catch {
      // try next probe
    }
  }

  return { installed: true, authenticated: false, verified: true };
}

const ENV_KEY_MAP: Record<string, string> = {
  ANTHROPIC_API_KEY: "anthropic",
  OPENAI_API_KEY: "openai",
  GOOGLE_API_KEY: "google",
  MISTRAL_API_KEY: "mistral",
  DEEPSEEK_API_KEY: "deepseek",
  XAI_API_KEY: "xai",
  GROQ_API_KEY: "groq",
  TOGETHER_API_KEY: "together",
};

const LOCAL_ENDPOINT_CHECK_TIMEOUT_MS = 500;
const LOCAL_ENDPOINT_CACHE_TTL_MS = 10_000;
const API_KEY_VERIFY_TIMEOUT_MS = 8_000;

let cachedLocalProviders:
  | {
      checkedAtMs: number;
      entries: Array<{ provider: "ollama" | "lmstudio" | "vllm"; endpoint: string }>;
    }
  | null = null;

function normalizeApiKeys(keys: Record<string, string> | undefined): Record<string, string> {
  if (!keys) return {};
  const normalized: Record<string, string> = {};

  for (const [provider, key] of Object.entries(keys)) {
    const normalizedProvider = provider.trim().toLowerCase();
    const normalizedKey = String(key ?? "").trim();
    if (!normalizedProvider || !normalizedKey) continue;
    normalized[normalizedProvider] = normalizedKey;
  }

  return normalized;
}

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function previewResponseBody(body: string, maxChars = 180): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

async function readStoredApiKeys(): Promise<Record<string, string>> {
  try {
    const { getAllApiKeys } = await import("./apiKeyStore");
    return normalizeApiKeys(getAllApiKeys());
  } catch {
    return {};
  }
}

async function checkLocalEndpointHasModels(
  provider: "ollama" | "lmstudio" | "vllm",
  url: string,
  timeoutMs = 2_000,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;

    const payload = await res.json() as unknown;
    if (provider === "ollama") {
      const models: Array<{ name?: unknown }> = Array.isArray((payload as { models?: unknown[] })?.models)
        ? ((payload as { models?: Array<{ name?: unknown }> }).models ?? [])
        : [];
      return models.some((entry) => typeof entry?.name === "string" && entry.name.trim().length > 0);
    }

    const models: Array<{ id?: unknown }> = Array.isArray((payload as { data?: unknown[] })?.data)
      ? ((payload as { data?: Array<{ id?: unknown }> }).data ?? [])
      : [];
    return models.some((entry) => typeof entry?.id === "string" && entry.id.trim().length > 0);
  } catch {
    return false;
  }
}

async function detectLocalProviders(): Promise<Array<{ provider: "ollama" | "lmstudio" | "vllm"; endpoint: string }>> {
  const now = Date.now();
  if (cachedLocalProviders && now - cachedLocalProviders.checkedAtMs < LOCAL_ENDPOINT_CACHE_TTL_MS) {
    return cachedLocalProviders.entries;
  }

  const localEndpoints: Array<{
    provider: "ollama" | "lmstudio" | "vllm";
    url: string;
  }> = [
    { provider: "ollama", url: "http://localhost:11434/api/tags" },
    { provider: "lmstudio", url: "http://localhost:1234/v1/models" },
    { provider: "vllm", url: "http://localhost:8000/v1/models" },
  ];

  const localChecks = await Promise.allSettled(
    localEndpoints.map(async ({ provider, url }) => {
      const alive = await checkLocalEndpointHasModels(provider, url, LOCAL_ENDPOINT_CHECK_TIMEOUT_MS);
      if (!alive) return null;
      const endpoint = url.replace(/\/api\/tags$|\/v1\/models$/, "");
      return { provider, endpoint } as const;
    }),
  );

  const entries: Array<{ provider: "ollama" | "lmstudio" | "vllm"; endpoint: string }> = [];
  for (const check of localChecks) {
    if (check.status === "fulfilled" && check.value) {
      entries.push(check.value);
    }
  }

  cachedLocalProviders = { checkedAtMs: now, entries };
  return entries;
}

function buildApiVerificationRequest(provider: string, key: string): {
  url: string;
  init: RequestInit;
} | null {
  switch (normalizeProvider(provider)) {
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/models",
        init: {
          method: "GET",
          headers: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
          },
        },
      };
    case "openai":
      return {
        url: "https://api.openai.com/v1/models",
        init: {
          method: "GET",
          headers: {
            Authorization: `Bearer ${key}`,
          },
        },
      };
    case "google":
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
        init: { method: "GET" },
      };
    case "mistral":
      return {
        url: "https://api.mistral.ai/v1/models",
        init: {
          method: "GET",
          headers: {
            Authorization: `Bearer ${key}`,
          },
        },
      };
    case "deepseek":
      return {
        url: "https://api.deepseek.com/v1/models",
        init: {
          method: "GET",
          headers: {
            Authorization: `Bearer ${key}`,
          },
        },
      };
    case "xai":
      return {
        url: "https://api.x.ai/v1/models",
        init: {
          method: "GET",
          headers: {
            Authorization: `Bearer ${key}`,
          },
        },
      };
    case "groq":
      return {
        url: "https://api.groq.com/openai/v1/models",
        init: {
          method: "GET",
          headers: {
            Authorization: `Bearer ${key}`,
          },
        },
      };
    case "together":
      return {
        url: "https://api.together.xyz/v1/models",
        init: {
          method: "GET",
          headers: {
            Authorization: `Bearer ${key}`,
          },
        },
      };
    case "openrouter":
      return {
        url: "https://openrouter.ai/api/v1/auth/key",
        init: {
          method: "GET",
          headers: {
            Authorization: `Bearer ${key}`,
          },
        },
      };
    default:
      return null;
  }
}

export async function verifyProviderApiKey(
  provider: string,
  key: string,
): Promise<ApiKeyVerificationResult> {
  const normalizedProvider = normalizeProvider(provider);
  const verifiedAt = new Date().toISOString();
  const keyText = String(key ?? "").trim();
  if (!normalizedProvider) {
    return {
      provider: normalizedProvider,
      ok: false,
      message: "Provider is required.",
      statusCode: null,
      verifiedAt,
    };
  }
  if (!keyText) {
    return {
      provider: normalizedProvider,
      ok: false,
      message: "No API key configured.",
      statusCode: null,
      verifiedAt,
    };
  }

  const request = buildApiVerificationRequest(normalizedProvider, keyText);
  if (!request) {
    return {
      provider: normalizedProvider,
      ok: false,
      message: "Provider does not support API key verification.",
      statusCode: null,
      verifiedAt,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_KEY_VERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(request.url, {
      ...request.init,
      signal: controller.signal,
    });

    if (response.ok) {
      return {
        provider: normalizedProvider,
        ok: true,
        message: "Connection verified successfully.",
        endpoint: request.url,
        statusCode: response.status,
        verifiedAt,
      };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        provider: normalizedProvider,
        ok: false,
        message: "Authentication failed. Check API key.",
        endpoint: request.url,
        statusCode: response.status,
        verifiedAt,
      };
    }

    if (response.status === 429) {
      return {
        provider: normalizedProvider,
        ok: true,
        message: "Authentication succeeded but provider is rate limiting requests.",
        endpoint: request.url,
        statusCode: response.status,
        verifiedAt,
      };
    }

    const body = previewResponseBody(await response.text().catch(() => ""));
    return {
      provider: normalizedProvider,
      ok: false,
      message: body ? `Verification failed (${response.status}): ${body}` : `Verification failed (${response.status}).`,
      endpoint: request.url,
      statusCode: response.status,
      verifiedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      provider: normalizedProvider,
      ok: false,
      message: `Verification request failed: ${message}`,
      endpoint: request.url,
      statusCode: null,
      verifiedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CLI auth cache — avoid re-probing every time a dialog opens
// ---------------------------------------------------------------------------
const CLI_AUTH_CACHE_TTL_MS = 60_000; // 1 minute
let cachedCliAuth: { checkedAtMs: number; statuses: CliAuthStatus[] } | null = null;

/** Synchronous read from cache — returns empty array if not yet populated. */
export function getCachedCliAuthStatuses(): CliAuthStatus[] {
  return cachedCliAuth?.statuses ?? [];
}

export async function detectCliAuthStatuses(options?: { force?: boolean }): Promise<CliAuthStatus[]> {
  const now = Date.now();
  if (!options?.force && cachedCliAuth && now - cachedCliAuth.checkedAtMs < CLI_AUTH_CACHE_TTL_MS) {
    return cachedCliAuth.statuses;
  }

  if (options?.force) {
    cachedCliAuth = null;
    cachedLocalProviders = null;
    await refreshProcessPathFromShell();
  }

  const cliChecks: CliName[] = ["claude", "codex", "cursor", "droid"];

  // Probe all CLIs in parallel
  const statuses = await Promise.all(
    cliChecks.map(async (cli) => {
      const spawnName = cliSpawnCommand(cli);
      const installed = await commandExists(spawnName);
      const path = installed ? await commandPath(spawnName) : null;
      const cmd = path ?? spawnName;
      if (!installed) {
        return {
          cli,
          installed,
          path,
          authenticated: false,
          verified: false,
        };
      }
      if (cli === "cursor") {
        const auth = await inspectCursorCliAuthentication(cmd);
        return {
          cli,
          installed,
          path,
          authenticated: auth.authenticated,
          verified: auth.verified,
          paidPlan: auth.paidPlan,
        };
      }
      if (cli === "droid") {
        const auth = await inspectDroidCliPresence(cmd);
        return {
          cli,
          installed: auth.installed,
          path,
          authenticated: auth.authenticated,
          verified: auth.verified,
        };
      }
      const auth = await inspectCliAuthentication(cli, cmd);
      return {
        cli,
        installed,
        path,
        authenticated: auth.authenticated,
        verified: auth.verified,
      };
    }),
  );

  cachedCliAuth = { checkedAtMs: now, statuses };
  return statuses;
}

export async function detectAllAuth(
  configApiKeys?: Record<string, string>,
  options?: { force?: boolean },
): Promise<DetectedAuth[]> {
  const results: DetectedAuth[] = [];

  // 1. CLI subscriptions (connected and authenticated)
  const cliStatuses = await detectCliAuthStatuses(options);
  for (const cli of cliStatuses) {
    if (cli.cli !== "claude" && cli.cli !== "codex" && cli.cli !== "cursor" && cli.cli !== "droid") continue;
    if (!cli.installed) continue;
    if (!cli.authenticated && cli.verified) continue;
    results.push({
      type: "cli-subscription",
      cli: cli.cli,
      path: cli.path ?? cliSpawnCommand(cli.cli),
      authenticated: cli.authenticated,
      verified: cli.verified,
      ...(cli.cli === "cursor" && typeof cli.paidPlan === "boolean" ? { paidPlan: cli.paidPlan } : {}),
    });
  }

  const cursorKey = process.env.CURSOR_API_KEY?.trim() || process.env.CURSOR_AUTH_TOKEN?.trim();
  if (cursorKey) {
    const hasCursorCli = results.some((r) => r.type === "cli-subscription" && r.cli === "cursor");
    if (!hasCursorCli) {
      const resolved = resolveExecutableFromKnownLocations("agent");
      results.push({
        type: "cli-subscription",
        cli: "cursor",
        path: resolved?.path ?? "agent",
        authenticated: true,
        verified: true,
        paidPlan: true,
      });
    }
  }

  const factoryKey = process.env.FACTORY_API_KEY?.trim();
  if (factoryKey) {
    const hasDroidCli = results.some((r) => r.type === "cli-subscription" && r.cli === "droid");
    if (!hasDroidCli) {
      const resolved = resolveDroidExecutable({ env: process.env, auth: results });
      if (resolved.source !== "fallback-command") {
        results.push({
          type: "cli-subscription",
          cli: "droid",
          path: resolved.path,
          authenticated: true,
          verified: true,
        });
      }
    }
  }

  // 2. API keys from config + secure local store
  const mergedApiKeys = new Map<string, { key: string; source: Exclude<ApiKeySource, "env"> }>();
  const normalizedConfig = normalizeApiKeys(configApiKeys);
  const normalizedStore = await readStoredApiKeys();

  for (const [provider, key] of Object.entries(normalizedStore)) {
    mergedApiKeys.set(provider, { key, source: "store" });
  }

  for (const [provider, key] of Object.entries(normalizedConfig)) {
    mergedApiKeys.set(provider, { key, source: "config" });
  }

  for (const [provider, entry] of mergedApiKeys.entries()) {
    if (provider === "openrouter") {
      results.push({ type: "openrouter", key: entry.key, source: entry.source });
    } else {
      results.push({
        type: "api-key",
        provider,
        key: entry.key,
        source: entry.source,
      });
    }
  }

  // 3. API keys from environment variables
  for (const [envVar, provider] of Object.entries(ENV_KEY_MAP)) {
    const value = process.env[envVar];
    if (!value || value.trim().length === 0) continue;
    if (mergedApiKeys.has(provider)) continue;
    results.push({ type: "api-key", provider, key: value.trim(), source: "env" });
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey && openrouterKey.trim().length > 0 && !mergedApiKeys.has("openrouter")) {
    results.push({ type: "openrouter", key: openrouterKey.trim(), source: "env" });
  }

  // 4. Local providers
  const localProviders = await detectLocalProviders();
  for (const localProvider of localProviders) {
    results.push({ type: "local", ...localProvider });
  }

  return results;
}
