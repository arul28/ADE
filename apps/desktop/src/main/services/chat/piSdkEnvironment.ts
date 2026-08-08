import fs from "node:fs";
import path from "node:path";

const PI_STANDARD_ENVIRONMENT_KEYS = [
  "PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "TEMP", "TMP", "TMPDIR", "SystemRoot", "ComSpec", "COMSPEC", "OS", "PATHEXT",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM",
  "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_OFFLINE",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID",
  "GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
  "MISTRAL_API_KEY", "DEEPSEEK_API_KEY", "XAI_API_KEY", "GROQ_API_KEY",
  "TOGETHER_API_KEY", "OPENROUTER_API_KEY", "CEREBRAS_API_KEY", "PERPLEXITY_API_KEY",
  "COHERE_API_KEY", "MINIMAX_API_KEY", "MOONSHOT_API_KEY", "ZAI_API_KEY",
  "OLLAMA_API_KEY", "LM_STUDIO_API_KEY", "GITHUB_TOKEN", "GH_TOKEN",
] as const;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function isBlockedPiEnvironmentName(name: string): boolean {
  return name.toUpperCase().startsWith("ADE_");
}

function configEnvironmentNames(value: string): string[] {
  const names: string[] = [];
  for (let index = 0; index < value.length;) {
    const dollar = value.indexOf("$", index);
    if (dollar < 0) break;
    const next = value[dollar + 1];
    if (next === "$" || next === "!") {
      index = dollar + 2;
      continue;
    }
    if (next === "{") {
      const end = value.indexOf("}", dollar + 2);
      if (end >= 0) {
        const name = value.slice(dollar + 2, end);
        if (ENV_NAME.test(name) && !names.includes(name)) names.push(name);
        index = end + 1;
        continue;
      }
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)/u.exec(value.slice(dollar + 1));
    if (match) {
      if (!names.includes(match[1]!)) names.push(match[1]!);
      index = dollar + 1 + match[1]!.length;
      continue;
    }
    index = dollar + 1;
  }
  return names;
}

function declaredPiEnvironmentNames(agentDir: string | undefined): Set<string> {
  if (!agentDir) return new Set();
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")) as unknown;
    const names = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === "string") {
        for (const name of configEnvironmentNames(value)) {
          if (!isBlockedPiEnvironmentName(name)) names.add(name);
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) collect(item);
        return;
      }
      if (value && typeof value === "object") {
        for (const child of Object.values(value)) collect(child);
      }
    };
    const walk = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (key === "apiKey" || key === "headers") collect(child);
        else walk(child);
      }
    };
    walk(parsed);
    return names;
  } catch {
    return new Set();
  }
}

/**
 * Pass Pi only the environment it needs. Custom providers may declare
 * `$ENV_NAME` references in models.json; those names are approved by the
 * user's Pi config and are copied without exposing unrelated ADE variables.
 */
export function buildPiWorkerEnvironment(
  source: NodeJS.ProcessEnv,
  agentDir?: string | null,
): NodeJS.ProcessEnv {
  const allowed = new Set<string>(PI_STANDARD_ENVIRONMENT_KEYS);
  for (const name of declaredPiEnvironmentNames(agentDir ?? source.PI_CODING_AGENT_DIR)) {
    if (!isBlockedPiEnvironmentName(name)) allowed.add(name);
  }
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (typeof source[key] === "string") result[key] = source[key];
  }
  return result;
}
