// ---------------------------------------------------------------------------
// Auth Detector — discovers available authentication methods
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";

export type DetectedAuth =
  | { type: "cli-subscription"; cli: "claude" | "codex" | "gemini"; path: string }
  | { type: "api-key"; provider: string; key: string; source: "config" | "env" }
  | { type: "openrouter"; key: string }
  | { type: "local"; provider: "ollama" | "lmstudio" | "vllm"; endpoint: string };

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function commandExists(command: string): boolean {
  try {
    if (process.platform === "win32") {
      const result = spawnSync("where", [command], { encoding: "utf8", timeout: 5_000 });
      return result.status === 0;
    }
    const result = spawnSync("sh", ["-lc", `command -v ${command} >/dev/null 2>&1`], {
      encoding: "utf8",
      timeout: 5_000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function commandPath(command: string): string {
  try {
    if (process.platform === "win32") {
      const result = spawnSync("where", [command], { encoding: "utf8", timeout: 5_000 });
      return result.stdout?.trim().split(/\r?\n/)[0] ?? command;
    }
    const result = spawnSync("sh", ["-lc", `command -v ${command}`], {
      encoding: "utf8",
      timeout: 5_000,
    });
    return result.stdout?.trim() || command;
  } catch {
    return command;
  }
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

async function checkLocalEndpoint(url: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function detectAllAuth(
  configApiKeys?: Record<string, string>,
): Promise<DetectedAuth[]> {
  const results: DetectedAuth[] = [];

  // 1. CLI subscriptions
  const cliChecks: Array<{ name: "claude" | "codex" | "gemini" }> = [
    { name: "claude" },
    { name: "codex" },
    { name: "gemini" },
  ];
  for (const { name } of cliChecks) {
    if (commandExists(name)) {
      results.push({ type: "cli-subscription", cli: name, path: commandPath(name) });
    }
  }

  // 2. API keys from config (passed by settings UI / project config)
  if (configApiKeys) {
    for (const [provider, key] of Object.entries(configApiKeys)) {
      if (key && key.trim().length > 0) {
        if (provider.toLowerCase() === "openrouter") {
          results.push({ type: "openrouter", key: key.trim() });
        } else {
          results.push({ type: "api-key", provider: provider.toLowerCase(), key: key.trim(), source: "config" });
        }
      }
    }
  }

  // 3. API keys from environment variables
  for (const [envVar, provider] of Object.entries(ENV_KEY_MAP)) {
    const value = process.env[envVar];
    if (value && value.trim().length > 0) {
      // Skip if already provided via config with the same provider
      const alreadyFromConfig = results.some(
        (r) => r.type === "api-key" && r.provider === provider && r.source === "config",
      );
      if (!alreadyFromConfig) {
        results.push({ type: "api-key", provider, key: value.trim(), source: "env" });
      }
    }
  }

  // OpenRouter from env
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey && openrouterKey.trim().length > 0) {
    const alreadyPresent = results.some((r) => r.type === "openrouter");
    if (!alreadyPresent) {
      results.push({ type: "openrouter", key: openrouterKey.trim() });
    }
  }

  // 4. Local providers
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
      const alive = await checkLocalEndpoint(url);
      if (alive) {
        const endpoint = url.replace(/\/api\/tags$|\/v1\/models$/, "");
        return { provider, endpoint } as const;
      }
      return null;
    }),
  );

  for (const check of localChecks) {
    if (check.status === "fulfilled" && check.value) {
      results.push({ type: "local", ...check.value });
    }
  }

  return results;
}
