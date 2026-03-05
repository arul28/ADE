import { spawn } from "node:child_process";
import type { AgentIdentity, AdapterType } from "../../../shared/types";

type WorkerAdapterRuntimeServiceArgs = {
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
};

export type WorkerAdapterRunArgs = {
  agent: AgentIdentity;
  prompt: string;
  context?: Record<string, unknown>;
  timeoutMs?: number;
};

export type WorkerAdapterRunResult = {
  adapterType: AdapterType;
  ok: boolean;
  statusCode?: number | null;
  outputText: string;
  raw: unknown;
  usage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    costCents?: number | null;
    estimated?: boolean;
  };
};

const ENV_REF_TOKEN_PATTERN = /\$\{env:([A-Z0-9_]+)\}/g;

function resolveEnvRef(value: string): string {
  return value.replace(ENV_REF_TOKEN_PATTERN, (_full, envName: string) => {
    const resolved = process.env[envName];
    if (typeof resolved !== "string" || !resolved.length) {
      throw new Error(`Missing required environment variable '${envName}' for adapter configuration.`);
    }
    return resolved;
  });
}

function resolveEnvRefsDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolveEnvRefsDeep(entry));
  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      next[key] = resolveEnvRefsDeep(child);
    }
    return next;
  }
  if (typeof value === "string") return resolveEnvRef(value);
  return value;
}

function toPositiveTimeout(preferred: unknown, fallback = 60_000): number {
  const candidate = Number(preferred);
  if (Number.isFinite(candidate) && candidate > 0) return Math.floor(candidate);
  return fallback;
}

function guardCommand(command: string): void {
  const normalized = command.trim();
  const blockedPatterns = [/rm\s+-rf\s+\/(?!\w)/i, /:\(\)\s*\{\s*:\|:&\s*\};:/, /mkfs\./i];
  if (blockedPatterns.some((pattern) => pattern.test(normalized))) {
    throw new Error("Refusing to execute unsafe process adapter command.");
  }
}

function runCommand(
  spawnImpl: typeof spawn,
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    shell?: boolean;
    timeoutMs: number;
    stdinText?: string;
  }
): Promise<{ ok: boolean; outputText: string; raw: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      shell: options.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const outputText = `${stdout}${stderr}`.trim();
      resolve({
        ok: code === 0,
        outputText,
        raw: {
          command,
          args,
          cwd: options.cwd ?? null,
          exitCode: code,
          signal,
          stdout,
          stderr,
        },
      });
    });

    if (options.stdinText != null && options.stdinText.length) {
      child.stdin.write(options.stdinText);
    }
    child.stdin.end();
  });
}

export function createWorkerAdapterRuntimeService(args: WorkerAdapterRuntimeServiceArgs = {}) {
  const fetchImpl = args.fetchImpl ?? fetch;
  const spawnImpl = args.spawnImpl ?? spawn;

  const run = async (input: WorkerAdapterRunArgs): Promise<WorkerAdapterRunResult> => {
    const prompt = input.prompt.trim();
    if (!prompt.length) {
      throw new Error("Worker adapter run requires a non-empty prompt.");
    }
    const adapterType = input.agent.adapterType;
    const config = resolveEnvRefsDeep(input.agent.adapterConfig ?? {}) as Record<string, unknown>;

    if (adapterType === "openclaw-webhook") {
      const url = String(config.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) {
        throw new Error("openclaw-webhook requires a valid http(s) URL.");
      }
      const method = String(config.method ?? "POST").toUpperCase();
      if (method !== "POST") {
        throw new Error("openclaw-webhook only supports POST.");
      }
      const headersRaw = config.headers && typeof config.headers === "object" ? config.headers as Record<string, unknown> : {};
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      for (const [key, value] of Object.entries(headersRaw)) {
        if (typeof value !== "string") continue;
        headers[key] = value;
      }
      const timeoutMs = toPositiveTimeout(input.timeoutMs ?? config.timeoutMs, 60_000);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const body = {
          agentId: input.agent.id,
          agentName: input.agent.name,
          adapterType,
          prompt,
          context: input.context ?? {},
          bodyTemplate: typeof config.bodyTemplate === "string" ? config.bodyTemplate : undefined,
        };
        const response = await fetchImpl(url, {
          method,
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await response.text();
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // keep text payload
        }
        const outputText = typeof parsed === "string"
          ? parsed
          : (parsed && typeof parsed === "object" && typeof (parsed as { output?: unknown }).output === "string")
            ? String((parsed as { output?: unknown }).output)
            : text;
        return {
          adapterType,
          ok: response.ok,
          statusCode: response.status,
          outputText: outputText.trim(),
          raw: parsed,
        };
      } finally {
        clearTimeout(timeout);
      }
    }

    if (adapterType === "process") {
      const command = String(config.command ?? "").trim();
      if (!command.length) throw new Error("process adapter requires command.");
      guardCommand(command);
      const commandArgs = Array.isArray(config.args) ? config.args.filter((entry): entry is string => typeof entry === "string") : [];
      const env = config.env && typeof config.env === "object"
        ? Object.fromEntries(
            Object.entries(config.env as Record<string, unknown>).filter(([, value]) => typeof value === "string")
          ) as Record<string, string>
        : undefined;
      const timeoutMs = toPositiveTimeout(input.timeoutMs ?? config.timeoutMs, 120_000);
      const result = await runCommand(spawnImpl, command, commandArgs, {
        cwd: typeof config.cwd === "string" ? config.cwd : undefined,
        env,
        shell: config.shell === true,
        timeoutMs,
        stdinText: `${prompt}\n`,
      });
      return {
        adapterType,
        ok: result.ok,
        statusCode: result.ok ? 0 : 1,
        outputText: result.outputText,
        raw: result.raw,
      };
    }

    if (adapterType === "claude-local" || adapterType === "codex-local") {
      const binary = adapterType === "claude-local" ? "claude" : "codex";
      const model = typeof config.model === "string" && config.model.trim().length
        ? config.model.trim()
        : typeof config.modelId === "string" && config.modelId.trim().length
          ? config.modelId.trim()
          : "";
      const args: string[] = [];
      if (model) {
        args.push("--model", model);
      }
      if (Array.isArray(config.cliArgs)) {
        args.push(...config.cliArgs.filter((entry): entry is string => typeof entry === "string"));
      }
      const timeoutMs = toPositiveTimeout(input.timeoutMs ?? config.timeoutMs, 120_000);
      const instructions = typeof config.instructions === "string" && config.instructions.trim().length
        ? `${config.instructions.trim()}\n\n`
        : "";
      const result = await runCommand(spawnImpl, binary, args, {
        cwd: typeof config.cwd === "string" ? config.cwd : undefined,
        timeoutMs,
        stdinText: `${instructions}${prompt}\n`,
      });
      return {
        adapterType,
        ok: result.ok,
        statusCode: result.ok ? 0 : 1,
        outputText: result.outputText,
        raw: result.raw,
      };
    }

    throw new Error(`Unsupported adapter type '${adapterType}'.`);
  };

  return {
    run,
  };
}

export type WorkerAdapterRuntimeService = ReturnType<typeof createWorkerAdapterRuntimeService>;
