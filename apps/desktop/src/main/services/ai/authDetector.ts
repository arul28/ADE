// ---------------------------------------------------------------------------
// Auth Detector — discovers available authentication methods
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";

type CliName = "claude" | "codex";

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
};

export type DetectedAuth =
  | {
      type: "cli-subscription";
      cli: CliName;
      path: string;
      authenticated: boolean;
      verified: boolean;
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
};

const AUTH_INDICATORS = [
  /logged in/i,
  /authenticated/i,
  /signed in/i,
  /active session/i,
  /account:/i,
  /token valid/i,
];

const UNAUTH_INDICATORS = [
  /not logged in/i,
  /not authenticated/i,
  /login required/i,
  /sign in required/i,
  /run .*login/i,
  /unauthorized/i,
  /forbidden/i,
  /invalid token/i,
  /expired/i,
];

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

/** Run a command asynchronously and return { status, stdout, stderr }. */
function spawnAsync(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", () => resolve({ status: null, stdout, stderr }));
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
  });
}

async function commandExists(command: string): Promise<boolean> {
  // Strategy 1: Direct spawn — bypasses shell init (.zshrc errors, slow profiles).
  // If the binary exists, --version will produce *some* exit code.
  // A spawn error (ENOENT) means the binary isn't on PATH → status is null.
  try {
    const direct = await spawnAsync(command, ["--version"], 5_000);
    if (direct.status !== null) return true;
  } catch {
    // fall through to shell-based check
  }

  // Strategy 2: Shell-based lookup (fallback for edge cases)
  try {
    if (process.platform === "win32") {
      const result = await spawnAsync("where", [command], 5_000);
      return result.status === 0;
    }
    const result = await spawnAsync("sh", ["-lc", `command -v ${command} >/dev/null 2>&1`], 5_000);
    return result.status === 0;
  } catch {
    return false;
  }
}

async function commandPath(command: string): Promise<string> {
  try {
    if (process.platform === "win32") {
      const result = await spawnAsync("where", [command], 5_000);
      return result.stdout?.trim().split(/\r?\n/)[0] ?? command;
    }
    // Try which first (simpler, doesn't load full login shell)
    const which = await spawnAsync("which", [command], 3_000);
    if (which.status === 0 && which.stdout?.trim()) {
      return which.stdout.trim();
    }
    // Fallback to login shell lookup
    const result = await spawnAsync("sh", ["-lc", `command -v ${command}`], 5_000);
    return result.stdout?.trim() || command;
  } catch {
    return command;
  }
}

async function inspectCliAuthentication(cli: CliName): Promise<Pick<CliAuthStatus, "authenticated" | "verified">> {
  const probes = CLI_AUTH_PROBES[cli] ?? [];
  let sawUnsupported = false;

  for (const args of probes) {
    try {
      const result = await spawnAsync(cli, args, 8_000);
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      const normalized = output.toLowerCase();

      // Try JSON parsing first (e.g. `claude auth status --json` returns {"loggedIn": true, ...})
      try {
        const json = JSON.parse(result.stdout?.trim() || "");
        if (typeof json === "object" && json !== null && "loggedIn" in json) {
          return { authenticated: Boolean(json.loggedIn), verified: true };
        }
      } catch {
        // Not JSON — fall through to regex matching.
      }

      if (hasPattern(normalized, UNAUTH_INDICATORS)) {
        return { authenticated: false, verified: true };
      }

      if (result.status === 0 && hasPattern(normalized, AUTH_INDICATORS)) {
        return { authenticated: true, verified: true };
      }

      if (result.status === 0 && normalized.length === 0) {
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

export async function detectCliAuthStatuses(): Promise<CliAuthStatus[]> {
  const now = Date.now();
  if (cachedCliAuth && now - cachedCliAuth.checkedAtMs < CLI_AUTH_CACHE_TTL_MS) {
    return cachedCliAuth.statuses;
  }

  const cliChecks: CliName[] = ["claude", "codex"];

  // Probe all CLIs in parallel
  const statuses = await Promise.all(
    cliChecks.map(async (cli) => {
      const installed = await commandExists(cli);
      const path = installed ? await commandPath(cli) : null;
      const auth = installed ? await inspectCliAuthentication(cli) : { authenticated: false, verified: false };
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
): Promise<DetectedAuth[]> {
  const results: DetectedAuth[] = [];

  // 1. CLI subscriptions (connected and authenticated)
  const cliStatuses = await detectCliAuthStatuses();
  for (const cli of cliStatuses) {
    if (cli.cli !== "claude" && cli.cli !== "codex") continue;
    if (!cli.installed) continue;
    if (!cli.authenticated && cli.verified) continue;
    results.push({
      type: "cli-subscription",
      cli: cli.cli,
      path: cli.path ?? cli.cli,
      authenticated: cli.authenticated,
      verified: cli.verified,
    });
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
